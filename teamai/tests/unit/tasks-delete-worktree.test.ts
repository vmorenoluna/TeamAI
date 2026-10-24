/**
 * deleteTaskWorktree is a thin engine wrapper: validation, the queued git removal and its
 * normal → --force → manual fallbacks run in the `tasks.deleteTaskWorktree` handler
 * (engine-handlers-tasks.test.ts). Here: what the wrapper sends and returns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ engineCall: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../src/app/actions/projects', () => ({ getActiveProjectPath: vi.fn(async () => '/test/project') }));
vi.mock('@/engine/engine-client', () => ({ engineCall: h.engineCall }));

import { revalidatePath } from 'next/cache';
import { deleteTaskWorktree, checkTaskWorktree, checkBulkTaskWorktrees } from '@/app/actions/tasks';

describe('deleteTaskWorktree wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards the project, task and operation id and revalidates on success', async () => {
    h.engineCall.mockResolvedValue({ success: true, operationId: 'op-1' });

    const res = await deleteTaskWorktree('t1', 'op-1');

    expect(res).toEqual({ success: true, operationId: 'op-1' });
    expect(h.engineCall).toHaveBeenCalledWith('tasks.deleteTaskWorktree', [{ projectPath: '/test/project', taskId: 't1', operationId: 'op-1' }]);
    expect(revalidatePath).toHaveBeenCalledWith('/');
    expect(revalidatePath).toHaveBeenCalledWith('/task/t1');
  });

  it('returns a validation failure unchanged without revalidating', async () => {
    h.engineCall.mockResolvedValue({ success: false, error: 'No branch found for this task' });

    const res = await deleteTaskWorktree('t1');

    expect(res).toEqual({ success: false, error: 'No branch found for this task' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('check actions return the engine value', async () => {
    h.engineCall.mockResolvedValueOnce({ exists: true, path: '/wt' }).mockResolvedValueOnce({ a: true });

    expect(await checkTaskWorktree('a')).toEqual({ exists: true, path: '/wt' });
    expect(await checkBulkTaskWorktrees(['a'])).toEqual({ a: true });
    expect(h.engineCall).toHaveBeenNthCalledWith(1, 'tasks.checkTaskWorktree', [{ projectPath: '/test/project', taskId: 'a' }]);
    expect(h.engineCall).toHaveBeenNthCalledWith(2, 'tasks.checkBulkTaskWorktrees', [{ projectPath: '/test/project', taskIds: ['a'] }]);
  });
});
