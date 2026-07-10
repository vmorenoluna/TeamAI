/**
 * Integration tests for markTaskDone end-to-end flow.
 *
 * Tests verify the delete→pull→fallback→emit sequence with a real git
 * repository on disk. The processManager and execFileSync are mocked so
 * no real remote operations occur, but filesystem operations (mkdir, rm,
 * readFileSync) use real Node.js APIs against a temp directory.
 *
 * Coverage:
 *  - Pull failure: directory deleted, recreated with task.json + events.jsonl
 *  - Pull success: directory deleted, restored by pull simulation, updatePhase called
 *  - Single emit: phase-change fires exactly once after the full sequence
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

function setupTestProject() {
  testDir = join(tmpdir(), `teamai-mtd-${randomUUID().slice(0, 8)}`);
  mkdirSync(testDir, { recursive: true });

  // Default: return '' for all execFileSync calls
  mockExecFileSync.mockReturnValue('');

  // Init git repo
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
    JSON.stringify({ maxQaAttempts: 3, parallelSubtasks: true }),
  );

  writeFileSync(
    join(taskDir, 'task.json'),
    JSON.stringify({
      id: taskId,
      title: 'Mark Task Done Test',
      description: 'Integration test for markTaskDone flow',
      phase: 'awaiting-review',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );

  // Write additional artifacts that would exist at this stage
  writeFileSync(join(taskDir, 'spec.md'), '# Feature spec\n');
  writeFileSync(join(taskDir, 'plan.json'), JSON.stringify({ subtasks: [] }));
  writeFileSync(join(taskDir, 'qa_report.json'), JSON.stringify({ overall: 'PASS' }));

  return { testDir, taskId, taskDir };
}

function cleanup() {
  vi.clearAllMocks();
  onHandlers.clear();

  if (testDir && existsSync(testDir)) {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('markTaskDone Integration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    onHandlers.clear();
    setupTestProject();

    const mod = await import('@/lib/orchestrator');
    orch = mod.getOrchestrator(testDir);
  });

  afterEach(() => {
    cleanup();
    vi.resetModules();
  });

  // ── Pull failure: fallback recreates task.json + events.jsonl ────────────

  describe('pull failure — fallback path', () => {
    it('deletes directory, attempts pull, recreates task.json + events.jsonl on failure, emits once', async () => {
      // Verify initial state
      expect(existsSync(taskDir)).toBe(true);
      expect(existsSync(join(taskDir, 'task.json'))).toBe(true);
      expect(existsSync(join(taskDir, 'spec.md'))).toBe(true);

      // Make git pull fail (simulating no remote / offline)
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('pull')) {
          throw new Error('fatal: Could not read from remote repository');
        }
        return '';
      });

      mockEmit.mockClear();
      await orch.markTaskDone(taskId);

      // ── Directory was deleted ──
      // The original directory with artifacts is gone (spec.md, plan.json,
      // qa_report.json were deleted along with the directory).
      // The fallback code recreates only task.json + events.jsonl.
      expect(existsSync(taskDir)).toBe(true);
      expect(existsSync(join(taskDir, 'task.json'))).toBe(true);
      expect(existsSync(join(taskDir, 'events.jsonl'))).toBe(true);

      // Original artifacts are gone (not recreated by fallback)
      expect(existsSync(join(taskDir, 'spec.md'))).toBe(false);
      expect(existsSync(join(taskDir, 'plan.json'))).toBe(false);

      // ── task.json has phase: "done" ──
      const taskJson = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf-8'));
      expect(taskJson.phase).toBe('done');
      expect(taskJson.updatedAt).toBeDefined();

      // ── events.jsonl has the "done" entry ──
      const eventsContent = readFileSync(join(taskDir, 'events.jsonl'), 'utf-8');
      const events = eventsContent.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
      expect(events.some((e: any) => e.phase === 'done')).toBe(true);

      // ── git pull was attempted with correct args ──
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['pull', '--ff-only', 'origin', 'master']),
        expect.objectContaining({ cwd: testDir }),
      );

      // ── phase-change emitted exactly once ──
      expect(mockEmit).toHaveBeenCalledTimes(1);
      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId,
        phase: 'done',
      }));
    });

    it('handles pull failure when directory has many artifact files', async () => {
      // Add extra artifacts to verify rmSync truly removes everything
      writeFileSync(join(taskDir, 'output.log'), 'sensitive terminal output');
      writeFileSync(join(taskDir, 'completion_summary.md'), '# Summary');
      writeFileSync(join(taskDir, 'qa_feedback.md'), 'feedback');

      // Make pull fail
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('pull')) {
          throw new Error('fatal: not a git repository');
        }
        return '';
      });

      mockEmit.mockClear();
      await orch.markTaskDone(taskId);

      // Directory exists (recreated by fallback)
      expect(existsSync(taskDir)).toBe(true);

      // Only task.json and events.jsonl remain
      expect(existsSync(join(taskDir, 'task.json'))).toBe(true);
      expect(existsSync(join(taskDir, 'events.jsonl'))).toBe(true);

      // All original artifacts are gone
      expect(existsSync(join(taskDir, 'spec.md'))).toBe(false);
      expect(existsSync(join(taskDir, 'plan.json'))).toBe(false);
      expect(existsSync(join(taskDir, 'output.log'))).toBe(false);
      expect(existsSync(join(taskDir, 'completion_summary.md'))).toBe(false);
      expect(existsSync(join(taskDir, 'qa_feedback.md'))).toBe(false);

      // Single emit
      expect(mockEmit).toHaveBeenCalledTimes(1);
    });

    it('preserves task identity fields in recreated task.json', async () => {
      // Make pull fail
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('pull')) {
          throw new Error('fatal: remote not found');
        }
        return '';
      });

      await orch.markTaskDone(taskId);

      const taskJson = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf-8'));

      // Identity fields preserved from snapshot
      expect(taskJson.id).toBe(taskId);
      expect(taskJson.title).toBe('Mark Task Done Test');
      expect(taskJson.description).toBe('Integration test for markTaskDone flow');
      expect(taskJson.createdAt).toBeDefined();

      // Phase updated
      expect(taskJson.phase).toBe('done');
    });
  });

  // ── Pull success: directory restored, events.jsonl updated ──────────────

  describe('pull success path', () => {
    it('deletes directory, pulls successfully, calls updatePhase for events.jsonl, emits once', async () => {
      // Make pull succeed and simulate restoring the directory
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('pull')) {
          // Simulate pull restoring the committed .teamai/{slug}/ directory
          mkdirSync(taskDir, { recursive: true });
          writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
            id: taskId,
            title: 'Mark Task Done Test',
            description: 'Integration test for markTaskDone flow',
            phase: 'done',   // phase was set to 'done' by commitArtifactsToWorktree before the merge
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          }));
          return '';
        }
        return '';
      });

      mockEmit.mockClear();
      await orch.markTaskDone(taskId);

      // ── Directory exists from pull restore ──
      expect(existsSync(taskDir)).toBe(true);
      expect(existsSync(join(taskDir, 'task.json'))).toBe(true);

      // ── events.jsonl was written by updatePhase ──
      expect(existsSync(join(taskDir, 'events.jsonl'))).toBe(true);
      const eventsContent = readFileSync(join(taskDir, 'events.jsonl'), 'utf-8');
      expect(eventsContent).toContain('"done"');

      // ── git pull was attempted ──
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['pull', '--ff-only', 'origin', 'master']),
        expect.objectContaining({ cwd: testDir }),
      );

      // ── phase-change emitted exactly once ──
      expect(mockEmit).toHaveBeenCalledTimes(1);
      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId,
        phase: 'done',
      }));
    });

    it('does not double-emit when pull succeeds', async () => {
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('pull')) {
          mkdirSync(taskDir, { recursive: true });
          writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
            id: taskId, title: 'Pull Test', description: 'desc',
            phase: 'done', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
          }));
          return '';
        }
        return '';
      });

      mockEmit.mockClear();
      await orch.markTaskDone(taskId);

      // Exactly one emit — no intermediate emits, no double emits
      expect(mockEmit).toHaveBeenCalledTimes(1);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('throws when task does not exist', async () => {
      await expect(orch.markTaskDone('nonexistent-task-id')).rejects.toThrow('not found');
    });

    it('handles multiple calls to markTaskDone gracefully (idempotent second call fails)', async () => {
      // First call: pull fails, fallback recreates
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('pull')) {
          throw new Error('fatal: remote not found');
        }
        return '';
      });

      await orch.markTaskDone(taskId);
      expect(existsSync(join(taskDir, 'events.jsonl'))).toBe(true);

      // Second call: the task directory exists from the fallback, so it gets
      // deleted again. But getDirById reads from disk and should find it.
      mockEmit.mockClear();
      await orch.markTaskDone(taskId);

      // Should still work — single emit for the second call
      expect(mockEmit).toHaveBeenCalledTimes(1);
    });

    it('does not emit phase-change before the pull attempt', async () => {
      // Use a mock that tracks call order
      const callOrder: string[] = [];

      mockEmit.mockImplementation(() => { callOrder.push('emit'); });

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('pull')) {
          callOrder.push('pull');
          throw new Error('fatal: remote not found');
        }
        return '';
      });

      try {
        await orch.markTaskDone(taskId);

        // 'pull' must come BEFORE 'emit' in the call order
        const pullIdx = callOrder.indexOf('pull');
        const emitIdx = callOrder.indexOf('emit');
        expect(pullIdx).toBeLessThan(emitIdx);
      } finally {
        // Restore defaults so mock implementations don't leak to other tests.
        // mockReset() returns vi.fn() to its default (no-op returning undefined).
        mockEmit.mockReset();
        mockExecFileSync.mockReturnValue('');
      }
    });
  });
});
