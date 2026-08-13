import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { warn as logWarn, log } from './logger';
import { IN_PROGRESS_PHASES } from '@/constants/phases';
import { projectStore } from './project-store';
import { getWorktreeBase, computePipelineConfig } from './orchestrator/helpers';
import { restoreWorktreeGitFileToHostPaths } from './orchestrator/worktree-utils';
import { REQUIRED_ARTIFACTS } from './orchestrator/artifacts';

export interface InterruptedTask {
  taskId: string;
  title: string;
  phase: string;
  projectPath: string;
  projectName: string;
  /** ISO timestamp — set when pipeline was paused by API rate limit. */
  rateLimitedUntil?: string;
  /** User-paused flag — task was deliberately paused and must not be auto-resumed. */
  isPaused?: boolean;
}

export interface OrphanedWorktree {
  path: string;
  projectPath: string;
  projectName: string;
}

export interface ArtifactInconsistency {
  taskId: string;
  title: string;
  phase: string;
  projectPath: string;
  projectName: string;
  issue: string;
}

export interface StartupRecoveryReport {
  interruptedTasks: InterruptedTask[];
  staleSessions: number;
  orphanedWorktrees: OrphanedWorktree[];
  autoClearedRateLimits: number;
  artifactInconsistencies: ArtifactInconsistency[];
  restoredWorktrees: number;
}

/**
 * Scan all registered projects for tasks that were interrupted mid-pipeline.
 * Called once on server startup.
 */
export function findInterruptedTasks(): InterruptedTask[] {
  const projects = _loadProjects();
  const interrupted: InterruptedTask[] = [];

  for (const project of projects) {
    // Demo projects have pipeline.json demo:true — their in-progress tasks
    // are intentional seed data, not interrupted. Skip them entirely.
    if (_isDemoProject(project.path)) continue;

    const teamaiDir = join(project.path, '.teamai');
    if (!existsSync(teamaiDir)) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(teamaiDir).sort();
    } catch {
      continue;
    }

    for (const entry of entries) {
      const taskFile = join(teamaiDir, entry, 'task.json');
      if (!existsSync(taskFile)) continue;
      try {
        const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
        if (IN_PROGRESS_PHASES.has(task.phase)) {
          // Only consider a task "interrupted" if there is evidence it was
          // actually running — session_map.json (written when a session
          // starts) or output.log (written during pipeline execution).
          // Tasks in active phases without either were placed there by
          // seed data or created manually and should not be auto-resumed.
          const hasSessionMap = existsSync(join(teamaiDir, entry, 'session_map.json'));
          const hasOutputLog = existsSync(join(teamaiDir, entry, 'output.log'));
          if (!hasSessionMap && !hasOutputLog) continue;
          interrupted.push({
            taskId: task.id,
            title: task.title,
            phase: task.phase,
            projectPath: project.path,
            projectName: project.name,
            rateLimitedUntil: task.rateLimitedUntil,
            isPaused: task.isPaused === true,
          });
        }
      } catch {
        // skip malformed task.json
      }
    }
  }

  return interrupted;
}

/**
 * Find git worktrees in a project that are no longer associated with an active
 * task (i.e. the task directory under .teamai/ is missing or the task is done).
 */
