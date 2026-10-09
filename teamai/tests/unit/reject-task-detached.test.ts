// @vitest-environment node

/**
 * rejectTask must resolve as soon as the pipeline has advanced to the resume
 * phase, handing the rework to the orchestrator's shared run lifecycle
 * (startRun) instead of awaiting it — otherwise the server action stays
 * pending and Next.js queues the board's router.refresh() behind it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { rejectTask } from '../../src/lib/orchestrator/review-actions';

function makeDeps() {
  const root = join(tmpdir(), `teamai-reject-detached-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  mkdirSync(specPath, { recursive: true });
  writeFileSync(join(specPath, 'spec.md'), '# Spec');
  const pipeline = {
    taskId: 'task-1',
    phase: 'awaiting-review',
    specPath,
    qaAttempt: 1,
    specRevision: 1,
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
    executePhase: vi.fn(),
    startRun: vi.fn(),
    savePipelineState: vi.fn(),
    writeCompletionSummary: vi.fn(),
  };
  return { root, specPath, pipeline, deps };
}

describe('rejectTask — hands the rework to the shared run lifecycle', () => {
  let root: string | undefined;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

  // Every reject target must resume at its own phase and start exactly one
  // run. The analyst path goes through beginSpecRevision (needs an existing
  // spec.md), the others through the generic resume branch.
  it.each([
    ['analyst', 'spec'],
    ['planner', 'plan'],
    ['coder', 'implement'],
    ['qa-reviewer', 'qa-review'],
  ] as const)('target %s: advances to %s then starts one run without awaiting it', async (target, resumePhase) => {
    const h = makeDeps();
    root = h.root;

    await rejectTask('task-1', 'fix it', target, undefined, h.deps as never);

    expect(h.deps.advancePhase).toHaveBeenCalledWith(h.pipeline, resumePhase);
    expect(h.deps.startRun).toHaveBeenCalledTimes(1);
    expect(h.deps.startRun).toHaveBeenCalledWith(h.pipeline);
    // The run is the orchestrator's to execute and own; review-actions never awaits it.
    expect(h.deps.executePhase).not.toHaveBeenCalled();
  });

  it('clears the previous failure summary and reason before the rework starts', async () => {
    const h = makeDeps();
    root = h.root;

    await rejectTask('task-1', 'fix it', 'coder', undefined, h.deps as never);

    expect(h.deps.taskStore.update).toHaveBeenCalledWith('task-1', { completionSummary: undefined, failureReason: undefined });
  });

  it('still rejects synchronously on a disallowed phase', async () => {
    const h = makeDeps();
    root = h.root;
    h.deps.taskStore.getById = () => ({ id: 'task-1', description: 'd', phase: 'backlog' });
    await expect(rejectTask('task-1', 'x', 'coder', undefined, h.deps as never)).rejects.toThrow();
    expect(h.deps.startRun).not.toHaveBeenCalled();
  });
});
