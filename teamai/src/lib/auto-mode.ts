import { TaskStore } from './task-store';
import { getOrchestrator } from './orchestrator';
import { processManager } from './process-manager';
import { execFileSync } from 'child_process';

interface AutoProjectState {
  enabled: boolean;
  maxParallel: number;
  /** Task IDs that were started by auto mode — tracked for CI polling after PR creation. */
  autoTrackedIds: Set<string>;
  /** Task IDs that auto mode has called approveTask for but pr-open hasn't fired yet.
   *  Bridges the timing gap: approveTask emits pr-open synchronously inside runCreatePR
   *  before the async call returns, so autoTrackedIds cannot be re-added via .then(). */
  autoApprovedIds: Set<string>;
  /** Task IDs currently being started (between resumeTask call and phase change) — prevents duplicate picks. */
  startingIds: Set<string>;
  tickTimer: ReturnType<typeof setInterval> | null;
  ciPollTimers: Map<string, ReturnType<typeof setInterval>>;
  eventCleanup: (() => void) | null;
}

const projectStates = new Map<string, AutoProjectState>();

function getState(projectRoot: string): AutoProjectState {
  let state = projectStates.get(projectRoot);
  if (!state) {
    state = {
      enabled: false,
      maxParallel: 1,
      autoTrackedIds: new Set(),
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
  trackedCount: number;
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
    trackedCount: state.autoTrackedIds.size,
  };
}

export function setAutoModeState(projectRoot: string, enabled: boolean, maxParallel: number = 1): void {
  const state = getState(projectRoot);
  if (enabled === state.enabled && maxParallel === state.maxParallel) return;

  state.maxParallel = maxParallel;

  if (enabled) {
    _start(projectRoot, state);
  } else {
    _stop(state);
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

const TERMINAL_PHASES = new Set(['backlog', 'done', 'failed']);
const PAUSED_PHASES = new Set(['awaiting-review', 'pr-open']);

function _start(projectRoot: string, state: AutoProjectState): void {
  if (state.enabled) return;
  state.enabled = true;

  const onPhaseChange = ({ taskId, phase, projectRoot: eventProject }:
    { taskId: string; phase: string; projectRoot: string }) => {
    if (eventProject !== projectRoot || !state.enabled) return;

    if (phase === 'awaiting-review' && state.autoTrackedIds.has(taskId)) {
      // Remove from autoTrackedIds to prevent infinite retry loop if approveTask fails.
      // Add to autoApprovedIds so the pr-open handler (which fires synchronously inside
      // approveTask before it returns) can still detect this task and start CI polling.
      state.autoTrackedIds.delete(taskId);
      state.autoApprovedIds.add(taskId);
      const orchestrator = getOrchestrator(projectRoot);
      orchestrator.approveTask(taskId, 'pull-request')
        .catch(err => {
          console.error(`[auto-mode] Failed to auto-approve task ${taskId}:`, err);
          state.autoApprovedIds.delete(taskId);
        });
    } else if (phase === 'pr-open' && (state.autoTrackedIds.has(taskId) || state.autoApprovedIds.has(taskId))) {
      state.autoApprovedIds.delete(taskId);
      // Start CI polling
      _startCIPolling(taskId, projectRoot, state);
    } else if (phase === 'done' && state.autoTrackedIds.has(taskId)) {
      // Task reached done — clean up tracking
      state.autoTrackedIds.delete(taskId);
    } else if (phase === 'failed' && state.autoTrackedIds.has(taskId)) {
      // Task failed — clean up tracking so it's not stuck
      state.autoTrackedIds.delete(taskId);
    } else if (phase === 'backlog' && state.autoTrackedIds.has(taskId)) {
      // Task was stopped/returned to backlog — clean up tracking
      state.autoTrackedIds.delete(taskId);
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

  // Run an immediate tick to pick up any backlog tasks right away
  _tick(projectRoot, state);

  console.log(`[auto-mode] Started for ${projectRoot} (max parallel: ${state.maxParallel})`);
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
  state.autoTrackedIds.clear();
  state.autoApprovedIds.clear();
  state.startingIds.clear();

  console.log('[auto-mode] Stopped');
}

function _tick(projectRoot: string, state: AutoProjectState): void {
  if (!state.enabled) return;

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
    state.autoTrackedIds.add(task.id);
    state.startingIds.add(task.id); // prevent duplicate pick until phase changes
    const orchestrator = getOrchestrator(projectRoot);
    orchestrator.resumeTask(task.id).catch(err => {
      console.error(`[auto-mode] Failed to start task ${task.id}:`, err);
      state.autoTrackedIds.delete(task.id);
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

      const prData = JSON.parse(execFileSync('gh', [
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
          execFileSync('gh', ['pr', 'merge', prNumber, '--merge'], {
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

function _finishTask(taskId: string, projectRoot: string, state: AutoProjectState): void {
  const orchestrator = getOrchestrator(projectRoot);
  orchestrator.markTaskDone(taskId).then(() => {
    const taskStore = new TaskStore(projectRoot);
    taskStore.update(taskId, { autoProcessed: true });
    state.autoTrackedIds.delete(taskId);
    console.log(`[auto-mode] Task ${taskId} marked as done (auto-processed)`);
  }).catch(err => {
    console.error(`[auto-mode] Failed to mark task ${taskId} as done:`, err);
  });
}