export function findOrphanedWorktrees(): OrphanedWorktree[] {
  const projects = _loadProjects();
  const orphaned: OrphanedWorktree[] = [];
  const reportedPaths = new Set<string>();

  for (const project of projects) {
    // Scan the actual worktree base directory (not .teamai/worktrees which is unused)
    const worktreesDir = getWorktreeBase(project.path);
    if (!existsSync(worktreesDir)) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(worktreesDir).sort();
    } catch {
      continue;
    }

    // Build a set of known task slugs for fast lookup
    const knownSlugs = new Set<string>();
    const teamaiDir = join(project.path, '.teamai');
    try {
      for (const taskDir of readdirSync(teamaiDir).sort()) {
        const taskFile = join(teamaiDir, taskDir, 'task.json');
        if (!existsSync(taskFile)) continue;
        try {
          const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
          if (task.phase && !IN_PROGRESS_PHASES.has(task.phase)) continue; // task is done/failed
          // Worktree dirs are named by slug (derived from description)
          // The task directory name (under .teamai/) is the slug
          if (taskDir) knownSlugs.add(taskDir);
          // A relocated worktree (ensureWorktree fell back to a suffixed
          // directory because the canonical <slug> path had a file locked
          // open by an external process) is registered under a different
          // name than the task dir — without this it would be wrongly
          // reported as orphaned and swept up by cleanup.
          if (task.worktreeDirName) knownSlugs.add(task.worktreeDirName);
        } catch { /* skip malformed */ }
      }
    } catch { /* skip unreadable */ }

    for (const entry of entries) {
      const wtPath = join(worktreesDir, entry);

      // Skip files, only consider directories
      try {
        if (!statSync(wtPath).isDirectory()) continue;
      } catch {
        continue;
      }

      // Worktree dirs are named by slug — check against known task slugs.
      // Skip paths already scanned by a previous project (sibling projects
      // that share a parent directory scan the same worktrees dir).
      if (reportedPaths.has(wtPath)) continue;
      reportedPaths.add(wtPath);
      if (!knownSlugs.has(entry)) {
        orphaned.push({
          path: wtPath,
          projectPath: project.path,
          projectName: project.name,
        });
      }
    }
  }

  return orphaned;
}

/**
 * Restore any worktree whose `.git` file (or its host-side back-reference
 * under `<projectRoot>/.git/worktrees/<name>/gitdir`) is still pointing at
 * container-style paths, back to host-resolvable ones.
 *
 * patchWorktreeGitFile (worktree-utils.ts) deliberately rewrites both to
 * container form so `docker exec` git commands work while a coder session
 * is running — but today the only place that reverses it is the
 * artifact-commit success path (commitArtifactsToWorktree), reached only
 * when a task finishes cleanly. Any interruption before that point — a
 * killed session, a crashed/reprovisioned container, or the TeamAI server
 * process itself being terminated (Ctrl+C, a crash, a machine restart) —
 * leaves the worktree stuck container-shaped: unusable from host-side git
 * (`git status`, `git worktree list` show it as "prunable") until
 * something restores it.
 *
 * Called once on server startup (startupCleanup), which makes this
 * unconditional and safe regardless of *why* or *how* the previous run
 * ended — there is no in-memory state to reason about after a restart, so
 * every worktree just gets checked and fixed if needed.
 * restoreWorktreeGitFileToHostPaths is itself a no-op for a worktree
 * that's already host-correct, so this never disturbs a healthy worktree.
 *
 * @returns the number of worktrees that needed restoring.
 */
export function restoreContainerPatchedWorktrees(): number {
  const projects = _loadProjects();
  let restored = 0;
  const reportedPaths = new Set<string>();

  for (const project of projects) {
    const worktreesDir = getWorktreeBase(project.path);
    if (!existsSync(worktreesDir)) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(worktreesDir).sort();
    } catch {
      continue;
    }

    for (const entry of entries) {
      const wtPath = join(worktreesDir, entry);
      if (reportedPaths.has(wtPath)) continue;
      reportedPaths.add(wtPath);

      try {
        if (!statSync(wtPath).isDirectory()) continue;
      } catch {
        continue;
      }

      const gitFile = join(wtPath, '.git');
      if (!existsSync(gitFile)) continue;

      let gitdir: string;
      try {
        const content = readFileSync(gitFile, 'utf-8').trim();
        if (!content.startsWith('gitdir:')) continue;
        gitdir = content.slice('gitdir:'.length).trim();
      } catch {
        continue;
      }

      // Already resolvable from the host — nothing to restore.
      if (existsSync(gitdir)) continue;

      try {
        restoreWorktreeGitFileToHostPaths(wtPath, project.path);
        restored++;
        log('sweep', `Restored container-patched worktree git metadata: ${wtPath}`);
      } catch { /* best-effort */ }
    }
  }

  return restored;
}

/**
 * Scan all tasks with a `rateLimitedUntil` field set to a past timestamp
 * and clear it, so the task no longer shows the hourglass icon.
 * The task remains in its active phase and will be picked up by
 * `findInterruptedTasks` / the recovery banner on startup.
 * @returns the number of rate limits that were cleared.
 */
