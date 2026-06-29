/**
 * Integration tests for the auto-mode engine.
 *
 * Tests verify:
 *  - Tick loop picks correct tasks from backlog (oldest first, up to maxParallel)
 *  - Dependency blocking works (tasks blocked by unfinished deps are not picked)
 *  - startingIds prevents duplicate picks during tick loop
 *  - Auto-approve fires on awaiting-review phase change
 *  - CI polling starts on pr-open, auto-merges when CI passes, stops on PR close
 *  - Auto mode stop cleans up all timers and listeners
 *
 * Uses real filesystem operations in temporary directories.
 * The processManager, orchestrator, and child_process are mocked.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Hoisted mocks ────────────────────────────────────────────────────────────

const onHandlers = vi.hoisted(() => new Map<string, Array<(...args: any[]) => void>>());
const mockCreateSession = vi.hoisted(() => vi.fn());
const mockSendMessage = vi.hoisted(() => vi.fn());
const mockKillSession = vi.hoisted(() => vi.fn());
const mockEmit = vi.hoisted(() => vi.fn());
const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('@/lib/process-manager', () => ({
  processManager: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    killSession: (...args: unknown[]) => mockKillSession(...args),
    writeToSession: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!onHandlers.has(event)) onHandlers.set(event, []);
      onHandlers.get(event)!.push(handler);
    },
    off: (event: string, handler: (...args: unknown[]) => void) => {
      const handlers = onHandlers.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
    },
    emit: (...args: unknown[]) => mockEmit(...args),
    getSession: vi.fn(),
    getStaleSessions: () => [],
    getAllSessions: () => [],
    removeStaleSession: vi.fn(),
    getTerminalSessions: () => [],
    killTerminalSession: vi.fn(),
    terminateSession: vi.fn(),
  },
  containerSessionOpts: (_projectRoot: string) => ({ projectRoot: _projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('@/lib/container-manager', () => ({
  containerManager: {
    on: vi.fn(),
    off: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn().mockReturnValue('stopped'),
    ensureContainer: vi.fn(),
    getRunningContainer: vi.fn(() => null),
  },
  readContainerConfig: vi.fn().mockReturnValue({ enabled: false }),
  readContainerRemoteUser: vi.fn(() => 'node'),
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => false),
  _resetDockerAvailableCache: vi.fn(),
}));

vi.mock('@/lib/recovery', () => ({
  findInterruptedTasks: () => [],
  findOrphanedWorktrees: () => [],
  startupCleanup: () => ({
    interruptedTasks: [],
    staleSessions: 0,
    orphanedWorktrees: [],
    autoClearedRateLimits: 0,
    artifactInconsistencies: [],
  }),
  autoClearExpiredRateLimits: () => 0,
  reconcileTaskArtifacts: () => [],
  autoResumeInterruptedTasks: vi.fn().mockResolvedValue(0),
  _resetAutoResumeDebounce: () => {},
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

let testDir: string;
/** The orchestrator mock instance (replaced per test via dynamic mock) */
let mockOrch: any;

/** Fire an event to all registered handlers for the given event type */
function fireEvent(event: string, data: any) {
  const handlers = onHandlers.get(event);
  if (handlers) {
    for (const h of [...handlers]) {
      try { h(data); } catch { /* ignore */ }
    }
  }
}

/** Create a task.json file at the given path */
function createTaskFile(
  taskDir: string,
  overrides: Partial<{
    id: string;
    title: string;
    description: string;
    phase: string;
    dependencies: string[];
    prUrl: string | null;
    autoProcessed: boolean;
    autoReviewed: boolean;
    createdAt: string;
    updatedAt: string;
  }> = {},
) {
  const id = overrides.id ?? randomUUID();
  writeFileSync(
    join(taskDir, 'task.json'),
    JSON.stringify({
      id,
      title: overrides.title ?? 'Test Task',
      description: overrides.description ?? `task-${id.slice(0, 6)}`,
      phase: overrides.phase ?? 'backlog',
      dependencies: overrides.dependencies ?? [],
      prUrl: overrides.prUrl,
      autoProcessed: overrides.autoProcessed ?? false,
      autoReviewed: overrides.autoReviewed ?? false,
      createdAt: overrides.createdAt ?? new Date().toISOString(),
      updatedAt: overrides.updatedAt ?? new Date().toISOString(),
    }),
  );
  return id;
}

