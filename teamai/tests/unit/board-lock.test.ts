// @vitest-environment node

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'fs';
import { join } from 'path';
import { tmpdir, hostname } from 'os';
import { withBoardLock, isLockStale, BOARD_LOCK_FILE, STALE_AFTER_MS } from '@/lib/board-lock';

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'teamai-lock-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

/** A pid that is certainly not running. */
const DEAD_PID = 2 ** 22 + 12345;

describe('withBoardLock', () => {
  it('holds the lock file during fn and removes it after', () => {
    const d = tempDir();
    const lockPath = join(d, BOARD_LOCK_FILE);
    const seen = withBoardLock(d, () => JSON.parse(readFileSync(lockPath, 'utf-8')));
    expect(seen.pid).toBe(process.pid);
    expect(existsSync(lockPath)).toBe(false);
  });

  it('releases the lock when fn throws', () => {
    const d = tempDir();
    expect(() => withBoardLock(d, () => { throw new Error('boom'); })).toThrow('boom');
    expect(existsSync(join(d, BOARD_LOCK_FILE))).toBe(false);
  });

  it('is re-entrant within a process', () => {
    const d = tempDir();
    const v = withBoardLock(d, () => withBoardLock(d, () => 42));
    expect(v).toBe(42);
    expect(existsSync(join(d, BOARD_LOCK_FILE))).toBe(false);
  });

  it('takes over a lock left by a dead process (crash)', () => {
    const d = tempDir();
    writeFileSync(join(d, BOARD_LOCK_FILE), JSON.stringify({ pid: DEAD_PID, host: hostname(), acquiredAt: Date.now() }));
    expect(withBoardLock(d, () => 'ran')).toBe('ran');
  });

  it('takes over a lock older than the stale limit (owner unreachable)', () => {
    const d = tempDir();
    writeFileSync(join(d, BOARD_LOCK_FILE), JSON.stringify({
      pid: process.ppid, host: 'another-host', acquiredAt: Date.now() - STALE_AFTER_MS - 1000,
    }));
    expect(withBoardLock(d, () => 'ran')).toBe('ran');
  });
});

describe('isLockStale', () => {
  it('is false for a fresh lock held by a live process', () => {
    const d = tempDir();
    const p = join(d, BOARD_LOCK_FILE);
    writeFileSync(p, JSON.stringify({ pid: process.ppid, host: hostname(), acquiredAt: Date.now() }));
    expect(isLockStale(p)).toBe(false);
  });

  it('judges an unreadable lock by file age', () => {
    const d = tempDir();
    const p = join(d, BOARD_LOCK_FILE);
    writeFileSync(p, '');
    expect(isLockStale(p)).toBe(false);
    const old = (Date.now() - STALE_AFTER_MS - 5000) / 1000;
    utimesSync(p, old, old);
    expect(isLockStale(p)).toBe(true);
  });
});
