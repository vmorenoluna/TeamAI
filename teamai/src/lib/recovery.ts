import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

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

export interface StartupRecoveryReport {
  interruptedTasks: InterruptedTask[];
  staleSessions: number;
  orphanedWorktrees: OrphanedWorktree[];
  autoClearedRateLimits: number;
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
export function startupCleanup(staleSessionCount: number): StartupRecoveryReport {
  const interruptedTasks = findInterruptedTasks();
  const orphanedWorktrees = findOrphanedWorktrees();
  const autoClearedRateLimits = autoClearExpiredRateLimits();

  return {
    interruptedTasks,
    staleSessions: staleSessionCount,
    orphanedWorktrees,
    autoClearedRateLimits,
  };
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
