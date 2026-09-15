import { TaskStore } from './task-store';
import { getOrchestrator } from './orchestrator';
import { processManager } from './process-manager';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { projectStore } from './project-store';
import { getToolPath } from './tool-checker';
import { log, error as logError, warn as logWarn } from './logger';
import { TERMINAL_PHASES, PAUSED_PHASES } from '@/constants/phases';
import { computePipelineConfig } from './orchestrator/helpers';
import { buildTicketMessageForPipeline } from './orchestrator/artifact-commit';
import { isAutoModeEnabled, getAutoModeState } from './auto-mode-state';
import { recordAutoProcessed } from './auto-review-store';
import { ContainerDockerMissingError } from './orchestrator/errors';

// Async (non-blocking) execFile — see the comment on _startCIPolling for why
// this matters: the *Sync variant blocks Node's entire single-threaded event
// loop, and this module's CI-poll timer fires unconditionally every 30s for
// as long as auto mode stays enabled for a project, which in a shared
// single-process server (e.g. the Playwright E2E harness) freezes every
// other concurrent request while `gh` runs.
const execFileAsync = promisify(execFile);

interface AutoProjectState {
  enabled: boolean;
  maxParallel: number;
  /** Task IDs with an approveTask call in flight — guards against double-approval.
   *  Cleared when pr-open fires (emitted synchronously inside runCreatePR before
   *  the async approveTask call returns) or when the approval fails.
   *  NOTE: keep this the only per-task tracking set, and never let it gate
   *  orchestration decisions beyond the in-flight window — in-memory membership
   *  does not survive server restarts, while tasks do (see the removed
   *  autoTrackedIds set, whose restart-stale gates stalled tasks in
   *  awaiting-review/pr-open). */
  autoApprovedIds: Set<string>;
  /** Task IDs currently being started (between resumeTask call and phase change) — prevents duplicate picks. */
  startingIds: Set<string>;
  tickTimer: ReturnType<typeof setInterval> | null;
  ciPollTimers: Map<string, ReturnType<typeof setInterval>>;
  eventCleanup: (() => void) | null;
}

// Store on global so server.ts and Next.js server actions share the same state
// across module contexts (Next.js loads server actions in a separate module
// graph). Without this there are TWO projectStates maps: restoreAutoModeStates
// (called from server.ts at boot) enables auto mode — timers and phase-change
// listener — in the custom-server instance, while a UI toggle-off runs in the
// Next bundle instance, sees enabled:false, and early-returns. The UI then
// shows auto mode off while the boot instance keeps approving and starting
// tasks.
declare global {
  var __autoModeProjectStates: Map<string, AutoProjectState> | undefined;
}

const projectStates: Map<string, AutoProjectState> =
  global.__autoModeProjectStates ?? (global.__autoModeProjectStates = new Map());

/** Path to the per-project auto-mode state file. */
function autoModeStatePath(projectRoot: string): string {
  return join(projectRoot, '.teamai', 'auto-mode.json');
}

/** Persist auto-mode state to disk so it survives server restarts (Bug 1).
 *  Only `enabled` and `maxParallel` are persisted — the runtime Sets (tracking,
 *  timers) are in-memory only and reconstructed by _adoptStalledTasks on restore. */
function saveAutoModeState(projectRoot: string, state: AutoProjectState): void {
  try {
    mkdirSync(join(projectRoot, '.teamai'), { recursive: true });
    writeFileSync(autoModeStatePath(projectRoot), JSON.stringify({
      enabled: state.enabled,
      maxParallel: state.maxParallel,
    }, null, 2));
  } catch (err) {
    // Don't block the toggle on a disk error — but surface it: this is the
    // state that survives server restarts (Bug 1), so a silent failure here
    // defeats crash recovery.
    logWarn('auto-mode', `Failed to persist auto-mode state for ${projectRoot}`, err);
  }
}

