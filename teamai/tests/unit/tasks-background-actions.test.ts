/**
 * Server actions that run slow work return before it settles and deliver the
 * outcome over processManager 'action-result' (broadcast to the UI by server.ts).
 * Covers AC1–AC5, AC9, AC10 of the background-actions spec.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

const h = vi.hoisted(() => {
  const never = () => new Promise<never>(() => { /* never settles */ });
  return {
    never,
    task: { id: 't1', phase: 'awaiting-review', branch: 'feat/x', isPaused: false } as Record<string, unknown>,
    approveTask: vi.fn(),
    markTaskDone: vi.fn(),
    cleanupTaskArtifacts: vi.fn(),
    cancelPipeline: vi.fn(),
    moveTaskToPhase: vi.fn(),
    execGitQueued: vi.fn(),
    update: vi.fn(),
    updatePhase: vi.fn(),
  };
});

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/auto-mode', () => ({ retryAutoMerge: vi.fn() }));
vi.mock('../../src/app/actions/projects', () => ({ getActiveProjectPath: vi.fn(async () => '/test/project') }));
vi.mock('@/lib/process-manager', async () => {
  const { EventEmitter: EE } = await import('events');
  return { processManager: new EE() };
});
vi.mock('@/lib/task-retry', () => ({ preRestoreFailedTask: vi.fn(), taskHasSpecConcerns: vi.fn(() => false) }));
vi.mock('@/lib/task-store', () => ({
  TaskStore: class {
    getByIdAsync = vi.fn(async () => h.task);
    getEventsAsync = vi.fn(async () => []);
    getDirByIdAsync = vi.fn(async () => '/test/project/.teamai/t1');
    update = (id: string, patch: Record<string, unknown>) => { h.update(id, patch); Object.assign(h.task, patch); };
    updatePhase = (id: string, phase: string) => { h.updatePhase(id, phase); h.task.phase = phase; };
  },
}));
vi.mock('@/lib/orchestrator', () => ({
  getOrchestrator: vi.fn(() => ({
    approveTask: h.approveTask,
    markTaskDone: h.markTaskDone,
    cleanupTaskArtifacts: h.cleanupTaskArtifacts,
    cancelPipeline: h.cancelPipeline,
    moveTaskToPhase: h.moveTaskToPhase,
    clearPipelineStateFile: vi.fn(),
    getWorktreePath: () => '/test/project/.worktrees/x',
  })),
}));
vi.mock('@/lib/orchestrator/worktree-utils', () => ({
  execGitQueued: h.execGitQueued,
  removeStaleWorktreeRegistration: vi.fn(),
}));
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => true) };
});

import { approveTask, markTaskDone, stopTask, deleteTaskWorktree, retryTask, moveTask } from '@/app/actions/tasks';
import { getBackgroundResult } from '@/lib/background-actions';
import { processManager } from '@/lib/process-manager';

type ActionResult = { operationId: string; action: string; taskId?: string; projectRoot: string; ok: boolean; error?: string };
let events: ActionResult[];
const onResult = (e: ActionResult) => events.push(e);
let T: string;
let seq = 0;
const flush = () => new Promise(resolve => setTimeout(resolve, 0));

