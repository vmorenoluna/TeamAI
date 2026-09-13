/**
 * Tests for `retryFailedTask` (lib/task-retry.ts) — the role-refinement
 * watcher's Phase-3 auto-retry path. It must share retryTask/
 * retryTaskWithOptions's pipeline-state-budget reset: a task that failed on
 * a carried counter (e.g. 'Wakeup attempt limit exceeded') must not retry
 * with that counter still intact, or the very next wakeup/deliverable check
 * can trip the same cap almost instantly — even right after a role-refinement
 * fix that correctly addressed the actual root cause.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockMoveTaskToPhase, mockClearPipelineStateFile } = vi.hoisted(() => ({
  mockMoveTaskToPhase: vi.fn().mockResolvedValue(undefined),
  mockClearPipelineStateFile: vi.fn(),
}));

vi.mock('@/lib/process-manager', () => ({
  processManager: {
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    emit: vi.fn(),
    sendMessage: vi.fn(),
    killSession: vi.fn(),
    createSession: vi.fn(),
    getSession: vi.fn(),
    getStaleSessions: vi.fn(() => []),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('@/lib/logger', () => ({
  log: vi.fn(), warn: vi.fn(), error: vi.fn(),
}));

vi.mock('@/lib/orchestrator', () => ({
  getOrchestrator: vi.fn(() => ({
    moveTaskToPhase: mockMoveTaskToPhase,
    clearPipelineStateFile: mockClearPipelineStateFile,
  })),
  detectDefaultBranch: vi.fn(() => 'main'),
}));

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TaskStore } from '@/lib/task-store';
import { retryFailedTask } from '@/lib/task-retry';

const TEST_DIR = join(
  process.cwd(),
  '.teamai-test-task-retry-' + Math.random().toString(36).slice(2, 10),
);

function seedFailedTask(slug: string) {
  const taskDir = join(TEST_DIR, '.teamai', slug);
  mkdirSync(taskDir, { recursive: true });

  const taskId = `task-${slug}`;
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    title: `Failed Task ${slug}`,
    description: 'a failed task for retryFailedTask testing',
    phase: 'failed',
    branch: `feat/${slug}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }, null, 2));

  writeFileSync(join(taskDir, 'events.jsonl'),
    JSON.stringify({ phase: 'implement', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ phase: 'qa-review', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ phase: 'failed', timestamp: new Date().toISOString() }) + '\n',
  );

  // Simulate the carried-over counter from the failed run.
  writeFileSync(join(taskDir, '.pipeline_state.json'), JSON.stringify({
    taskId, phase: 'implement', wakeupAttemptCount: 2,
  }, null, 2));

  return { taskId, taskDir };
}

describe('retryFailedTask', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('clears the pipeline-state budget before resuming', () => {
    const slug = 'auto-retry-clears-budget';
    const { taskId } = seedFailedTask(slug);
    const taskStore = new TaskStore(TEST_DIR);

    retryFailedTask(TEST_DIR, taskId);

    expect(mockClearPipelineStateFile).toHaveBeenCalledWith(taskStore.getDirById(taskId));
    expect(mockMoveTaskToPhase).toHaveBeenCalledWith(taskId, 'qa-review');
  });

  it('is a no-op for a task that is not in the failed phase', () => {
    const slug = 'auto-retry-not-failed';
    const { taskId, taskDir } = seedFailedTask(slug);
    writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
      id: taskId, title: 't', description: 'd', phase: 'implement',
      branch: `feat/${slug}`, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }, null, 2));

    retryFailedTask(TEST_DIR, taskId);

    expect(mockClearPipelineStateFile).not.toHaveBeenCalled();
    expect(mockMoveTaskToPhase).not.toHaveBeenCalled();
  });
});
