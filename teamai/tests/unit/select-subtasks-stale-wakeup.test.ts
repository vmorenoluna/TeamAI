// @vitest-environment node

/**
 * Regression test for the QA-rework dispatch bug (task 585a32e0):
 *
 * A stale `wakeupSubtaskId` (set by an earlier wakeup cycle, never cleared
 * because the re-entry completed through a non-wakeup path) combined with
 * the ADR-002 wakeup isolation filter silently emptied the bounce-back
 * subtask selection. runImplement then did zero coder sessions — the log
 * showed only the worktree rebase + "push to remote" — and QA attempts
 * burned down to `failed` with no rework ever dispatched.
 *
 * The fix: isolation is keyed off whether the wakeup subtask is actually
 * still part of this round's selection, not off `wakeupUntil` — every real
 * resume ALSO has `wakeupUntil` already cleared by the time this runs (see
 * orchestrator.ts's `_fireWakeup`), so gating on that field disables
 * isolation for genuine resumes too, not just stale ones (that regression
 * is covered separately by orchestrator-robustness.test.ts's "only
 * re-enters the wakeup subtask — deferred subtasks are excluded"). A stale
 * isolation that matches nothing in this round's selection is dropped (with
 * a log line) instead of silently emptying the selection; one that matches
 * something is still applied, wakeupUntil or not.
 *
 * A second, related staleness mode surfaced on the very same task after it
 * was replanned: the same task's plan.json was scoped-replanned to correct
 * an earlier subtask, resetting it to `completed: false`, while task.json
 * still carried the OLD wakeupSubtaskId pointing at a LATER subtask that
 * depends_on the one just reset. Plain selection-membership isn't enough
 * there — the later subtask is trivially "in" the selection (it was never
 * completed either), so isolation would dispatch it while skipping the
 * dependency the replan just invalidated. Isolation now also requires every
 * depends_on id of the wakeup subtask to be completed in the full plan.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(), off: vi.fn(), emit: vi.fn(), createSession: vi.fn(),
    sendMessage: vi.fn(), killSession: vi.fn(), getSession: vi.fn(),
    getAllSessions: vi.fn(() => []), getStaleSessions: vi.fn(() => []),
    removeStaleSession: vi.fn(), getTerminalSessions: vi.fn(() => []),
    killTerminalSession: vi.fn(), writeToSession: vi.fn(), terminateSession: vi.fn(),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: { ensureContainer: vi.fn(), getRunningContainer: vi.fn(() => null) },
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

import { selectSubtasks } from '../../src/lib/orchestrator/implement';

function setup() {
  const root = join(tmpdir(), `teamai-stale-wakeup-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  mkdirSync(specPath, { recursive: true });

  // All subtasks complete + qa_flagged — the exact state right after a
  // QA FAIL bounce where every subtask was finished pre-review.
  writeFileSync(join(specPath, 'plan.json'), JSON.stringify({
    subtasks: [
      { id: 1, title: 'S1', description: '', files: ['src/a.ts'], acceptance_criteria: ['A works'], depends_on: [], completed: true, qa_flagged: true },
      { id: 2, title: 'S2', description: '', files: ['src/b.ts'], acceptance_criteria: ['B works'], depends_on: [], completed: true },
      { id: 3, title: 'S3', description: '', files: ['src/c.ts'], acceptance_criteria: ['C works'], depends_on: [], completed: true },
    ],
  }));
  writeFileSync(join(specPath, 'qa_feedback.md'), '# QA Feedback\n\n- fix the thing');

  return { root, specPath };
}

function pipeline(specPath: string, extra: Record<string, unknown> = {}) {
  return {
    taskId: 't1',
    description: 'd',
    phase: 'implement',
    specPath,
    worktreePath: join(specPath, '..', 'wt'),
    branch: 'feat/test',
    qaAttempt: 1,
    maxQaAttempts: 3,
    ...extra,
  };
}

describe('selectSubtasks — stale wakeup isolation must not empty the QA-rework selection', () => {
  let root: string;
  let specPath: string;

  beforeEach(() => {
    const ctx = setup();
    root = ctx.root;
    specPath = ctx.specPath;
  });

  afterEach(() => {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('stale wakeupSubtaskId (no pending wakeupUntil) does not filter flagged subtasks', () => {
    const selection = selectSubtasks(
      pipeline(specPath, { wakeupSubtaskId: 2, wakeupUntil: undefined }) as never,
    );
    // Without the fix this filter produced [] → zero coder sessions → the
    // bounce fell straight through to push+QA with no rework dispatched.
    expect(selection.effectiveSubtasks.map(s => s.id)).toEqual([1]);
  });

  it('stale wakeupSubtaskId matching nothing in the selection is dropped, not silently emptying the run', () => {
    const selection = selectSubtasks(
      pipeline(specPath, { wakeupSubtaskId: 2, wakeupUntil: undefined }) as never,
    );
    expect(selection.effectiveSubtasks.length).toBeGreaterThan(0);
  });

  it('active wakeup (wakeupUntil pending) still isolates to the wakeup subtask', () => {
    const selection = selectSubtasks(
      pipeline(specPath, { wakeupSubtaskId: 1, wakeupUntil: '2026-09-01T12:00:00Z' }) as never,
    );
    expect(selection.effectiveSubtasks.map(s => s.id)).toEqual([1]);
  });

  it('no wakeup state at all leaves the QA-flagged selection intact', () => {
    const selection = selectSubtasks(pipeline(specPath) as never);
    expect(selection.effectiveSubtasks.map(s => s.id)).toEqual([1]);
  });

  it('a genuine resume (wakeupUntil already cleared, matching real _fireWakeup behavior) still isolates and excludes deferred subtasks', () => {
    // Shape of pipeline state at the exact moment _fireWakeup re-enters this
    // phase: wakeupUntil already undefined (cleared just before re-entry),
    // wakeupSubtaskId still set, and — unlike the other cases in this file —
    // sibling subtasks that genuinely have NOT started yet (not just
    // already-completed ones). If isolation were skipped here (e.g. by
    // gating on wakeupUntil), subtask 2 would run early instead of staying
    // deferred, which is exactly the regression the wakeupUntil-gated
    // version of this fix introduced.
    const root = join(tmpdir(), `teamai-real-resume-${randomUUID().slice(0, 8)}`);
    const deferredSpecPath = join(root, 'task-slug');
    mkdirSync(deferredSpecPath, { recursive: true });
    writeFileSync(join(deferredSpecPath, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'S1', description: '', files: ['src/a.ts'], acceptance_criteria: ['A works'], depends_on: [], completed: true },
        { id: 2, title: 'S2 (resuming from wakeup)', description: '', files: ['src/b.ts'], acceptance_criteria: ['B works'], depends_on: [], completed: false },
        { id: 3, title: 'S3 (deferred — never started)', description: '', files: ['src/c.ts'], acceptance_criteria: ['C works'], depends_on: [], completed: false },
      ],
    }));

    try {
      const selection = selectSubtasks(
        pipeline(deferredSpecPath, { wakeupSubtaskId: 2, wakeupUntil: undefined }) as never,
      );
      expect(selection.effectiveSubtasks.map(s => s.id)).toEqual([2]);
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('wakeup subtask whose dependency was reset by a replan is treated as stale, not isolated', () => {
    // Shape after a scoped replan corrects an earlier subtask (resetting it
    // to completed: false) while task.json still carries the OLD
    // wakeupSubtaskId pointing at a LATER subtask that depends on it. Every
    // subtask here is `!completed`, so plain selection membership would
    // trivially include subtask 3 — the bug this test guards against is
    // isolating to it anyway and running it before its now-incomplete
    // dependency (subtask 2) has been redone.
    const root = join(tmpdir(), `teamai-replan-stale-${randomUUID().slice(0, 8)}`);
    const replanSpecPath = join(root, 'task-slug');
    mkdirSync(replanSpecPath, { recursive: true });
    writeFileSync(join(replanSpecPath, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'S1', description: '', files: ['src/a.ts'], acceptance_criteria: ['A works'], depends_on: [], completed: true },
        { id: 2, title: 'S2 (reset by replan)', description: '', files: ['src/b.ts'], acceptance_criteria: ['B works'], depends_on: [], completed: false },
        { id: 3, title: 'S3 (stale wakeup target, depends on S2)', description: '', files: ['src/c.ts'], acceptance_criteria: ['C works'], depends_on: [2], completed: false },
      ],
    }));

    try {
      const selection = selectSubtasks(
        pipeline(replanSpecPath, { wakeupSubtaskId: 3, wakeupUntil: undefined }) as never,
      );
      // Isolation is dropped as stale — the full non-completed selection
      // (subtasks 2 and 3, in dependency order via parallel groups) runs
      // instead of isolating to subtask 3 alone.
      expect(selection.effectiveSubtasks.map(s => s.id)).toEqual([2, 3]);
    } finally {
      try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
