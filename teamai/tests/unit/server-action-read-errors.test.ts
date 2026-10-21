/**
 * A rejected TaskStore read in a server action surfaces as the action's
 * `{ success: false, error }` result — never a rejected action (a hung or
 * blank UI) and never an orchestrator call on data that could not be read.
 *
 *   AC6: retryTask on a getByIdAsync or getDirByIdAsync rejection.
 *   AC7: every other task-control action on a getByIdAsync rejection.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockMoveTaskToPhase, mockRunTask, mockResumeTask, mockCancelPipeline, mockRetryAutoMerge } = vi.hoisted(() => ({
  mockMoveTaskToPhase: vi.fn().mockResolvedValue(undefined),
  mockRunTask: vi.fn().mockResolvedValue(undefined),
  mockResumeTask: vi.fn().mockResolvedValue(undefined),
  mockCancelPipeline: vi.fn(),
  mockRetryAutoMerge: vi.fn(),
}));

vi.mock('@/lib/auto-mode', () => ({ retryAutoMerge: mockRetryAutoMerge }));

let mockProjectPath = '/test/project';

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: vi.fn((name: string) => (name === 'activeProject' ? { value: mockProjectPath } : undefined)),
    set: vi.fn(),
    delete: vi.fn(),
  })),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

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

vi.mock('@/lib/logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));

vi.mock('@/lib/orchestrator', () => ({
  getOrchestrator: vi.fn(() => ({
    moveTaskToPhase: mockMoveTaskToPhase,
    clearPipelineStateFile: vi.fn(),
    cancelPipeline: mockCancelPipeline,
    runTask: mockRunTask,
    resumeTask: mockResumeTask,
    cleanupTaskArtifacts: vi.fn(),
    approveTask: vi.fn(),
    rejectTask: vi.fn(),
    getWorktreePath: vi.fn(),
  })),
  detectDefaultBranch: vi.fn(async () => 'main'),
}));

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { TaskStore } from '@/lib/task-store';
import {
  retryTask, retryTaskWithOptions, pauseTask, resumeTask, stopTask, playTask, restartCurrentPhase,
} from '@/app/actions/tasks';
import { analyzeFailedTask } from '@/app/actions/role-refinement';

const READ_ERROR = 'EIO: i/o error, read';

let testDir: string;
const taskId = 'task-read-errors';

function seedFailedTask() {
  const taskDir = join(testDir, '.teamai', 'read-errors');
  mkdirSync(taskDir, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId, title: 'Failed Task', description: 'a failed task', phase: 'failed',
    branch: 'feat/read-errors', createdAt: now, updatedAt: now,
  }));
  writeFileSync(join(taskDir, 'events.jsonl'),
    ['backlog', 'spec', 'plan', 'implement', 'qa-review', 'failed']
      .map(phase => JSON.stringify({ phase, timestamp: now }))
      .join('\n') + '\n');
}

describe('server actions return the read error', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    testDir = join(tmpdir(), `teamai-read-errors-${randomUUID().slice(0, 8)}`);
    mkdirSync(testDir, { recursive: true });
    mockProjectPath = testDir;
    seedFailedTask();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
  });

  describe('retryTask (AC6)', () => {
    it('resolves { success: false, error } when getByIdAsync rejects, without moving the task', async () => {
      vi.spyOn(TaskStore.prototype, 'getByIdAsync').mockRejectedValue(new Error(READ_ERROR));

      await expect(retryTask(taskId)).resolves.toEqual({ success: false, error: READ_ERROR });
      expect(mockMoveTaskToPhase).not.toHaveBeenCalled();
    }, 30_000);

    it('resolves { success: false, error } when getDirByIdAsync rejects, without moving the task', async () => {
      vi.spyOn(TaskStore.prototype, 'getDirByIdAsync').mockRejectedValue(new Error(READ_ERROR));

      await expect(retryTask(taskId)).resolves.toEqual({ success: false, error: READ_ERROR });
      expect(mockMoveTaskToPhase).not.toHaveBeenCalled();
    }, 30_000);
  });

  describe('task-control actions (AC7)', () => {
    const actions: Array<[string, () => Promise<{ success: boolean; error?: string }>]> = [
      ['retryTaskWithOptions', () => retryTaskWithOptions(taskId, 'implement')],
      ['pauseTask', () => pauseTask(taskId)],
      ['resumeTask', () => resumeTask(taskId)],
      ['stopTask', () => stopTask(taskId)],
      ['playTask', () => playTask(taskId)],
      ['restartCurrentPhase', () => restartCurrentPhase(taskId)],
      ['analyzeFailedTask', () => analyzeFailedTask(taskId)],
    ];

    it.each(actions)('%s resolves { success: false, error } when getByIdAsync rejects', async (_name, run) => {
      vi.spyOn(TaskStore.prototype, 'getByIdAsync').mockRejectedValue(new Error(READ_ERROR));

      await expect(run()).resolves.toEqual({ success: false, error: READ_ERROR });
      expect(mockMoveTaskToPhase).not.toHaveBeenCalled();
      expect(mockRunTask).not.toHaveBeenCalled();
      expect(mockResumeTask).not.toHaveBeenCalled();
    }, 30_000);
  });
});
