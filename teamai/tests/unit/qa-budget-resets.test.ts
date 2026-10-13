// @vitest-environment node

/**
 * QA budget resets (AC13, AC14): a spec revision restarts only the stall
 * counter + round history (qaRoundCount, the hard cap, survives); a human
 * Request Changes to any other target, or a reject, resets both budgets.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { autoReviseSpec, routeHumanFeedback, rejectTask } from '../../src/lib/orchestrator/review-actions';
import { savePipelineState } from '../../src/lib/orchestrator/pipeline-state';
import { processManager } from '../../src/lib/process-manager';

const HISTORY = [
  { round: 1, failedCriteria: ['AC1'], passedCriteria: ['AC2'], failedIssues: [] },
  { round: 2, failedCriteria: ['AC3'], passedCriteria: ['AC1', 'AC2'], failedIssues: [] },
];

function makeCtx() {
  const root = join(tmpdir(), `teamai-qa-budget-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  mkdirSync(specPath, { recursive: true });
  writeFileSync(join(specPath, 'spec.md'), '# spec');
  writeFileSync(join(specPath, 'plan.json'), '{}');

  const pipeline = {
    taskId: 'task-1',
    title: 't',
    description: 'd',
    phase: 'awaiting-review',
    specPath,
    worktreePath: join(specPath, '..', 'wt'),
    branch: 'feat/test',
    qaAttempt: 2,
    qaRoundCount: 5,
    qaStallCount: 2,
    qaRoundHistory: structuredClone(HISTORY),
    maxQaAttempts: 3,
    maxQaRounds: 9,
    specRevision: 1,
    qaRevision: 0,
    deliverableFailCounts: {},
    persistedCriterionFailCounts: { AC3: 2 },
    wakeupAttemptCount: 0,
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
    savePipelineState,
  };
  const originalEmit = processManager.emit;
  processManager.emit = vi.fn() as typeof processManager.emit;

  return { root, specPath, pipeline, deps, originalEmit };
}

function readState(specPath: string) {
  return JSON.parse(readFileSync(join(specPath, '.pipeline_state.json'), 'utf-8'));
}

describe('QA budget resets', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => { ctx = makeCtx(); });
  afterEach(() => {
    processManager.emit = ctx.originalEmit;
    rmSync(ctx.root, { recursive: true, force: true });
  });

  describe('AC13 — spec revision resets the stall counter only', () => {
    it('autoReviseSpec zeroes stall + history, keeps qaRoundCount', async () => {
      await autoReviseSpec(ctx.pipeline as never, ctx.deps as never);

      expect(ctx.pipeline.qaStallCount).toBe(0);
      expect(ctx.pipeline.qaRoundHistory).toEqual([]);
      expect(ctx.pipeline.qaRoundCount).toBe(5);
      expect(ctx.pipeline.persistedCriterionFailCounts).toEqual({ AC3: 2 });

      const state = readState(ctx.specPath);
      expect(state.qaStallCount).toBe(0);
      expect(state.qaRoundHistory).toEqual([]);
      expect(state.qaRoundCount).toBe(5);
    });

    it('routeHumanFeedback to the analyst zeroes stall + history, keeps qaRoundCount', async () => {
      await routeHumanFeedback(ctx.pipeline as never, ctx.deps as never, { target: 'analyst', message: 'fix spec' });

      expect(ctx.pipeline.qaStallCount).toBe(0);
      expect(ctx.pipeline.qaRoundHistory).toEqual([]);
      expect(ctx.pipeline.qaRoundCount).toBe(5);

      const state = readState(ctx.specPath);
      expect(state.qaStallCount).toBe(0);
      expect(state.qaRoundHistory).toEqual([]);
      expect(state.qaRoundCount).toBe(5);
    });
  });

  describe('AC14 — human Request Changes (non-analyst) and reject reset both budgets', () => {
    it('routeHumanFeedback to the coder resets stall, history and qaRoundCount', async () => {
      await routeHumanFeedback(ctx.pipeline as never, ctx.deps as never, { target: 'coder', message: 'fix it' });

      expect(ctx.pipeline.qaStallCount).toBe(0);
      expect(ctx.pipeline.qaRoundHistory).toEqual([]);
      expect(ctx.pipeline.qaRoundCount).toBe(0);
      expect(ctx.pipeline.qaAttempt).toBe(0);
    });

    it('rejectTask resets stall, history and qaRoundCount', async () => {
      await rejectTask('task-1', 'redo', 'coder', undefined, ctx.deps as never);

      expect(ctx.pipeline.qaStallCount).toBe(0);
      expect(ctx.pipeline.qaRoundHistory).toEqual([]);
      expect(ctx.pipeline.qaRoundCount).toBe(0);
    });
  });

  describe('Retry', () => {
    it('removes .pipeline_state.json so the next run starts with fresh budgets', async () => {
      savePipelineState(ctx.pipeline as never);
      expect(existsSync(join(ctx.specPath, '.pipeline_state.json'))).toBe(true);

      const { Orchestrator } = await import('../../src/lib/orchestrator');
      Orchestrator.prototype.clearPipelineStateFile.call({}, ctx.specPath);

      expect(existsSync(join(ctx.specPath, '.pipeline_state.json'))).toBe(false);
    });
  });
});
