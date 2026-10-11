/**
 * Path allocation for per-subtask git worktrees.
 *
 * A subtask worktree's canonical path is `<task worktree>-st<id>`. If a stale
 * directory is still there — a file held open by a scanner or an orphaned
 * process, on any OS — it can't be reliably removed OR renamed, and waiting
 * for the lock is a gamble. So the pipeline never depends on freeing a path:
 * it takes the next free `-r<N>` variant of it instead and remembers the
 * choice. Reclaiming the abandoned directory is best-effort tidying
 * (cleanStaleSubtaskWorktrees, sweepAbandonedWorktreeRemnants at startup),
 * never load-bearing for a run.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import path from 'path';

/** Persisted choice of path per subtask id, so a later pass (wakeup resume,
 *  server restart) finds a relocated worktree instead of the canonical one. */
const SUBTASK_WORKTREES_FILE = 'subtask_worktrees.json';

const MAX_RELOCATION_SUFFIX = 10_000;

/** The canonical (un-relocated) path for a subtask's worktree. */
export function subtaskWorktreeBasePath(taskWorktreePath: string, subtaskId: number): string {
  return `${taskWorktreePath}-st${subtaskId}`;
}

/**
 * The canonical path if nothing occupies it, otherwise the first free
 * `<path>-r<N>` (N >= 2). Never touches the occupying directory.
 */
export function pickFreshSubtaskWorktreePath(
  basePath: string,
  exists: (p: string) => boolean = existsSync,
): string {
  if (!exists(basePath)) return basePath;
  for (let n = 2; n <= MAX_RELOCATION_SUFFIX; n++) {
    const candidate = `${basePath}-r${n}`;
    if (!exists(candidate)) return candidate;
  }
  // Ten thousand abandoned directories is a runaway process, not a lock.
  throw new Error(`No free worktree path for ${basePath} (checked ${MAX_RELOCATION_SUFFIX} variants)`);
}

function readMap(specPath: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path.join(specPath, SUBTASK_WORKTREES_FILE), 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

/** Remember where a subtask's worktree actually lives. Best-effort. */
export function recordSubtaskWorktree(specPath: string, subtaskId: number, worktreePath: string): void {
  try {
    const map = readMap(specPath);
    map[String(subtaskId)] = worktreePath;
    writeFileSync(path.join(specPath, SUBTASK_WORKTREES_FILE), JSON.stringify(map, null, 2));
  } catch { /* best-effort — resume falls back to the canonical path */ }
}

/** Forget all recorded subtask worktrees (their directories are being discarded). */
export function clearSubtaskWorktreeRecord(specPath: string): void {
  try { unlinkSync(path.join(specPath, SUBTASK_WORKTREES_FILE)); } catch { /* absent — fine */ }
}

/**
 * Where a preserved subtask worktree lives: the recorded (possibly relocated)
 * path if it still exists, else the canonical path if it does, else null.
 */
export function resolveSubtaskWorktreePath(
  specPath: string,
  taskWorktreePath: string,
  subtaskId: number,
): string | null {
  const recorded = readMap(specPath)[String(subtaskId)];
  if (recorded && existsSync(recorded)) return recorded;
  const canonical = subtaskWorktreeBasePath(taskWorktreePath, subtaskId);
  return existsSync(canonical) ? canonical : null;
}
