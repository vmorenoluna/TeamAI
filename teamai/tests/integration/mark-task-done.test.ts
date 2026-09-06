/**
 * Integration tests for markTaskDone end-to-end flow.
 *
 * Ticket-history refactor (§3d): the committed artifact snapshot no longer
 * exists — the folder-commit mechanism was replaced by the trailer-bearing
 * pre-merge squash. markTaskDone is therefore deterministic:
 *
 *   PR-merge guard  →  finalize record (task.json phase=done + events.jsonl)
 *   →  delete .teamai/<slug>/ unconditionally  →  emit phase-change once
 *
 * No git fetch / ls-tree / ff-only merge / scoped checkout is attempted.
 * The durable record after completion is the trailer-bearing merge commit
 * and (for PR-strategy tasks) the PR body — not the local folder.
 *
 * The processManager and execFileSync are mocked so no real remote
 * operations occur, but filesystem operations use real Node.js APIs
 * against a temp directory.
 *
 * Coverage:
 *  - Finalize + folder deletion (unconditional, both merge strategies)
 *  - Single emit after the record is settled
 *  - PR-merge guard still refuses unmerged PRs and leaves everything intact
 *  - Task-not-found error
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
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

  describe('finalize + folder deletion', () => {
    it('deletes the task folder, emits phase-change exactly once', async () => {
      expect(existsSync(taskDir)).toBe(true);
      expect(existsSync(join(taskDir, 'task.json'))).toBe(true);

      mockEmit.mockClear();
      await orch.markTaskDone(taskId);

      // Folder is gone — the durable record is the trailer-bearing commit
      // and (for PR tasks) the PR body, not the local folder (§3d/§3j).
      expect(existsSync(taskDir)).toBe(false);

      // phase-change emitted exactly once, after the folder is settled.
      // (TaskStore's own 'task-updated' — a generic refresh signal every
      // write emits — also fires from the updatePhase call inside
      // markTaskDone; expected and harmless, so this asserts on the
      // authoritative phase-change event specifically.)
      const phaseChangeCalls = mockEmit.mock.calls.filter((c: unknown[]) => c[0] === 'phase-change');
      expect(phaseChangeCalls).toHaveLength(1);
      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId,
        phase: 'done',
      }));
    });

    it('deletes the folder regardless of merge strategy (local-merge included)', async () => {
      writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
        id: taskId,
        title: 'Mark Task Done Test',
        description: 'Integration test for markTaskDone flow',
        phase: 'awaiting-review',
        mergeStrategy: 'local-merge',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      await orch.markTaskDone(taskId);

      expect(existsSync(taskDir)).toBe(false);
      expect(mockEmit.mock.calls.filter((c: unknown[]) => c[0] === 'phase-change')).toHaveLength(1);
    });

    it('deletes the folder regardless of recordHistoryInGit (§3j — no keep-folder safety net)', async () => {
      // recordHistoryInGit off must not preserve the folder; the toggle only
      // controls whether trailers are written, not whether folders persist.
      writeFileSync(
        join(testDir, '.teamai', 'pipeline.json'),
        JSON.stringify({ maxQaAttempts: 3, parallelSubtasks: true, recordHistoryInGit: false }),
      );

      await orch.markTaskDone(taskId);

      expect(existsSync(taskDir)).toBe(false);
      expect(mockEmit.mock.calls.filter((c: unknown[]) => c[0] === 'phase-change')).toHaveLength(1);
    });

    it('removes every artifact file with the folder — including transient logs', async () => {
      writeFileSync(join(taskDir, 'output.log'), 'terminal output');
      writeFileSync(join(taskDir, 'completion_summary.md'), '# Summary');
      writeFileSync(join(taskDir, 'qa_feedback.md'), 'feedback');

      await orch.markTaskDone(taskId);

      expect(existsSync(taskDir)).toBe(false);
      expect(existsSync(join(taskDir, 'task.json'))).toBe(false);
      expect(existsSync(join(taskDir, 'output.log'))).toBe(false);
    });
  });

  // ── PR-merge guard ──────────────────────────────────────────────────────

  describe('PR-merge guard', () => {
    function writeTaskJsonWithPr(taskDir: string, taskId: string) {
      writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
        id: taskId,
        title: 'Test Task',
        description: 'A test task for full coverage',
        phase: 'pr-open',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        platform: 'github',
        prUrl: 'https://github.com/example/repo/pull/42',
        mergeStrategy: 'pull-request',
      }));
    }

    it('refuses to mark done when the PR is still open, leaving the folder untouched', async () => {
      writeTaskJsonWithPr(taskDir, taskId);
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('view') && args.includes('state')) {
          return JSON.stringify({ state: 'OPEN' });
        }
        return '';
      });

      mockEmit.mockClear();
      await expect(orch.markTaskDone(taskId)).rejects.toThrow(/has not been merged yet/);

      // Nothing destructive happened — folder intact, no phase-change.
      expect(existsSync(taskDir)).toBe(true);
      expect(existsSync(join(taskDir, 'task.json'))).toBe(true);
      expect(mockEmit).not.toHaveBeenCalled();
    });

    it('proceeds when the PR is confirmed merged', async () => {
      writeTaskJsonWithPr(taskDir, taskId);
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('view') && args.includes('state')) {
          return JSON.stringify({ state: 'MERGED' });
        }
        return '';
      });

      mockEmit.mockClear();
      await orch.markTaskDone(taskId);

      expect(existsSync(taskDir)).toBe(false);
      const phaseChangeCalls = mockEmit.mock.calls.filter((c: unknown[]) => c[0] === 'phase-change');
      expect(phaseChangeCalls).toHaveLength(1);
      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId,
        phase: 'done',
      }));
    });

    it('proceeds when merge state cannot be determined (CLI failure) rather than blocking indefinitely', async () => {
      writeTaskJsonWithPr(taskDir, taskId);
      mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
        if (args.includes('view') && args.includes('state')) {
          throw new Error('gh: command not found');
        }
        return '';
      });

      mockEmit.mockClear();
      await orch.markTaskDone(taskId);

      expect(existsSync(taskDir)).toBe(false);
      expect(mockEmit.mock.calls.filter((c: unknown[]) => c[0] === 'phase-change')).toHaveLength(1);
    });
  });

  // ── Edge cases ──────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('throws when task does not exist', async () => {
      await expect(orch.markTaskDone('nonexistent-task-id')).rejects.toThrow('not found');
    });

    it('is idempotent-safe: a second call on a deleted folder fails cleanly without emitting', async () => {
      await orch.markTaskDone(taskId);
      expect(existsSync(taskDir)).toBe(false);

      mockEmit.mockClear();
      // Second call: folder is gone — getDirById can no longer resolve it.
      await expect(orch.markTaskDone(taskId)).rejects.toThrow();
      expect(mockEmit).not.toHaveBeenCalled();
    });
  });
});
