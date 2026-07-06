/**
 * Integration tests for rate-limit handling in the orchestrator.
 *
 * Tests simulate a task hitting a Claude API rate limit mid-pipeline and verify:
 *  - The pipeline survives runTask's finally block (rateLimited flag fix)
 *  - rateLimitedUntil is set on the task
 *  - The handleRateLimit setTimeout callback resumes the pipeline correctly
 *  - After resume, the phase advances normally through the pipeline
 *
 * Uses real filesystem operations in a temporary git project.
 * The processManager is mocked so no real Claude sessions are spawned.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockCreateSession = vi.hoisted(() => vi.fn());
const mockSendMessage = vi.hoisted(() => vi.fn());
const mockKillSession = vi.hoisted(() => vi.fn());
const mockOn = vi.hoisted(() => vi.fn());
const mockOff = vi.hoisted(() => vi.fn());
const mockEmit = vi.hoisted(() => vi.fn());
const mockExecFileSync = vi.hoisted(() => vi.fn());

/** Track on/off handlers so tests can simulate events */
const onHandlers = vi.hoisted(() => new Map<string, Array<(...args: unknown[]) => void>>());

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
      return mockOn(event, handler);
    },
    off: (event: string, handler: (...args: unknown[]) => void) => {
      const handlers = onHandlers.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
      return mockOff(event, handler);
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
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
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
let taskId: string;
let taskDir: string;
let orch: any;

/** Fire an event to all registered handlers for the given event type */
function fireEvent(event: string, data: any) {
  const handlers = onHandlers.get(event);
  if (handlers) {
    for (const h of [...handlers]) {
      try { h(data); } catch { /* ignore */ }
    }
  }
}

function setupTestProject() {
  testDir = join(tmpdir(), `teamai-rl-${randomUUID().slice(0, 8)}`);
  mkdirSync(testDir, { recursive: true });

  // Default mockExecFileSync: return empty string for all calls.
  // Tests that need real git (setup below) use realExecFileSync directly.
  // This prevents "not a git repository" errors from _commitArtifactsToWorktree
  // which calls execFileSync('git', ...) directly (not through _execGit).
  mockExecFileSync.mockReturnValue('');

  // Init git repo (needed for worktree operations) — use mockExecFileSync
  // directly since it already returns '' (the try/catch is best-effort).
  try {
    mockExecFileSync('git', ['init'], { cwd: testDir, stdio: 'ignore' });
    mockExecFileSync('git', ['config', 'user.email', 'test@teamai.dev'], { cwd: testDir, stdio: 'ignore' });
    mockExecFileSync('git', ['config', 'user.name', 'TeamAI Test'], { cwd: testDir, stdio: 'ignore' });
    writeFileSync(join(testDir, '.gitkeep'), '');
    mockExecFileSync('git', ['add', '.gitkeep'], { cwd: testDir, stdio: 'ignore' });
    mockExecFileSync('git', ['commit', '-m', 'initial'], { cwd: testDir, stdio: 'ignore' });
  } catch { /* git might not be available in test env */ }

  const teamaiDir = join(testDir, '.teamai');
  mkdirSync(teamaiDir, { recursive: true });

  taskId = randomUUID();
  taskDir = join(teamaiDir, taskId);
  mkdirSync(taskDir, { recursive: true });

  writeFileSync(
    join(teamaiDir, 'pipeline.json'),
    JSON.stringify({
      maxQaAttempts: 3,
      parallelSubtasks: true,
    }),
  );

  writeFileSync(
    join(taskDir, 'task.json'),
    JSON.stringify({
      id: taskId,
      title: 'Rate Limit Test',
      description: 'Integration test for rate limit handling',
      phase: 'backlog',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );

  return { testDir, taskId, taskDir };
}

function cleanup() {
  vi.clearAllMocks();
  onHandlers.clear();

  if (testDir && existsSync(testDir)) {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** Make a minimal pipeline object for testing. */
function makePipeline(overrides: Record<string, any> = {}): any {
  return {
    taskId,
    description: 'test',
    phase: 'spec',
    specPath: taskDir,
    worktreePath: join(testDir, '..', 'worktrees', 'test-slug'),
    branch: 'feat/test-slug',
    qaAttempt: 0,
    maxQaAttempts: 3,
    specRevision: 0,
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Rate Limit Integration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    onHandlers.clear();
    setupTestProject();

    // Write a spec.md so runSpec doesn't trip on a missing file when sending /spec
    writeFileSync(join(taskDir, 'spec.md'), '# Spec for rate limit test\n');

    const mod = await import('@/lib/orchestrator');
    orch = mod.getOrchestrator(testDir);
  });

  afterEach(() => {
    cleanup();
    vi.resetModules();
  });

  // ── Core: finally block survival ─────────────────────────────────────────

  describe('pipeline survival after rate limit in runTask', () => {
    it('pipeline survives runTask finally block after RateLimitError', async () => {
      // Mock createSession so the pipeline can start
      mockCreateSession.mockResolvedValue('sess-rl-survive');

      // Start runTask — it will enter executePhase → runSpec → createSession → waitForCompletion
      const runPromise = orch.runTask(taskId, 'rate limit survival', 'spec').catch(() => {});

      // Wait for session creation and waitForCompletion to be listening
      await new Promise(r => setTimeout(r, 50));

      // Verify createSession was called (pipeline is running)
      expect(mockCreateSession).toHaveBeenCalled();

      // Fire rate limit events to trigger RateLimitError in waitForCompletion
      const future = Math.floor(Date.now() / 1000) + 9999;
      fireEvent('event', {
        sessionId: 'sess-rl-survive',
        event: {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'limited', resetsAt: future },
        },
      });
      fireEvent('event', {
        sessionId: 'sess-rl-survive',
        event: { type: 'result', is_error: true },
      });

      // Wait for error to propagate through catch block → handleRateLimit → finally
      await new Promise(r => setTimeout(r, 50));
      await runPromise;

      // ── Verify pipeline survived the finally block ──
      expect(orch.pipelines.has(taskId)).toBe(true);
      expect(orch.activeTasks.has(taskId)).toBe(true);

      // ── Verify rateLimitedUntil was set by handleRateLimit ──
      const taskStore = orch.taskStore;
      const task = taskStore.getById(taskId);
      expect(task?.rateLimitedUntil).toBeDefined();

      // ── Verify phase-change was emitted with rateLimitedUntil ──
      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId,
        rateLimitedUntil: expect.any(String),
      }));

      // ── Clean up pending setTimeout so it doesn't fire during cleanup ──
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });
  });

  // ── Full resume cycle: setTimeout → executePhase → advancePhase ───────────

  describe('setTimeout resume executes phase correctly', () => {
    it('handleRateLimit setTimeout resumes pipeline and advances phase', async () => {
      // Create a pipeline and manually add it to the maps,
      // simulating that handleRateLimit already re-acquired the lock.
      const pipeline = makePipeline({ phase: 'spec' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'spec' });

      // Mock createSession for the resume
      mockCreateSession.mockResolvedValue('sess-resume');

      // Call handleRateLimit with resetsAt=0 — fires the setTimeout on next tick
      orch.handleRateLimit(pipeline, 0);

      // Wait for setTimeout to fire and executePhase to start
      await new Promise(r => setTimeout(r, 50));

      // executePhase → runSpec → createSession should have been called
      expect(mockCreateSession).toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith('sess-resume', expect.stringContaining('/spec'));

      // Now complete the session — runSpec will advance to plan and cascade
      fireEvent('event', { sessionId: 'sess-resume', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 100));

      // Phase should have advanced from spec → plan
      // (plan would try to create another session, which should have been called)
      expect(pipeline.phase).toBe('plan');

      // rateLimitedUntil should have been cleared
      const task = orch.taskStore.getById(taskId);
      expect(task?.rateLimitedUntil).toBeUndefined();

      // Clean up pipeline entries left by finally block
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });

    it('setTimeout resume advances through full spec→plan cascade', async () => {
      // A more complete test: spec completes → plan starts → we can verify both
      const pipeline = makePipeline({ phase: 'spec' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'spec' });

      // First session: spec phase
      // Second session: plan phase (cascade from advancePhase)
      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-${++sessionCounter}`));

      orch.handleRateLimit(pipeline, 0);

      await new Promise(r => setTimeout(r, 50));

      // Spec session created
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith('sess-1', expect.stringContaining('/spec'));

      // Complete spec session
      fireEvent('event', { sessionId: 'sess-1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 100));

      // Phase advanced to plan; plan is now running (waiting for its result event)
      expect(mockCreateSession).toHaveBeenCalledTimes(2);
      expect(pipeline.phase).toBe('plan'); // spec completed, plan started

      // Clean up
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });

    it('handles double rate limit (nested handleRateLimit call)', async () => {
      // Scenario: task resumes, hits rate limit again, handleRateLimit called recursively
      // This test verifies the nested handleRateLimit flow doesn't crash
      const pipeline = makePipeline({ phase: 'spec' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'spec' });

      let counter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-double-${++counter}`));

      // Track handleRateLimit calls
      let rlCalls = 0;
      const origHandle = orch.handleRateLimit.bind(orch);
      orch.handleRateLimit = (p: any, r: number) => {
        rlCalls++;
        return origHandle(p, r);
      };

      // First rate limit — fires setTimeout immediately
      orch.handleRateLimit(pipeline, 0);

      await new Promise(r => setTimeout(r, 50));

      // First attempt: session created, now fire another rate limit
      fireEvent('event', {
        sessionId: 'sess-double-1',
        event: {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'limited', resetsAt: Math.floor(Date.now() / 1000) + 9999 },
        },
      });
      fireEvent('event', {
        sessionId: 'sess-double-1',
        event: { type: 'result', is_error: true },
      });

      await new Promise(r => setTimeout(r, 50));

      // handleRateLimit should have been called twice (initial + nested)
      expect(rlCalls).toBeGreaterThanOrEqual(2);

      // Pipeline should still be in maps (wasRateLimited=true protects it)
      expect(orch.pipelines.has(taskId)).toBe(true);
      expect(orch.activeTasks.has(taskId)).toBe(true);

      // Clean up
      orch.handleRateLimit = origHandle;
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handleRateLimit skips resume when task was moved to backlog', async () => {
      const pipeline = makePipeline({ phase: 'spec' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'spec' });

      // Mock createSession to verify it's NOT called
      mockCreateSession.mockRejectedValue(new Error('should not be called — resume was skipped'));

      orch.handleRateLimit(pipeline, 0);

      // Before setTimeout fires, move task to backlog
      orch.taskStore.update(taskId, { phase: 'backlog' });

      await new Promise(r => setTimeout(r, 50));

      // createSession should NOT have been called (resume was skipped)
      expect(mockCreateSession).not.toHaveBeenCalled();

      // Pipelines should have been cleaned up by the NO_RESUME_PHASES guard
      expect(orch.pipelines.has(taskId)).toBe(false);
      expect(orch.activeTasks.has(taskId)).toBe(false);

      // rateLimitedUntil should be cleared
      const task = orch.taskStore.getById(taskId);
      expect(task?.rateLimitedUntil).toBeUndefined();
    });

    it('handleRateLimit skips resume when pipeline was replaced (stale guard)', async () => {
      const pipelineA = makePipeline({ phase: 'spec' });
      orch.pipelines.set(taskId, pipelineA);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'spec' });

      // Create a different pipeline object for the same taskId
      const pipelineB = makePipeline({ phase: 'spec' });
      pipelineB._marker = 'replacement';

      mockCreateSession.mockRejectedValue(new Error('should not be called — stale pipeline skipped'));

      orch.handleRateLimit(pipelineA, 0);

      // Replace pipelineA with pipelineB before setTimeout fires
      orch.pipelines.set(taskId, pipelineB);

      await new Promise(r => setTimeout(r, 50));

      // createSession should NOT have been called
      expect(mockCreateSession).not.toHaveBeenCalled();

      // Pipeline B should still be in the map (stale guard doesn't delete it)
      expect(orch.pipelines.get(taskId)).toBe(pipelineB);
      expect(orch.activeTasks.has(taskId)).toBe(true);

      // rateLimitedUntil should be cleared even for stale pipelines
      const task = orch.taskStore.getById(taskId);
      expect(task?.rateLimitedUntil).toBeUndefined();

      // Clean up
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });

    it('handleRateLimit advances to failed on non-rate-limit error during resume', async () => {
      const pipeline = makePipeline({ phase: 'spec' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'spec' });

      // Make createSession throw a regular error (not RateLimitError)
      mockCreateSession.mockRejectedValue(new Error('session creation failed'));

      // Track advancePhase('failed') call
      let failedCalled = false;
      const origAdvance = orch.advancePhase.bind(orch);
      orch.advancePhase = (p: any, phase: string, ...rest: any[]) => {
        if (phase === 'failed') failedCalled = true;
        return origAdvance(p, phase, ...rest);
      };

      try {
        orch.handleRateLimit(pipeline, 0);

        await new Promise(r => setTimeout(r, 50));

        // Should have advanced to 'failed'
        expect(failedCalled).toBe(true);
        expect(pipeline.phase).toBe('failed');

        // Pipeline should be cleaned up (wasRateLimited=false since it's not a rate limit)
        expect(orch.pipelines.has(taskId)).toBe(false);
        expect(orch.activeTasks.has(taskId)).toBe(false);

        // Output log should contain the error
        const logFile = join(taskDir, 'output.log');
        expect(existsSync(logFile)).toBe(true);
        const logContent = readFileSync(logFile, 'utf-8');
        expect(logContent).toContain('ERROR');
      } finally {
        orch.advancePhase = origAdvance;
      }
    });

    it('rate-limited task has rateLimitedUntil persisted to task.json on disk', async () => {
      mockCreateSession.mockResolvedValue('sess-rl-persist');

      const runPromise = orch.runTask(taskId, 'persist test', 'spec').catch(() => {});

      await new Promise(r => setTimeout(r, 50));

      // Fire rate limit events
      fireEvent('event', {
        sessionId: 'sess-rl-persist',
        event: {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'limited', resetsAt: Math.floor(Date.now() / 1000) + 9999 },
        },
      });
      fireEvent('event', {
        sessionId: 'sess-rl-persist',
        event: { type: 'result', is_error: true },
      });

      await new Promise(r => setTimeout(r, 50));
      await runPromise;

      // Read task.json directly from disk to verify persistence
      const taskJson = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf-8'));
      expect(taskJson.rateLimitedUntil).toBeDefined();

      // Clean up
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });
  });

  // ── Rate limit during plan phase ────────────────────────────────────────

  describe('rate limit during plan phase', () => {
    it('pipeline survives rate limit during plan and resumes at plan', async () => {
      // Setup: write plan.json so runPlan doesn't fail reading it after session completes
      writeFileSync(join(taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Test', description: 'Desc', files: ['src/a.ts'], acceptance_criteria: ['ac1'] }],
      }));

      const pipeline = makePipeline({ phase: 'plan' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'plan' });

      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-plan-${++sessionCounter}`));

      // Call handleRateLimit — timeout fires immediately, calls executePhase → runPlan
      orch.handleRateLimit(pipeline, 0);

      await new Promise(r => setTimeout(r, 50));

      // runPlan should have created a session with planner role and /plan command
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith('sess-plan-1', expect.stringContaining('/plan'));

      // Fire rate limit events for the plan session
      fireEvent('event', {
        sessionId: 'sess-plan-1',
        event: {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'limited', resetsAt: Math.floor(Date.now() / 1000) + 9999 },
        },
      });
      fireEvent('event', {
        sessionId: 'sess-plan-1',
        event: { type: 'result', is_error: true },
      });

      await new Promise(r => setTimeout(r, 50));

      // Pipeline should survive — rateLimited flag prevents finally cleanup
      expect(orch.pipelines.has(taskId)).toBe(true);
      expect(orch.activeTasks.has(taskId)).toBe(true);

      // Phase should still be 'plan' (session never completed)
      expect(pipeline.phase).toBe('plan');

      // rateLimitedUntil should be set
      const task = orch.taskStore.getById(taskId);
      expect(task?.rateLimitedUntil).toBeDefined();

      // Clean up
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });

    it('plan resume completes and advances to implement after rate limit clears', { timeout: 10000 }, async () => {
      // Setup: spec.md and plan.json needed for full plan → implement cascade
      writeFileSync(join(taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Test', description: 'Desc', files: ['src/a.ts'], acceptance_criteria: ['ac1'] }],
      }));

      const pipeline = makePipeline({ phase: 'plan' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'plan' });

      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-plan-adv-${++sessionCounter}`));

      orch.handleRateLimit(pipeline, 0);

      await new Promise(r => setTimeout(r, 50));

      // Plan session created
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith('sess-plan-adv-1', expect.stringContaining('/plan'));

      // Complete the plan session — should advance to implement and cascade
      fireEvent('event', { sessionId: 'sess-plan-adv-1', event: { type: 'result' } });

      await new Promise(r => setTimeout(r, 100));

      // Plan advanced to implement — implement phase started
      // Verify cascade: plan session + implement session(s)
      expect(mockCreateSession).toHaveBeenCalledTimes(2);
      expect(pipeline.phase).toBe('implement');

      // rateLimitedUntil should be cleared
      const task = orch.taskStore.getById(taskId);
      expect(task?.rateLimitedUntil).toBeUndefined();

      // Clean up
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });
  });

  // ── Rate limit during implement phase ───────────────────────────────────

  describe('rate limit during implement phase', () => {
    it('pipeline survives rate limit during implement and resumes at implement', async () => {
      // Setup: plan.json with subtasks needed for runImplement
      writeFileSync(join(taskDir, 'plan.json'), JSON.stringify({
        subtasks: [
          { id: 1, title: 'Fix bug', description: 'Fix the thing', files: ['src/a.ts'], acceptance_criteria: ['it works'] },
        ],
      }));

      // Create the worktree directory so runImplement finds it healthy
      mkdirSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true });

      const pipeline = makePipeline({ phase: 'implement' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'implement' });

      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-impl-${++sessionCounter}`));

      // Call handleRateLimit — timeout fires immediately, calls executePhase → runImplement
      orch.handleRateLimit(pipeline, 0);

      await new Promise(r => setTimeout(r, 50));

      // runImplement should have created a coder session for the subtask
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith('sess-impl-1', expect.stringContaining('/implement'));

      // Fire rate limit events for the implement session
      fireEvent('event', {
        sessionId: 'sess-impl-1',
        event: {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'limited', resetsAt: Math.floor(Date.now() / 1000) + 9999 },
        },
      });
      fireEvent('event', {
        sessionId: 'sess-impl-1',
        event: { type: 'result', is_error: true },
      });

      await new Promise(r => setTimeout(r, 50));

      // Pipeline should survive — rateLimited flag prevents finally cleanup
      expect(orch.pipelines.has(taskId)).toBe(true);
      expect(orch.activeTasks.has(taskId)).toBe(true);

      // Phase should still be 'implement' (session never completed)
      expect(pipeline.phase).toBe('implement');

      // rateLimitedUntil should be set
      const task = orch.taskStore.getById(taskId);
      expect(task?.rateLimitedUntil).toBeDefined();

      // Clean up worktree
      try { rmSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true, force: true }); } catch {}
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });

    it('implement phase resume sends correct /implement command to coder', async () => {
      // Setup: plan.json with specific subtask
      writeFileSync(join(taskDir, 'plan.json'), JSON.stringify({
        subtasks: [
          { id: 7, title: 'Add auth', description: 'Implement OAuth2 flow', files: ['src/auth.ts'], acceptance_criteria: ['Users can login', 'Tokens refresh'] },
        ],
      }));

      mkdirSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true });

      const pipeline = makePipeline({ phase: 'implement' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'implement' });

      mockCreateSession.mockResolvedValue('sess-impl-cmd');

      orch.handleRateLimit(pipeline, 0);

      await new Promise(r => setTimeout(r, 50));

      // Verify the coder received the correct /implement command with subtask details
      expect(mockSendMessage).toHaveBeenCalledWith(
        'sess-impl-cmd',
        expect.stringContaining('/implement Subtask 7: Add auth'),
      );
      expect(mockSendMessage).toHaveBeenCalledWith(
        'sess-impl-cmd',
        expect.stringContaining('Implement OAuth2 flow'),
      );
      expect(mockSendMessage).toHaveBeenCalledWith(
        'sess-impl-cmd',
        expect.stringContaining('src/auth.ts'),
      );

      // Clean up
      try { rmSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true, force: true }); } catch {}
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });

    it('implement resume completes subtask and advances to qa-review', { timeout: 10000 }, async () => {
      // Setup: plan.json with one subtask, worktree exists
      writeFileSync(join(taskDir, 'plan.json'), JSON.stringify({
        subtasks: [
          { id: 1, title: 'Simple fix', description: 'Quick fix', files: ['src/fix.ts'], acceptance_criteria: ['works'] },
        ],
      }));

      mkdirSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true });

      const pipeline = makePipeline({ phase: 'implement' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'implement' });

      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-impl-done-${++sessionCounter}`));

      orch.handleRateLimit(pipeline, 0);

      await new Promise(r => setTimeout(r, 50));

      // First session: coder for subtask 1
      expect(mockCreateSession).toHaveBeenCalledTimes(1);

      // Complete the coder session
      fireEvent('event', { sessionId: 'sess-impl-done-1', event: { type: 'result' } });

      // Wait for subtask checkpoint + git push + advance to qa-review
      await new Promise(r => setTimeout(r, 100));

      // After subtask completion, runImplement tries git push.
      // mockExecFileSync returns '' for all calls (including git push),
      // so the push appears to succeed and the pipeline advances to qa-review.
      expect(pipeline.phase).toBe('qa-review');

      // rateLimitedUntil should be cleared
      const task = orch.taskStore.getById(taskId);
      expect(task?.rateLimitedUntil).toBeUndefined();

      // Clean up
      try { rmSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true, force: true }); } catch {}
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });
  });

  // ── Rate limit during qa-review phase ───────────────────────────────────

  describe('rate limit during qa-review phase', () => {
    it('pipeline survives rate limit during qa-review and resumes at qa-review', async () => {
      // Setup: plan.json, spec.md, and worktree needed for runQaReview
      writeFileSync(join(taskDir, 'plan.json'), JSON.stringify({
        subtasks: [
          { id: 1, title: 'Done', description: 'Done', files: ['src/done.ts'], acceptance_criteria: ['works'], completed: true },
        ],
      }));

      // Create the worktree so runQaReview doesn't trip on missing worktree
      mkdirSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true });

      const pipeline = makePipeline({ phase: 'qa-review' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'qa-review' });

      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-qa-${++sessionCounter}`));

      // Call handleRateLimit — timeout fires immediately, calls executePhase → runQaReview
      orch.handleRateLimit(pipeline, 0);

      await new Promise(r => setTimeout(r, 50));

      // runQaReview should have created a session with qa-reviewer role
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith('sess-qa-1', expect.stringContaining('/qa-review'));

      // Fire rate limit events for the qa-review session
      fireEvent('event', {
        sessionId: 'sess-qa-1',
        event: {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'limited', resetsAt: Math.floor(Date.now() / 1000) + 9999 },
        },
      });
      fireEvent('event', {
        sessionId: 'sess-qa-1',
        event: { type: 'result', is_error: true },
      });

      await new Promise(r => setTimeout(r, 50));

      // Pipeline should survive — rateLimited flag prevents finally cleanup
      expect(orch.pipelines.has(taskId)).toBe(true);
      expect(orch.activeTasks.has(taskId)).toBe(true);

      // Phase should still be 'qa-review' (session never completed)
      expect(pipeline.phase).toBe('qa-review');

      // qaAttempt should NOT have been incremented — rate limits are free retries
      expect(pipeline.qaAttempt).toBe(0);

      // rateLimitedUntil should be set
      const task = orch.taskStore.getById(taskId);
      expect(task?.rateLimitedUntil).toBeDefined();

      // Clean up
      try { rmSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true, force: true }); } catch {}
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });

    it('qa-review resume sends correct /qa-review command with spec path', async () => {
      writeFileSync(join(taskDir, 'plan.json'), JSON.stringify({
        subtasks: [
          { id: 1, title: 'Feature', description: 'Implemented', files: ['src/feature.ts'], acceptance_criteria: ['tests pass'], completed: true },
        ],
      }));

      mkdirSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true });

      const pipeline = makePipeline({ phase: 'qa-review' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'qa-review' });

      mockCreateSession.mockResolvedValue('sess-qa-cmd');

      orch.handleRateLimit(pipeline, 0);

      await new Promise(r => setTimeout(r, 50));

      // Verify qa-reviewer received the /qa-review command referencing the spec
      expect(mockSendMessage).toHaveBeenCalledWith(
        'sess-qa-cmd',
        expect.stringContaining('/qa-review'),
      );

      // Complete the session so the promise chain resolves cleanly
      fireEvent('event', { sessionId: 'sess-qa-cmd', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

      // Clean up
      try { rmSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true, force: true }); } catch {}
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });

    it('qaAttempt is NOT incremented on rate-limited qa-review (rate limits are free retries)', async () => {
      writeFileSync(join(taskDir, 'plan.json'), JSON.stringify({
        subtasks: [
          { id: 1, title: 'Retry', description: 'Needs retry', files: ['src/retry.ts'], acceptance_criteria: ['retry works'], completed: true },
        ],
      }));

      mkdirSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true });

      const pipeline = makePipeline({ phase: 'qa-review', qaAttempt: 0 });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'qa-review' });

      // First resume: qaAttempt increments to 1 (at top of runQaReview)
      mockCreateSession.mockResolvedValue('sess-qa-a1');
      orch.handleRateLimit(pipeline, 0);
      await new Promise(r => setTimeout(r, 50));
      // Still 1 here — incremented at top of runQaReview, rate limit hasn't fired yet
      expect(pipeline.qaAttempt).toBe(1);

      // Fire rate limit to trigger nested handleRateLimit
      // runQaReview decrements qaAttempt back (rate limits are free retries)
      fireEvent('event', {
        sessionId: 'sess-qa-a1',
        event: {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'limited', resetsAt: Math.floor(Date.now() / 1000) + 9999 },
        },
      });
      fireEvent('event', {
        sessionId: 'sess-qa-a1',
        event: { type: 'result', is_error: true },
      });
      await new Promise(r => setTimeout(r, 50));

      // Pipeline survived; qaAttempt should be back to 0 (rate limit decremented it)
      expect(pipeline.qaAttempt).toBe(0);
      expect(orch.pipelines.has(taskId)).toBe(true);

      // Clean up
      try { rmSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true, force: true }); } catch {}
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });
  });

  // ── Rate limit during merge phase ───────────────────────────────────────

  describe('rate limit during merge phase', () => {
    it('pipeline survives rate limit during merge and resumes at merge', async () => {
      // Create a real worktree so removeWorktree can clean it up after merge
      mkdirSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true });

      // _commitArtifactsToWorktree now calls execFileSync('git', ...) directly
      // (not through _execGit), so we need mockExecFileSync to handle git calls.
      // Mock _execGit: throw on 'merge' so runMergePhase spawns a merger agent;
      // all other git commands (rebase, removeWorktree, etc.) succeed as no-ops.
      vi.spyOn(orch, '_execGit').mockImplementation((...callArgs: unknown[]) => {
        const gitArgs = callArgs[0] as string[];
        if (gitArgs[0] === 'merge') throw new Error('simulated merge conflict');
      });

      const pipeline = makePipeline({ phase: 'merge' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'merge' });
      // Set branch on task so removeWorktree cleanup works
      orch.taskStore.update(taskId, { branch: 'feat/test-slug' });

      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-merge-${++sessionCounter}`));

      // handleRateLimit timeout fires → executePhase → runMerge
      orch.handleRateLimit(pipeline, 0);

      await new Promise(r => setTimeout(r, 50));

      // runMerge should have created a session with merger role and /merge command
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith('sess-merge-1', expect.stringContaining('/merge'));

      // Fire rate limit events for the merge session
      fireEvent('event', {
        sessionId: 'sess-merge-1',
        event: {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'limited', resetsAt: Math.floor(Date.now() / 1000) + 9999 },
        },
      });
      fireEvent('event', {
        sessionId: 'sess-merge-1',
        event: { type: 'result', is_error: true },
      });

      await new Promise(r => setTimeout(r, 50));

      // Pipeline should survive
      expect(orch.pipelines.has(taskId)).toBe(true);
      expect(orch.activeTasks.has(taskId)).toBe(true);
      expect(pipeline.phase).toBe('merge');

      // rateLimitedUntil should be set
      const task = orch.taskStore.getById(taskId);
      expect(task?.rateLimitedUntil).toBeDefined();

      // Clean up
      try { rmSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true, force: true }); } catch {}
      orch.pipelines.delete(taskId);
      orch.activeTasks.delete(taskId);
    });

    it('merge resume completes and advances to done', async () => {
      mkdirSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true });

      // Mock _execGit: throw on 'merge' so runMergePhase spawns a merger agent;
      // all other git commands (rebase, removeWorktree, etc.) succeed as no-ops.
      vi.spyOn(orch, '_execGit').mockImplementation((...callArgs: unknown[]) => {
        const gitArgs = callArgs[0] as string[];
        if (gitArgs[0] === 'merge') throw new Error('simulated merge conflict');
      });

      const pipeline = makePipeline({ phase: 'merge' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'merge' });
      // Set branch on task so removeWorktree cleanup works
      orch.taskStore.update(taskId, { branch: 'feat/test-slug' });

      mockCreateSession.mockResolvedValue('sess-merge-done');

      orch.handleRateLimit(pipeline, 0);

      await new Promise(r => setTimeout(r, 50));

      expect(mockSendMessage).toHaveBeenCalledWith('sess-merge-done', expect.stringContaining('/merge'));

      // Complete the merge session — advances to 'done' and cleans up worktree
      fireEvent('event', { sessionId: 'sess-merge-done', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 100));

      // Phase should be 'done' after merge completes
      expect(pipeline.phase).toBe('done');

      // rateLimitedUntil cleared
      const task = orch.taskStore.getById(taskId);
      expect(task?.rateLimitedUntil).toBeUndefined();

      // Pipeline cleaned up by finally block
      expect(orch.pipelines.has(taskId)).toBe(false);
      expect(orch.activeTasks.has(taskId)).toBe(false);
    });

    it('merge resume sends correct /merge command with branch name', async () => {
      mkdirSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true });

      // Mock _execGit: throw on 'merge' so runMergePhase spawns a merger agent;
      // all other git commands (rebase, removeWorktree, etc.) succeed as no-ops.
      vi.spyOn(orch, '_execGit').mockImplementation((...callArgs: unknown[]) => {
        const gitArgs = callArgs[0] as string[];
        if (gitArgs[0] === 'merge') throw new Error('simulated merge conflict');
      });

      const pipeline = makePipeline({ phase: 'merge', branch: 'feat/my-feature-branch' });
      orch.pipelines.set(taskId, pipeline);
      orch.activeTasks.add(taskId);
      orch.taskStore.update(taskId, { phase: 'merge' });
      // Set branch on task so removeWorktree cleanup works
      orch.taskStore.update(taskId, { branch: 'feat/my-feature-branch' });

      mockCreateSession.mockResolvedValue('sess-merge-branch');

      orch.handleRateLimit(pipeline, 0);

      await new Promise(r => setTimeout(r, 50));

      // The merger should receive the branch name in the command
      expect(mockSendMessage).toHaveBeenCalledWith(
        'sess-merge-branch',
        expect.stringContaining('/merge feat/my-feature-branch'),
      );

      // Complete the session cleanly
      fireEvent('event', { sessionId: 'sess-merge-branch', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 50));

      // Clean up worktree (already cleaned from maps by finally block after merge→done)
      try { rmSync(join(testDir, '..', 'worktrees', 'test-slug'), { recursive: true, force: true }); } catch {}
    });
  });
});
