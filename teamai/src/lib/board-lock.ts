/**
 * Cross-process lock on a project's ticket board (`.teamai/`).
 *
 * Every write that creates, deletes or re-links tickets on behalf of an
 * overlap check runs under this lock, so "compare the board with what the
 * agent saw, then write" is atomic across the TeamAI server and the
 * interactive create-task CLI (a separate Node process —
 * defaults/create-task-cli.mjs carries a copy of this protocol).
 *
 * The lock is held for milliseconds only (a fingerprint comparison plus a
 * few file writes), never across an agent session: agents read a snapshot
 * and the writer re-checks it under the lock (see backlog-check.ts).
 *
 * Lock file: `.teamai/.board.lock`, created with O_EXCL, holding the owner's
 * `{ pid, host, acquiredAt }`. It never outlives its owner:
 *  - released in `finally` on every normal path;
 *  - released by a process `exit` handler if the process exits while
 *    holding it (app closed, uncaught exception);
 *  - treated as stale and taken over when its pid is dead on this host
 *    (crash, kill -9) or when it is older than STALE_AFTER_MS (an owner on
 *    another host or in a container whose pid can't be probed).
 *
 * Re-entrant within a process: a holder can call withBoardLock again (e.g.
 * TaskStore.create inside a locked apply) without deadlocking itself.
 */
import { openSync, closeSync, writeSync, readFileSync, unlinkSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import { hostname } from 'os';

export const BOARD_LOCK_FILE = '.board.lock';
/** Holds last milliseconds; anything this old is abandoned. */
export const STALE_AFTER_MS = 30_000;
/** How long to wait for a live holder before giving up. */
const ACQUIRE_TIMEOUT_MS = 15_000;
const RETRY_SLEEP_MS = 25;

interface LockOwner { pid: number; host: string; acquiredAt: number }

/** specsDir → re-entrancy depth held by this process. */
const held = new Map<string, number>();
let exitHandlerInstalled = false;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readOwner(lockPath: string): LockOwner | null {
  try {
    return JSON.parse(readFileSync(lockPath, 'utf-8')) as LockOwner;
  } catch {
    return null;
  }
}

/** True when the lock at `lockPath` can be taken over. */
export function isLockStale(lockPath: string, now = Date.now()): boolean {
  const owner = readOwner(lockPath);
  if (!owner) {
    // Unreadable: a writer crashed between create and write, or is writing
    // right now. Judge by file age so a just-created file isn't stolen.
    try { return now - statSync(lockPath).mtimeMs > STALE_AFTER_MS; } catch { return true; }
  }
  if (now - owner.acquiredAt > STALE_AFTER_MS) return true;
  if (owner.host === hostname() && !pidAlive(owner.pid)) return true;
  return false;
}

function installExitHandler(): void {
  if (exitHandlerInstalled) return;
  exitHandlerInstalled = true;
  process.on('exit', () => {
    for (const specsDir of held.keys()) {
      const lockPath = join(specsDir, BOARD_LOCK_FILE);
      const owner = readOwner(lockPath);
      if (owner?.pid === process.pid && owner.host === hostname()) {
        try { unlinkSync(lockPath); } catch { /* best-effort */ }
      }
    }
    held.clear();
  });
}

function acquire(specsDir: string): void {
  const lockPath = join(specsDir, BOARD_LOCK_FILE);
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = openSync(lockPath, 'wx');
      try {
        writeSync(fd, JSON.stringify({ pid: process.pid, host: hostname(), acquiredAt: Date.now() }));
      } finally {
        closeSync(fd);
      }
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST') throw err;
    }
    if (isLockStale(lockPath)) {
      try { unlinkSync(lockPath); } catch { /* another process took it over first */ }
      continue;
    }
    if (Date.now() > deadline) {
      const owner = readOwner(lockPath);
      throw new Error(
        `Timed out waiting for the board lock at ${lockPath}` +
        (owner ? ` (held by pid ${owner.pid} on ${owner.host})` : ''),
      );
    }
    sleepSync(RETRY_SLEEP_MS);
  }
}

function release(specsDir: string): void {
  const lockPath = join(specsDir, BOARD_LOCK_FILE);
  const owner = readOwner(lockPath);
  // Never delete a lock that was taken over from us after going stale.
  if (owner && (owner.pid !== process.pid || owner.host !== hostname())) return;
  try { if (existsSync(lockPath)) unlinkSync(lockPath); } catch { /* best-effort */ }
}

/** Run `fn` while holding the board lock of the `.teamai/` dir `specsDir`. */
export function withBoardLock<T>(specsDir: string, fn: () => T): T {
  const depth = held.get(specsDir) ?? 0;
  if (depth === 0) {
    installExitHandler();
    acquire(specsDir);
  }
  held.set(specsDir, depth + 1);
  try {
    return fn();
  } finally {
    const next = (held.get(specsDir) ?? 1) - 1;
    if (next <= 0) {
      held.delete(specsDir);
      release(specsDir);
    } else {
      held.set(specsDir, next);
    }
  }
}
