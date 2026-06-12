import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { warn as logWarn } from './logger';

const IN_PROGRESS_PHASES = new Set([
  'spec', 'plan', 'implement', 'qa-review', 'merge', 'create-pr',
]);

export interface InterruptedTask {
  taskId: string;
  title: string;
  phase: string;
  projectPath: string;
  projectName: string;
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
}

/**
 * Scan all registered projects for tasks that were interrupted mid-pipeline.
 * Called once on server startup.
 */
export function findInterruptedTasks(): InterruptedTask[] {
  const projects = _loadProjects();
  const interrupted: InterruptedTask[] = [];

  for (const project of projects) {
    const teamaiDir = join(project.path, '.teamai');
    if (!existsSync(teamaiDir)) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(teamaiDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const taskFile = join(teamaiDir, entry, 'task.json');
      if (!existsSync(taskFile)) continue;
      try {
        const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
        if (IN_PROGRESS_PHASES.has(task.phase)) {
          interrupted.push({
            taskId: task.id,
            title: task.title,
            phase: task.phase,
            projectPath: project.path,
            projectName: project.name,
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

  for (const project of projects) {
    const worktreesDir = join(project.path, '.teamai', 'worktrees');
    if (!existsSync(worktreesDir)) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(worktreesDir);
    } catch {
      continue;
    }

    for (const entry of entries) {
      const wtPath = join(worktreesDir, entry);

      // Skip files, only consider directories
      try {
        if (!statSync(wtPath).isDirectory()) continue;
      } catch {
        continue;
      }

      // Extract task ID from worktree directory name (format: task-<uuid>)
      const taskIdMatch = entry.match(/^task-(.+)$/);
      if (!taskIdMatch) continue;
      const taskId = taskIdMatch[1];

      // Look up the task in the teamai directory
      const teamaiDir = join(project.path, '.teamai');
      let taskFound = false;
      let taskActive = false;

      try {
        for (const taskDir of readdirSync(teamaiDir)) {
          const taskFile = join(teamaiDir, taskDir, 'task.json');
          if (!existsSync(taskFile)) continue;
          try {
            const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
            if (task.id === taskId) {
              taskFound = true;
              taskActive = IN_PROGRESS_PHASES.has(task.phase);
              break;
            }
          } catch {
            // skip
          }
        }
      } catch {
        // skip
      }

      // Orphaned if task not found OR task is no longer active
      if (!taskFound || !taskActive) {
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
      entries = readdirSync(teamaiDir);
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
          writeFileSync(taskFile, JSON.stringify(task, null, 2));
          cleared++;
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
  const phaseRequirements: Record<string, string[]> = {
    plan: ['spec.md'],
    implement: ['spec.md', 'plan.json'],
    'qa-review': ['spec.md', 'plan.json'],
    merge: ['spec.md', 'plan.json'],
    'create-pr': ['spec.md', 'plan.json'],
  };

  for (const project of projects) {
    const teamaiDir = join(project.path, '.teamai');
    if (!existsSync(teamaiDir)) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(teamaiDir);
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

/** @internal Reset the auto-resume debounce timer (used in tests). */
export function _resetAutoResumeDebounce(): void {
  _lastAutoResumeTime = 0;
}

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

  for (const task of interrupted) {
    try {
      const orchestrator = getOrchestrator(task.projectPath);
      console.log(`[auto-resume] Resuming task ${task.taskId} "${task.title}" at phase ${task.phase} in ${task.projectName}`);
      orchestrator.resumeTask(task.taskId).catch(err => {
        logWarn('auto-resume', `Task ${task.taskId} "${task.title}" failed to resume:`, err);
      });
    } catch (err) {
      logWarn('auto-resume', `Failed to create orchestrator for ${task.projectPath}:`, err);
    }
  }

  return interrupted.length;
}

export function startupCleanup(staleSessionCount: number): StartupRecoveryReport {
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

  const projects = _loadProjects();
  let resumed = 0;

  for (const project of projects) {
    const teamaiDir = join(project.path, '.teamai');
    if (!existsSync(teamaiDir)) continue;

    let entries: string[] = [];
    try {
      entries = readdirSync(teamaiDir);
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

          // Clear the stale rate-limit flag and re-queue
          console.log(`[sweep] Task ${task.id} "${task.title}" has expired rate limit (was ${task.rateLimitedUntil}) — clearing and resuming`);
          delete task.rateLimitedUntil;
          try { writeFileSync(taskFile, JSON.stringify(task, null, 2)); } catch { /* best-effort */ }
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
          if (updatedAt > staleThreshold) continue; // recently updated, leave alone

          console.log(`[sweep] Task ${task.id} "${task.title}" stalled >30min in phase "${task.phase}" — resuming`);
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
  const projectsFile = join(homedir(), '.teamai', 'projects.json');
  if (!existsSync(projectsFile)) return [];
  try {
    return JSON.parse(readFileSync(projectsFile, 'utf-8'));
  } catch {
    return [];
  }
}
