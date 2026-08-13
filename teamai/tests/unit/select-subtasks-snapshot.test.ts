// @vitest-environment node

/**
 * Tests the human_feedback_before_bounce.md snapshot in selectSubtasks:
 * a failed snapshot write must warn (not swallow).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockWarn, mockWriteFileSync, mockExecFileSync } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockWriteFileSync: vi.fn(),
  mockExecFileSync: vi.fn(),
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

// Override only writeFileSync with a controllable mock that defaults to the
// real implementation, so plan.json/human_feedback.md setup writes land on disk.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realWrite = actual.writeFileSync;
  (mockWriteFileSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realWrite(...(args as Parameters<typeof realWrite>)));
  return { ...actual, writeFileSync: mockWriteFileSync };
});

import { selectSubtasks } from '../../src/lib/orchestrator/implement';
import { writeFileSync } from 'fs';

// ── Helpers ──

function setup() {
  const root = join(tmpdir(), `teamai-select-subtasks-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  mkdirSync(specPath, { recursive: true });

  writeFileSync(join(specPath, 'plan.json'), JSON.stringify({
    subtasks: [
      { id: 1, title: 'S1', description: '', files: ['src/a.ts'], acceptance_criteria: ['A works'], depends_on: [] },
    ],
  }));
  writeFileSync(join(specPath, 'human_feedback.md'), '# Feedback');

  return { root, specPath };
}

function pipeline(specPath: string) {
  return {
    taskId: 't1',
    description: 'd',
    phase: 'implement',
    specPath,
    worktreePath: join(specPath, '..', 'wt'),
    branch: 'feat/test',
    qaAttempt: 0,
    maxQaAttempts: 3,
  };
}

// ── Tests ──

describe('selectSubtasks — human_feedback_before_bounce.md snapshot', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = setup();
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('snapshots human_feedback.md when absent', () => {
    selectSubtasks(pipeline(ctx.specPath) as never);
    expect(existsSync(join(ctx.specPath, 'human_feedback_before_bounce.md'))).toBe(true);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('warns (does not throw) when the snapshot write fails', () => {
    mockWriteFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => selectSubtasks(pipeline(ctx.specPath) as never)).not.toThrow();

    expect(mockWarn).toHaveBeenCalledWith(
      'implement',
      expect.stringContaining('Failed to snapshot human feedback'),
      expect.anything(),
    );
  });
});