function setupTestProject() {
  testDir = join(tmpdir(), `teamai-am-${randomUUID().slice(0, 8)}`);
  mkdirSync(testDir, { recursive: true });

  // Default mockExecFileSync: return empty string
  mockExecFileSync.mockReturnValue('');

  // Create pipeline config
  mkdirSync(join(testDir, '.teamai'), { recursive: true });
  writeFileSync(
    join(testDir, '.teamai', 'pipeline.json'),
    JSON.stringify({ maxQaAttempts: 3, parallelSubtasks: true, autoModeMaxParallel: 2 }),
  );

  return testDir;
}

function cleanup() {
  // Always restore real timers — prevents fake-timer leaks between describe blocks
  vi.useRealTimers();
  vi.clearAllMocks();
  onHandlers.clear();
  // Clear module-level state by resetting the auto-mode module
  vi.resetModules();

  if (testDir && existsSync(testDir)) {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** Import auto-mode module and register mock orchestrator */
async function setupAutoMode(): Promise<any> {
  // Create a fresh mock orchestrator for each test
  mockOrch = {
    resumeTask: vi.fn().mockResolvedValue(undefined),
    approveTask: vi.fn().mockResolvedValue(undefined),
    markTaskDone: vi.fn().mockResolvedValue(undefined),
    rejectTask: vi.fn().mockResolvedValue(undefined),
    isTaskActive: vi.fn().mockReturnValue(false),
    cancelPipeline: vi.fn(),
    cleanupTaskArtifacts: vi.fn(),
    moveTaskToPhase: vi.fn(),
    runTask: vi.fn(),
    projectRoot: testDir,
  };

  // Dynamic mock: override getOrchestrator for auto-mode
  vi.doMock('@/lib/orchestrator', () => ({
    getOrchestrator: (_projectRoot: string) => mockOrch,
    Orchestrator: class {},
    detectGitPlatform: vi.fn(() => 'unknown'),
    detectDefaultBranch: vi.fn(() => 'master'),
    buildPlatformPrompt: vi.fn(() => ''),
  }));

  const autoMode = await import('@/lib/auto-mode');
  return autoMode;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Auto Mode Integration', () => {
  describe('Tick loop — task selection', () => {
    let autoMode: any;
    let taskA: string;
    let taskB: string;
    let taskC: string;

    beforeEach(async () => {
      setupTestProject();
      autoMode = await setupAutoMode();

      // Create 3 backlog tasks
      const teamaiDir = join(testDir, '.teamai');

      // Task A — oldest
      const dirA = join(teamaiDir, `task-a`);
      mkdirSync(dirA, { recursive: true });
      taskA = createTaskFile(dirA, {
        title: 'Task A',
        description: 'task-a',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      // Task B — middle
      const dirB = join(teamaiDir, `task-b`);
      mkdirSync(dirB, { recursive: true });
      taskB = createTaskFile(dirB, {
        title: 'Task B',
        description: 'task-b',
        createdAt: '2024-01-02T00:00:00.000Z',
      });

      // Task C — newest
      const dirC = join(teamaiDir, `task-c`);
      mkdirSync(dirC, { recursive: true });
      taskC = createTaskFile(dirC, {
        title: 'Task C',
        description: 'task-c',
        createdAt: '2024-01-03T00:00:00.000Z',
      });
    });

    afterEach(() => {
      cleanup();
    });

    it('picks oldest backlog tasks first when enabling auto mode', async () => {
      autoMode.setAutoModeState(testDir, true, 2);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledTimes(2);
      });

      expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskA);
      expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskB);
      expect(mockOrch.resumeTask).not.toHaveBeenCalledWith(taskC);
    });

    it('respects maxParallel limit (only picks up to N tasks)', async () => {
      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledTimes(1);
      });

      expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskA);
      expect(mockOrch.resumeTask).not.toHaveBeenCalledWith(taskB);
      expect(mockOrch.resumeTask).not.toHaveBeenCalledWith(taskC);
    });

    it('skips tick when no eligible backlog tasks exist', async () => {
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskA, 'done');
      store.updatePhase(taskB, 'done');
      store.updatePhase(taskC, 'done');

      mockOrch.resumeTask.mockClear();

      autoMode.setAutoModeState(testDir, true, 2);

      await new Promise(r => setTimeout(r, 50));

      expect(mockOrch.resumeTask).not.toHaveBeenCalled();
    });

    it('skips tasks that are already in active (non-terminal, non-paused) phases', async () => {
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskB, 'implement');
      store.updatePhase(taskC, 'spec');

      mockOrch.resumeTask.mockClear();

      autoMode.setAutoModeState(testDir, true, 3);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledTimes(1);
      });

      expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskA);
    });

    it('counts paused-phase tasks (awaiting-review, pr-open) as active slots', async () => {
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskB, 'awaiting-review');
      store.updatePhase(taskC, 'pr-open');

      mockOrch.resumeTask.mockClear();

      autoMode.setAutoModeState(testDir, true, 3);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledTimes(1);
      });

      expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskA);
    });
  });

  // ── Dependency Blocking ──────────────────────────────────────────────────

  describe('Dependency blocking', () => {
    let autoMode: any;
    let taskA: string;
    let taskB: string;
    let taskC: string;

    beforeEach(async () => {
      setupTestProject();
      autoMode = await setupAutoMode();

      const teamaiDir = join(testDir, '.teamai');

      const dirA = join(teamaiDir, `task-a`);
      mkdirSync(dirA, { recursive: true });
      taskA = createTaskFile(dirA, {
        title: 'Task A',
        description: 'task-a',
        createdAt: '2024-01-01T00:00:00.000Z',
        dependencies: [],
      });

      const dirB = join(teamaiDir, `task-b`);
      mkdirSync(dirB, { recursive: true });
      taskB = createTaskFile(dirB, {
        title: 'Task B',
        description: 'task-b',
        createdAt: '2024-01-02T00:00:00.000Z',
        dependencies: [taskA],
      });

      const dirC = join(teamaiDir, `task-c`);
      mkdirSync(dirC, { recursive: true });
      taskC = createTaskFile(dirC, {
        title: 'Task C',
        description: 'task-c',
        createdAt: '2024-01-03T00:00:00.000Z',
        dependencies: [taskA, taskB],
      });
    });

    afterEach(() => {
      cleanup();
    });

    it('picks tasks with no dependencies from backlog', async () => {
      autoMode.setAutoModeState(testDir, true, 3);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskA);
      });

      expect(mockOrch.resumeTask).not.toHaveBeenCalledWith(taskB);
      expect(mockOrch.resumeTask).not.toHaveBeenCalledWith(taskC);
    });

    it('picks task when its only dependency is done', async () => {
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskA, 'done');

      mockOrch.resumeTask.mockClear();

      autoMode.setAutoModeState(testDir, true, 2);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledTimes(1);
      });

      expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskB);
      expect(mockOrch.resumeTask).not.toHaveBeenCalledWith(taskC);
    });

    it('picks task when ALL its dependencies are done', async () => {
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskA, 'done');
      store.updatePhase(taskB, 'done');

      mockOrch.resumeTask.mockClear();

      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledTimes(1);
      });

      expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskC);
    });

    it('does not pick task when dep is in progress (not done)', async () => {
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskA, 'implement');

      mockOrch.resumeTask.mockClear();

      autoMode.setAutoModeState(testDir, true, 3);

      // Task A is in 'implement' (active) so not in backlog to be picked.
      // Task B is blocked — A is not done. Task C is blocked — A and B not done.
      // No tasks should be picked.
      await new Promise(r => setTimeout(r, 50));
      expect(mockOrch.resumeTask).not.toHaveBeenCalled();
    });

    it('does not pick task when dep is in awaiting-review (not done)', async () => {
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskA, 'awaiting-review');

      mockOrch.resumeTask.mockClear();

      autoMode.setAutoModeState(testDir, true, 3);

      await new Promise(r => setTimeout(r, 50));
      expect(mockOrch.resumeTask).not.toHaveBeenCalled();
    });

    it('handles task with dependency on non-existent task gracefully', async () => {
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.update(taskB, { dependencies: ['non-existent-id'] });

      mockOrch.resumeTask.mockClear();

      autoMode.setAutoModeState(testDir, true, 3);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskA);
      });

      expect(mockOrch.resumeTask).not.toHaveBeenCalledWith(taskB);
    });

    it('tasks with empty dependencies array are treated as having no deps', async () => {
      autoMode.setAutoModeState(testDir, true, 3);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskA);
      });
    });
  });

  // ── startingIds prevents duplicates ──────────────────────────────────────

  describe('startingIds — duplicate prevention', () => {
    let autoMode: any;
    let taskA: string;
    let taskB: string;

    beforeEach(async () => {
      setupTestProject();
      autoMode = await setupAutoMode();

      const teamaiDir = join(testDir, '.teamai');

      const dirA = join(teamaiDir, `task-a`);
      mkdirSync(dirA, { recursive: true });
      taskA = createTaskFile(dirA, {
        title: 'Task A',
        description: 'task-a',
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      const dirB = join(teamaiDir, `task-b`);
      mkdirSync(dirB, { recursive: true });
      taskB = createTaskFile(dirB, {
        title: 'Task B',
        description: 'task-b',
        createdAt: '2024-01-02T00:00:00.000Z',
      });
    });

    afterEach(() => {
      cleanup();
    });

    it('does not pick the same task twice during tick loop', async () => {
      vi.useFakeTimers();

      // Make resumeTask instantly resolve
      mockOrch.resumeTask.mockResolvedValue(undefined);

      autoMode.setAutoModeState(testDir, true, 2);

      // Immediate tick picks A and B, adding them to startingIds
      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledTimes(2);
      });

      // Clear history
      mockOrch.resumeTask.mockClear();

      // Advance 5s to trigger the next tick interval
      await vi.advanceTimersByTimeAsync(5_001);

      // Tasks are still in startingIds → should NOT be re-picked
      expect(mockOrch.resumeTask).not.toHaveBeenCalled();
    });

    it('removes task from startingIds when it leaves backlog phase', async () => {
      vi.useFakeTimers();

      autoMode.setAutoModeState(testDir, true, 2);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledTimes(2);
      });

      // Simulate Task A's phase change: backlog → spec
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskA, 'spec');
      fireEvent('phase-change', { taskId: taskA, phase: 'spec', projectRoot: testDir });

      // Also mark Task B as spec (both now active)
      store.updatePhase(taskB, 'spec');
      fireEvent('phase-change', { taskId: taskB, phase: 'spec', projectRoot: testDir });

      mockOrch.resumeTask.mockClear();

      // Advance 5s — next tick should see both tasks active (2 slots),
      // so no backlog tasks to pick
      await vi.advanceTimersByTimeAsync(5_001);

      expect(mockOrch.resumeTask).not.toHaveBeenCalled();
    });
  });

  // ── Auto-approve on awaiting-review ──────────────────────────────────────

  describe('Auto-approve on awaiting-review', () => {
    let autoMode: any;
    let taskId: string;

    beforeEach(async () => {
      setupTestProject();
      autoMode = await setupAutoMode();

      const teamaiDir = join(testDir, '.teamai');
      taskId = randomUUID();
      const taskDir = join(teamaiDir, taskId);
      mkdirSync(taskDir, { recursive: true });
      createTaskFile(taskDir, {
        id: taskId,
        title: 'Auto-approve Test',
        description: 'auto-approve-test',
        phase: 'backlog',
      });
    });

    afterEach(() => {
      cleanup();
    });

    it('auto-approves task when it reaches awaiting-review and was auto-tracked', async () => {
      autoMode.setAutoModeState(testDir, true, 1);

      // The tick picks the task and adds to autoTrackedIds
      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      // Simulate phase change to awaiting-review (as if pipeline progressed)
      mockOrch.approveTask.mockClear();
      fireEvent('phase-change', { taskId, phase: 'awaiting-review', projectRoot: testDir });

      await vi.waitFor(() => {
        expect(mockOrch.approveTask).toHaveBeenCalledWith(taskId, 'pull-request');
      });
    });

    it('does NOT auto-approve task that was NOT auto-tracked', async () => {
      // Move task to 'implement' so the tick does NOT pick it (not in backlog).
      // The phase-change listener is still registered, but the task won't be
      // in autoTrackedIds, so approveTask should not fire.
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskId, 'implement');

      autoMode.setAutoModeState(testDir, true, 1);

      mockOrch.approveTask.mockClear();

      fireEvent('phase-change', { taskId, phase: 'awaiting-review', projectRoot: testDir });

      await new Promise(r => setTimeout(r, 50));

      expect(mockOrch.approveTask).not.toHaveBeenCalled();
    });

    it('does NOT auto-approve when auto mode is disabled', async () => {
      mockOrch.approveTask.mockClear();

      fireEvent('phase-change', { taskId, phase: 'awaiting-review', projectRoot: testDir });

      await new Promise(r => setTimeout(r, 50));
      expect(mockOrch.approveTask).not.toHaveBeenCalled();
    });

    it('ignores phase-change events for different project roots', async () => {
      autoMode.setAutoModeState(testDir, true, 1);

      mockOrch.approveTask.mockClear();

      fireEvent('phase-change', {
        taskId,
        phase: 'awaiting-review',
        projectRoot: '/some/other/project',
      });

      await new Promise(r => setTimeout(r, 50));
      expect(mockOrch.approveTask).not.toHaveBeenCalled();
    });
  });

  // ── CI Polling ───────────────────────────────────────────────────────────

  describe('CI Polling', () => {
    let autoMode: any;
    let taskId: string;

    beforeEach(async () => {
      setupTestProject();
      autoMode = await setupAutoMode();

      const teamaiDir = join(testDir, '.teamai');
      taskId = randomUUID();
      const taskDir = join(teamaiDir, taskId);
      mkdirSync(taskDir, { recursive: true });
      createTaskFile(taskDir, {
        id: taskId,
        title: 'CI Test',
        description: 'ci-test',
        phase: 'backlog',
        prUrl: 'https://github.com/test/repo/pull/42',
      });
    });

    afterEach(() => {
      cleanup();
    });

    it('starts CI polling on pr-open phase change for auto-tracked tasks', async () => {
      vi.useFakeTimers();

      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      // Persist pr-open to disk so the CI poll interval callback sees it
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskId, 'pr-open');

      mockExecFileSync.mockClear();

      // Fire the pr-open event (triggers phase-change handler → _startCIPolling)
      fireEvent('phase-change', { taskId, phase: 'pr-open', projectRoot: testDir });

      // Advance 30s to trigger first CI poll
      await vi.advanceTimersByTimeAsync(31_000);

      // gh pr view should have been called to check PR status
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['pr', 'view', '42']),
        expect.any(Object),
      );
    });

    it('auto-merges PR when all CI checks pass', async () => {
      vi.useFakeTimers();

      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            state: 'OPEN',
            statusCheckRollup: [
              { conclusion: 'SUCCESS' },
              { conclusion: 'SUCCESS' },
              { conclusion: 'NEUTRAL' },
            ],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
          return 'Merged pull request #42';
        }
        return '';
      });

      const { TaskStore: TSm } = await import('@/lib/task-store');
      new TSm(testDir).updatePhase(taskId, 'pr-open');
      fireEvent('phase-change', { taskId, phase: 'pr-open', projectRoot: testDir });

      await vi.advanceTimersByTimeAsync(31_000);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh', ['pr', 'merge', '42', '--merge'],
        expect.objectContaining({ cwd: testDir }),
      );
    });

    it('does NOT merge when CI checks are failing', async () => {
      vi.useFakeTimers();

      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({
            state: 'OPEN',
            statusCheckRollup: [
              { conclusion: 'SUCCESS' },
              { conclusion: 'FAILURE' },
            ],
          });
        }
        return '';
      });

      const { TaskStore: TSf } = await import('@/lib/task-store');
      new TSf(testDir).updatePhase(taskId, 'pr-open');
      fireEvent('phase-change', { taskId, phase: 'pr-open', projectRoot: testDir });

      await vi.advanceTimersByTimeAsync(31_000);

      const mergeCalls = mockExecFileSync.mock.calls.filter(
        (c: string[]) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'merge',
      );
      expect(mergeCalls.length).toBe(0);
    });

    it('stops polling when PR is closed (not OPEN)', async () => {
      vi.useFakeTimers();

      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      let viewCallCount = 0;
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          viewCallCount++;
          return JSON.stringify({ state: 'CLOSED', statusCheckRollup: [] });
        }
        return '';
      });

      const { TaskStore: TSc } = await import('@/lib/task-store');
      new TSc(testDir).updatePhase(taskId, 'pr-open');
      fireEvent('phase-change', { taskId, phase: 'pr-open', projectRoot: testDir });

      // First poll
      await vi.advanceTimersByTimeAsync(31_000);
      expect(viewCallCount).toBe(1);

      // Second poll should NOT happen (timer was cleared on CLOSED)
      await vi.advanceTimersByTimeAsync(31_000);
      expect(viewCallCount).toBe(1);

      const mergeCalls = mockExecFileSync.mock.calls.filter(
        (c: string[]) => c[0] === 'gh' && c[1] === 'pr' && c[2] === 'merge',
      );
      expect(mergeCalls.length).toBe(0);
    });

    it('auto-merges when PR is already MERGED (external merge)', async () => {
      vi.useFakeTimers();

      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({ state: 'MERGED', statusCheckRollup: [] });
        }
        return '';
      });

      const { TaskStore: TSmg } = await import('@/lib/task-store');
      new TSmg(testDir).updatePhase(taskId, 'pr-open');
      fireEvent('phase-change', { taskId, phase: 'pr-open', projectRoot: testDir });

      await vi.advanceTimersByTimeAsync(31_000);

      // markTaskDone should have been called (inside _finishTask)
      await vi.waitFor(() => {
        expect(mockOrch.markTaskDone).toHaveBeenCalledWith(taskId);
      });
    });

    it('stops polling when task leaves pr-open phase', async () => {
      vi.useFakeTimers();

      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      let viewCallCount = 0;
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          viewCallCount++;
          return JSON.stringify({ state: 'OPEN', statusCheckRollup: [] });
        }
        return '';
      });

      const { TaskStore: TSph } = await import('@/lib/task-store');
      const store = new TSph(testDir);
      store.updatePhase(taskId, 'pr-open');
      fireEvent('phase-change', { taskId, phase: 'pr-open', projectRoot: testDir });

      // First poll runs
      await vi.advanceTimersByTimeAsync(31_000);
      expect(viewCallCount).toBe(1);

      // Task moves to 'done' (manually merged)
      store.updatePhase(taskId, 'done');

      // Next poll: task no longer in pr-open, polling stops
      await vi.advanceTimersByTimeAsync(31_000);
      expect(viewCallCount).toBe(1);
    });

    it('handles gh CLI errors gracefully (retries on next poll)', async () => {
      vi.useFakeTimers();

      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      let viewCallCount = 0;
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          viewCallCount++;
          if (viewCallCount === 1) {
            throw new Error('gh: command not found');
          }
          return JSON.stringify({
            state: 'OPEN',
            statusCheckRollup: [{ conclusion: 'SUCCESS' }],
          });
        }
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'merge') {
          return 'Merged pull request #42';
        }
        return '';
      });

      const { TaskStore: TSerr } = await import('@/lib/task-store');
      new TSerr(testDir).updatePhase(taskId, 'pr-open');
      fireEvent('phase-change', { taskId, phase: 'pr-open', projectRoot: testDir });

      // First poll fails, second poll succeeds and merges
      await vi.advanceTimersByTimeAsync(31_000);
      await vi.advanceTimersByTimeAsync(31_000);

      expect(viewCallCount).toBe(2);
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh', ['pr', 'merge', '42', '--merge'],
        expect.any(Object),
      );
    });

    it('does NOT start CI polling when task has no prUrl', async () => {
      // Override the task's prUrl to undefined
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.update(taskId, { prUrl: undefined as any });

      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      mockExecFileSync.mockClear();

      fireEvent('phase-change', { taskId, phase: 'pr-open', projectRoot: testDir });

      await new Promise(r => setTimeout(r, 50));

      const ghCalls = mockExecFileSync.mock.calls.filter(
        (c: string[]) => c[0] === 'gh',
      );
      expect(ghCalls.length).toBe(0);
    });
  });

  // ── Auto Mode Stop Cleanup ───────────────────────────────────────────────

  describe('Auto mode stop cleanup', () => {
    let autoMode: any;
    let taskId: string;

    beforeEach(async () => {
      setupTestProject();
      autoMode = await setupAutoMode();

      const teamaiDir = join(testDir, '.teamai');
      taskId = randomUUID();
      const taskDir = join(teamaiDir, taskId);
      mkdirSync(taskDir, { recursive: true });
      createTaskFile(taskDir, {
        id: taskId,
        title: 'Cleanup Test',
        description: 'cleanup-test',
      });
    });

    afterEach(() => {
      cleanup();
    });

    it('disables auto mode and removes phase-change listener', async () => {
      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      expect(autoMode.isAutoModeEnabled(testDir)).toBe(true);

      const phaseChangeHandlers = onHandlers.get('phase-change') ?? [];
      expect(phaseChangeHandlers.length).toBeGreaterThan(0);

      autoMode.setAutoModeState(testDir, false, 1);

      expect(autoMode.isAutoModeEnabled(testDir)).toBe(false);

      const state = autoMode.getAutoModeState(testDir);
      expect(state.enabled).toBe(false);
    });

    it('clears autoTrackedIds on stop', async () => {
      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      const stateBefore = autoMode.getAutoModeState(testDir);
      expect(stateBefore.trackedCount).toBeGreaterThanOrEqual(1);

      autoMode.setAutoModeState(testDir, false, 1);

      const stateAfter = autoMode.getAutoModeState(testDir);
      expect(stateAfter.trackedCount).toBe(0);
    });
  });

  // ── Full end-to-end tick cycle ───────────────────────────────────────────

  describe('Full tick cycle', () => {
    afterEach(() => {
      cleanup();
    });

    it('picks backlog tasks on each tick interval when slots free up', async () => {
      vi.useFakeTimers();

      const dir = join(tmpdir(), `teamai-am2-${randomUUID().slice(0, 8)}`);
      mkdirSync(dir, { recursive: true });
      mkdirSync(join(dir, '.teamai'), { recursive: true });
      writeFileSync(
        join(dir, '.teamai', 'pipeline.json'),
        JSON.stringify({ maxQaAttempts: 3, parallelSubtasks: true, autoModeMaxParallel: 2 }),
      );
      testDir = dir;

      const autoMode = await setupAutoMode();
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(dir);

      // Create 4 backlog tasks
      const tasks: string[] = [];
      for (let i = 0; i < 4; i++) {
        const tId = randomUUID();
        const tDir = join(dir, '.teamai', tId);
        mkdirSync(tDir, { recursive: true });
        createTaskFile(tDir, {
          id: tId,
          title: `Task ${i + 1}`,
          description: `task-${i + 1}`,
          createdAt: `2024-01-0${i + 1}T00:00:00.000Z`,
        });
        tasks.push(tId);
      }

      autoMode.setAutoModeState(dir, true, 2);

      // First tick picks 2 tasks
      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledTimes(2);
      });

      expect(mockOrch.resumeTask).toHaveBeenCalledWith(tasks[0]);
      expect(mockOrch.resumeTask).toHaveBeenCalledWith(tasks[1]);

      // Mark task 0 as 'spec' (leaves startingIds, becomes active — persists to disk)
      store.updatePhase(tasks[0], 'spec');
      fireEvent('phase-change', { taskId: tasks[0], phase: 'spec', projectRoot: dir });
      store.updatePhase(tasks[1], 'spec');
      fireEvent('phase-change', { taskId: tasks[1], phase: 'spec', projectRoot: dir });

      // Both slots are now occupied by active tasks (spec)
      mockOrch.resumeTask.mockClear();

      // Next tick: no tasks should be picked (slots full)
      await vi.advanceTimersByTimeAsync(5_001);
      expect(mockOrch.resumeTask).not.toHaveBeenCalled();

      // Mark task 0 as done (frees a slot), persist to disk
      store.updatePhase(tasks[0], 'done');
      fireEvent('phase-change', { taskId: tasks[0], phase: 'done', projectRoot: dir });

      mockOrch.resumeTask.mockClear();

      await vi.advanceTimersByTimeAsync(5_001);

      // One slot freed — Task 2 should be picked
      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(tasks[2]);
      });
    });
  });
});
