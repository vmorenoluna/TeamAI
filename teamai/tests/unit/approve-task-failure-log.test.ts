// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { approveTask } from '../../src/lib/orchestrator/review-actions';

function makeCtx() {
  const root = join(tmpdir(), `teamai-approve-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  mkdirSync(specPath, { recursive: true });

  const pipeline = {
    taskId: 'task-1',
    title: 't',
    description: 'd',
    phase: 'awaiting-review',
    specPath,
    worktreePath: join(specPath, '..', 'wt'),
    branch: 'feat/test',
    qaAttempt: 1,
    maxQaAttempts: 3,
    specRevision: 1,
    qaRevision: 0,
    deliverableFailCounts: {},
    persistedCriterionFailCounts: {},
    wakeupAttemptCount: 0,
    wakeupUntil: undefined,
    wakeupSubtaskId: undefined,
    wakeupCommand: undefined,
    wakeupArtifact: undefined,
    wakeupProgressPath: undefined,
  };

  // Collect advancePhase calls so we can assert no rollback happens.
  const advancePhaseCalls: Array<{ phase: string; eventExtra?: Record<string, unknown> }> = [];

  const deps = {
    taskStore: {
      getById: () => ({ id: 'task-1', description: 'd', phase: 'awaiting-review' }),
      update: vi.fn(),
      clearArtifacts: vi.fn(),
    },
    pipelines: new Map([['task-1', pipeline]]),
    restorePipeline: vi.fn(),
    advancePhase: (_p: typeof pipeline, phase: string, eventExtra?: Record<string, unknown>) => {
      advancePhaseCalls.push({ phase, eventExtra });
      pipeline.phase = phase;
    },
    executePhase: vi.fn(async () => undefined),
    savePipelineState: vi.fn(),
  };

  return { root, specPath, pipeline, deps, advancePhaseCalls };
}

describe('approveTask failure propagation', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    writeFileSync(join(ctx.specPath, 'spec.md'), '# test');
  });

  afterEach(() => {
    rmSync(ctx.root, { recursive: true, force: true });
  });

  it('re-throws the error and does not roll back to awaiting-review for local-merge', async () => {
    ctx.deps.executePhase.mockRejectedValueOnce(new Error('push rejected: branch is behind'));

    await expect(
      approveTask('task-1', 'local-merge', ctx.deps as any),
    ).rejects.toThrow('push rejected: branch is behind');

    // Only the forward advance; failure handling belongs to the run lifecycle.
    expect(ctx.advancePhaseCalls).toHaveLength(1);
    expect(ctx.advancePhaseCalls[0].phase).toBe('merge');
    expect(ctx.advancePhaseCalls.some(c => c.eventExtra?.awaitingReviewReason !== undefined)).toBe(false);
    expect(ctx.pipeline.phase).toBe('merge');
  });

  it('re-throws the error and does not roll back to awaiting-review for pull-request', async () => {
    ctx.deps.executePhase.mockRejectedValueOnce(new Error('gh auth token expired'));

    await expect(
      approveTask('task-1', 'pull-request', ctx.deps as any),
    ).rejects.toThrow('gh auth token expired');

    expect(ctx.advancePhaseCalls).toHaveLength(1);
    expect(ctx.advancePhaseCalls[0].phase).toBe('create-pr');
    expect(ctx.pipeline.phase).toBe('create-pr');
  });

  it('propagates structured error codes unchanged', async () => {
    const execErr: Error & { code?: string } = new Error('rate limit exceeded');
    execErr.code = 'RATE_LIMIT';
    ctx.deps.executePhase.mockRejectedValueOnce(execErr);

    await expect(
      approveTask('task-1', 'local-merge', ctx.deps as any),
    ).rejects.toBe(execErr);
  });

  it('propagates non-Error rejections unchanged', async () => {
    ctx.deps.executePhase.mockRejectedValueOnce('plain string rejection');

    await expect(
      approveTask('task-1', 'local-merge', ctx.deps as any),
    ).rejects.toBe('plain string rejection');
    expect(ctx.advancePhaseCalls).toHaveLength(1);
  });

  it('does not write its own [ERROR] line (the run lifecycle logs it)', async () => {
    ctx.deps.executePhase.mockRejectedValueOnce(new Error('rebase conflict'));

    await expect(
      approveTask('task-1', 'pull-request', ctx.deps as any),
    ).rejects.toThrow('rebase conflict');

    expect(existsSync(join(ctx.specPath, 'output.log'))).toBe(false);
  });
});
