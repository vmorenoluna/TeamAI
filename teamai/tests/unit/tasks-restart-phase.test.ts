/**
 * restartCurrentPhase is a thin engine wrapper: which phases restart and how (qa-review →
 * runTask, implement → plan reset + runTask, spec/plan → moveTaskToPhase) is asserted
 * against the handler in engine-handlers-tasks.test.ts. Here: the wrapper contract.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ engineCall: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('../../src/app/actions/projects', () => ({ getActiveProjectPath: vi.fn(async () => '/test/project') }));
vi.mock('@/engine/engine-client', () => ({ engineCall: h.engineCall }));

import { revalidatePath } from 'next/cache';
import { restartCurrentPhase } from '@/app/actions/tasks';

describe('restartCurrentPhase wrapper', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('forwards to tasks.restartCurrentPhase and revalidates the board and task page', async () => {
    h.engineCall.mockResolvedValue({ success: true, operationId: 'op-2' });

    const res = await restartCurrentPhase('t1', 'op-2');

    expect(res).toEqual({ success: true, operationId: 'op-2' });
    expect(h.engineCall).toHaveBeenCalledWith('tasks.restartCurrentPhase', [{ projectPath: '/test/project', taskId: 't1', operationId: 'op-2' }]);
    expect(revalidatePath).toHaveBeenCalledWith('/');
    expect(revalidatePath).toHaveBeenCalledWith('/task/t1');
  });

  it('returns a refusal unchanged without revalidating', async () => {
    h.engineCall.mockResolvedValue({ success: false, error: 'Cannot restart task in "done" phase' });

    const res = await restartCurrentPhase('t1');

    expect(res).toEqual({ success: false, error: 'Cannot restart task in "done" phase' });
    expect(revalidatePath).not.toHaveBeenCalled();
  });
});
