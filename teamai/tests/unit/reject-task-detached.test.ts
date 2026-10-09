// @vitest-environment node

/**
 * rejectTask must resolve as soon as the pipeline has advanced to the resume
 * phase, not when the rework run finishes — otherwise the server action stays
 * pending and Next.js queues the board's router.refresh() behind it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockError } = vi.hoisted(() => ({ mockError: vi.fn() }));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(),
  warn: vi.fn(),
  error: mockError,
  info: vi.fn(),
}));

import { rejectTask } from '../../src/lib/orchestrator/review-actions';

function makeDeps(executePhase: () => Promise<void>) {
  const root = join(tmpdir(), `teamai-reject-detached-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  mkdirSync(specPath, { recursive: true });
  const pipeline = {
    taskId: 'task-1',
    phase: 'awaiting-review',
    specPath,
    qaAttempt: 1,
    deliverableFailCounts: {},
    persistedCriterionFailCounts: {},
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
    advancePhase: vi.fn((p: { phase: string }, phase: string) => { p.phase = phase; }),
    executePhase: vi.fn(executePhase),
    savePipelineState: vi.fn(),
    writeCompletionSummary: vi.fn(),
  };
  return { root, specPath, pipeline, deps };
}

describe('rejectTask — does not await the rework run', () => {
  let root: string | undefined;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

  it('resolves after advancePhase while executePhase is still running', async () => {
    let finish!: () => void;
    const h = makeDeps(() => new Promise<void>(r => { finish = r; }));
    root = h.root;

    await rejectTask('task-1', 'fix it', 'qa-reviewer', undefined, h.deps as never);

    expect(h.deps.advancePhase).toHaveBeenCalledWith(h.pipeline, 'qa-review');
    expect(h.deps.executePhase).toHaveBeenCalledTimes(1);
    finish();
  });

  it('logs rework failures instead of leaving an unhandled rejection', async () => {
    const h = makeDeps(async () => { throw new Error('boom'); });
    root = h.root;

    await rejectTask('task-1', 'fix it', 'qa-reviewer', undefined, h.deps as never);
    await new Promise(r => setTimeout(r, 10));

    expect(mockError).toHaveBeenCalled();
    expect(readFileSync(join(h.specPath, 'output.log'), 'utf-8')).toContain('Rework after reject failed: boom');
  });

  it('still rejects synchronously on a disallowed phase', async () => {
    const h = makeDeps(async () => undefined);
    root = h.root;
    h.deps.taskStore.getById = () => ({ id: 'task-1', description: 'd', phase: 'backlog' });
    await expect(rejectTask('task-1', 'x', 'coder', undefined, h.deps as never)).rejects.toThrow();
    expect(h.deps.executePhase).not.toHaveBeenCalled();
  });
});
