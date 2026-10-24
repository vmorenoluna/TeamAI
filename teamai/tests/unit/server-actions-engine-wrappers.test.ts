import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const PROJECT = '/proj';
const engineCall = vi.fn();

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/app/actions/projects', () => ({ getActiveProjectPath: async () => PROJECT }));
vi.mock('@/app/actions/pipeline', () => ({ getPipelineConfig: async () => ({ autoModeMaxParallel: 3 }) }));
vi.mock('@/engine/engine-client', () => ({
  // Honours timeoutMs the way the real host does, so a never-resolving engine still settles.
  engineCall: (method: string, args: unknown[], opts?: { timeoutMs?: number }) => {
    const result = engineCall(method, args, opts);
    if (result !== 'never') return result;
    return new Promise((_resolve, reject) => {
      if (opts?.timeoutMs) setTimeout(() => reject(new EngineTimeoutError()), opts.timeoutMs);
    });
  },
}));
vi.mock('@/lib/task-store', () => ({
  TaskStore: class {
    async getAllAsync() { return [{ id: 't1', phase: 'spec' }, { id: 't2', phase: 'plan' }]; }
    async getEventsAsync() { return []; }
  },
}));

import { revalidatePath } from 'next/cache';
import { EngineTimeoutError, EngineUnavailableError } from '@/engine/protocol';
import * as tasks from '@/app/actions/tasks';
import * as autoMode from '@/app/actions/auto-mode';
import * as terminals from '@/app/actions/terminals';
import * as roleRefinement from '@/app/actions/role-refinement';
import * as containers from '@/app/actions/containers';
import { getBackgroundActionResult } from '@/app/actions/background';
import { getWorkflowTasks } from '@/app/actions/workflow';
import { isRoadmapSessionAlive } from '@/app/actions/roadmap';
import { sendInsightsMessage } from '@/app/actions/insights';

const revalidated = () => vi.mocked(revalidatePath).mock.calls.map(c => c[0]);

