/**
 * Worktree lifecycle operations extracted from Orchestrator class.
 *
 * Each function receives its dependencies explicitly so tests can
 * spy on orchestrator methods via the delegate pattern.
 */
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, rmSync } from 'fs';
import path from 'path';
import { slugify } from '../utils';
import { TaskStore } from '../task-store';
import { getWorktreeBase } from './helpers';

// ── Types ─────────────────────────────────────────────────────────────────

export interface WorktreeOpsDeps {
  /** Execute a git command — may be host-side or container-side. */
  execGit: (args: string[], hostCwd: string) => void;
  /** The project root for git operations and path resolution. */
  projectRoot: string;
}

export interface RemoveWorktreeDeps extends WorktreeOpsDeps {
  taskStore: TaskStore;
}

interface SubtaskWorktreePipeline {
  worktreePath: string;
  branch: string;
}

// ── Worktree path resolver ────────────────────────────────────────────────

/** Get the filesystem path to a task's git worktree, or null if no branch. */
export function getWorktreePath(
  taskId: string,
  taskStore: TaskStore,
  worktreeBase: string,
): string | null {
  const task = taskStore.getById(taskId);
  if (!task || !task.branch) return null;
  const slug = slugify(task.description);
  return path.join(worktreeBase, slug);
}

// ── Stale subtask worktree cleanup ────────────────────────────────────────

/**
 * Clean up stale per-subtask worktrees from a previous crashed run (AC9).
 * Scans for directories matching <worktree-base>/<task-slug>-st* and removes
 * them along with their branches and git worktree metadata.
 */
export function cleanStaleSubtaskWorktrees(
  pipeline: SubtaskWorktreePipeline,
  deps: WorktreeOpsDeps,
): void {
  const slug = path.basename(pipeline.worktreePath);
  const prefix = slug + '-st';
  const worktreeBase = getWorktreeBase(deps.projectRoot);
  if (!existsSync(worktreeBase)) return;

  let entries;
  try {
    entries = readdirSync(worktreeBase, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.name.startsWith(prefix)) continue;
    if (!entry.name.slice(prefix.length).match(/^\d+$/)) continue;
    const stPath = path.join(worktreeBase, entry.name);
    const stBranch = pipeline.branch + entry.name.slice(slug.length);

    try {
      deps.execGit(['worktree', 'remove', '--force', stPath], deps.projectRoot);
    } catch {
      try { rmSync(stPath, { recursive: true, force: true }); } catch { /* best-effort */ }
      try { execFileSync('git', ['worktree', 'prune'], { cwd: deps.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
    }

    try {
      execFileSync('git', ['branch', '-D', stBranch], { cwd: deps.projectRoot, stdio: 'pipe' });
    } catch { /* best-effort */ }
  }
}

// ── Worktree removal ──────────────────────────────────────────────────────

/**
 * Remove the git worktree for a task.
 * Tries normal remove first; falls back to --force; then manual cleanup.
 * Always cleans up the branch and clears the task's branch record.
 */
export function removeWorktree(
  taskId: string,
  deps: RemoveWorktreeDeps,
): void {
  const worktreeBase = getWorktreeBase(deps.projectRoot);
  const wtPath = getWorktreePath(taskId, deps.taskStore, worktreeBase);
  if (!wtPath || !existsSync(wtPath)) return;

  try {
    deps.execGit(['worktree', 'remove', wtPath], deps.projectRoot);
  } catch {
    // Normal remove failed (e.g. uncommitted changes) — force it
    try {
      deps.execGit(['worktree', 'remove', '--force', wtPath], deps.projectRoot);
    } catch {
      // Worktree is stuck (files locked) — delete manually + prune
      try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* best-effort */ }
      try { execFileSync('git', ['worktree', 'prune'], { cwd: deps.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
    }
  }

  const task = deps.taskStore.getById(taskId);
  if (task?.branch) {
    try { execFileSync('git', ['branch', '-D', task.branch], { cwd: deps.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
  }
  deps.taskStore.update(taskId, { branch: undefined });
}

// ── Worktree cleaning ─────────────────────────────────────────────────────

/** Discard all uncommitted changes in the worktree. */
export function cleanWorktree(
  taskId: string,
  deps: WorktreeOpsDeps & { taskStore: TaskStore },
): void {
  const worktreeBase = getWorktreeBase(deps.projectRoot);
  const wtPath = getWorktreePath(taskId, deps.taskStore, worktreeBase);
  if (!wtPath || !existsSync(wtPath)) return;
  try {
    deps.execGit(['checkout', 'HEAD', '--', '.'], wtPath);
  } catch { /* best-effort */ }
}
