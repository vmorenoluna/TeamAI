/**
 * Slow task actions (move/run/stop/approve/mark-done/delete-worktree...) are engine
 * wrappers: the work is started by the handler in the engine process, which owns the
 * background registry, the duplicate guards and the action-result emit (asserted in
 * engine-handlers-tasks.test.ts). Here: the wrapper returns what the engine returns,
 * carries the caller operation id through, and revalidates only when work started.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ engineCall: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../src/app/actions/projects', () => ({ getActiveProjectPath: vi.fn(async () => '/test/project') }));
vi.mock('@/engine/engine-client', () => ({ engineCall: h.engineCall }));

import { revalidatePath } from 'next/cache';
import * as tasks from '@/app/actions/tasks';

const SLOW_ACTIONS = [
  ['stopTask', 'tasks.stopTask', ['t1', 'op']],
  ['approveTask', 'tasks.approveTask', ['t1', 'local-merge', 'op']],
  ['markTaskDone', 'tasks.markTaskDone', ['t1', 'op']],
  ['resumeTask', 'tasks.resumeTask', ['t1', 'op']],
  ['playTask', 'tasks.playTask', ['t1', 'op']],
  ['deleteTaskWorktree', 'tasks.deleteTaskWorktree', ['t1', 'op']],
] as const;

describe('background task action wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each(SLOW_ACTIONS)('%s returns the engine operationId and revalidates', async (name, method, args) => {
    h.engineCall.mockResolvedValue({ success: true, operationId: 'op' });

    const res = await (tasks[name] as (...a: unknown[]) => Promise<unknown>)(...args);

    expect(res).toEqual({ success: true, operationId: 'op' });
    const sent = h.engineCall.mock.calls[0];
    expect(sent[0]).toBe(method);
    expect(sent[1][0]).toMatchObject({ projectPath: '/test/project', taskId: 't1', operationId: 'op' });
    expect(revalidatePath).toHaveBeenCalledWith('/');
  });

  it.each(SLOW_ACTIONS)('%s relays a duplicate-start refusal without revalidating', async (name, _method, args) => {
    h.engineCall.mockResolvedValue({ success: false, error: 'already in progress for this task' });

    const res = await (tasks[name] as (...a: unknown[]) => Promise<unknown>)(...args);

    expect(res).toEqual({ success: false, error: 'already in progress for this task' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('moveTask and runTask return the operationId and revalidate', async () => {
    h.engineCall.mockResolvedValue({ operationId: 'op-m' });

    expect(await tasks.moveTask('t1', 'spec', 'op-m')).toEqual({ operationId: 'op-m' });
    expect(await tasks.runTask('t1', 'op-m')).toEqual({ operationId: 'op-m' });
    expect(h.engineCall).toHaveBeenNthCalledWith(1, 'tasks.moveTask', [{ projectPath: '/test/project', taskId: 't1', targetPhase: 'spec', operationId: 'op-m' }]);
    expect(h.engineCall).toHaveBeenNthCalledWith(2, 'tasks.runTask', [{ projectPath: '/test/project', taskId: 't1', operationId: 'op-m' }]);
    expect(revalidatePath).toHaveBeenCalledWith('/');
  });

  it('a rejected engine call (e.g. a rejected background start) propagates to the caller', async () => {
    h.engineCall.mockRejectedValue(new Error('Task t1 not found'));

    await expect(tasks.runTask('t1')).rejects.toThrow('Task t1 not found');
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