describe('server actions are thin engine wrappers (AC7)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const ok = { success: true };
  // [action name, invoke, engine method, params beyond projectPath, engine value, revalidated paths]
  const cases: [string, () => Promise<unknown>, string, Record<string, unknown>, unknown, string[]][] = [
    ['moveTask', () => tasks.moveTask('a', 'plan', 'op'), 'tasks.moveTask', { taskId: 'a', targetPhase: 'plan', operationId: 'op' }, { operationId: 'op' }, ['/']],
    ['deleteTask', () => tasks.deleteTask('a'), 'tasks.deleteTask', { taskId: 'a' }, undefined, ['/']],
    ['bulkDeleteTasks', () => tasks.bulkDeleteTasks(['a', 'b']), 'tasks.bulkDeleteTasks', { taskIds: ['a', 'b'] }, undefined, ['/']],
    ['retryTask', () => tasks.retryTask('a', 'op'), 'tasks.retryTask', { taskId: 'a', operationId: 'op' }, { success: true, operationId: 'op' }, ['/']],
    ['retryTaskWithOptions', () => tasks.retryTaskWithOptions('a', 'qa-review', 'op'), 'tasks.retryTaskWithOptions', { taskId: 'a', phase: 'qa-review', operationId: 'op' }, ok, ['/']],
    ['pauseTask', () => tasks.pauseTask('a'), 'tasks.pauseTask', { taskId: 'a' }, ok, ['/', '/task/a']],
    ['resumeTask', () => tasks.resumeTask('a', 'op'), 'tasks.resumeTask', { taskId: 'a', operationId: 'op' }, ok, ['/', '/task/a']],
    ['stopTask', () => tasks.stopTask('a', 'op'), 'tasks.stopTask', { taskId: 'a', operationId: 'op' }, ok, ['/', '/task/a']],
    ['playTask', () => tasks.playTask('a', 'op'), 'tasks.playTask', { taskId: 'a', operationId: 'op' }, ok, ['/']],
    ['restartCurrentPhase', () => tasks.restartCurrentPhase('a', 'op'), 'tasks.restartCurrentPhase', { taskId: 'a', operationId: 'op' }, ok, ['/', '/task/a']],
    ['runTask', () => tasks.runTask('a', 'op'), 'tasks.runTask', { taskId: 'a', operationId: 'op' }, { operationId: 'op' }, ['/']],
    ['approveTask', () => tasks.approveTask('a', 'pull-request', 'op'), 'tasks.approveTask', { taskId: 'a', strategy: 'pull-request', operationId: 'op' }, ok, ['/']],
    ['markTaskDone', () => tasks.markTaskDone('a', 'op'), 'tasks.markTaskDone', { taskId: 'a', operationId: 'op' }, ok, ['/']],
    ['rejectTask', () => tasks.rejectTask('a', 'fb', 'coder', [1]), 'tasks.rejectTask', { taskId: 'a', feedback: 'fb', target: 'coder', subtaskIds: [1] }, undefined, ['/']],
    ['addDependency', () => tasks.addDependency('a', 'b'), 'tasks.addDependency', { taskId: 'a', depId: 'b' }, undefined, ['/task/a', '/task/b', '/']],
    ['removeDependency', () => tasks.removeDependency('a', 'b'), 'tasks.removeDependency', { taskId: 'a', depId: 'b' }, undefined, ['/task/a', '/task/b', '/']],
    ['addBlock', () => tasks.addBlock('a', 'b'), 'tasks.addBlock', { thisTaskId: 'a', blockedTaskId: 'b' }, undefined, ['/task/a', '/task/b', '/']],
    ['removeBlock', () => tasks.removeBlock('a', 'b'), 'tasks.removeBlock', { thisTaskId: 'a', blockedTaskId: 'b' }, undefined, ['/task/a', '/task/b', '/']],
    ['checkBulkTaskWorktrees', () => tasks.checkBulkTaskWorktrees(['a']), 'tasks.checkBulkTaskWorktrees', { taskIds: ['a'] }, { a: true }, []],
    ['checkTaskWorktree', () => tasks.checkTaskWorktree('a'), 'tasks.checkTaskWorktree', { taskId: 'a' }, { exists: true, path: '/wt' }, []],
    ['deleteTaskWorktree', () => tasks.deleteTaskWorktree('a', 'op'), 'tasks.deleteTaskWorktree', { taskId: 'a', operationId: 'op' }, ok, ['/', '/task/a']],
    ['toggleAutoMode', () => autoMode.toggleAutoMode(true, PROJECT), 'autoMode.toggle', { enabled: true, maxParallel: 3 }, undefined, ['/']],
    ['markAutoReviewed', () => autoMode.markAutoReviewed('a'), 'autoMode.markReviewed', { taskId: 'a' }, undefined, ['/', '/task/a']],
    ['analyzeFailedTask', () => roleRefinement.analyzeFailedTask('a', 'op'), 'roleRefinement.analyzeFailedTask', { taskId: 'a', operationId: 'op' }, { success: true, operationId: 'op' }, ['/', '/task/a']],
    ['setRoleRefinementConfigAction', () => roleRefinement.setRoleRefinementConfigAction({ mode: 'auto' } as never), 'roleRefinement.setRoleRefinementConfigAction', { cfg: { mode: 'auto' } }, undefined, ['/', '/settings']],
    ['applyRefinementAction', () => roleRefinement.applyRefinementAction('s1', { x: 'y' }), 'roleRefinement.applyRefinementAction', { suggestionId: 's1', overrides: { x: 'y' } }, { success: true, sourceTaskId: 'a' }, ['/', '/settings', '/task/a']],
    ['applyAndRetryRefinementAction', () => roleRefinement.applyAndRetryRefinementAction('s1'), 'roleRefinement.applyAndRetryRefinementAction', { suggestionId: 's1', overrides: undefined }, ok, ['/', '/settings']],
    ['dismissRefinementAction', () => roleRefinement.dismissRefinementAction('s1'), 'roleRefinement.dismissRefinementAction', { suggestionId: 's1' }, ok, ['/', '/settings']],
    ['revertRefinementAction', () => roleRefinement.revertRefinementAction('s1'), 'roleRefinement.revertRefinementAction', { suggestionId: 's1' }, ok, ['/', '/settings']],
    ['revalidateContainer', () => containers.revalidateContainer('op'), 'containers.revalidateContainer', { operationId: 'op' }, { operationId: 'op' }, []],
    ['getValidationStatus', () => containers.getValidationStatus(), 'containers.getValidationStatus', {}, { status: 'passed' }, []],
    ['getContainerState', () => containers.getContainerState(), 'containers.getContainerState', {}, { state: 'running' }, []],
    ['getValidationSteps', () => containers.getValidationSteps(), 'containers.getValidationSteps', {}, [], []],
    ['createTerminalSession', () => terminals.createTerminalSession('coder'), 'terminals.create', { role: 'coder' }, 'sess-1', []],
    ['closeTerminalSession', () => terminals.closeTerminalSession('sess-1'), 'terminals.close', { sessionId: 'sess-1' }, undefined, []],
  ];

  it.each(cases)('%s', async (_name, invoke, method, params, engineValue, paths) => {
    engineCall.mockResolvedValue(engineValue);
    await invoke();
    expect(engineCall).toHaveBeenCalledTimes(1);
    const [calledMethod, args] = engineCall.mock.calls[0];
    expect(calledMethod).toBe(method);
    expect(args).toHaveLength(1);
    // terminals.close addresses a session id, which is already globally unique.
    expect(args[0]).toMatchObject(method === 'terminals.close' ? params : { projectPath: PROJECT, ...params });
    expect(revalidated()).toEqual(paths);
  });

  it('createTask forwards the form fields and returns the engine value unchanged', async () => {
    engineCall.mockResolvedValue({ id: 'new' });
    const fd = new FormData();
    fd.set('title', 'T');
    fd.set('description', 'D');
    fd.set('taskType', 'feature');
    expect(await tasks.createTask(fd)).toEqual({ id: 'new' });
    expect(engineCall.mock.calls[0][0]).toBe('tasks.createTask');
    expect(engineCall.mock.calls[0][1][0]).toEqual({ projectPath: PROJECT, title: 'T', description: 'D', taskType: 'feature' });
    expect(revalidated()).toEqual(['/']);
  });

  it('returns the engine value unchanged, including failures (and does not revalidate on failure)', async () => {
    const failure = { success: false, error: 'Approve is already in progress for this task' };
    engineCall.mockResolvedValue(failure);
    expect(await tasks.approveTask('a', 'local-merge')).toBe(failure);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('retryTask delegates to the engine so a failed task is resumed there (AC: retry crosses IPC)', async () => {
    engineCall.mockResolvedValue({ success: true });
    await tasks.retryTask('failed-task');
    expect(engineCall).toHaveBeenCalledWith('tasks.retryTask', [{ projectPath: PROJECT, taskId: 'failed-task', operationId: undefined }], undefined);
  });

  it('session actions forward to sessions.*', async () => {
    engineCall.mockResolvedValue(undefined);
    await sendInsightsMessage('s1', 'hello');
    expect(engineCall).toHaveBeenCalledWith('sessions.send', [{ sessionId: 's1', message: 'hello' }], undefined);
  });

  it('isDockerAvailable and resetDockerAvailability forward to containers.*', async () => {
    engineCall.mockResolvedValueOnce(true);
    expect(await containers.isDockerAvailable()).toBe(true);
    expect(engineCall.mock.calls[0][0]).toBe('containers.isDockerAvailable');
    engineCall.mockResolvedValueOnce(undefined);
    await containers.resetDockerAvailability();
    expect(engineCall.mock.calls[1][0]).toBe('containers.resetDockerAvailability');
  });
});

describe('getBackgroundActionResult degradation (AC8)', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('forwards the operationId and returns the engine result unchanged', async () => {
    engineCall.mockResolvedValue({ status: 'settled', ok: true });
    expect(await getBackgroundActionResult('op1')).toEqual({ status: 'settled', ok: true });
    expect(engineCall.mock.calls[0][0]).toBe('background.getResult');
    expect(engineCall.mock.calls[0][1]).toEqual([{ operationId: 'op1' }]);
  });

  it('returns {status:"unknown"} when the engine is unavailable', async () => {
    engineCall.mockRejectedValue(new EngineUnavailableError());
    expect(await getBackgroundActionResult('op1')).toEqual({ status: 'unknown' });
  });

  it('rethrows EngineTimeoutError so the client poller retries', async () => {
    engineCall.mockRejectedValue(new EngineTimeoutError());
    await expect(getBackgroundActionResult('op1')).rejects.toBeInstanceOf(EngineTimeoutError);
  });

  it('rethrows any other error', async () => {
    engineCall.mockRejectedValue(new Error('boom'));
    await expect(getBackgroundActionResult('op1')).rejects.toThrow('boom');
  });
});

