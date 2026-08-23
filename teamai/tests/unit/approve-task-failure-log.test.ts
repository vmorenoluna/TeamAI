// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'fs';
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

  // Collect advancePhase calls so we can inspect eventExtra on the rollback.
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

describe('approveTask failure logging', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    // Write a minimal spec.md so logToOutput can resolve specPath correctly.
    writeFileSync(join(ctx.specPath, 'spec.md'), '# test');
  });

  afterEach(() => {
    rmSync(ctx.root, { recursive: true, force: true });
  });

  it('logs the error to output.log and includes approvalError in the rollback eventExtra for local-merge', async () => {
    const execErr = new Error('push rejected: branch is behind');
    ctx.deps.executePhase.mockRejectedValueOnce(execErr);

    await expect(
      approveTask('task-1', 'local-merge', ctx.deps as any),
    ).rejects.toThrow('push rejected: branch is behind');

    // Two advancePhase calls: one to 'merge' (forward), one to 'awaiting-review' (rollback).
    expect(ctx.advancePhaseCalls).toHaveLength(2);
    expect(ctx.advancePhaseCalls[0].phase).toBe('merge');

    const rollback = ctx.advancePhaseCalls[1];
    expect(rollback.phase).toBe('awaiting-review');
    expect(rollback.eventExtra).toBeDefined();
    expect(rollback.eventExtra!.approvalError).toBe('push rejected: branch is behind');
    expect(rollback.eventExtra!.fromPhase).toBe('merge');

    // Verify output.log contains the error.
    const logPath = join(ctx.specPath, 'output.log');
    expect(existsSync(logPath)).toBe(true);
    const logContent = readFileSync(logPath, 'utf-8');
    expect(logContent).toContain('[ERROR] Approval failed (merge): push rejected: branch is behind');
  });

  it('logs the error to output.log and includes approvalError in the rollback eventExtra for pull-request', async () => {
    const execErr = new Error('gh auth token expired');
    ctx.deps.executePhase.mockRejectedValueOnce(execErr);

    await expect(
      approveTask('task-1', 'pull-request', ctx.deps as any),
    ).rejects.toThrow('gh auth token expired');

    expect(ctx.advancePhaseCalls).toHaveLength(2);
    expect(ctx.advancePhaseCalls[0].phase).toBe('create-pr');

    const rollback = ctx.advancePhaseCalls[1];
    expect(rollback.phase).toBe('awaiting-review');
    expect(rollback.eventExtra!.approvalError).toBe('gh auth token expired');
    expect(rollback.eventExtra!.fromPhase).toBe('create-pr');

    const logContent = readFileSync(join(ctx.specPath, 'output.log'), 'utf-8');
    expect(logContent).toContain('[ERROR] Approval failed (create-pr): gh auth token expired');
  });

  it('preserves structured error codes in eventExtra when present', async () => {
    const execErr: Error & { code?: string } = new Error('rate limit exceeded');
    execErr.code = 'RATE_LIMIT';
    ctx.deps.executePhase.mockRejectedValueOnce(execErr);

    await expect(
      approveTask('task-1', 'local-merge', ctx.deps as any),
    ).rejects.toThrow('rate limit exceeded');

    const rollback = ctx.advancePhaseCalls[1];
    expect(rollback.eventExtra!.approvalError).toBe('rate limit exceeded');
    expect(rollback.eventExtra!.errorCode).toBe('RATE_LIMIT');
  });

  it('handles non-Error rejections and still logs a String representation', async () => {
    ctx.deps.executePhase.mockRejectedValueOnce('plain string rejection');

    await expect(
      approveTask('task-1', 'local-merge', ctx.deps as any),
    ).rejects.toBe('plain string rejection');

    const rollback = ctx.advancePhaseCalls[1];
    expect(rollback.eventExtra!.approvalError).toBe('plain string rejection');
    // No errorCode for non-Error — the check is `'code' in err`.

    const logContent = readFileSync(join(ctx.specPath, 'output.log'), 'utf-8');
    expect(logContent).toContain('[ERROR] Approval failed (merge): plain string rejection');
  });

  it('does not mutate the global pipeline state before rolling back', async () => {
    // When executePhase throws, the pipeline is rolled back to awaiting-review.
    // The intermediate next-phase advance must be undone.
    const execErr = new Error('rebase conflict');
    ctx.deps.executePhase.mockRejectedValueOnce(execErr);

    await expect(
      approveTask('task-1', 'pull-request', ctx.deps as any),
    ).rejects.toThrow('rebase conflict');

    // After rollback, pipeline.phase must be 'awaiting-review'.
    expect(ctx.pipeline.phase).toBe('awaiting-review');
  });
});