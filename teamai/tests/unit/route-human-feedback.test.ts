// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import {
  routeHumanFeedback,
  trimArtifactsForTarget,
} from '../../src/lib/orchestrator/review-actions';
import type { FeedbackTarget } from '../../src/lib/orchestrator/human-feedback';

const QA_ARTIFACTS = [
  'qa_report.json',
  'qa_feedback.md',
  'completion_summary.md',
  'qa_report_before_bounce.json',
  'qa_report_before_failed.json',
];

function makeCtx() {
  const root = join(tmpdir(), `teamai-route-${randomUUID().slice(0, 8)}`);
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

  const deps = {
    taskStore: {
      getById: () => ({ id: 'task-1', description: 'd', phase: 'awaiting-review' }),
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

function seedArtifacts(specPath: string) {
  writeFileSync(join(specPath, 'spec.md'), '# spec');
  writeFileSync(join(specPath, 'plan.json'), '{}');
  writeFileSync(join(specPath, 'qa_report.json'), JSON.stringify({ overall: 'PASS', criteria: [] }));
  for (const f of QA_ARTIFACTS) {
    if (f === 'qa_report.json') continue;
    writeFileSync(join(specPath, f), 'stale');
  }
}

describe('trimArtifactsForTarget', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    seedArtifacts(ctx.specPath);
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('deletes nothing for a coder target', () => {
    trimArtifactsForTarget(ctx.specPath, 'coder');
    expect(existsSync(join(ctx.specPath, 'spec.md'))).toBe(true);
    expect(existsSync(join(ctx.specPath, 'plan.json'))).toBe(true);
    for (const f of QA_ARTIFACTS) expect(existsSync(join(ctx.specPath, f))).toBe(true);
  });

  for (const target of ['analyst', 'planner', 'qa-reviewer'] as const) {
    it(`clears only QA artifacts for a ${target} target, preserving spec and plan`, () => {
      trimArtifactsForTarget(ctx.specPath, target);
      expect(existsSync(join(ctx.specPath, 'spec.md'))).toBe(true);
      expect(existsSync(join(ctx.specPath, 'plan.json'))).toBe(true);
      for (const f of QA_ARTIFACTS) expect(existsSync(join(ctx.specPath, f))).toBe(false);
    });
  }
});

describe('routeHumanFeedback', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  const cases: [FeedbackTarget, string][] = [
    ['analyst', 'spec'],
    ['planner', 'plan'],
    ['coder', 'implement'],
    ['qa-reviewer', 'qa-review'],
  ];

  it.each(cases)('routes a %s target to the %s phase and writes the feedback', async (target, phase) => {
    await routeHumanFeedback(ctx.pipeline, ctx.deps as never, {
      target,
      message: 'Do the thing',
    });

    expect(ctx.pipeline.phase).toBe(phase);
    expect(ctx.deps.executePhase).toHaveBeenCalledTimes(1);
    const raw = readFileSync(join(ctx.specPath, 'human_feedback.md'), 'utf-8');
    expect(raw).toContain(`Target: ${target}`);
    expect(raw).toContain('Do the thing');
  });

  it('records a change request when qa_report.json exists', async () => {
    writeFileSync(join(ctx.specPath, 'qa_report.json'), JSON.stringify({ overall: 'PASS', criteria: [] }));
    await routeHumanFeedback(ctx.pipeline, ctx.deps as never, {
      target: 'coder',
      message: 'Fix the auth module',
    });
    const report = JSON.parse(readFileSync(join(ctx.specPath, 'qa_report.json'), 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria).toEqual([
      { name: 'Change Request', status: 'FAIL', notes: 'Fix the auth module' },
    ]);
  });

  it('preserves plan.json when routing to the analyst (no blind cleanup)', async () => {
    seedArtifacts(ctx.specPath);
    await routeHumanFeedback(ctx.pipeline, ctx.deps as never, {
      target: 'analyst',
      message: 'Derive the formula from first principles',
    });
    expect(existsSync(join(ctx.specPath, 'plan.json'))).toBe(true);
    expect(existsSync(join(ctx.specPath, 'spec.md'))).toBe(true);
  });
});
