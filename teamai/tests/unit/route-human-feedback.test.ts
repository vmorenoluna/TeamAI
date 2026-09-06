// @vitest-environment node

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import {
  routeHumanFeedback,
  rejectTask,
  trimArtifactsForTarget,
} from '../../src/lib/orchestrator/review-actions';
import type { FeedbackTarget } from '../../src/lib/orchestrator/human-feedback';
import { processManager } from '../../src/lib/process-manager';

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
    savePipelineState: vi.fn(),
  };
  // Silence the phase-change emit during tests — we only care about the
  // in-memory pipeline state and on-disk artifacts, not the event bus.
  const originalEmit = processManager.emit;
  processManager.emit = vi.fn() as typeof processManager.emit;

  return { root, specPath, pipeline, deps, originalEmit };
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
    processManager.emit = ctx.originalEmit;
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
    processManager.emit = ctx.originalEmit;
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

  it('records a change request when qa_report.json exists (coder target)', async () => {
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

  it('does not record a change request into qa_report.json for upstream targets', async () => {
    for (const target of ['analyst', 'planner', 'qa-reviewer'] as const) {
      seedArtifacts(ctx.specPath);
      await routeHumanFeedback(ctx.pipeline, ctx.deps as never, {
        target,
        message: 'Tighten the acceptance criteria',
      });
      // The change request lives in human_feedback.md for these targets; the QA
      // report is trimmed rather than carrying a throwaway "Change Request" entry.
      expect(existsSync(join(ctx.specPath, 'qa_report.json'))).toBe(false);
    }
  });

  it('writes reviewer-selected subtask ids into the feedback for a coder target', async () => {
    await routeHumanFeedback(ctx.pipeline, ctx.deps as never, {
      target: 'coder',
      message: 'Tighten error handling',
      subtaskIds: [2, 5],
    });
    const raw = readFileSync(join(ctx.specPath, 'human_feedback.md'), 'utf-8');
    expect(raw).toContain('Target: coder');
    expect(raw).toContain('Subtasks: 2,5');
    expect(raw).toContain('Tighten error handling');
  });

  it('preserves plan.json when routing to the analyst (no blind cleanup)', async () => {
    seedArtifacts(ctx.specPath);
    await routeHumanFeedback(ctx.pipeline, ctx.deps as never, {
      target: 'analyst',
      message: 'Derive the formula from first principles',
    });
    expect(existsSync(join(ctx.specPath, 'plan.json'))).toBe(true);
    // The pre-revision spec was renamed to spec_v1.md (the revision baseline)
    // — spec.md itself is absent until the analyst writes the revised spec.
    expect(existsSync(join(ctx.specPath, 'spec.md'))).toBe(false);
    expect(readFileSync(join(ctx.specPath, 'spec_v1.md'), 'utf-8')).toBe('# spec');
  });

  it('routes the analyst into revision mode: writes feedback + renames the pre-revision spec to spec_v{R-1}.md', async () => {
    seedArtifacts(ctx.specPath);
    await routeHumanFeedback(ctx.pipeline, ctx.deps as never, {
      target: 'analyst',
      message: 'Derive the formula from first principles',
    });

    // spec_revision_feedback.md triggers runSpecPhase's REVISION mode, so the
    // analyst revises the existing spec instead of regenerating it.
    expect(readFileSync(join(ctx.specPath, 'spec_revision_feedback.md'), 'utf-8')).toContain(
      'Derive the formula from first principles',
    );

    // The pre-revision spec is RENAMED to the previous version number — it
    // doubles as the version-history entry and the no-op guard's baseline
    // (the old spec_revision_before.md marker scheme is retired).
    expect(ctx.pipeline.specRevision).toBe(2);
    expect(readFileSync(join(ctx.specPath, 'spec_v1.md'), 'utf-8')).toBe('# spec');
    expect(existsSync(join(ctx.specPath, 'spec.md'))).toBe(false);
    expect(existsSync(join(ctx.specPath, 'spec_revision_before.md'))).toBe(false);
    // The revision has not completed — no spec_v2.md exists yet; the analyst
    // writes the revised spec to spec.md, which the versions UI surfaces live.
    expect(existsSync(join(ctx.specPath, 'spec_v2.md'))).toBe(false);
    expect(ctx.deps.savePipelineState).toHaveBeenCalled();
  });

  it('does NOT write revision feedback when routing to the analyst with no existing spec', async () => {
    // No spec.md seeded — the analyst should generate a fresh spec.
    await routeHumanFeedback(ctx.pipeline, ctx.deps as never, {
      target: 'analyst',
      message: 'Draft a new spec',
    });
    expect(existsSync(join(ctx.specPath, 'spec_revision_feedback.md'))).toBe(false);
    expect(ctx.pipeline.specRevision).toBe(1);
  });
});

