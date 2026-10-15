/**
 * Worktree lifecycle operations extracted from Orchestrator class.
 *
 * Each function receives its dependencies explicitly so tests can
 * spy on orchestrator methods via the delegate pattern.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync, readdirSync, appendFileSync } from 'fs';
import path from 'path';
import { TaskStore } from '../task-store';
import { warn as logWarn } from '../logger';
import { getWorktreeBase, resolveWorktreeDirName } from './helpers';
import { removeStaleWorktreeRegistration, removeDirBestEffort } from './worktree-utils';
import { clearSubtaskWorktreeRecord } from './subtask-worktree-paths';
import type { TaskPipeline } from './types';

const execFileAsync = promisify(execFile);

/** Run `git` on the host with stdin closed; rejects with execFile's Error. */
async function runHostGit(args: string[], cwd: string): Promise<string> {
  const promise = execFileAsync('git', args, { cwd, encoding: 'utf-8' });
  promise.child?.stdin?.end();
  return (await promise).stdout;
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface WorktreeOpsDeps {
  /** Execute a git command — may be host-side or container-side. */
  execGit: (args: string[], hostCwd: string) => Promise<void>;
  /** The project root for git operations and path resolution. */
  projectRoot: string;
}

export type SubtaskCleanupDeps = WorktreeOpsDeps;

export interface RemoveWorktreeDeps extends WorktreeOpsDeps {
  taskStore: TaskStore;
}

type SubtaskWorktreePipeline = Pick<TaskPipeline, 'worktreePath' | 'branch'> & { specPath?: string };

// ── Unpushed-commit detection ─────────────────────────────────────────────

/**
 * Check whether a branch has local commits that haven't been pushed to its
 * remote-tracking branch.  Returns the `git log --oneline` output (empty
 * string = clean) or null if the remote branch doesn't exist yet.
 */
export async function getUnpushedCommits(
  projectRoot: string,
  branch: string,
): Promise<string | null> {
  try {
    return (await runHostGit(['log', `origin/${branch}..${branch}`, '--oneline'], projectRoot)).trim() || null;
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
 * Scans for directories matching <worktree-base>/<task-slug>-st<N>[-r<M>] and
 * removes them along with their branches and git worktree metadata.
 *
 * Strictly best-effort and never throws or waits: a directory that survives
 * removal (a file held open by a scanner or orphaned process — on any OS) is
 * simply left behind. The next subtask worktree takes a fresh path
 * (pickFreshSubtaskWorktreePath) so the run never depends on this cleanup
 * succeeding, and sweepAbandonedWorktreeRemnants reclaims the leftover at
 * the next server startup, once the lock has gone.
 */
export async function cleanStaleSubtaskWorktrees(
  pipeline: SubtaskWorktreePipeline,
  deps: SubtaskCleanupDeps,
): Promise<void> {
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
    const suffix = entry.name.slice(prefix.length);
    if (!/^\d+(-r\d+)?$/.test(suffix)) continue;
    const stPath = path.join(worktreeBase, entry.name);
    // Relocated variants (-st1-r2) share the canonical subtask branch (-st1).
    const stBranch = pipeline.branch + '-st' + suffix.replace(/-r\d+$/, '');

    try {
      await deps.execGit(['worktree', 'remove', '--force', stPath], deps.projectRoot);
    } catch { /* fall through to direct removal below */ }
    // git can deregister a worktree yet leave the directory behind (a locked
    // file), so check the directory itself rather than trusting git's result.
    if (existsSync(stPath)) removeDirBestEffort(stPath, 'stale subtask worktree from an earlier run');
    // Unconditional: deregisters the worktree even when the directory itself
    // couldn't be deleted, so the branch below is no longer "checked out".
    await removeStaleWorktreeRegistration(deps.projectRoot, stPath);

    try {
      await runHostGit(['branch', '-D', stBranch], deps.projectRoot);
    } catch { /* best-effort */ }
  }

  if (pipeline.specPath) clearSubtaskWorktreeRecord(pipeline.specPath);
}

const REMNANT_NAME = /-(?:st\d+(?:-r\d+)?|r\d+)$/;

/**
 * Startup sweep: delete leftover worktree directories that an earlier run
 * abandoned because they were locked at the time. Only touches directories
 * named like a subtask or relocated worktree (`*-st<N>`, `*-st<N>-r<M>`,
 * `*-r<M>`) that have no `.git` entry — a live worktree always has one, so
 * this can never remove a usable worktree (including a container-patched one
 * whose registration is invisible from the host). Silent on any failure: a
 * directory that is still locked is simply retried at the next startup.
 *
 * @returns the paths that were removed
 */
export async function sweepAbandonedWorktreeRemnants(projectRoot: string): Promise<string[]> {
  const removed: string[] = [];
  try {
    const worktreeBase = getWorktreeBase(projectRoot);
    if (!existsSync(worktreeBase)) return removed;
    for (const entry of readdirSync(worktreeBase, { withFileTypes: true })) {
      if (!entry.isDirectory() || !REMNANT_NAME.test(entry.name)) continue;
      const dir = path.join(worktreeBase, entry.name);
      if (existsSync(path.join(dir, '.git'))) continue; // live worktree — leave it
      if (removeDirBestEffort(dir, 'abandoned worktree remnant, startup sweep')) removed.push(dir);
      await removeStaleWorktreeRegistration(projectRoot, dir);
    }
  } catch (err) {
    logWarn('worktree', 'Startup sweep of abandoned worktree remnants failed', err);
  }
  return removed;
}

// ── Worktree removal ──────────────────────────────────────────────────────

/**
 * Remove the git worktree for a task.
 * Tries normal remove first; falls back to --force; then manual cleanup.
 * Always cleans up the branch and clears the task's branch record.
 */
export async function removeWorktree(
  taskId: string,
  deps: RemoveWorktreeDeps,
): Promise<void> {
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
      const unpushed = await getUnpushedCommits(deps.projectRoot, task.branch);
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
        } catch (err) {
          // Non-blocking — must not stop worktree removal — but not silent:
          // this is the actual data-loss warning, so it must reach the operator
          // somewhere even if it couldn't be appended to the task's own log.
          logWarn('orchestrator', `Failed to log unpushed-commit warning to ${outputLog} for task ${taskId} (branch ${task.branch})`, err);
        }
      }
    } catch (err) {
      // Non-blocking — must not stop worktree removal — but not silent: if the
      // check itself fails, the worktree is removed with no safety-net having
      // actually run, which is exactly the silent-data-loss case it exists to catch.
      logWarn('orchestrator', `Unpushed-commit check failed before removing worktree for task ${taskId} (branch ${task.branch}) — proceeding without it`, err);
    }
  }

  try {
    await deps.execGit(['worktree', 'remove', wtPath], deps.projectRoot);
  } catch {
    // Normal remove failed (e.g. uncommitted changes) — force it
    try {
      await deps.execGit(['worktree', 'remove', '--force', wtPath], deps.projectRoot);
    } catch {
      // Worktree is stuck (files locked) — delete manually + prune
      removeDirBestEffort(wtPath, `task ${taskId} worktree`);
      await removeStaleWorktreeRegistration(deps.projectRoot, wtPath);
    }
  }

  if (task?.branch) {
    try { await runHostGit(['branch', '-D', task.branch], deps.projectRoot); } catch { /* best-effort */ }
  }
  deps.taskStore.update(taskId, { branch: undefined });
}

// ── Worktree cleaning ─────────────────────────────────────────────────────

/** Discard all uncommitted changes in the worktree. */
export async function cleanWorktree(
  taskId: string,
  deps: WorktreeOpsDeps & { taskStore: TaskStore },
): Promise<void> {
  const worktreeBase = getWorktreeBase(deps.projectRoot);
  const wtPath = getWorktreePath(taskId, deps.taskStore, worktreeBase);
  if (!wtPath || !existsSync(wtPath)) return;
  try {
    await deps.execGit(['checkout', 'HEAD', '--', '.'], wtPath);
  } catch { /* best-effort */ }
}
