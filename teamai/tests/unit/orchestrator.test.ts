import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createTestProject } from '../utils/test-project';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyOrch = any; // Access private members for test setup

// We mock the process-manager module before importing orchestrator
vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(),
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
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false })),
  containerManager: {
    getRunningContainer: vi.fn(() => null),
  },
  hostToContainerPath: vi.fn((p: string) => p),
}));

import { getOrchestrator } from '../../src/lib/orchestrator';
import { Orchestrator } from '../../src/lib/orchestrator';
import { processManager } from '../../src/lib/process-manager';

// Helper to create a test project directory with a task
function setupTestProject(): { root: string; taskId: string; clean: () => void } {
  const { root, clean } = createTestProject();
  mkdirSync(join(root, '.teamai'), { recursive: true });

  // Create default pipeline config
  writeFileSync(join(root, '.teamai', 'pipeline.json'), JSON.stringify({
    phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'],
    maxQaAttempts: 3,
    parallelSubtasks: true,
  }));

  const taskId = randomUUID();
  const taskDir = join(root, '.teamai', 'my-test-task');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    title: 'My Test Task',
    description: 'A test task for unit tests',
    phase: 'backlog',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  return { root, taskId, clean };
}

describe('getOrchestrator', () => {
  it('returns the same instance for the same project path (singleton)', () => {
    const orch1 = getOrchestrator('/test/project');
    const orch2 = getOrchestrator('/test/project');
    expect(orch1).toBe(orch2);
  });

  it('returns different instances for different project paths', () => {
    const orch1 = getOrchestrator('/test/project-a');
    const orch2 = getOrchestrator('/test/project-b');
    expect(orch1).not.toBe(orch2);
  });
});

describe('Orchestrator', () => {
  let orch: Orchestrator;
  let testData: ReturnType<typeof setupTestProject>;

  beforeEach(() => {
    vi.clearAllMocks();
    testData = setupTestProject();
    orch = getOrchestrator(testData.root);
  });

  afterEach(() => {
    testData.clean();
  });

  describe('isTaskActive', () => {
    it('returns false for unknown task', () => {
      expect(orch.isTaskActive('nonexistent')).toBe(false);
    });

    it('returns false for a task not currently running', () => {
      // Task exists but is not active (not in the activeTasks set)
      expect(orch.isTaskActive(testData.taskId)).toBe(false);
    });
  });

  describe('cancelPipeline', () => {
    it('does nothing when no pipeline exists for the task', () => {
      expect(() => orch.cancelPipeline('nonexistent')).not.toThrow();
      expect(processManager.killSession).not.toHaveBeenCalled();
    });

    it('calls killSession when pipeline has an active sessionId', () => {
      // Access private pipelines map to set up state
      const pipelines = (orch as AnyOrch).pipelines;
      const pipeline = {
        taskId: testData.taskId,
        description: 'test',
        phase: 'implement',
        specPath: '/test',
        worktreePath: '/test/wt',
        branch: 'feat/test',
        qaAttempt: 0,
        maxQaAttempts: 3,
        sessionId: 'session-abc',
      };
      pipelines.set(testData.taskId, pipeline);
      (orch as AnyOrch).activeTasks.add(testData.taskId);

      orch.cancelPipeline(testData.taskId);

      expect(processManager.killSession).toHaveBeenCalledWith('session-abc');
      expect(pipelines.has(testData.taskId)).toBe(false);
    });
  });

  describe('moveTaskToPhase', () => {
    it('throws for nonexistent task', async () => {
      await expect(orch.moveTaskToPhase('nonexistent', 'spec')).rejects.toThrow('not found');
    });

    it('handles done phase as a no-run phase without spawning', async () => {
      await orch.moveTaskToPhase(testData.taskId, 'done');

      // Should have emitted phase-change
      expect(processManager.emit).toHaveBeenCalledWith('phase-change', {
        taskId: testData.taskId,
        phase: 'done',
      });

      vi.mocked(processManager.emit).mockClear();

      await orch.moveTaskToPhase(testData.taskId, 'backlog');
      expect(processManager.emit).toHaveBeenCalledWith('phase-change', {
        taskId: testData.taskId,
        phase: 'backlog',
      });
    });
  });

  describe('approveTask', () => {
    it('throws when task is not awaiting review', async () => {
      await expect(orch.approveTask(testData.taskId, 'local-merge')).rejects.toThrow('not awaiting review');
    });
  });

  describe('rejectTask', () => {
    it('throws when task is not awaiting review', async () => {
      await expect(orch.rejectTask(testData.taskId, 'Needs more work')).rejects.toThrow('not awaiting review');
    });
  });

  // ── Private method coverage (via AnyOrch) ──

  describe('getWorktreeBase', () => {
    it('returns ..\worktrees path when container is disabled', () => {
      const base = (orch as AnyOrch).getWorktreeBase();
      expect(base).toContain('worktrees');
      expect(base).not.toContain('.worktrees');
    });
  });

  describe('sessionOpts', () => {
    it('returns session options object with expected shape', () => {
      const opts = (orch as AnyOrch).sessionOpts('coder', '/test/cwd', 'task-1', '/test/log.txt');
      expect(opts.taskId).toBe('task-1');
      expect(opts.role).toBe('coder');
      expect(opts.cwd).toBe('/test/cwd');
      expect(opts.permissionMode).toBe('bypassPermissions');
      expect(opts.logFile).toBe('/test/log.txt');
    });

    it('omits logFile when not provided', () => {
      const opts = (orch as AnyOrch).sessionOpts('planner', '/cwd', 'task-2');
      expect(opts.logFile).toBeUndefined();
    });
  });

  describe('_phaseHeader', () => {
    it('writes phase header to log file without throwing', () => {
      const logFile = join(testData.root, '.teamai', 'test-output.log');
      expect(() => (orch as AnyOrch)._phaseHeader(logFile, 'spec')).not.toThrow();
    });
  });

  describe('advancePhase', () => {
    it('updates phase and emits', () => {
      const pipeline = {
        taskId: testData.taskId,
        description: 'test',
        phase: 'spec',
        specPath: '/test',
        worktreePath: '/test/wt',
        branch: 'feat/test',
        qaAttempt: 0,
        maxQaAttempts: 3,
      };

      (orch as AnyOrch).advancePhase(pipeline, 'plan');

      expect(pipeline.phase).toBe('plan');
      expect(processManager.emit).toHaveBeenCalledWith('phase-change', {
        taskId: testData.taskId,
        phase: 'plan',
      });
    });
  });

  describe('_toAgentPath', () => {
    it('returns hostPath unchanged when container is disabled', () => {
      const result = (orch as AnyOrch)._toAgentPath('/test/path');
      expect(result).toBe('/test/path');
    });
  });
});
