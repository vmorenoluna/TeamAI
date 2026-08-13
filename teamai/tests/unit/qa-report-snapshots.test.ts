// @vitest-environment node

/**
 * Tests the QA report snapshot helpers: qa_report_before_bounce.json and
 * qa_report_v{N}.json must warn (not swallow) when their write fails.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockWarn, mockWriteFileSync, realWriteFileSync } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockWriteFileSync: vi.fn(),
  realWriteFileSync: { current: null as null | ((...args: unknown[]) => void) },
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

// Override only writeFileSync with a controllable mock that defaults to the
// real implementation (captured here so tests can delegate selectively).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  realWriteFileSync.current = actual.writeFileSync as unknown as (...args: unknown[]) => void;
  (mockWriteFileSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realWriteFileSync.current!(...args));
  return { ...actual, writeFileSync: mockWriteFileSync };
});

import { snapshotQaReportBeforeBounce, snapshotQaReportVersioned } from '../../src/lib/orchestrator/qa-review';

function setup() {
  const root = join(tmpdir(), `teamai-qasnap-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  mkdirSync(specPath, { recursive: true });
  realWriteFileSync.current!(join(specPath, 'qa_report.json'), JSON.stringify({ overall: 'FAIL' }));
  return { root, specPath };
}

function pipeline(specPath: string) {
  return {
    taskId: 'task-1',
    description: 'd',
    phase: 'qa-review',
    specPath,
    qaRevision: 2,
  };
}

describe('QA report snapshot helpers', () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = setup();
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('snapshotQaReportBeforeBounce writes the snapshot without warning', () => {
    snapshotQaReportBeforeBounce(pipeline(ctx.specPath) as never);
    expect(existsSync(join(ctx.specPath, 'qa_report_before_bounce.json'))).toBe(true);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('snapshotQaReportBeforeBounce warns (does not throw) on write failure', () => {
    mockWriteFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => snapshotQaReportBeforeBounce(pipeline(ctx.specPath) as never)).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith(
      'qa-review',
      expect.stringContaining('Failed to snapshot QA report before bounce'),
      expect.anything(),
    );
  });

  it('snapshotQaReportVersioned writes qa_report_v{N}.json without warning', () => {
    snapshotQaReportVersioned(pipeline(ctx.specPath) as never);
    expect(existsSync(join(ctx.specPath, 'qa_report_v2.json'))).toBe(true);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('snapshotQaReportVersioned warns (does not throw) on write failure', () => {
    mockWriteFileSync.mockImplementationOnce(() => { throw new Error('disk full'); });
    expect(() => snapshotQaReportVersioned(pipeline(ctx.specPath) as never)).not.toThrow();
    expect(mockWarn).toHaveBeenCalledWith(
      'qa-review',
      expect.stringContaining('Failed to snapshot qa_report_v2'),
      expect.anything(),
    );
  });
});
