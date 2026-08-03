/**
 * Worktree lifecycle operations extracted from Orchestrator class.
 *
 * Each function receives its dependencies explicitly so tests can
 * spy on orchestrator methods via the delegate pattern.
 */
import { execFileSync } from 'child_process';
import { existsSync, readdirSync, rmSync, appendFileSync } from 'fs';
import path from 'path';
import { TaskStore } from '../task-store';
import { getWorktreeBase, resolveWorktreeDirName } from './helpers';
import { pruneWorktreesSafely } from './worktree-utils';
import type { TaskPipeline } from './types';

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

type SubtaskWorktreePipeline = Pick<TaskPipeline, 'worktreePath' | 'branch'>;

// ── Unpushed-commit detection ─────────────────────────────────────────────

/**
 * Check whether a branch has local commits that haven't been pushed to its
 * remote-tracking branch.  Returns the `git log --oneline` output (empty
 * string = clean) or null if the remote branch doesn't exist yet.
 */
export function getUnpushedCommits(
  projectRoot: string,
  branch: string,
): string | null {
  try {
    return execFileSync('git', ['log', `origin/${branch}..${branch}`, '--oneline'], {
      cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe',
    }).trim() || null;
  } catch {
    // Remote branch doesn't exist yet — nothing to compare against
    return null;
  }
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
  return path.join(worktreeBase, resolveWorktreeDirName(task));
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
      pruneWorktreesSafely(deps.projectRoot, stPath);
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

  // Check for unpushed commits before tearing down the worktree.
  // Commits made directly in the worktree outside the normal pipeline
  // push steps (e.g. a manual session after PR creation) would be
  // silently lost once the worktree is removed — the commit objects
  // survive in the local object store but become unreachable from any
  // branch.  Log a warning so the discrepancy is not invisible.
  const task = deps.taskStore.getById(taskId);
  if (task?.branch) {
    try {
      const unpushed = getUnpushedCommits(deps.projectRoot, task.branch);
      if (unpushed) {
        const taskDir = deps.taskStore.getDirById(taskId);
        const outputLog = path.join(taskDir, 'output.log');
        const timestamp = new Date().toISOString();
        try {
          appendFileSync(outputLog,
            `\n[${timestamp}] [WORKTREE] ⚠ WARNING: Removing worktree at ${wtPath}\n` +
            `[${timestamp}] [WORKTREE] The branch ${task.branch} has unpushed commits:\n` +
            unpushed.split('\n').map(l => `[${timestamp}] [WORKTREE]   ${l}`).join('\n') + '\n' +
            `[${timestamp}] [WORKTREE] These commits will become unreachable once the worktree is removed.\n` +
            `[${timestamp}] [WORKTREE] To recover: git branch recover-${taskId} ${task.branch} && git push origin recover-${taskId}\n`
          );
        } catch { /* best-effort — logging must not block worktree removal */ }
      }
    } catch { /* best-effort — unpushed check must not block worktree removal */ }
  }

  try {
    deps.execGit(['worktree', 'remove', wtPath], deps.projectRoot);
  } catch {
    // Normal remove failed (e.g. uncommitted changes) — force it
    try {
      deps.execGit(['worktree', 'remove', '--force', wtPath], deps.projectRoot);
    } catch {
      // Worktree is stuck (files locked) — delete manually + prune
      try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* best-effort */ }
      pruneWorktreesSafely(deps.projectRoot, wtPath);
    }
  }

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
