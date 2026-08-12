/**
 * Shared helper for creating real git worktrees in integration tests.
 *
 * On Windows, `git worktree add` can hit a race where git tries to create
 * `.git/index.lock` inside the worktree's `.git` directory before that
 * directory exists. Under full-suite parallel load (many vitest workers plus
 * antivirus real-time scanning), that window widens and a single attempt can
 * fail transiently. Retry with full cleanup of git's internal state (branch +
 * worktree registry + partial directory) between attempts so a stale lock or
 * half-created worktree can't poison the next attempt.
 */
import { execFileSync } from 'child_process';
import { rmSync } from 'fs';

export interface AddWorktreeOptions {
  /** stdio for the `git worktree add` invocation. Default `'pipe'`. */
  stdio?: 'pipe' | 'ignore';
  /** Max attempts before giving up. Default 5. */
  attempts?: number;
  /** Base busy-wait delay (ms) between attempts; ramps linearly. Default 400. */
  delayMs?: number;
}

/**
 * Run `git worktree add` with retries that clean up git's partial state
 * between attempts, so a transient Windows `index.lock` race doesn't fail
 * the test.
 *
 * @param addArgs Arguments after `worktree add` — e.g.
 *                `[worktreePath, '-b', branch]` (create a new branch) or
 *                `[worktreePath, branch]` (check out a pre-existing branch).
 *                When `-b <branch>` is present, that newly-created branch is
 *                deleted on failure before retrying (it is created as a side
 *                effect even when the add fails); a pre-existing branch is
 *                never touched.
 * @param cwd     Working directory for the git invocation (the repo root).
 */
export function addWorktreeWithRetry(
  addArgs: string[],
  cwd: string,
  options: AddWorktreeOptions = {},
): void {
  const { stdio = 'pipe', attempts = 5, delayMs = 400 } = options;
  // Guard against misuse (attempts <= 0) so the loop always runs at least once.
  const totalAttempts = Math.max(1, attempts);

  // `git worktree add <path> -b <branch>` creates the branch as a side
  // effect — including on failure — so it must be cleaned up before retrying.
  // A pre-existing branch (no `-b`) belongs to the test and must be left alone.
  const bIndex = addArgs.indexOf('-b');
  const branchToDelete = bIndex !== -1 ? addArgs[bIndex + 1] : undefined;
  const worktreePath = addArgs[0];

  let lastErr: unknown;
  for (let attempt = 0; attempt < totalAttempts; attempt++) {
    try {
      execFileSync('git', ['worktree', 'add', ...addArgs], { cwd, stdio });
      return;
    } catch (e) {
      lastErr = e;
      // 1. Delete the branch (`-b` variant only) — created even on failure.
      if (branchToDelete) {
        try { execFileSync('git', ['branch', '-D', branchToDelete], { cwd, stdio: 'pipe' }); } catch { /* ok */ }
      }
      // 2. Remove the partial worktree directory.
      if (worktreePath) {
        try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* ok */ }
      }
      // 3. Prune git's internal worktree registry of stale entries.
      try { execFileSync('git', ['worktree', 'prune'], { cwd, stdio: 'pipe' }); } catch { /* ok */ }

      // Back off before the next attempt so the filesystem can settle.
      if (attempt < totalAttempts - 1) {
        const waitMs = delayMs * (attempt + 1);
        const end = Date.now() + waitMs;
        while (Date.now() < end) { /* busy-wait */ }
      }
    }
  }
  throw lastErr;
}
