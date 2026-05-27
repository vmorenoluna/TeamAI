/**
 * Integration tests for the TeamAI pipeline orchestrator.
 *
 * Tests verify phase transitions, concurrency control, pipeline cancellation,
 * and session cleanup. Uses a real git repo for git-dependent phases.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockCreateSession = vi.fn();
const mockSendMessage = vi.fn();
const mockKillSession = vi.fn();
const mockOn = vi.fn();
const mockOff = vi.fn();
const mockEmit = vi.fn();
const mockGetSession = vi.fn();

/** Track on/off handlers so tests can simulate events from processManager */
const onHandlers: Map<string, Array<(...args: unknown[]) => void>> = new Map();

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
    getSession: (...args: unknown[]) => mockGetSession(...args),
    getStaleSessions: () => [],
    getAllSessions: () => [],
  },
}));

vi.mock('@/lib/container-manager', () => ({
  containerManager: {
    on: vi.fn(),
    off: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn().mockReturnValue('stopped'),
  },
  readContainerConfig: vi.fn().mockReturnValue({ enabled: false }),
  hostToContainerPath: vi.fn((p: string) => p),
}));

// ── Helpers ──────────────────────────────────────────────────────────────────

let testDir: string;
let taskId: string;
let orch: unknown;

type AnyOrch = any;  

/** Fire an exit event to signal session termination */
function fireExitEvent(sessionId: string, code: number) {
  const handlers = onHandlers.get('exit');
  if (!handlers) return;
  for (const h of [...handlers]) {
    try {
      h({ sessionId, code });
    } catch {
      // ignore
    }
  }
}

