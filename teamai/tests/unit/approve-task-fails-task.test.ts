/**
 * approveTask: a failed approval phase goes through the shared run lifecycle —
 * the task lands in `failed` (so Retry is offered), the run holds the lock while
 * executing, and the error is re-thrown to the caller.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

import { makePipeline, AnyOrch, setupTestProject, makeOrch } from '../utils/orchestrator-harness';

const { onHandlers } = vi.hoisted(() => ({
  onHandlers: new Map<string, Array<(...args: any[]) => void>>(),
}));
const mockExecFileSync = vi.hoisted(() => vi.fn());
const mockExecFile = await vi.hoisted(async () => {
  const { createExecFileMock } = await import('../utils/mock-child-process');
  return createExecFileMock({ resetSafe: true, execFileSync: (...a) => mockExecFileSync(...a) });
});

vi.mock('child_process', async (orig) => {
  const { buildChildProcessMock } = await import('../utils/mock-child-process');
  return { ...buildChildProcessMock(await orig(), mockExecFile), execFileSync: mockExecFileSync };
});

vi.mock('../../src/lib/logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!onHandlers.has(event)) onHandlers.set(event, []);
      onHandlers.get(event)!.push(handler);
    },
    off: vi.fn(),
    emit: vi.fn(),
    createSession: vi.fn(),
    sendMessage: vi.fn(),
    killSession: vi.fn(),
    getSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    getStaleSessions: vi.fn(() => []),
    removeStaleSession: vi.fn(),
    getTerminalSessions: vi.fn(() => []),
    killTerminalSession: vi.fn(),
    writeToSession: vi.fn(),
    terminateSession: vi.fn(),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: { ensureContainer: vi.fn(), getRunningContainer: vi.fn(async () => null) },
  hostToContainerPath: vi.fn((p: string) => p),
  checkDockerAvailable: vi.fn(async () => true),
}));

import { getOrchestrator } from '../../src/lib/orchestrator';
import { TaskAlreadyRunningError } from '../../src/lib/orchestrator/errors';
import { RateLimitError } from '../../src/lib/orchestrator/rate-limit';
import { getResumePhaseForFailedTask } from '../../src/lib/task-utils';

describe('approveTask — failure moves the task to failed', () => {
  let testData: ReturnType<typeof setupTestProject>;
  let orch: AnyOrch;

  beforeEach(() => {
    onHandlers.clear();
    testData = setupTestProject();
    orch = makeOrch(testData.root, getOrchestrator);
    orch.taskStore.update(testData.taskId, { phase: 'awaiting-review' });
    const pipeline = makePipeline({
      taskId: testData.taskId,
      phase: 'awaiting-review',
      specPath: testData.taskDir,
      branch: testData.branchName,
    });
    orch.pipelines.set(testData.taskId, pipeline);
  });

  afterEach(() => {
    testData.clean(onHandlers);
  });

  it('AC7: a rejected create-pr leaves the task failed with failedPhase and a summary, and re-throws', async () => {
    vi.spyOn(orch, 'executePhase').mockRejectedValue(new Error('gh: HTTP 502'));

    await expect(orch.approveTask(testData.taskId, 'pull-request')).rejects.toThrow('gh: HTTP 502');

    const task = orch.taskStore.getById(testData.taskId);
    expect(task.phase).toBe('failed');
    expect(task.failedPhase).toBe('create-pr');
    expect(task.completionSummary).toContain('create-pr phase: gh: HTTP 502');

    const events = orch.taskStore.getEvents(testData.taskId);
    expect(events.some((e: { awaitingReviewReason?: unknown }) => e.awaitingReviewReason !== undefined)).toBe(false);
    expect(getResumePhaseForFailedTask(events)).toBe('create-pr');

    expect(readFileSync(join(testData.taskDir, 'output.log'), 'utf-8')).toContain('[ERROR] Task failed');
    expect(orch.activeTasks.has(testData.taskId)).toBe(false);
  });

  it('AC7: a RateLimitError pauses the task and approveTask resolves', async () => {
    const handleRateLimit = vi.spyOn(orch, 'handleRateLimit').mockImplementation(() => undefined);
    vi.spyOn(orch, 'executePhase').mockRejectedValue(new RateLimitError(Math.floor(Date.now() / 1000) + 60));

    await expect(orch.approveTask(testData.taskId, 'pull-request')).resolves.toBeUndefined();

    expect(handleRateLimit).toHaveBeenCalledTimes(1);
    expect(orch.taskStore.getById(testData.taskId).phase).not.toBe('failed');
  });

  it('AC8: holds the run lock while executing and releases it afterwards', async () => {
    let release!: () => void;
    vi.spyOn(orch, 'executePhase').mockImplementation(() => new Promise<void>((_, reject) => {
      release = () => reject(new Error('gh: HTTP 502'));
    }));

    const approval = orch.approveTask(testData.taskId, 'pull-request');
    const settled = approval.catch(() => undefined);
    await vi.waitFor(() => expect(orch.activeTasks.has(testData.taskId)).toBe(true));

    await expect(orch.runTask(testData.taskId, 'desc')).rejects.toBeInstanceOf(TaskAlreadyRunningError);

    release();
    await expect(approval).rejects.toThrow('gh: HTTP 502');
    await settled;
    expect(orch.activeTasks.has(testData.taskId)).toBe(false);
  });
});
