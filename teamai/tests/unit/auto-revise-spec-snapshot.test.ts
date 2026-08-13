// @vitest-environment node

/**
 * Tests autoReviseSpec's spec_v{N}.md snapshot write:
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

import { autoReviseSpec } from '../../src/lib/orchestrator/review-actions';

function makeCtx() {
  const root = join(tmpdir(), `teamai-revise-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  mkdirSync(specPath, { recursive: true });

  const pipeline = {
    taskId: 'task-1',
    description: 'd',
    phase: 'qa-review',
    specPath,
    worktreePath: join(specPath, '..', 'wt'),
    branch: 'feat/test',
    specRevision: 1,
    qaAttempt: 0,
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
    taskStore: {
      getById: () => ({ id: 'task-1', description: 'd', phase: 'qa-review' }),
      update: vi.fn(),
      clearArtifacts: vi.fn(),
    },
    pipelines: new Map([['task-1', pipeline]]),
    restorePipeline: vi.fn(),
    advancePhase: (p: typeof pipeline, phase: string) => { (p as { phase: string }).phase = phase; },
    executePhase: vi.fn(async () => undefined),
    savePipelineState: vi.fn(),
  };

  return { root, specPath, pipeline, deps };
}

describe('autoReviseSpec — spec_v{N}.md snapshot', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx();
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('snapshots the spec without warning on success', async () => {
    realWriteFileSync.current!(join(ctx.specPath, 'spec.md'), '# original spec');
    await autoReviseSpec(ctx.pipeline as never, ctx.deps as never);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('warns (does not throw) when the spec snapshot write fails', async () => {
    realWriteFileSync.current!(join(ctx.specPath, 'spec.md'), '# original spec');

    let calls = 0;
    mockWriteFileSync.mockImplementation((...args: unknown[]) => {
      calls += 1;
      // 1st write = spec_revision_feedback.md (writeSpecRevisionFeedback);
      // 2nd = the spec_v{N}.md snapshot.
      if (calls === 2) throw new Error('disk full');
      return realWriteFileSync.current!(...args);
    });

    await expect(autoReviseSpec(ctx.pipeline as never, ctx.deps as never)).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(
      'review',
      expect.stringContaining('Failed to snapshot spec v2'),
      expect.anything(),
    );
  });
});