export function autoClearExpiredRateLimits(): number {
  const projects = _loadProjects();
  let cleared = 0;

  for (const project of projects) {
    const teamaiDir = join(project.path, '.teamai');
    if (!existsSync(teamaiDir)) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(teamaiDir).sort();
    } catch {
      continue;
    }

    for (const entry of entries) {
      const taskFile = join(teamaiDir, entry, 'task.json');
      if (!existsSync(taskFile)) continue;
      try {
        const raw = readFileSync(taskFile, 'utf-8');
        const task = JSON.parse(raw);
        if (task.rateLimitedUntil && new Date(task.rateLimitedUntil).getTime() <= Date.now()) {
          // Rate limit has expired — clear it and write back
          delete task.rateLimitedUntil;
          try {
            writeFileSync(taskFile, JSON.stringify(task, null, 2));
            cleared++;
          } catch (err) {
            // A failed write leaves the stale rateLimitedUntil on disk — surface
            // it instead of silently treating it like a malformed task.
            logWarn('recovery', `Failed to clear expired rate limit for ${taskFile}`, err);
          }
        }
      } catch {
        // skip malformed task.json
      }
    }
  }

  return cleared;
}

/**
 * Run full startup recovery scan across all projects.
 * Returns a unified report for logging and UI display.
 * Call this once on server startup.
 */
/**
 * Reconcile task phase against expected artifacts on disk (#9).
 * Catches cases where a task is in a phase but the corresponding artifact
 * is missing (e.g. spec.md deleted while task is in 'plan' phase).
 */
export function reconcileTaskArtifacts(): ArtifactInconsistency[] {
  const projects = _loadProjects();
  const inconsistencies: ArtifactInconsistency[] = [];

  // Phases and their required artifacts
  const phaseRequirements = REQUIRED_ARTIFACTS;

  for (const project of projects) {
    const teamaiDir = join(project.path, '.teamai');
    if (!existsSync(teamaiDir)) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(teamaiDir).sort();
    } catch {
      continue;
    }

    for (const entry of entries) {
      const taskFile = join(teamaiDir, entry, 'task.json');
      if (!existsSync(taskFile)) continue;
      try {
        const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
        const required = phaseRequirements[task.phase];
        if (!required) continue;

        for (const artifact of required) {
          const artifactPath = join(teamaiDir, entry, artifact);
          if (!existsSync(artifactPath)) {
            inconsistencies.push({
              taskId: task.id,
              title: task.title,
              phase: task.phase,
              projectPath: project.path,
              projectName: project.name,
              issue: `Missing required artifact '${artifact}' for phase '${task.phase}'`,
            });
          }
        }
      } catch {
        // skip malformed task.json
      }
    }
  }

  return inconsistencies;
}

// Debounce guard: prevent auto-resume from firing twice within a short window
// (e.g. on startup when both the initial call and the container-state listener fire).
let _lastAutoResumeTime = 0;
const AUTO_RESUME_DEBOUNCE_MS = 15_000; // 15 seconds

/** Threshold for detecting stalled tasks — tasks inactive for longer than this
 *  are considered stuck and eligible for auto-resume. */
const STALLED_TASK_THRESHOLD_MS = 30 * 60_000; // 30 minutes

/** Threshold for detecting abandoned in-flight phases — if output.log hasn't
 *  been touched in this long and there's no active pipeline, the task was
 *  likely orphaned by a server crash between retryTask writing the phase and
 *  the pipeline actually starting. Real pipeline work writes to output.log
 *  continuously. Defect 6 part 1. */
const ABANDONED_PHASE_THRESHOLD_MS = 5 * 60_000; // 5 minutes

/** Threshold for killing an IDLE session with no stdout output — no tool
 *  call in flight, no new message.
 *
 *  Originally 2 minutes, on the theory that there's no legitimate reason
 *  for a session to go quiet while it isn't waiting on a tool. Observed
 *  directly to be wrong: a real coder session was killed twice, 5 minutes
 *  apart, while genuinely reasoning through a multi-file investigation
 *  between tool calls (composing a long analysis, deciding what to read
 *  next) — no tool in flight, but real progress happening. This is the
 *  same class of false positive as WAKEUP_PROGRESS_STALE_THRESHOLD_MS below:
 *  silence between visible actions is not evidence of death. 15 minutes
 *  gives an idle "thinking" stretch comfortable headroom while still
 *  catching a genuinely dead/hung session (a crashed process, a broken
 *  connection) well before it could be mistaken for a slow subtask. */
