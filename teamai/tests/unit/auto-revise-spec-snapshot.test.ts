// @vitest-environment node

/**
 * Tests autoReviseSpec's pre-revision handling under the rename-at-revision
 * scheme: instead of copying spec.md to a spec_revision_before.md marker,
 * beginSpecRevision RENAMES spec.md → spec_v{specRevision - 1}.md. The renamed
 * file doubles as (a) the version history entry for the pre-revision spec and
 * (b) the no-op guard's baseline in runSpecPhase.
 *
 * A failed rename must warn (not swallow) — losing the baseline would make
 * the no-op guard silently pass on every future attempt.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockWarn, mockWriteFileSync, realWriteFileSync, mockRenameSync, realRenameSync } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockWriteFileSync: vi.fn(),
  realWriteFileSync: { current: null as null | ((...args: unknown[]) => void) },
  mockRenameSync: vi.fn(),
  realRenameSync: { current: null as null | ((...args: unknown[]) => void) },
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(),
  warn: mockWarn,
  error: vi.fn(),
  info: vi.fn(),
}));

// Override writeFileSync and renameSync with controllable mocks that default
// to the real implementations (captured here so tests can delegate selectively).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  realWriteFileSync.current = actual.writeFileSync as unknown as (...args: unknown[]) => void;
  realRenameSync.current = actual.renameSync as unknown as (...args: unknown[]) => void;
  (mockWriteFileSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realWriteFileSync.current!(...args));
  (mockRenameSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realRenameSync.current!(...args));
  return { ...actual, writeFileSync: mockWriteFileSync, renameSync: mockRenameSync };
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

describe('autoReviseSpec — rename-at-revision baseline', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx();
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('renames spec.md to spec_v{specRevision-1}.md as the pre-revision baseline', async () => {
    realWriteFileSync.current!(join(ctx.specPath, 'spec.md'), '# original spec');
    // Fresh task: specRevision starts at 1, autoReviseSpec bumps it to 2,
    // so the pre-revision spec is renamed to spec_v1.md.

    await autoReviseSpec(ctx.pipeline as never, ctx.deps as never);
    expect(mockWarn).not.toHaveBeenCalled();
    expect(ctx.pipeline.specRevision).toBe(2);

    // The pre-revision spec now lives at the previous version number…
    expect(readFileSync(join(ctx.specPath, 'spec_v1.md'), 'utf-8')).toBe('# original spec');
    // …and spec.md is gone until the analyst writes the revised spec there.
    expect(existsSync(join(ctx.specPath, 'spec.md'))).toBe(false);
    // The old marker file scheme is retired.
    expect(existsSync(join(ctx.specPath, 'spec_revision_before.md'))).toBe(false);
    // The in-flight revision has NOT created spec_v2.md — the analyst writes
    // the revised spec to spec.md, which the versions UI surfaces live.
    expect(existsSync(join(ctx.specPath, 'spec_v2.md'))).toBe(false);
  });

  it('warns (does not throw) when the pre-revision rename fails', async () => {
    realWriteFileSync.current!(join(ctx.specPath, 'spec.md'), '# original spec');

    mockRenameSync.mockImplementation(((from: unknown, to: unknown) => {
      if (String(to).includes('spec_v1.md')) throw new Error('disk full');
      return realRenameSync.current!(from, to);
    }) as never);

    await expect(autoReviseSpec(ctx.pipeline as never, ctx.deps as never)).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(
      'review',
      expect.stringContaining('Failed to snapshot pre-revision spec'),
      expect.anything(),
    );
  });
});