/** Read persisted auto-mode state from disk. Returns null if missing/invalid. */
function loadAutoModeState(projectRoot: string): { enabled: boolean; maxParallel: number } | null {
  try {
    const p = autoModeStatePath(projectRoot);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch { return null; }
}

function getState(projectRoot: string): AutoProjectState {
  let state = projectStates.get(projectRoot);
  if (!state) {
    state = {
      enabled: false,
      maxParallel: 1,
      autoApprovedIds: new Set(),
      startingIds: new Set(),
      tickTimer: null,
      ciPollTimers: new Map(),
      eventCleanup: null,
    };
    projectStates.set(projectRoot, state);
  }
  return state;
}

export { isAutoModeEnabled, getAutoModeState };

// ── Public API ──────────────────────────────────────────────────────────────

export function setAutoModeState(projectRoot: string, enabled: boolean, maxParallel: number = 1): void {
  const state = getState(projectRoot);
  const changed = enabled !== state.enabled || maxParallel !== state.maxParallel;

  state.maxParallel = maxParallel;

  if (changed) {
    if (enabled) {
      _start(projectRoot, state);
    } else {
      _stop(state);
    }
  } else if (enabled) {
    // An explicit enable can happen after startup restoration or after tasks
    // were imported while auto mode was already on. In both cases the state
    // is unchanged, but the scheduler still needs an immediate reconciliation
    // rather than waiting for the next interval tick.
    _adoptStalledTasks(projectRoot, state);
    _tick(projectRoot, state);
  }

  // Always persist, even when in-memory state already matches — an explicit
  // toggle must land on disk so a stale auto-mode.json (e.g. after a failed
  // restore) can't resurrect the old setting on the next restart.
  saveAutoModeState(projectRoot, state);
}

// ── Internal helpers ────────────────────────────────────────────────────────

/** Check whether pipeline.json has demo:true — halts all pipeline processing. */
function _isDemoProject(projectRoot: string): boolean {
  try {
    const cfgPath = join(projectRoot, '.teamai', 'pipeline.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      return cfg.demo === true;
    }
  } catch { /* malformed config — don't block */ }
  return false;
}

function _start(projectRoot: string, state: AutoProjectState): void {
  if (state.enabled) return;
  state.enabled = true;

  const onPhaseChange = ({ taskId, phase, projectRoot: eventProject }:
    { taskId: string; phase: string; projectRoot: string }) => {
    if (eventProject !== projectRoot || !state.enabled) return;

    if (phase === 'awaiting-review') {
      // Auto mode owns awaiting-review: approve ANY task that reaches it while
      // enabled. Membership in an in-memory tracking set must never gate this —
      // a task resumed by crash recovery after a server restart would not be
      // in such a set and would stall here forever (_adoptStalledTasks only
      // scans at _start, and the tick loop skips paused phases).
      _autoApprove(taskId, projectRoot, state);
    } else if (phase === 'pr-open') {
      // Same reasoning: start CI polling for any task that reaches pr-open
      // while auto mode is enabled — untracked-membership gates stall tasks
      // resumed after a restart. _startCIPolling is idempotent (ciPollTimers
      // guard), so duplicate events are safe.
      state.autoApprovedIds.delete(taskId);
      _startCIPolling(taskId, projectRoot, state);
    }

    // Clean up startingIds when task leaves backlog (success or failure)
    if (phase !== 'backlog' && state.startingIds.has(taskId)) {
      state.startingIds.delete(taskId);
    }
  };

  processManager.on('phase-change', onPhaseChange);
  state.eventCleanup = () => processManager.off('phase-change', onPhaseChange);

  // Start tick loop — runs every 5 seconds
  state.tickTimer = setInterval(() => _tick(projectRoot, state), 5000);

  // Re-adopt tasks that stalled in paused phases while auto mode was off:
  // their phase-change events already fired (or were never seen), so scan the
  // task store and approve / restart CI polling for them directly.
  _adoptStalledTasks(projectRoot, state);

  // Run an immediate tick to pick up any backlog tasks right away
  _tick(projectRoot, state);

  log('auto-mode', `Started for ${projectRoot} (max parallel: ${state.maxParallel})`);
}

/**
 * Auto-approve a task sitting in awaiting-review. Shared by the phase-change
 * listener and _adoptStalledTasks.
 *
 * Does NOT stamp autoProcessed here — the stamp is applied only after the
 * task is fully auto-processed (CI passes → auto-merge → markTaskDone).
 * Stamping at this point would leak the flag onto tasks that a human
 * manually approves after auto mode is turned on, since the create-pr
 * artifact commit copies the live task.json into the committed snapshot.
 *
 * The autoApprovedIds guard prevents double-approval while one is in flight;
 * on failure the id is removed (one-shot, no retry loop).
 */
function _autoApprove(taskId: string, projectRoot: string, state: AutoProjectState): void {
  if (state.autoApprovedIds.has(taskId)) return;
  state.autoApprovedIds.add(taskId);
  getOrchestrator(projectRoot).approveTask(taskId, 'pull-request')
    .catch(err => {
      logError('auto-mode', `Failed to auto-approve task ${taskId}`, err);
      state.autoApprovedIds.delete(taskId);
    });
}

/**
 * Re-adopt tasks that stalled in paused phases (awaiting-review, pr-open)
 * while auto mode was disabled. Their phase-change events fired (or were
 * missed) before this _start, so the listener alone won't process them.
 *
 * - awaiting-review: approve immediately.
 * - pr-open: start CI polling immediately.
 */
function _adoptStalledTasks(projectRoot: string, state: AutoProjectState): void {
  // Demo mode: when pipeline.json has demo:true, skip all pipeline processing
  if (_isDemoProject(projectRoot)) return;

  let taskStore: TaskStore;
  try {
    taskStore = new TaskStore(projectRoot);
  } catch {
    return; // project not yet initialized
  }

  const allTasks = taskStore.getAll();
  let adopted = 0;

  for (const task of allTasks) {
    // Respect user-paused tasks — same invariant as recovery.ts's
    // autoResumeInterruptedTasks/sweepStalledTasks: a deliberate pause must
    // only be lifted by clicking Resume in the UI, never by automated
    // recovery/adoption. Without this, turning auto mode on would silently
    // override a pause the user set specifically to prevent auto-processing.
    if (task.isPaused) continue;

    if (task.phase === 'awaiting-review') {
      // Approve immediately — the phase-change event won't fire because the
      // task is already in this phase.
      adopted++;
      _autoApprove(task.id, projectRoot, state);
    } else if (task.phase === 'pr-open') {
      // Restart CI polling — the pr-open phase-change event was missed while
      // auto mode was off.
      adopted++;
      _startCIPolling(task.id, projectRoot, state);
    }
  }

  if (adopted > 0) {
    log('auto-mode', `Re-adopted ${adopted} stalled task(s) in paused phases`);
  }
}

function _stop(state: AutoProjectState): void {
  state.enabled = false;

  if (state.tickTimer) {
    clearInterval(state.tickTimer);
    state.tickTimer = null;
  }
  if (state.eventCleanup) {
    state.eventCleanup();
    state.eventCleanup = null;
  }
  for (const timer of state.ciPollTimers.values()) {
    clearInterval(timer);
  }
  state.ciPollTimers.clear();
  state.autoApprovedIds.clear();
  state.startingIds.clear();

  log('auto-mode', 'Stopped');
}

function _tick(projectRoot: string, state: AutoProjectState): void {
  if (!state.enabled) return;

  // Demo mode: when pipeline.json has demo:true, skip all pipeline processing
  if (_isDemoProject(projectRoot)) return;

  let taskStore: TaskStore;
  try {
    taskStore = new TaskStore(projectRoot);
  } catch {
    return; // project not yet initialized
  }

  const allTasks = taskStore.getAll();

  // Count active tasks (running phases: spec, plan, implement, qa-review, merge, create-pr)
  const activeCount = allTasks.filter(t =>
    !TERMINAL_PHASES.has(t.phase) && !PAUSED_PHASES.has(t.phase)
  ).length;

  if (activeCount >= state.maxParallel) return;

  const slots = state.maxParallel - activeCount;
  if (slots <= 0) return;

  // Find eligible backlog tasks where all dependencies are in "done" status.
  // Exclude tasks already being started (in startingIds) to prevent duplicate picks.
  const eligible = allTasks.filter(t => {
    if (t.phase !== 'backlog') return false;
    if (state.startingIds.has(t.id)) return false;
    if (!t.dependencies || t.dependencies.length === 0) return true;
    return t.dependencies.every(depId => {
      const dep = allTasks.find(dt => dt.id === depId);
      // Completed task directories are deleted during finalization, so a
      // missing dependency can still be a valid completed prerequisite.
      return (dep && dep.phase === 'done') || taskStore.isTaskCompleted(depId);
    });
  });

  if (eligible.length === 0) return;

  // Pick oldest (by createdAt) — fair FIFO ordering. Tie-break by id so the
  // pick is deterministic when two tasks share the same createdAt.
  eligible.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  // Start up to `slots` tasks
  const toStart = eligible.slice(0, slots);
  for (const task of toStart) {
    state.startingIds.add(task.id); // prevent duplicate pick until phase changes
    const orchestrator = getOrchestrator(projectRoot);
    orchestrator.resumeTask(task.id).catch(err => {
      if (err instanceof ContainerDockerMissingError) {
        // Docker not running while container mode is enabled — not a crash,
        // the container-docker-missing event will notify the UI to show a dialog.
        // Don't log as error (it's an expected gate, not a failure).
        log('auto-mode', `Task ${task.id} blocked — container mode enabled but Docker not running`);
        state.startingIds.delete(task.id);
        return;
      }
      logError('auto-mode', `Failed to start task ${task.id}`, err);
      state.startingIds.delete(task.id);
    });
    log('auto-mode', `Started task: ${task.title} (${task.id})`);
  }
}

// ── CI Polling ──────────────────────────────────────────────────────────────

function _startCIPolling(taskId: string, projectRoot: string, state: AutoProjectState): void {
  if (state.ciPollTimers.has(taskId)) return;

  const taskStore = new TaskStore(projectRoot);
  const task = taskStore.getById(taskId);
  if (!task?.prUrl) return;

  // Parse PR number from GitHub URL (/pull/N)
  const prMatch = task.prUrl.match(/\/pull\/(\d+)/);
  if (!prMatch) return;
  const prNumber = prMatch[1];

  log('auto-mode', `Starting CI polling for PR #${prNumber} (task ${taskId})`);

  let mergeFailures = 0;
  const MAX_MERGE_FAILURES = 5;
  let ciRerunAttempts = 0;
  const MAX_CI_RERUN_ATTEMPTS = 3;
  // Guards against overlapping polls: the body below is now async (execFile,
  // not execFileSync), so a slow `gh` call could still be in flight when the
  // next 30s tick fires. Without this, overlapping polls could race each
  // other's terminal actions (e.g. two concurrent merge attempts).
  let pollInFlight = false;

  const timer = setInterval(() => {
    if (!state.enabled) {
      clearInterval(timer);
      state.ciPollTimers.delete(taskId);
      return;
    }
    if (pollInFlight) return;
    pollInFlight = true;

    void (async () => {
    try {
      // Refresh task data to get latest prUrl (may have been updated)
      const currentTask = new TaskStore(projectRoot).getById(taskId);
      if (!currentTask || currentTask.phase !== 'pr-open') {
        clearInterval(timer);
        state.ciPollTimers.delete(taskId);
        return;
      }

      // GitHub PR polling via gh. Async (not execFileSync) — this timer
      // fires every 30s for as long as the project has an open PR under
      // auto mode, and execFileSync would freeze the entire shared Node
      // event loop (all other concurrent requests, on every worker) for the
      // duration of each `gh` call. See the comment on execFileAsync above.
      const { stdout } = await execFileAsync(getToolPath('gh'), [
        'pr', 'view', prNumber,
        '--json', 'state,statusCheckRollup',
      ], { cwd: projectRoot, encoding: 'utf-8', timeout: 10_000 });
      const prData = JSON.parse(stdout);

      if (prData.state === 'MERGED') {
        // Already merged externally — just mark done
        clearInterval(timer);
        state.ciPollTimers.delete(taskId);
        _finishTask(taskId, projectRoot, state);
        return;
      }

      if (prData.state !== 'OPEN') {
        // PR closed without merge — stop polling
        clearInterval(timer);
        state.ciPollTimers.delete(taskId);
        log('auto-mode', `PR #${prNumber} closed without merge — stopping CI poll`);
        return;
      }

      // Check if all status checks passed
      const checks: Array<{ conclusion: string | null; detailsUrl?: string }> = prData.statusCheckRollup ?? [];
      if (checks.length === 0) {
        // No CI checks configured — stop polling, keep task in pr-open for manual review
        clearInterval(timer);
        state.ciPollTimers.delete(taskId);
        log('auto-mode', `No CI checks configured for PR #${prNumber} — stopping poll, awaiting manual review`);
        return;
      }
      const allPassed = checks.every(c =>
        c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED'
      );
      // Terminal failure conclusions — distinct from "still running" (conclusion
      // is null/undefined while a check is queued or in progress). Transient CI
      // infra flakiness (a network blip in an unrelated setup step, a runner
      // hiccup) commonly resolves on a plain re-run without any code change, so
      // this re-runs the failed jobs — via the failing check's own workflow run
      // — a bounded number of times before giving up, instead of treating a
      // failure identically to "still pending" and polling forever with no
      // escalation and no visible outcome.
      const failedChecks = checks.filter(c =>
        c.conclusion === 'FAILURE' || c.conclusion === 'TIMED_OUT' ||
        c.conclusion === 'CANCELLED' || c.conclusion === 'ACTION_REQUIRED' ||
        c.conclusion === 'STARTUP_FAILURE'
      );

      if (allPassed) {
        log('auto-mode', `All CI checks passed for PR #${prNumber} — auto-merging`);

        try {
          const method = computePipelineConfig(projectRoot).autoMergeMethod ?? 'merge';
          // Ticket-history refactor (§3h): 'squash' is the only merge method
          // that always synthesizes a brand-new commit message, so the
          // trailer-bearing message prepared by the pre-merge squash (§3b)
          // must be passed explicitly or GitHub would replace it with a
          // generic "Merge pull request #N" subject. 'merge' keeps the branch
          // commit (already carrying the trailers) as an ancestor, and
          // 'rebase' replays it verbatim — both findable via git log --grep
          // regardless; passing --subject/--body-file there is cosmetic and
          // 'rebase' ignores them entirely, so only squash gets the override.
          const mergeArgs = ['pr', 'merge', prNumber, `--${method}`];
          if (method === 'squash') {
            const ticketMsg = buildTicketMessageForTask(projectRoot, taskId);
            if (ticketMsg) {
              mergeArgs.push('--subject', ticketMsg.subject, '--body-file', ticketMsg.bodyFile);
            }
          }
          await execFileAsync(getToolPath('gh'), mergeArgs, {
            cwd: projectRoot, encoding: 'utf-8', timeout: 15_000,
          });
          log('auto-mode', `PR #${prNumber} merged successfully`);
          clearInterval(timer);
          state.ciPollTimers.delete(taskId);
          _finishTask(taskId, projectRoot, state);
        } catch (mergeErr) {
          mergeFailures++;
          const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
          logError('auto-mode', `Failed to merge PR #${prNumber} (attempt ${mergeFailures}/${MAX_MERGE_FAILURES}): ${msg}`);
          if (mergeFailures >= MAX_MERGE_FAILURES) {
            clearInterval(timer);
            state.ciPollTimers.delete(taskId);
            log('auto-mode', `PR #${prNumber} merge failed after ${MAX_MERGE_FAILURES} attempts — stopping poll, awaiting manual review`);
          }
        }
      } else if (failedChecks.length > 0) {
        if (ciRerunAttempts >= MAX_CI_RERUN_ATTEMPTS) {
          clearInterval(timer);
          state.ciPollTimers.delete(taskId);
          log('auto-mode', `PR #${prNumber} still has failing CI check(s) after ${MAX_CI_RERUN_ATTEMPTS} rerun attempts — stopping poll, awaiting manual review`);
          return;
        }
        const runId = failedChecks[0].detailsUrl?.match(/\/actions\/runs\/(\d+)/)?.[1];
        if (!runId) {
          clearInterval(timer);
          state.ciPollTimers.delete(taskId);
          log('auto-mode', `PR #${prNumber} has failing CI check(s) but no workflow run URL to re-run — stopping poll, awaiting manual review`);
          return;
        }
        ciRerunAttempts++;
        log('auto-mode', `PR #${prNumber} has failing CI check(s) — re-running failed jobs (attempt ${ciRerunAttempts}/${MAX_CI_RERUN_ATTEMPTS})`);
        try {
          await execFileAsync(getToolPath('gh'), ['run', 'rerun', runId, '--failed'], {
            cwd: projectRoot, encoding: 'utf-8', timeout: 15_000,
          });
        } catch (rerunErr) {
          const msg = rerunErr instanceof Error ? rerunErr.message : String(rerunErr);
          logError('auto-mode', `Failed to re-run CI for PR #${prNumber}: ${msg}`);
        }
      }
    } catch (err) {
      // Silently retry — gh might be temporarily unavailable or rate-limited
      const msg = err instanceof Error ? err.message : String(err);
      logError('auto-mode', `CI poll error for PR #${prNumber}: ${msg}`);
    } finally {
      pollInFlight = false;
    }
    })();
  }, 30_000); // poll every 30 seconds

  state.ciPollTimers.set(taskId, timer);
}

/**
 * Build the trailer-bearing squash-merge subject/body for a task (§3h).
 *
 * Reads the task's title/description/spec dir via TaskStore, then reuses the
 * shared message builder (same builder the phase runners use, so the squash
 * merge subject matches the pre-merge squashed commit). The body is written
 * to a temp file because `gh pr merge --body-file` requires a file path.
 *
 * Returns null when the task/folder is missing or recordHistoryInGit is off
 * (in which case gh's default squash message is used — same as today).
 */
function buildTicketMessageForTask(
  projectRoot: string,
  taskId: string,
): { subject: string; bodyFile: string } | null {
  try {
    const taskStore = new TaskStore(projectRoot);
    const task = taskStore.getById(taskId);
    const specPath = taskStore.getDirById(taskId);
    if (!task || !specPath || !existsSync(specPath)) return null;

    const config = computePipelineConfig(projectRoot);
    const result = buildTicketMessageForPipeline(
      {
        taskId,
        title: task.title,
        description: task.description,
        specPath,
      },
      {
        recordHistoryInGit: config.recordHistoryInGit,
        includePhasesTrailer: config.includePhasesTrailer,
        taskType: task.taskType,
      },
    );
    if (!result) return null;

    // gh --subject takes the first line; --body-file takes the rest.
    const [subject, ...bodyLines] = result.message.split('\n');
    const body = bodyLines.join('\n').replace(/^\n+/, '').replace(/\n+$/, '');
    const bodyFile = join(specPath, 'pr-squash-body.txt');
    writeFileSync(bodyFile, body, 'utf-8');
    return { subject, bodyFile };
  } catch (err) {
    logWarn('auto-mode', `Failed to build squash-merge message for task ${taskId}`, err);
    return null;
  }
}

function _finishTask(taskId: string, projectRoot: string, _state: AutoProjectState): void {
  // Persist this before markTaskDone deletes the per-task workspace. The
  // completed ticket is reconstructed from git history afterwards, so
  // autoProcessed/autoReviewed cannot live in task.json anymore.
  try {
    const taskStore = new TaskStore(projectRoot);
    const task = taskStore.getById(taskId);
    if (task) {
      const dir = taskStore.getDirById(taskId);
      recordAutoProcessed(projectRoot, taskId, task.slug ?? dir.split(/[\\/]/).pop() ?? taskId);
    }
  } catch (err) {
    logWarn('auto-mode', `Failed to persist auto-review metadata for task ${taskId}`, err);
  }

  const orchestrator = getOrchestrator(projectRoot);
  orchestrator.markTaskDone(taskId).then(() => {
    log('auto-mode', `Task ${taskId} marked as done (auto-processed)`);
  }).catch(err => {
    logError('auto-mode', `Failed to mark task ${taskId} as done`, err);
  }).finally(() => {
    // Keep the legacy task.json stamp when a task record still exists (for
    // compatibility with in-flight/non-history consumers). Normal completion
    // has already deleted the task workspace, and the durable record above is
    // the source used by history-reconstructed cards.
    try {
      const taskStore = new TaskStore(projectRoot);
      if (taskStore.getById(taskId)) {
        taskStore.update(taskId, { autoProcessed: true });
      }
    } catch (err) {
      logWarn('auto-mode', `Failed to stamp autoProcessed on task ${taskId} after markTaskDone`, err);
    }
  });
}

// ── Server startup restoration (Bug 1) ─────────────────────────────────────

/**
 * Scan all registered projects for persisted auto-mode state and re-enable
 * auto mode for any project that had it enabled before the server restarted.
 *
 * This is the Bug 1 fix: previously, auto-mode state lived only in memory
 * (the `projectStates` Map). A server restart — common during a long rate-limit
 * pause, dev hot reload, or crash — silently lost the enabled state, forcing
 * the user to manually re-enable auto mode in the UI. Now the state is
 * persisted to `.teamai/auto-mode.json` and restored on startup.
 *
 * Call this once on server startup, after processManager is ready.
 * @returns the number of projects that had auto mode re-enabled.
 */
export function restoreAutoModeStates(): number {
  let projects: { name: string; path: string }[];
  try {
    projects = projectStore.getAll();
  } catch {
    return 0;
  }
  let restored = 0;

  for (const project of projects) {
    const saved = loadAutoModeState(project.path);
    if (!saved || !saved.enabled) continue;

    // Don't double-enable if already running (e.g. HMR in dev)
    const existing = projectStates.get(project.path);
    if (existing?.enabled) continue;

    log('auto-mode', `Restoring auto mode for ${project.name} (max parallel: ${saved.maxParallel})`);
    setAutoModeState(project.path, true, saved.maxParallel);
    restored++;
  }

  return restored;
}