const SESSION_IDLE_STALL_THRESHOLD_MS = 15 * 60_000; // 15 minutes

/** Threshold for treating a wakeup-pending background job's own progress
 *  log as stale — i.e. the job most likely died. Checked against the log's
 *  own mtime, not the scheduled `wakeup_at`, so a dead process is caught
 *  well before the full wait window elapses rather than only when the
 *  coder wakes up naturally. Generous relative to a sweep's own per-cell
 *  cadence (seconds), tight relative to a 1-2h wait.
 *
 *  Deliberately well above 15 minutes: a background job's stdout, when
 *  redirected to a log file rather than a TTY, is commonly block-buffered
 *  by the OS/runtime rather than line-buffered — a script emitting short,
 *  frequent lines (tens of bytes each) can legitimately go 15-20+ minutes
 *  between actual disk flushes while continuously making real progress.
 *  A 15-minute threshold treated that normal buffering lag as death,
 *  burning a wakeup attempt on every occurrence — three of those in a row
 *  exhausted the attempt cap and failed a task whose background job was
 *  never actually dead (confirmed independently: process alive, log
 *  demonstrably still advancing minutes after the task had been failed).
 *  30 minutes keeps comfortable margin above realistic buffering gaps
 *  while still catching a genuinely dead job well before any real
 *  `wakeup_at` window (typically 1-2h) elapses. */
const WAKEUP_PROGRESS_STALE_THRESHOLD_MS = 30 * 60_000; // 30 minutes

/** Threshold for killing a session that has a tool call in flight
 *  (`AgentSession.toolInFlight`). The CLI emits nothing between issuing a
 *  Bash tool call and that call returning, so a single slow-but-legitimate
 *  command (a cold `sbt compile`/`sbt test` on a Scala/Timefold project, a
 *  slow HTTP call, a big git operation) looks identical to a hung session
 *  under a flat no-output metric — this was observed directly, killing a
 *  session mid-investigation that was making real progress on one silent
 *  command, not stuck. Using the actual "is a tool running" signal instead
 *  of a single bigger number means idle stalls are still caught fast while
 *  genuine long-running work gets real headroom; a tool call that somehow
 *  never returns (e.g. a sweep the coder forgot to detach, despite being
 *  instructed to) is still eventually caught here. */
const SESSION_TOOL_STALL_THRESHOLD_MS = 30 * 60_000; // 30 minutes

/**
 * Auto-resume all interrupted tasks by re-queuing them through the orchestrator.
 * Called on server startup and when a container becomes available after being down.
 * Debounced: subsequent calls within AUTO_RESUME_DEBOUNCE_MS are ignored.
 * @returns the number of tasks that were auto-resumed, or 0 if debounced
 */
export async function autoResumeInterruptedTasks(): Promise<number> {
  const now = Date.now();
  if (now - _lastAutoResumeTime < AUTO_RESUME_DEBOUNCE_MS) {
    return 0;
  }
  _lastAutoResumeTime = now;

  // Dynamic import to avoid circular dependency at module load time
  const { getOrchestrator } = await import('./orchestrator');
  const interrupted = findInterruptedTasks();
  let resumed = 0;

  for (const task of interrupted) {
    try {
      const orchestrator = getOrchestrator(task.projectPath);

      // Skip tasks that are still within their rate-limit window —
      // attempting to resume would just waste an API call.
      if (task.rateLimitedUntil) {
        const expiresAt = new Date(task.rateLimitedUntil).getTime();
        if (expiresAt > Date.now()) {
          log('auto-resume', `Task ${task.taskId} "${task.title}" is still rate-limited until ${task.rateLimitedUntil} — skipping (will retry on expiry)`);
          continue;
        }
        log('auto-resume', `Task ${task.taskId} "${task.title}" rate limit expired (was ${task.rateLimitedUntil}) — resuming`);
      }

      // Respect user-paused tasks — the pause is deliberate and must only
      // be lifted by clicking Resume in the UI, never by automated recovery.
      if (task.isPaused) {
        log('auto-resume', `Task ${task.taskId} "${task.title}" is paused — skipping (user must unpause)`);
        continue;
      }

      log('auto-resume', `Resuming task ${task.taskId} "${task.title}" at phase ${task.phase} in ${task.projectName}`);
      orchestrator.resumeTask(task.taskId).catch(err => {
        logWarn('auto-resume', `Task ${task.taskId} "${task.title}" failed to resume:`, err);
      });
      resumed++;
    } catch (err) {
      logWarn('auto-resume', `Failed to create orchestrator for ${task.projectPath}:`, err);
    }
  }

  return resumed;
}