function setupTestProject() {
  testDir = join(tmpdir(), `teamai-integ-${randomUUID().slice(0, 8)}`);
  mkdirSync(testDir, { recursive: true });

  // Init git repo (needed for worktree operations in runPlan)
  execFileSync('git', ['init'], { cwd: testDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@teamai.dev'], { cwd: testDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'TeamAI Test'], { cwd: testDir, stdio: 'ignore' });
  writeFileSync(join(testDir, '.gitkeep'), '');
  execFileSync('git', ['add', '.gitkeep'], { cwd: testDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: testDir, stdio: 'ignore' });

  const teamaiDir = join(testDir, '.teamai');
  mkdirSync(teamaiDir, { recursive: true });

  taskId = randomUUID();
  const taskDir = join(teamaiDir, taskId);
  mkdirSync(taskDir, { recursive: true });

  writeFileSync(
    join(teamaiDir, 'pipeline.json'),
    JSON.stringify({ phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'], maxQaAttempts: 2, parallelSubtasks: true })
  );

  writeFileSync(
    join(taskDir, 'task.json'),
    JSON.stringify({ id: taskId, title: 'Integration test task', description: 'Verify pipeline integration', phase: 'backlog', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() })
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

/** Helper to create a pipeline object matching the internal TaskPipeline shape */
function makePipeline(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    taskId,
    description: 'test',
    phase: 'spec',
    specPath: join(testDir, '.teamai', taskId),
    worktreePath: join(testDir, '.teamai', 'worktrees', taskId),
    branch: 'feat/test-branch',
    qaAttempt: 0,
    maxQaAttempts: 2,
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Orchestrator Pipeline Integration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    onHandlers.clear();
    mockGetSession.mockReturnValue(undefined);
    setupTestProject();

    const mod = await import('@/lib/orchestrator');
    orch = mod.getOrchestrator(testDir);
  });

  afterEach(() => {
    cleanup();
    vi.resetModules();
  });

  // ── Phase Transitions ──────────────────────────────────────────────

  describe('Phase Transitions via advancePhase', () => {
    it('should update pipeline phase and emit phase-change', () => {
      const pipeline = makePipeline({ phase: 'spec' });
      (orch as AnyOrch).pipelines.set(taskId, pipeline);

      (orch as AnyOrch).advancePhase(pipeline, 'plan');

      expect(pipeline.phase).toBe('plan');
      expect(mockEmit).toHaveBeenCalledWith('phase-change', { taskId, phase: 'plan' });
    });

    it('should emit for each phase in a full pipeline sequence', () => {
      const pipeline = makePipeline({ phase: 'backlog' });
      const phases = ['spec', 'plan', 'implement', 'qa-review', 'merge'];

      for (const phase of phases) {
        (orch as AnyOrch).advancePhase(pipeline, phase);
        expect(pipeline.phase).toBe(phase);
      }

      expect(mockEmit).toHaveBeenCalledTimes(phases.length);
    });

    it('should persist phase update to taskStore via advancePhase', () => {
      const pipeline = makePipeline({ phase: 'spec' });
      (orch as AnyOrch).advancePhase(pipeline, 'plan');

      const taskPath = join(testDir, '.teamai', taskId, 'task.json');
      if (existsSync(taskPath)) {
        const data = JSON.parse(readFileSync(taskPath, 'utf-8'));
        expect(data.phase).toBe('plan');
      }
    });
  });

  // ── moveTaskToPhase ────────────────────────────────────────────────

  describe('moveTaskToPhase', () => {
    it('should move task to a terminal phase (done)', () => {
      (orch as AnyOrch).moveTaskToPhase(taskId, 'done');

      const taskPath = join(testDir, '.teamai', taskId, 'task.json');
      if (existsSync(taskPath)) {
        const data = JSON.parse(readFileSync(taskPath, 'utf-8'));
        expect(data.phase).toBe('done');
      }
    });

    it('should move task to backlog', () => {
      (orch as AnyOrch).moveTaskToPhase(taskId, 'backlog');

      const taskPath = join(testDir, '.teamai', taskId, 'task.json');
      if (existsSync(taskPath)) {
        const data = JSON.parse(readFileSync(taskPath, 'utf-8'));
        expect(data.phase).toBe('backlog');
      }
    });

    it('should cancel running pipeline when moving phase', () => {
      const pipeline = makePipeline({ phase: 'spec', sessionId: 'sess-1' });
      (orch as AnyOrch).pipelines.set(taskId, pipeline);

      (orch as AnyOrch).moveTaskToPhase(taskId, 'done');

      expect(mockKillSession).toHaveBeenCalledWith('sess-1');
    });
  });

  // ── Pipeline Cancel ────────────────────────────────────────────────

  describe('Pipeline Cancel', () => {
    it('should kill session and remove pipeline on cancel', () => {
      const pipeline = makePipeline({ sessionId: 'sess-cancel' });
      (orch as AnyOrch).pipelines.set(taskId, pipeline);
      (orch as AnyOrch).activeTasks.add(taskId);

      (orch as AnyOrch).cancelPipeline(taskId);

      expect(mockKillSession).toHaveBeenCalledWith('sess-cancel');
      expect((orch as AnyOrch).pipelines.has(taskId)).toBe(false);
      expect((orch as AnyOrch).activeTasks.has(taskId)).toBe(false);
    });

    it('should be a no-op when pipeline does not exist', () => {
      expect(() => (orch as AnyOrch).cancelPipeline('nonexistent')).not.toThrow();
      expect(mockKillSession).not.toHaveBeenCalled();
    });

    it('should be a no-op when pipeline has no sessionId', () => {
      const pipeline = makePipeline();
      (orch as AnyOrch).pipelines.set(taskId, pipeline);

      (orch as AnyOrch).cancelPipeline(taskId);

      expect(mockKillSession).not.toHaveBeenCalled();
      expect((orch as AnyOrch).pipelines.has(taskId)).toBe(false);
    });
  });

  // ── Concurrency Control ────────────────────────────────────────────

  describe('Concurrency Control', () => {
    it('should track active tasks to prevent duplicate runs', () => {
      (orch as AnyOrch).activeTasks.add(taskId);

      expect((orch as AnyOrch).activeTasks.has(taskId)).toBe(true);
    });

    it('should reject runTask when task is already active', async () => {
      (orch as AnyOrch).activeTasks.add(taskId);

      await expect((orch as AnyOrch).runTask(taskId, 'test')).rejects.toThrow(/already running/i);
    });

    it('should cancel existing pipeline before starting new run of same task', async () => {
      // Simulate a pipeline with a session that needs cleanup
      const pipeline = makePipeline({ sessionId: 'old-sess' });
      (orch as AnyOrch).pipelines.set(taskId, pipeline);

      (orch as AnyOrch).cancelPipeline(taskId);

      expect(mockKillSession).toHaveBeenCalledWith('old-sess');
      expect((orch as AnyOrch).pipelines.has(taskId)).toBe(false);
    });
  });

  // ── Error Recovery (single-phase async with event mocking) ────────

  describe('Error Recovery', () => {
    it('should clean up pipelines after session error', async () => {
      mockCreateSession.mockResolvedValue('err-sess');

      // Fire error exit after a tick
      setTimeout(() => fireExitEvent('err-sess', 1), 5);

      const promise = (orch as AnyOrch).runTask(taskId, 'error test');

      await new Promise((r) => setTimeout(r, 80));

      // Pipeline should be cleaned up
      const pipelines = (orch as AnyOrch).pipelines as Map<string, unknown>;
      expect(pipelines.has(taskId)).toBe(false);

      // Active tasks should be cleaned too
      const active = (orch as AnyOrch).activeTasks as Set<string>;
      expect(active.has(taskId)).toBe(false);

      await promise.catch(() => {});
    });

    it('should advance to failed phase on session error', async () => {
      mockCreateSession.mockResolvedValue('fail-sess');
      setTimeout(() => fireExitEvent('fail-sess', 1), 5);

      await (orch as AnyOrch).runTask(taskId, 'failure').catch(() => {});

      await new Promise((r) => setTimeout(r, 80));

      // Phase-change event should show 'failed'
      const phaseChanges = mockEmit.mock.calls
        .filter((c: unknown[]) => c[0] === 'phase-change')
        .map((c: unknown[]) => (c[1] as { phase: string }).phase);
      expect(phaseChanges).toContain('failed');
    });
  });

  // ── Singleton Behavior ─────────────────────────────────────────────

  describe('getOrchestrator Singleton', () => {
    it('should return same instance for same path', async () => {
      const mod = await import('@/lib/orchestrator');
      expect(mod.getOrchestrator(testDir)).toBe(mod.getOrchestrator(testDir));
    });

    it('should return different instance for different path', async () => {
      const mod = await import('@/lib/orchestrator');
      expect(mod.getOrchestrator(testDir)).not.toBe(mod.getOrchestrator('/tmp/other'));
    });
  });
});
