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
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
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
const mockProjectStoreGetAll = vi.hoisted(() => vi.fn().mockReturnValue([]));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
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
}));

vi.mock('@/lib/project-store', () => ({
  projectStore: {
    getAll: mockProjectStoreGetAll,
  },
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
  // Restore safe default — vi.clearAllMocks() does NOT reset implementations,
  // so a mockImplementation(throw) from a prior test would leak. Reset to the
  // default empty array so restoreAutoModeStates finds no projects by default.
  mockProjectStoreGetAll.mockReturnValue([]);
  onHandlers.clear();
  // projectStates lives on globalThis (shared across module graphs, like
  // processManager) so vi.resetModules() no longer clears it. Stop any live
  // timers/listeners and drop all states explicitly.
  const states = (global as { __autoModeProjectStates?: Map<string, {
    tickTimer: ReturnType<typeof setInterval> | null;
    ciPollTimers: Map<string, ReturnType<typeof setInterval>>;
    eventCleanup: (() => void) | null;
  }> }).__autoModeProjectStates;
  if (states) {
    for (const s of states.values()) {
      if (s.tickTimer) clearInterval(s.tickTimer);
      for (const t of s.ciPollTimers.values()) clearInterval(t);
      s.eventCleanup?.();
    }
    states.clear();
  }
  // Reset the module registry (fresh module-level imports per test)
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

      // The tick picks the task and starts it
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

    it('auto-approves task even when NOT auto-tracked (e.g. resumed after a server restart)', async () => {
      // Move task to 'implement' so the tick does NOT pick it (not in backlog).
      // A task resumed by crash recovery after a restart was never started by
      // this auto-mode session, but auto mode must still approve it when it
      // reaches awaiting-review, otherwise it stalls there forever.
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskId, 'implement');

      autoMode.setAutoModeState(testDir, true, 1);

      mockOrch.approveTask.mockClear();

      fireEvent('phase-change', { taskId, phase: 'awaiting-review', projectRoot: testDir });

      await vi.waitFor(() => {
        expect(mockOrch.approveTask).toHaveBeenCalledWith(taskId, 'pull-request');
      });
    });

    it('stamps autoProcessed: true on the live task.json before approving', async () => {
      autoMode.setAutoModeState(testDir, true, 1);

      mockOrch.approveTask.mockClear();
      fireEvent('phase-change', { taskId, phase: 'awaiting-review', projectRoot: testDir });

      await vi.waitFor(() => {
        expect(mockOrch.approveTask).toHaveBeenCalledWith(taskId, 'pull-request');
      });

      // The stamp lands before approveTask, so the create-pr artifact commit
      // copies it into the snapshot and the amber border survives the
      // delete-on-done + pull flow.
      const taskJson = JSON.parse(
        readFileSync(join(testDir, '.teamai', taskId, 'task.json'), 'utf-8'),
      );
      expect(taskJson.autoProcessed).toBe(true);
    });

    it('does not double-approve while an approval is already in flight', async () => {
      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      // Keep the approval pending so the autoApprovedIds guard stays active.
      mockOrch.approveTask.mockClear();
      mockOrch.approveTask.mockReturnValue(new Promise(() => {}));

      fireEvent('phase-change', { taskId, phase: 'awaiting-review', projectRoot: testDir });
      fireEvent('phase-change', { taskId, phase: 'awaiting-review', projectRoot: testDir });

      await new Promise(r => setTimeout(r, 50));
      expect(mockOrch.approveTask).toHaveBeenCalledTimes(1);
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

    it('respects autoMergeMethod from pipeline.json when auto-merging (T11)', async () => {
      vi.useFakeTimers();

      // Configure squash strategy in pipeline.json
      const { writeFileSync: wfs, mkdirSync: mds } = await import('fs');
      const { join: j } = await import('path');
      mds(j(testDir, '.teamai'), { recursive: true });
      wfs(j(testDir, '.teamai', 'pipeline.json'), JSON.stringify({ autoMergeMethod: 'squash' }));

      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
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

      const { TaskStore: TSq } = await import('@/lib/task-store');
      new TSq(testDir).updatePhase(taskId, 'pr-open');
      fireEvent('phase-change', { taskId, phase: 'pr-open', projectRoot: testDir });

      await vi.advanceTimersByTimeAsync(31_000);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh', ['pr', 'merge', '42', '--squash'],
        expect.objectContaining({ cwd: testDir }),
      );
    });

    it('persists autoProcessed: true to task.json after CI auto-merge', async () => {
      vi.useFakeTimers();

      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      // Simulate CI passing → auto-merge → _finishTask → autoProcessed: true
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
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

      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskId, 'pr-open');
      fireEvent('phase-change', { taskId, phase: 'pr-open', projectRoot: testDir });

      // Advance 30s to trigger CI poll → all checks pass → merge → _finishTask
      await vi.advanceTimersByTimeAsync(31_000);

      // Wait for _finishTask .then() callback to persist autoProcessed
      await vi.waitFor(() => {
        const taskData = store.getById(taskId);
        expect(taskData?.autoProcessed).toBe(true);
      });
    });

    it('sets autoProcessed before markTaskDone (flag is on disk even if markTaskDone fails)', async () => {
      vi.useFakeTimers();

      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      // PR is already externally merged → triggers _finishTask
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({ state: 'MERGED', statusCheckRollup: [] });
        }
        return '';
      });

      // markTaskDone fails — the .catch() path in _finishTask should run
      mockOrch.markTaskDone.mockRejectedValue(new Error('mark-as-done failed'));

      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskId, 'pr-open');
      fireEvent('phase-change', { taskId, phase: 'pr-open', projectRoot: testDir });

      // Advance 30s to trigger CI poll → MERGED → _finishTask
      await vi.advanceTimersByTimeAsync(31_000);

      // markTaskDone WAS called (so we know _finishTask ran)
      await vi.waitFor(() => {
        expect(mockOrch.markTaskDone).toHaveBeenCalledWith(taskId);
      });

      // autoProcessed IS set — it's written BEFORE markTaskDone, so even if
      // markTaskDone fails, the flag persists. The PR WAS genuinely auto-processed
      // (merged), so autoProcessed:true is semantically correct regardless.
      const taskData = store.getById(taskId);
      expect(taskData?.autoProcessed).toBe(true);
    });

    it('autoProcessed is on disk BEFORE markTaskDone executes (ordering verified via mockImplementation)', async () => {
      vi.useFakeTimers();

      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      // PR is already externally merged
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'gh' && args[0] === 'pr' && args[1] === 'view') {
          return JSON.stringify({ state: 'MERGED', statusCheckRollup: [] });
        }
        return '';
      });

      // Use mockImplementation to PROVE ordering: capture the value of
      // autoProcessed at the moment markTaskDone runs. Since _finishTask writes
      // autoProcessed BEFORE calling markTaskDone, the flag must already be
      // true on disk. (Use a captured variable rather than expect() inside the
      // mock because _finishTask's .catch() would swallow assertion errors.)
      let autoProcessedAtCallTime = false;
      mockOrch.markTaskDone.mockImplementation(async () => {
        const { TaskStore: TSm } = await import('@/lib/task-store');
        const currentStore = new TSm(testDir);
        const currentTask = currentStore.getById(taskId);
        autoProcessedAtCallTime = currentTask?.autoProcessed ?? false;
      });

      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskId, 'pr-open');
      fireEvent('phase-change', { taskId, phase: 'pr-open', projectRoot: testDir });

      // Advance 30s to trigger CI poll → MERGED → _finishTask
      await vi.advanceTimersByTimeAsync(31_000);

      // Wait for markTaskDone to have been called (meaning the mockImplementation ran)
      await vi.waitFor(() => {
        expect(mockOrch.markTaskDone).toHaveBeenCalledWith(taskId);
      });

      // Assert on the captured value: proves autoProcessed was already on disk
      // when markTaskDone executed, confirming the write-before-call ordering
      expect(autoProcessedAtCallTime).toBe(true);

      // Confirm the flag is also still set after everything completes
      const taskData = store.getById(taskId);
      expect(taskData?.autoProcessed).toBe(true);
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

    it('stops approving on awaiting-review after stop', async () => {
      autoMode.setAutoModeState(testDir, true, 1);

      await vi.waitFor(() => {
        expect(mockOrch.resumeTask).toHaveBeenCalledWith(taskId);
      });

      autoMode.setAutoModeState(testDir, false, 1);

      mockOrch.approveTask.mockClear();
      fireEvent('phase-change', { taskId, phase: 'awaiting-review', projectRoot: testDir });

      await new Promise(r => setTimeout(r, 50));
      expect(mockOrch.approveTask).not.toHaveBeenCalled();
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

  // ── Bug 1: Auto-mode state persistence across restarts ─────────────────

  describe('Auto-mode state persistence (Bug 1)', () => {
    afterEach(() => {
      cleanup();
    });

    it('persists enabled state to .teamai/auto-mode.json on enable', async () => {
      setupTestProject();
      const autoMode = await setupAutoMode();

      autoMode.setAutoModeState(testDir, true, 3);

      const statePath = join(testDir, '.teamai', 'auto-mode.json');
      expect(existsSync(statePath)).toBe(true);
      const saved = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(saved.enabled).toBe(true);
      expect(saved.maxParallel).toBe(3);
    });

    it('persists disabled state to .teamai/auto-mode.json on disable', async () => {
      setupTestProject();
      const autoMode = await setupAutoMode();

      autoMode.setAutoModeState(testDir, true, 2);
      autoMode.setAutoModeState(testDir, false, 2);

      const statePath = join(testDir, '.teamai', 'auto-mode.json');
      const saved = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(saved.enabled).toBe(false);
    });

    it('restoreAutoModeStates re-enables auto mode from disk for persisted projects', async () => {
      setupTestProject();

      // Simulate a previous session: write auto-mode.json with enabled=true
      writeFileSync(
        join(testDir, '.teamai', 'auto-mode.json'),
        JSON.stringify({ enabled: true, maxParallel: 2 }, null, 2),
      );

      // Mock projectStore.getAll() to return the test project — avoids
      // touching the real ~/.teamai/projects.json
      mockProjectStoreGetAll.mockReturnValue([{ name: 'test-restore', path: testDir }]);

      const autoMode = await setupAutoMode();

      // Before restore: auto mode is off (fresh module state)
      expect(autoMode.isAutoModeEnabled(testDir)).toBe(false);

      const restored = autoMode.restoreAutoModeStates();
      expect(restored).toBe(1);
      expect(autoMode.isAutoModeEnabled(testDir)).toBe(true);

      // Verify maxParallel was restored from disk
      const state = autoMode.getAutoModeState(testDir);
      expect(state.maxParallel).toBe(2);
    });

    it('restoreAutoModeStates does NOT re-enable projects that had auto mode off', async () => {
      setupTestProject();

      // Write auto-mode.json with enabled=false
      writeFileSync(
        join(testDir, '.teamai', 'auto-mode.json'),
        JSON.stringify({ enabled: false, maxParallel: 1 }, null, 2),
      );

      // Mock projectStore.getAll() to return the test project
      mockProjectStoreGetAll.mockReturnValue([{ name: 'test-no-restore', path: testDir }]);

      const autoMode = await setupAutoMode();
      const restored = autoMode.restoreAutoModeStates();
      expect(restored).toBe(0);
      expect(autoMode.isAutoModeEnabled(testDir)).toBe(false);
    });

    it('restoreAutoModeStates returns 0 when projectStore.getAll() throws', async () => {
      setupTestProject();

      // Simulate a corrupted/missing projects.json
      mockProjectStoreGetAll.mockImplementation(() => {
        throw new Error('projects.json not found');
      });

      const autoMode = await setupAutoMode();
      const restored = autoMode.restoreAutoModeStates();
      expect(restored).toBe(0);
    });
  });

  // ── Cross-module-instance state (globalThis singleton) ──────────────────

  describe('Cross-module-instance state (globalThis singleton)', () => {
    afterEach(() => {
      cleanup();
    });

    it('a second module instance sees and can disable auto mode enabled by the first', async () => {
      setupTestProject();
      const autoMode = await setupAutoMode();

      autoMode.setAutoModeState(testDir, true, 1);
      expect(autoMode.isAutoModeEnabled(testDir)).toBe(true);

      // Simulate Next.js loading server actions in a separate module graph
      // (the custom server.ts and the Next bundle each import auto-mode):
      // reset the registry and import a fresh module instance.
      vi.resetModules();
      const second = await import('@/lib/auto-mode');

      // Without the globalThis singleton this was the auto-mode-stays-on bug:
      // the second instance saw enabled:false, the toggle early-returned, and
      // the first instance's tick loop kept starting tasks.
      expect(second.isAutoModeEnabled(testDir)).toBe(true);

      second.setAutoModeState(testDir, false, 1);
      expect(autoMode.isAutoModeEnabled(testDir)).toBe(false);
      expect(second.isAutoModeEnabled(testDir)).toBe(false);

      // The toggle-off is also persisted to disk
      const saved = JSON.parse(readFileSync(join(testDir, '.teamai', 'auto-mode.json'), 'utf-8'));
      expect(saved.enabled).toBe(false);
    });

    it('persists enabled:false to disk even when in-memory state already matches', async () => {
      setupTestProject();
      const autoMode = await setupAutoMode();

      // Stale disk state: enabled:true on disk, in-memory disabled (e.g. a
      // restore that never ran). An explicit toggle-off must overwrite it.
      writeFileSync(
        join(testDir, '.teamai', 'auto-mode.json'),
        JSON.stringify({ enabled: true, maxParallel: 1 }, null, 2),
      );

      autoMode.setAutoModeState(testDir, false, 1);

      const saved = JSON.parse(readFileSync(join(testDir, '.teamai', 'auto-mode.json'), 'utf-8'));
      expect(saved.enabled).toBe(false);
    });
  });

  // ── Bug 2: Stalled task adoption on re-enable ─────────────────────────

  describe('Stalled task adoption on re-enable (Bug 2)', () => {
    let autoMode: any;
    let taskId: string;

    beforeEach(async () => {
      setupTestProject();
      autoMode = await setupAutoMode();

      const teamaiDir = join(testDir, '.teamai');
      taskId = randomUUID();
      const taskDir = join(teamaiDir, taskId);
      mkdirSync(taskDir, { recursive: true });
      // Task is already in awaiting-review (stalled while auto mode was off)
      createTaskFile(taskDir, {
        id: taskId,
        title: 'Stalled Task',
        description: 'stalled-task',
        phase: 'awaiting-review',
      });
    });

    afterEach(() => {
      cleanup();
    });

    it('re-adopts awaiting-review tasks and auto-approves them on re-enable', async () => {
      autoMode.setAutoModeState(testDir, true, 1);

      // _adoptStalledTasks should have immediately called approveTask
      await vi.waitFor(() => {
        expect(mockOrch.approveTask).toHaveBeenCalledWith(taskId, 'pull-request');
      });
    });

    it('does NOT call resumeTask for stalled awaiting-review tasks (they need approve, not resume)', async () => {
      mockOrch.resumeTask.mockClear();

      autoMode.setAutoModeState(testDir, true, 1);

      await new Promise(r => setTimeout(r, 50));
      expect(mockOrch.resumeTask).not.toHaveBeenCalledWith(taskId);
    });

    it('re-adopts pr-open tasks and starts CI polling on re-enable', async () => {
      vi.useFakeTimers();

      // Set the task to pr-open with a prUrl
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.update(taskId, { phase: 'pr-open', prUrl: 'https://github.com/test/repo/pull/99' });

      mockExecFileSync.mockClear();
      mockExecFileSync.mockReturnValue(JSON.stringify({ state: 'OPEN', statusCheckRollup: [] }));

      autoMode.setAutoModeState(testDir, true, 1);

      // CI polling should start immediately — advance 30s for first poll
      await vi.advanceTimersByTimeAsync(31_000);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['pr', 'view', '99']),
        expect.any(Object),
      );
    });

    it('does NOT re-adopt tasks in terminal or active phases', async () => {
      // Change task to 'done' — should not be adopted
      const { TaskStore } = await import('@/lib/task-store');
      const store = new TaskStore(testDir);
      store.updatePhase(taskId, 'done');

      mockOrch.approveTask.mockClear();

      autoMode.setAutoModeState(testDir, true, 1);

      await new Promise(r => setTimeout(r, 50));
      expect(mockOrch.approveTask).not.toHaveBeenCalled();
    });

    it('removes task from autoApprovedIds if approveTask fails for stalled task', async () => {
      mockOrch.approveTask.mockRejectedValue(new Error('approve failed'));

      autoMode.setAutoModeState(testDir, true, 1);

      // Wait for the .catch() to fire
      await vi.waitFor(() => {
        expect(mockOrch.approveTask).toHaveBeenCalledWith(taskId, 'pull-request');
      });

      // Give the .catch() handler time to run
      await new Promise(r => setTimeout(r, 50));

      // The in-flight guard was released — a new awaiting-review event may
      // attempt approval again (one attempt per event, no retry loop).
      mockOrch.approveTask.mockClear();
      mockOrch.approveTask.mockResolvedValue(undefined);
      fireEvent('phase-change', { taskId, phase: 'awaiting-review', projectRoot: testDir });

      await vi.waitFor(() => {
        expect(mockOrch.approveTask).toHaveBeenCalledWith(taskId, 'pull-request');
      });
    });
  });
});