export function startupCleanup(staleSessionCount: number): StartupRecoveryReport {
  // Repair worktree git metadata first — findOrphanedWorktrees and anything
  // downstream that touches these worktrees works with host-resolvable
  // paths either way, but fixing them first means the rest of startup
  // never has to reason about a worktree stuck in container-shaped form.
  const restoredWorktrees = restoreContainerPatchedWorktrees();
  const interruptedTasks = findInterruptedTasks();
  const orphanedWorktrees = findOrphanedWorktrees();
  const autoClearedRateLimits = autoClearExpiredRateLimits();
  const artifactInconsistencies = reconcileTaskArtifacts();

  return {
    interruptedTasks,
    staleSessions: staleSessionCount,
    orphanedWorktrees,
    autoClearedRateLimits,
    artifactInconsistencies,
    restoredWorktrees,
  };
}

/**
 * Scan all projects for tasks that are stalled mid-pipeline:
 * - Task is in an active phase (in-progress)
 * - `rateLimitedUntil` has expired (timestamp in the past)
 * - The orchestrator lost the resume timeout (e.g. process restart, or
 *   the finally-block deletion bug)
 *
 * This is a periodic safety-net sweep, separate from the one-shot startup
 * recovery.  Called on a 5-minute interval while the server is running.
 *
 * @returns the number of stalled tasks that were auto-cleared and queued for resume.
 */
