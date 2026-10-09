// @vitest-environment node

/**
 * Tests rejectTask's human_feedback_before_bounce.md snapshot write:
 * a failed snapshot write must warn (not swallow).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockWarn, mockWriteFileSync, realWriteFileSync } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockWriteFileSync: vi.fn(),
  realWriteFileSync: { current: null as null | ((...args: unknown[]) => void) },
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(),
  warn: mockWarn,
  error: vi.fn(),
  info: vi.fn(),
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

import { rejectTask } from '../../src/lib/orchestrator/review-actions';

function makeDeps() {
  const root = join(tmpdir(), `teamai-reject-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  mkdirSync(specPath, { recursive: true });

  const pipeline = {
    taskId: 'task-1',
    description: 'd',
    phase: 'awaiting-review',
    specPath,
    worktreePath: join(specPath, '..', 'wt'),
    branch: 'feat/test',
    qaAttempt: 2,
    maxQaAttempts: 3,
    deliverableFailCounts: {},
    persistedCriterionFailCounts: {},
    wakeupAttemptCount: 0,
    wakeupUntil: undefined,
    wakeupSubtaskId: undefined,
    wakeupCommand: undefined,
    wakeupArtifact: undefined,
    wakeupProgressPath: undefined,
  };

  const deps = {
    projectRoot: root,
    taskStore: {
      getById: () => ({ id: 'task-1', description: 'd', phase: 'awaiting-review' }),
      update: vi.fn(),
      updatePhase: vi.fn(),
      clearArtifacts: vi.fn(),
    },
    pipelines: new Map([['task-1', pipeline]]),
    restorePipeline: vi.fn(),
    advancePhase: (p: typeof pipeline, phase: string) => { (p as { phase: string }).phase = phase; },
    executePhase: vi.fn(async () => undefined),
    startRun: vi.fn(),
    savePipelineState: vi.fn(),
  };

  return { root, specPath, pipeline, deps };
}

describe('rejectTask — human_feedback_before_bounce.md snapshot', () => {
  let ctx: ReturnType<typeof makeDeps>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeDeps();
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('snapshots human feedback without warning on success', async () => {
    await rejectTask('task-1', 'Fix the bugs', 'coder', undefined, ctx.deps as never);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('warns (does not throw) when the snapshot write fails', async () => {
    let calls = 0;
    mockWriteFileSync.mockImplementation((...args: unknown[]) => {
      calls += 1;
      // 1st write = human_feedback.md (primary); 2nd = the snapshot.
      if (calls === 2) throw new Error('disk full');
      return realWriteFileSync.current!(...args);
    });

    await expect(rejectTask('task-1', 'Fix the bugs', 'coder', undefined, ctx.deps as never)).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(
      'review',
      expect.stringContaining('Failed to snapshot human feedback'),
      expect.anything(),
    );
  });

  it('warns (does not throw) when the qa_report.json change-request patch fails', async () => {
    // qa_report.json must exist for the patch block to run.
    realWriteFileSync.current!(
      join(ctx.specPath, 'qa_report.json'),
      JSON.stringify({ overall: 'PASS', criteria: [] }),
    );

    let calls = 0;
    mockWriteFileSync.mockImplementation((...args: unknown[]) => {
      calls += 1;
      // 1st = human_feedback.md, 2nd = snapshot, 3rd = qa_report.json patch.
      if (calls === 3) throw new Error('disk full');
      return realWriteFileSync.current!(...args);
    });

    await expect(rejectTask('task-1', 'Fix the bugs', 'coder', undefined, ctx.deps as never)).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(
      'review',
      expect.stringContaining('Failed to record change request in qa_report.json'),
      expect.anything(),
    );
  });
});
