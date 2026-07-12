import { TaskStore } from './task-store';
import { getOrchestrator } from './orchestrator';
import { processManager } from './process-manager';
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { projectStore } from './project-store';
import { getToolPath } from './tool-checker';

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
  } catch { /* best-effort — don't block toggle on disk errors */ }
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

// ── Public API ──────────────────────────────────────────────────────────────

export function isAutoModeEnabled(projectRoot: string): boolean {
  return projectStates.get(projectRoot)?.enabled ?? false;
}

export function getAutoModeState(projectRoot: string): {
  enabled: boolean;
  maxParallel: number;
  activeCount: number;
} {
  const state = getState(projectRoot);
  let activeCount = 0;
  try {
    const taskStore = new TaskStore(projectRoot);
    activeCount = taskStore.getAll().filter(t =>
      !TERMINAL_PHASES.has(t.phase) && !PAUSED_PHASES.has(t.phase)
    ).length;
  } catch { /* taskStore may fail if projectRoot doesn't exist yet */ }
  return {
    enabled: state.enabled,
    maxParallel: state.maxParallel,
    activeCount,
  };
}

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

const TERMINAL_PHASES = new Set(['backlog', 'done', 'failed']);
// create-pr is a brief transitional phase between awaiting-review and pr-open.
// It counts as paused so it doesn't consume a parallel slot in the tick loop
// (the approveTask it runs is synchronous within _adoptStalledTasks).
const PAUSED_PHASES = new Set(['awaiting-review', 'pr-open', 'create-pr']);

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

  console.log(`[auto-mode] Started for ${projectRoot} (max parallel: ${state.maxParallel})`);
}

/**
 * Auto-approve a task sitting in awaiting-review. Shared by the phase-change
 * listener and _adoptStalledTasks.
 *
 * Stamps autoProcessed: true on the live task.json BEFORE approving: the
 * create-pr artifact commit copies the live task.json into the committed
 * snapshot, so the flag survives the delete-on-done + pull flow and the amber
 * "auto-processed" border persists after the merge. (Stamping later, at merge
 * time, would only reach the live copy — which markTaskDone deletes.)
 *
 * The autoApprovedIds guard prevents double-approval while one is in flight;
 * on failure the id is removed (one-shot, no retry loop).
 */
function _autoApprove(taskId: string, projectRoot: string, state: AutoProjectState): void {
  if (state.autoApprovedIds.has(taskId)) return;
  state.autoApprovedIds.add(taskId);
  try {
    new TaskStore(projectRoot).update(taskId, { autoProcessed: true });
  } catch { /* best-effort — approval proceeds regardless */ }
  getOrchestrator(projectRoot).approveTask(taskId, 'pull-request')
    .catch(err => {
      console.error(`[auto-mode] Failed to auto-approve task ${taskId}:`, err);
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
    console.log(`[auto-mode] Re-adopted ${adopted} stalled task(s) in paused phases`);
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

  console.log('[auto-mode] Stopped');
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
      return dep && dep.phase === 'done';
    });
  });

  if (eligible.length === 0) return;

  // Pick oldest (by createdAt) — fair FIFO ordering
  eligible.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  // Start up to `slots` tasks
  const toStart = eligible.slice(0, slots);
  for (const task of toStart) {
    state.startingIds.add(task.id); // prevent duplicate pick until phase changes
    const orchestrator = getOrchestrator(projectRoot);
    orchestrator.resumeTask(task.id).catch(err => {
      console.error(`[auto-mode] Failed to start task ${task.id}:`, err);
      state.startingIds.delete(task.id);
    });
    console.log(`[auto-mode] Started task: ${task.title} (${task.id})`);
  }
}

// ── CI Polling ──────────────────────────────────────────────────────────────

function _startCIPolling(taskId: string, projectRoot: string, state: AutoProjectState): void {
  if (state.ciPollTimers.has(taskId)) return;

  const taskStore = new TaskStore(projectRoot);
  const task = taskStore.getById(taskId);
  if (!task?.prUrl) return;

  const prMatch = task.prUrl.match(/\/pull\/(\d+)/);
  if (!prMatch) return;
  const prNumber = prMatch[1];

  console.log(`[auto-mode] Starting CI polling for PR #${prNumber} (task ${taskId})`);

  const timer = setInterval(() => {
    if (!state.enabled) {
      clearInterval(timer);
      state.ciPollTimers.delete(taskId);
      return;
    }

    try {
      // Refresh task data to get latest prUrl (may have been updated)
      const currentTask = new TaskStore(projectRoot).getById(taskId);
      if (!currentTask || currentTask.phase !== 'pr-open') {
        clearInterval(timer);
        state.ciPollTimers.delete(taskId);
        return;
      }

      const prData = JSON.parse(execFileSync(getToolPath('gh'), [
        'pr', 'view', prNumber,
        '--json', 'state,statusCheckRollup',
      ], { cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000 }));

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
        console.log(`[auto-mode] PR #${prNumber} closed without merge — stopping CI poll`);
        return;
      }

      // Check if all status checks passed
      const checks: Array<{ conclusion: string }> = prData.statusCheckRollup ?? [];
      const allPassed = checks.length > 0 && checks.every(c =>
        c.conclusion === 'SUCCESS' || c.conclusion === 'NEUTRAL' || c.conclusion === 'SKIPPED'
      );

      if (allPassed) {
        console.log(`[auto-mode] All CI checks passed for PR #${prNumber} — auto-merging`);
        clearInterval(timer);
        state.ciPollTimers.delete(taskId);

        try {
          execFileSync(getToolPath('gh'), ['pr', 'merge', prNumber, '--merge'], {
            cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe', timeout: 15_000,
          });
          console.log(`[auto-mode] PR #${prNumber} merged successfully`);
        } catch (mergeErr) {
          const msg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
          console.error(`[auto-mode] Failed to merge PR #${prNumber}: ${msg}`);
          // Don't mark done if merge failed — leave for manual intervention
          return;
        }

        _finishTask(taskId, projectRoot, state);
      }
    } catch (err) {
      // Silently retry — gh might be temporarily unavailable or rate-limited
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[auto-mode] CI poll error for PR #${prNumber}: ${msg}`);
    }
  }, 30_000); // poll every 30 seconds

  state.ciPollTimers.set(taskId, timer);
}

function _finishTask(taskId: string, projectRoot: string, _state: AutoProjectState): void {
  // Belt-and-braces autoProcessed stamp. The flag is normally already in the
  // committed artifact snapshot (set by _autoApprove before create-pr), which
  // markTaskDone's pull restores. This live-copy stamp covers the pull-failure
  // fallback, which recreates task.json from the live copy read at the start
  // of markTaskDone. (On pull success the snapshot wins by design — a task
  // approved manually and only merged by auto mode won't carry the flag.)
  const taskStore = new TaskStore(projectRoot);
  taskStore.update(taskId, { autoProcessed: true });

  const orchestrator = getOrchestrator(projectRoot);
  orchestrator.markTaskDone(taskId).then(() => {
    console.log(`[auto-mode] Task ${taskId} marked as done (auto-processed)`);
  }).catch(err => {
    console.error(`[auto-mode] Failed to mark task ${taskId} as done:`, err);
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

    console.log(`[auto-mode] Restoring auto mode for ${project.name} (max parallel: ${saved.maxParallel})`);
    setAutoModeState(project.path, true, saved.maxParallel);
    restored++;
  }

  return restored;
}