describe('background server actions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    events = [];
    (processManager as unknown as EventEmitter).on('action-result', onResult);
    T = `t${++seq}`; // fresh id: never-settling work from earlier tests keeps its duplicate guard
    h.task = { id: T, phase: 'awaiting-review', branch: 'feat/x', isPaused: false };
    h.approveTask.mockImplementation(h.never);
    h.markTaskDone.mockImplementation(h.never);
    h.cleanupTaskArtifacts.mockImplementation(h.never);
    h.execGitQueued.mockImplementation(h.never);
    h.moveTaskToPhase.mockResolvedValue(undefined);
  });
  afterEach(() => {
    (processManager as unknown as EventEmitter).off('action-result', onResult);
  });

  describe('AC1: return before the slow work settles', () => {
    it.each([
      ['approveTask', () => approveTask(T, 'pull-request'), 'awaiting-review'],
      ['markTaskDone', () => markTaskDone(T), 'awaiting-review'],
      ['stopTask', () => stopTask(T), 'implement'],
      ['deleteTaskWorktree', () => deleteTaskWorktree(T), 'done'],
    ])('%s resolves with an operationId while the work is pending', async (_name, call, phase) => {
      h.task.phase = phase;
      const res = await call();
      expect(res.success).toBe(true);
      expect(res.operationId).toBeTruthy();
      expect(getBackgroundResult(res.operationId!).status).toBe('pending');
      expect(events).toEqual([]);
    });
  });

  describe('AC2: validation errors are synchronous and start nothing', () => {
    it('approveTask outside awaiting-review', async () => {
      h.task.phase = 'implement';
      expect(await approveTask(T, 'local-merge')).toEqual({
        success: false, error: 'Task is in phase "implement", not "awaiting-review"',
      });
      await flush();
      expect(h.approveTask).not.toHaveBeenCalled();
      expect(events).toEqual([]);
    });

    it('deleteTaskWorktree without a branch', async () => {
      h.task.branch = undefined;
      expect(await deleteTaskWorktree(T)).toEqual({ success: false, error: 'No branch found for this task' });
      expect(h.execGitQueued).not.toHaveBeenCalled();
    });
  });

  describe('AC3: background rejection reaches the UI as a failure event', () => {
    it('markTaskDone', async () => {
      const msg = 'Cannot mark task done: PR https://x/1 has not been merged yet.';
      h.markTaskDone.mockRejectedValue(new Error(msg));
      expect(await markTaskDone(T, 'op-1')).toEqual({ success: true, operationId: 'op-1' });
      await flush();
      expect(events).toEqual([
        { operationId: 'op-1', action: 'mark-done', taskId: T, projectRoot: '/test/project', ok: false, error: msg },
      ]);
      expect(getBackgroundResult('op-1')).toEqual({ status: 'failed', error: msg });
    });
  });

  describe('AC4: successful tracked work emits ok: true', () => {
    it('deleteTaskWorktree', async () => {
      h.task.phase = 'done';
      h.execGitQueued.mockResolvedValue('');
      await deleteTaskWorktree(T, 'op-2');
      await flush();
      expect(events).toEqual([
        { operationId: 'op-2', action: 'delete-worktree', taskId: T, projectRoot: '/test/project', ok: true },
      ]);
      expect(h.task.branch).toBeUndefined();
    });
  });

  describe('AC5: fire-and-forget starts never turn failure into silent success', () => {
    it('reports a rejected moveTaskToPhase for retryTask and moveTask', async () => {
      h.task.phase = 'failed';
      h.moveTaskToPhase.mockRejectedValue(new Error('boom'));
      const retried = await retryTask(T);
      const moved = await moveTask(T, 'backlog');
      expect(retried.success).toBe(true);
      expect(moved.operationId).toBeTruthy();
      await flush();
      expect(events.map(e => [e.action, e.ok, e.error])).toEqual([
        ['retry', false, 'boom'],
        ['move', false, 'boom'],
      ]);
    });

    it('emits nothing when the work resolves (failure-only)', async () => {
      h.task.phase = 'failed';
      await retryTask(T);
      await moveTask(T, 'backlog');
      await flush();
      expect(events).toEqual([]);
    });
  });

  describe('AC9: stop is safe while its cleanup runs', () => {
    it('pauses synchronously and moves to backlog after cleanup resolves', async () => {
      h.task.phase = 'implement';
      let finish!: () => void;
      h.cleanupTaskArtifacts.mockImplementation(() => new Promise<void>(r => { finish = r; }));
      const phaseChanges: unknown[] = [];
      (processManager as unknown as EventEmitter).on('phase-change', e => phaseChanges.push(e));

      await stopTask(T);
      expect(h.cancelPipeline).toHaveBeenCalledWith(T);
      expect(h.task).toMatchObject({ phase: 'implement', isPaused: true });

      finish();
      await flush();
      expect(h.task).toMatchObject({ phase: 'backlog', isPaused: false });
      expect(phaseChanges).toEqual([{ taskId: T, phase: 'backlog', projectRoot: '/test/project' }]);
    });

    it('stays paused in its phase and reports failure when cleanup rejects', async () => {
      h.task.phase = 'implement';
      h.cleanupTaskArtifacts.mockRejectedValue(new Error('cleanup failed'));
      await stopTask(T, 'op-3');
      await flush();
      expect(h.task).toMatchObject({ phase: 'implement', isPaused: true });
      expect(events).toEqual([
        { operationId: 'op-3', action: 'stop', taskId: T, projectRoot: '/test/project', ok: false, error: 'cleanup failed' },
      ]);
    });
  });

  describe('AC10: duplicate starts are refused', () => {
    it('markTaskDone while one is pending', async () => {
      expect((await markTaskDone(T)).success).toBe(true);
      expect(await markTaskDone(T)).toEqual({ success: false, error: 'Mark done is already in progress for this task' });
      expect(h.markTaskDone).toHaveBeenCalledTimes(1);
    });
  });
});
