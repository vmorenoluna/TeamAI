// @vitest-environment node

/**
 * Tests the cleanQaFlaggedMarkers helper: removes qa_flagged markers from
 * plan.json after a bounce-back implement run, and warns (not swallows) when
 * the write fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockWarn, mockWriteFileSync } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockWriteFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(),
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
// real implementation, so plan.json setup writes land on disk.
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  const realWrite = actual.writeFileSync;
  (mockWriteFileSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realWrite(...(args as Parameters<typeof realWrite>)));
  return { ...actual, writeFileSync: mockWriteFileSync };
});

import { cleanQaFlaggedMarkers } from '../../src/lib/orchestrator/implement';
import { writeFileSync } from 'fs';

function setup() {
  const root = join(tmpdir(), `teamai-clean-qa-flagged-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  mkdirSync(specPath, { recursive: true });
  writeFileSync(join(specPath, 'plan.json'), JSON.stringify({
    subtasks: [
      { id: 1, title: 'S1', description: '', files: [], acceptance_criteria: [], qa_flagged: true },
      { id: 2, title: 'S2', description: '', files: [], acceptance_criteria: [], qa_flagged: false },
    ],
  }));
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

describe('cleanQaFlaggedMarkers', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = setup();
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('removes qa_flagged markers from plan.json', () => {
    cleanQaFlaggedMarkers(pipeline(ctx.specPath) as never);

    const plan = JSON.parse(readFileSync(join(ctx.specPath, 'plan.json'), 'utf-8'));
    expect(plan.subtasks[0].qa_flagged).toBeUndefined();
    expect(plan.subtasks[1].qa_flagged).toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('warns (does not throw) when the cleanup write fails', () => {
    mockWriteFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });

    expect(() => cleanQaFlaggedMarkers(pipeline(ctx.specPath) as never)).not.toThrow();

    expect(mockWarn).toHaveBeenCalledWith(
      'implement',
      expect.stringContaining('Failed to clean qa_flagged markers'),
      expect.anything(),
    );
  });
});
