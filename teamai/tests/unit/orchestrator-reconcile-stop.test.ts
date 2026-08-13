// @vitest-environment node

/**
 * Tests the plan.json persistence in _reconcileSubtaskCompletionsOnStop:
 * a failed write of the completed→false reset must warn (not swallow),
 * otherwise the next run still sees the subtask as completed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Hoisted mocks ──

const { mockExecFileSync, mockWarn, mockWriteFileSync, mockAppendFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockWarn: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockAppendFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(),
  warn: mockWarn,
  error: vi.fn(),
  info: vi.fn(),
}));

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
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: {
    ensureContainer: vi.fn(),
    getRunningContainer: vi.fn(() => null),
  },
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

// Override only writeFileSync/appendFileSync with controllable mocks that
// default to the real implementation, so TaskStore setup still writes to disk.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realWrite = actual.writeFileSync;
  const realAppend = actual.appendFileSync;
  (mockWriteFileSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realWrite(...(args as Parameters<typeof realWrite>)));
  (mockAppendFileSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realAppend(...(args as Parameters<typeof realAppend>)));
  return { ...actual, writeFileSync: mockWriteFileSync, appendFileSync: mockAppendFileSync };
});

import { Orchestrator } from '../../src/lib/orchestrator';
import { writeFileSync } from 'fs';

// ── Helpers ──

function setup() {
  const root = join(tmpdir(), `teamai-reconcile-${randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, '.teamai'), { recursive: true });

  const taskId = randomUUID();
  const taskDir = join(root, '.teamai', taskId);
  mkdirSync(taskDir, { recursive: true });

  const now = new Date().toISOString();
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    title: 'T',
    description: 'd',
    phase: 'implement',
    branch: 'feat/test-reconcile',
    slug: 'test-reconcile',
    createdAt: now,
    updatedAt: now,
  }));
  writeFileSync(join(taskDir, 'plan.json'), JSON.stringify({
    subtasks: [
      { id: 1, title: 'S1', description: '', files: [], acceptance_criteria: [], completed: true },
    ],
  }));

  return { root, taskId, taskDir };
}

// ── Tests ──

describe('_reconcileSubtaskCompletionsOnStop — plan.json persistence', () => {
  let orch: Orchestrator;
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = setup();
    orch = new Orchestrator(ctx.root);
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('resets the subtask and persists plan.json when cherry-pick fails', async () => {
    const wtPath = orch.getWorktreePath(ctx.taskId)!;
    mkdirSync(wtPath, { recursive: true });

    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args?.[0] === 'rev-parse') return 'abc\n';
      if (cmd === 'git' && args?.[0] === 'log') return 'abc unintegrated\n';
      if (cmd === 'git' && args?.[0] === 'cherry-pick' && args?.[1] !== '--abort') {
        throw new Error('CONFLICT');
      }
      return '';
    });

    await orch.cleanupTaskArtifacts(ctx.taskId, 'implement');

    const plan = JSON.parse(readFileSync(join(ctx.taskDir, 'plan.json'), 'utf-8'));
    expect(plan.subtasks[0].completed).toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('warns (does not throw) when the plan.json reset write fails', async () => {
    const wtPath = orch.getWorktreePath(ctx.taskId)!;
    mkdirSync(wtPath, { recursive: true });

    mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && args?.[0] === 'rev-parse') return 'abc\n';
      if (cmd === 'git' && args?.[0] === 'log') return 'abc unintegrated\n';
      if (cmd === 'git' && args?.[0] === 'cherry-pick' && args?.[1] !== '--abort') {
        throw new Error('CONFLICT');
      }
      return '';
    });

    // The next writeFileSync (the reconcile plan.json write) throws.
    mockWriteFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    await expect(orch.cleanupTaskArtifacts(ctx.taskId, 'implement')).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(
      'orchestrator',
      expect.stringContaining('Failed to persist plan.json'),
      expect.anything(),
    );
  });
});