export async function sweepStalledTasks(): Promise<number> {
  // Dynamic import to avoid circular dependency at module load time
  const { getOrchestrator } = await import('./orchestrator');
  // Dynamic import processManager to avoid circular dependency
  const { processManager } = await import('./process-manager');

  // ── Kill hung sessions using per-project config ──
  // Each session carries a projectRoot; resolve the project's pipeline.json
  // thresholds (idleStallMinutes × 60_000, toolStallMinutes × 60_000) so
  // project A's 5-minute idle threshold doesn't affect project B's 15-minute
  // default.  Sessions without a resolvable project config fall back to the
  // hardcoded defaults (15 / 30 min).  Pre-resolve per projectPath so the
  // resolver callback (called once per running session) is a cheap map lookup.
  const projectConfigCache = new Map<string, { idleMs: number; toolMs: number }>();
  const defaultMs = { idleMs: SESSION_IDLE_STALL_THRESHOLD_MS, toolMs: SESSION_TOOL_STALL_THRESHOLD_MS };
  const stalledSessions = processManager.getStalledSessions((session) => {
    const root = session.projectRoot;
    if (!root) return defaultMs;
    if (projectConfigCache.has(root)) return projectConfigCache.get(root)!;
    try {
      const cfg = computePipelineConfig(root);
      const entry = {
        idleMs: cfg.idleStallMinutes * 60_000,
        toolMs: cfg.toolStallMinutes * 60_000,
      };
      projectConfigCache.set(root, entry);
      return entry;
    } catch {
      projectConfigCache.set(root, defaultMs);
      return defaultMs;
    }
  });
  for (const session of stalledSessions) {
    try {
      const root = session.projectRoot;
      const cfg = root ? projectConfigCache.get(root) : undefined;
      const idleMin = cfg ? Math.round(cfg.idleMs / 60_000) : 15;
      const toolMin = cfg ? Math.round(cfg.toolMs / 60_000) : 30;
      const kind = session.toolInFlight
        ? `tool-in-flight >${toolMin}min`
        : `idle >${idleMin}min`;
      logWarn('sweep',
        `Session ${session.id} (task ${session.taskId}, role ${session.role}) ` +
        `stalled (${kind}) with no output — killing`,
      );
      processManager.killSession(session.id, 'stalled', session.toolInFlight ? 'tool' : 'idle');
    } catch (err) {
      logWarn('sweep', `Failed to kill stalled session ${session.id}:`, err);
    }
  }

  const projects = _loadProjects();
  let resumed = 0;

  for (const project of projects) {
    // Demo projects have pipeline.json demo:true — skip them entirely
    if (_isDemoProject(project.path)) continue;

    const teamaiDir = join(project.path, '.teamai');
    if (!existsSync(teamaiDir)) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(teamaiDir).sort();
    } catch {
      continue;
    }

    for (const entry of entries) {
      const taskFile = join(teamaiDir, entry, 'task.json');
      if (!existsSync(taskFile)) continue;
      try {
        const raw = readFileSync(taskFile, 'utf-8');
        const task = JSON.parse(raw);

        // Only consider tasks in active pipeline phases
        if (!IN_PROGRESS_PHASES.has(task.phase)) continue;

        // Check 0: task is mid-wakeup-wait (ADR 002) for a background job
        // with a known progress log — verify that log is still fresh
        // rather than blindly trusting the full scheduled wait. A stale
        // log (no writes in WAKEUP_PROGRESS_STALE_THRESHOLD_MS) means the
        // background process most likely died; end the wait early so the
        // coder can assess and report failure now instead of after the
        // full window elapses. This task is either already handled by the
        // wakeup path or not eligible for the checks below either way, so
        // it always falls through to the next task afterward.
        if (task.wakeupUntil && new Date(task.wakeupUntil).getTime() > Date.now()) {
          try {
            const statePath = join(teamaiDir, entry, '.pipeline_state.json');
            if (existsSync(statePath)) {
              const state = JSON.parse(readFileSync(statePath, 'utf-8'));
              if (state.wakeupProgressPath && state.worktreePath) {
                const progressLogPath = join(state.worktreePath, state.wakeupProgressPath);
                // If the log doesn't exist yet, the job may have only just
                // started — that's not staleness, just don't check yet.
                if (existsSync(progressLogPath)) {
                  const staleForMs = Date.now() - statSync(progressLogPath).mtimeMs;
                  if (staleForMs > WAKEUP_PROGRESS_STALE_THRESHOLD_MS) {
                    const staleMin = Math.round(staleForMs / 60_000);
                    try {
                      const orchestrator = getOrchestrator(project.path);
                      const triggered = orchestrator.triggerEarlyWakeup(
                        task.id,
                        `progress log ${state.wakeupProgressPath} hasn't been modified in ${staleMin}min — background job appears dead`,
                      );
                      if (triggered) {
                        log('sweep', `Task ${task.id} "${task.title}" wakeup ended early — progress log stale for ${staleMin}min`);
                      }
                    } catch { /* orchestrator not available — leave for the scheduled wakeup */ }
                  }
                }
              }
            }
          } catch { /* best-effort — never let this check block the rest of the sweep */ }
          continue;
        }

        // Check 1: expired rate limit — the timeout was lost
        if (task.rateLimitedUntil) {
          const expiresAt = new Date(task.rateLimitedUntil).getTime();
          if (expiresAt > Date.now()) continue; // still rate-limited, leave alone

          // Rate limit expired but task never resumed.
          // Skip if the orchestrator already has an active pipeline for this task —
          // the handleRateLimit setTimeout will resume it (the finally-block bug is fixed).
          try {
            const orchestrator = getOrchestrator(project.path);
            if (orchestrator.isTaskActive(task.id)) continue;
          } catch { /* orchestrator not available — proceed */ }

          // Respect user-paused tasks — never auto-resume a paused task.
          if (task.isPaused) {
            log('sweep', `Task ${task.id} "${task.title}" is paused — skipping (user must unpause)`);
            continue;
          }

          // Clear the stale rate-limit flag and re-queue
          log('sweep', `Task ${task.id} "${task.title}" has expired rate limit (was ${task.rateLimitedUntil}) — clearing and resuming`);
          delete task.rateLimitedUntil;
          try { writeFileSync(taskFile, JSON.stringify(task, null, 2)); }
          catch (err) { logWarn('sweep', `Failed to clear expired rate limit for task ${task.id}`, err); }
        } else {
          // Check 2: no rate limit, but task has been in this phase with no
          // active session for > 30 minutes — likely a silent crash or exit.
          // Skip if the orchestrator is actively running a pipeline for this task.
          try {
            const orchestrator = getOrchestrator(project.path);
            if (orchestrator.isTaskActive(task.id)) continue;
          } catch { /* orchestrator not available — proceed */ }

          // Check if any active session still exists for this task
          const activeSession = processManager.getAllSessions().find(
            s => s.taskId === task.id && s.status === 'running'
          );
          if (activeSession) continue; // session still running, don't interfere

          // Check last-updated time: if task hasn't been touched recently
          const updatedAt = task.updatedAt ? new Date(task.updatedAt).getTime() : 0;
          const staleThreshold = Date.now() - STALLED_TASK_THRESHOLD_MS;

          let shouldResume = false;
          let reason = '';

          if (updatedAt <= staleThreshold) {
            // >30 minutes since last update — classic stall
            shouldResume = true;
            reason = `stalled >30min in phase "${task.phase}"`;
          } else {
            // Defect 6 part 1: detect tasks abandoned mid-phase — the phase was
            // written to disk but the pipeline never started (e.g. server crash
            // between retryTask writing task.json and the actual pipeline work).
            // Real pipeline work writes to output.log continuously, so a stale
            // log file means nothing is actually running.
            const outputLogPath = join(teamaiDir, entry, 'output.log');
            if (existsSync(outputLogPath)) {
              try {
                const logStat = statSync(outputLogPath);
                const logStaleMs = Date.now() - logStat.mtimeMs;
                if (logStaleMs >= ABANDONED_PHASE_THRESHOLD_MS) {
                  shouldResume = true;
                  reason = `output.log untouched for ${Math.round(logStaleMs / 60_000)}min — phase "${task.phase}" was written but pipeline never started`;
                }
              } catch { /* can't stat — skip */ }
            } else {
              // No output.log at all but task is in active phase.  Only
              // consider it "abandoned" if there is a session_map.json —
              // evidence the task was actually running before the crash.
              // Without it the task was seeded or manually created in this
              // phase and should not be swept.
              const sessionMapPath = join(teamaiDir, entry, 'session_map.json');
              if (existsSync(sessionMapPath)) {
                if (updatedAt < Date.now() - ABANDONED_PHASE_THRESHOLD_MS) {
                  shouldResume = true;
                  reason = `no output.log and phase "${task.phase}" set ${Math.round((Date.now() - updatedAt) / 60_000)}min ago — likely abandoned on startup`;
                }
              }
            }
          }

          if (!shouldResume) continue;

          // Respect user-paused tasks — the pause is deliberate.
          if (task.isPaused) {
            log('sweep', `Task ${task.id} "${task.title}" is paused — skipping stalled-task resume (user must unpause)`);
            continue;
          }

          log('sweep', `Task ${task.id} "${task.title}" ${reason} — resuming`);
        }

        // Re-queue the task for resumption
        try {
          const orchestrator = getOrchestrator(project.path);
          orchestrator.resumeTask(task.id).catch(err => {
            logWarn('sweep', `Stalled task ${task.id} "${task.title}" failed to resume:`, err);
          });
          resumed++;
        } catch (err) {
          logWarn('sweep', `Failed to create orchestrator for ${project.path}:`, err);
        }
      } catch {
        // skip malformed task.json
      }
    }
  }

  return resumed;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _loadProjects(): { name: string; path: string }[] {
  return projectStore.getAll();
}

/** Check whether a project's pipeline.json has demo:true. */
function _isDemoProject(projectPath: string): boolean {
  try {
    const cfgPath = join(projectPath, '.teamai', 'pipeline.json');
    if (existsSync(cfgPath)) {
      const cfg = JSON.parse(readFileSync(cfgPath, 'utf-8'));
      return cfg.demo === true;
    }
  } catch { /* malformed config — don't block */ }
  return false;
}