describe('rejectTask — Request Changes → Planner with subtask scoping from pr-open', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    // The task is already in pr-open (a live PR exists on GitHub). rejectTask
    // gates on the taskStore phase, so both it and the pipeline must agree.
    ctx.pipeline.phase = 'pr-open';
    ctx.deps.taskStore.getById = () => ({ id: 'task-1', description: 'd', phase: 'pr-open' });
    // Reflect a realistic pr-open task: plan.json exists with subtasks to scope.
    writeFileSync(join(ctx.specPath, 'spec.md'), '# spec');
    writeFileSync(join(ctx.specPath, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'A', files: ['src/a.ts'], acceptance_criteria: ['a'] },
        { id: 2, title: 'B', files: ['src/b.ts'], acceptance_criteria: ['b'] },
        { id: 5, title: 'E', files: ['src/e.ts'], acceptance_criteria: ['e'] },
      ],
    }));
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
    processManager.emit = ctx.originalEmit;
  });

  it('writes the planner Subtasks: directive and resumes at plan (same code path as awaiting-review)', async () => {
    await rejectTask('task-1', 'Re-plan only the migration subtask', 'planner', [2, 5], ctx.deps as never);

    // The reviewer's subtask selection is carried into the directive verbatim.
    const raw = readFileSync(join(ctx.specPath, 'human_feedback.md'), 'utf-8');
    expect(raw).toContain('Target: planner');
    expect(raw).toContain('Subtasks: 2,5');
    expect(raw).toContain('Re-plan only the migration subtask');

    // The pipeline resumes at the planner's phase, not create-pr or anything
    // PR-specific — no duplicate PR is created; the existing PR is reused.
    expect(ctx.pipeline.phase).toBe('plan');
    expect(ctx.deps.executePhase).toHaveBeenCalledTimes(1);
  });

  it('rejects subtask scoping for planner only if the task is awaiting-review, pr-open, or failed', async () => {
    ctx.deps.taskStore.getById = () => ({ id: 'task-1', description: 'd', phase: 'implement' });
    await expect(
      rejectTask('task-1', 'Scope this', 'planner', [1], ctx.deps as never),
    ).rejects.toThrow('awaiting-review, pr-open, or failed');
  });
});

describe('rejectTask from a failed task', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    ctx = makeCtx();
    // A task that exhausted its spec-revision budget (or QA-attempt budget)
    // lands in `failed`, not `awaiting-review` — reject must still work from
    // there, since redirecting feedback to an agent (most often the analyst,
    // for a spec-revision-exhausted task) is the primary recovery action.
    ctx.pipeline.phase = 'failed';
    ctx.deps.taskStore.getById = () => ({ id: 'task-1', description: 'd', phase: 'failed' });
    writeFileSync(join(ctx.specPath, 'spec.md'), '# spec');
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
    processManager.emit = ctx.originalEmit;
  });

  it('routes feedback to the analyst from a failed task, same as from awaiting-review', async () => {
    await rejectTask('task-1', 'The weight-scaling approach does not converge — redesign the constraint', 'analyst', undefined, ctx.deps as never);

    const raw = readFileSync(join(ctx.specPath, 'human_feedback.md'), 'utf-8');
    expect(raw).toContain('Target: analyst');
    expect(raw).toContain('redesign the constraint');
    expect(ctx.pipeline.phase).toBe('spec');
    expect(ctx.deps.executePhase).toHaveBeenCalledTimes(1);
  });

  it('still rejects a phase that is neither awaiting-review, pr-open, nor failed', async () => {
    ctx.deps.taskStore.getById = () => ({ id: 'task-1', description: 'd', phase: 'implement' });
    await expect(
      rejectTask('task-1', 'x', 'coder', undefined, ctx.deps as never),
    ).rejects.toThrow('awaiting-review, pr-open, or failed');
  });
});