describe('render-path queries never hang a page when the engine never answers (AC16)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    engineCall.mockReturnValue('never');
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('getActiveTerminals resolves to [] within 6 s', async () => {
    const p = terminals.getActiveTerminals();
    await vi.advanceTimersByTimeAsync(6000);
    await expect(p).resolves.toEqual([]);
    expect(engineCall.mock.calls[0][2]?.timeoutMs).toBeLessThanOrEqual(6000);
  });

  it('getWorkflowTasks reports every task isActive:false within 6 s', async () => {
    const p = getWorkflowTasks();
    await vi.advanceTimersByTimeAsync(6000);
    const result = await p;
    expect(result.map(r => r.task.id)).toEqual(['t1', 't2']);
    expect(result.every(r => r.isActive === false)).toBe(true);
    expect(engineCall.mock.calls[0][0]).toBe('orchestrator.getActiveTaskIds');
    expect(engineCall.mock.calls[0][2]?.timeoutMs).toBeLessThanOrEqual(6000);
  });

  it('isRoadmapSessionAlive resolves false within 6 s', async () => {
    const p = isRoadmapSessionAlive('sess-1');
    await vi.advanceTimersByTimeAsync(6000);
    await expect(p).resolves.toBe(false);
    expect(engineCall.mock.calls[0][2]?.timeoutMs).toBeLessThanOrEqual(6000);
  });
});
