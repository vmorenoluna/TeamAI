// @vitest-environment node

/**
 * runQaReview budget wiring (AC7-AC12, AC15): the stall counter resets on
 * progress, the round cap never resets, pipeline-written rounds are no
 * progress, a PASS never fails on budget, the budget is checked before
 * spec-concern routing, and rate-limited rounds are free.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), error: vi.fn(), warn: vi.fn(),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    createSession: vi.fn(async () => 'sess-qa'),
    sendMessage: vi.fn(),
    killSession: vi.fn(),
  },
}));

vi.mock('../../src/lib/orchestrator/phase-runners', () => ({
  syncPhaseBaseline: vi.fn(async () => undefined),
}));

import { runQaReview } from '../../src/lib/orchestrator/qa-review';
import { RateLimitError } from '../../src/lib/orchestrator/rate-limit';

type AnyPipeline = any;

const roundRecord = (round: number, failedCriteria: string[], passedCriteria: string[] = []) =>
  ({ round, failedCriteria, passedCriteria, failedIssues: [] as string[] });

function fail(...ids: string[]) {
  return { overall: 'FAIL', criteria: ids.map(id => ({ id, criterion: id, status: 'FAIL', fix_needed: 'fix' })) };
}

/** FAIL report over a fixed criteria set: listed ids fail, the rest explicitly pass. */
function failOf(all: string[], failing: string[]) {
  return {
    overall: 'FAIL',
    criteria: all.map(id => failing.includes(id)
      ? { id, criterion: id, status: 'FAIL', fix_needed: 'fix' }
      : { id, criterion: id, status: 'PASS' }),
  };
}

describe('runQaReview — stall counter and hard cap', () => {
  let root: string;
  let specPath: string;
  let report: unknown;
  let waitError: Error | null;
  let deps: AnyPipeline;

  function makePipeline(overrides: Record<string, unknown> = {}): AnyPipeline {
    return {
      taskId: 'task-1',
      description: 'd',
      phase: 'qa-review',
      specPath,
      worktreePath: root,
      branch: 'feat/test',
      qaAttempt: 0,
      qaRoundCount: 0,
      qaStallCount: 0,
      qaRoundHistory: [],
      qaRevision: 0,
      specRevision: 1,
      maxQaAttempts: 3,
      maxQaRounds: 9,
      ...overrides,
    };
  }

  const output = () => readFileSync(join(specPath, 'output.log'), 'utf-8');

  beforeEach(() => {
    vi.clearAllMocks();
    root = join(tmpdir(), `teamai-qa-budget-run-${randomUUID().slice(0, 8)}`);
    specPath = join(root, 'task-slug');
    mkdirSync(specPath, { recursive: true });
    report = fail('AC1');
    waitError = null;
    mockExecFileSync.mockReturnValue('');
    deps = {
      projectRoot: root,
      persistAndEmitPhase: vi.fn(),
      advancePhase: vi.fn((p: AnyPipeline, phase: string) => { p.phase = phase; }),
      savePipelineState: vi.fn(),
      executePhase: vi.fn(async () => undefined),
      sessionOpts: vi.fn(() => ({})),
      waitForCompletion: vi.fn(async () => {
        if (waitError) throw waitError;
        if (report !== undefined) writeFileSync(join(specPath, 'qa_report.json'), JSON.stringify(report));
      }),
      gitPush: vi.fn(),
      execGit: vi.fn(),
      execGitCapture: vi.fn(() => ''),
      writeQaFeedback: vi.fn(),
      writeCompletionSummary: vi.fn(),
      phaseHeader: vi.fn(),
      toAgentPath: (p: string) => p,
      autoReviseSpec: vi.fn(async () => undefined),
      planWriteLock: { current: Promise.resolve() },
      getPipelineConfig: () => ({ maxImplementRetries: 3 }),
      scheduleWakeup: vi.fn(),
    };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('AC7: a converging task outlives maxQaAttempts rounds', async () => {
    const pipeline = makePipeline({ maxQaAttempts: 2, maxQaRounds: 8 });
    const rounds = [['AC1', 'AC2', 'AC3', 'AC4'], ['AC2', 'AC3', 'AC4'], ['AC3', 'AC4'], ['AC4']];
    for (const failing of rounds) {
      report = failOf(['AC1', 'AC2', 'AC3', 'AC4'], failing);
      await runQaReview(pipeline, deps);
    }
    expect(pipeline.qaRoundCount).toBe(4);
    expect(pipeline.qaStallCount).toBe(0);
    expect(pipeline.phase).not.toBe('failed');
    expect(deps.writeCompletionSummary).not.toHaveBeenCalled();
    expect(deps.executePhase).toHaveBeenCalledTimes(4);
    expect(pipeline.qaRoundHistory).toHaveLength(4);
    expect(output()).toContain('[QA-BUDGET] round 4/8: progress');
    expect(output()).toContain('stall 0/2');
  });

  it('AC8: consecutive no-progress rounds exhaust the stall budget', async () => {
    const pipeline = makePipeline({ maxQaAttempts: 2 });
    report = fail('AC1');
    await runQaReview(pipeline, deps); // first appearance — no earlier round to beat
    const afterFirst = pipeline.qaStallCount;
    await runQaReview(pipeline, deps); // identical failure set — no progress
    expect(afterFirst).toBeLessThan(2);
    expect(pipeline.qaStallCount).toBe(2);
    expect(pipeline.phase).toBe('failed');
    expect(deps.writeCompletionSummary).toHaveBeenCalledWith(pipeline, 'qa-attempts-exhausted', 'stall');
    expect(output()).toContain('[QA-BUDGET] stall budget exhausted (2/2 consecutive rounds without progress)');
  });

  it('AC9: the hard cap fails the task even when the stall counter keeps resetting', async () => {
    const pipeline = makePipeline({
      maxQaAttempts: 3,
      maxQaRounds: 4,
      qaRoundCount: 3,
      qaAttempt: 3,
      qaRoundHistory: [
        roundRecord(1, ['AC1', 'AC2', 'AC3', 'AC4']),
        roundRecord(2, ['AC2', 'AC3', 'AC4'], ['AC1']),
        roundRecord(3, ['AC3', 'AC4'], ['AC1', 'AC2']),
      ],
    });
    // AC3 is resolved this round — progress, so the stall counter resets.
    report = { overall: 'FAIL', criteria: [
      { id: 'AC1', criterion: 'AC1', status: 'PASS' },
      { id: 'AC2', criterion: 'AC2', status: 'PASS' },
      { id: 'AC3', criterion: 'AC3', status: 'PASS' },
      { id: 'AC4', criterion: 'AC4', status: 'FAIL', fix_needed: 'fix' },
    ] };
    await runQaReview(pipeline, deps);
    expect(pipeline.qaRoundCount).toBe(4);
    expect(pipeline.qaStallCount).toBe(0); // progress: AC3 resolved
    expect(pipeline.phase).toBe('failed');
    expect(deps.writeCompletionSummary).toHaveBeenCalledWith(pipeline, 'qa-attempts-exhausted', 'rounds');
    expect(output()).toContain('[QA-BUDGET] round cap reached (4/4)');
    expect(deps.executePhase).not.toHaveBeenCalled();
  });

  it('AC10: an unreadable report counts as no progress and is not added to history', async () => {
    const pipeline = makePipeline({ maxQaAttempts: 2, qaStallCount: 1 });
    report = undefined; // QA wrote nothing
    await runQaReview(pipeline, deps);
    expect(pipeline.qaStallCount).toBe(2);
    expect(pipeline.qaRoundHistory).toEqual([]);
    expect(pipeline.phase).toBe('failed');
    expect(output()).toContain('no progress (pipeline-written report (unreadable)); stall 2/2');
  });

  it('AC10: an unpushed-commits precheck round counts as no progress and is not added to history', async () => {
    const pipeline = makePipeline({ maxQaAttempts: 3, qaStallCount: 1 });
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => (args?.[0] === 'log' ? 'abc1234 wip\n' : ''));
    deps.gitPush = vi.fn(() => { throw new Error('auth failed'); });
    await runQaReview(pipeline, deps);
    expect(pipeline.qaStallCount).toBe(2);
    expect(pipeline.qaRoundHistory).toEqual([]);
    expect(deps.waitForCompletion).not.toHaveBeenCalled();
    expect(deps.executePhase).toHaveBeenCalledTimes(1); // bounced to implement
    expect(output()).toContain('pipeline-written report (unpushed commits)); stall 2/3');
  });

  it('AC10: an IN_PROGRESS report counts as no progress, re-runs QA, and fails as qa-incomplete when exhausted', async () => {
    const pipeline = makePipeline({ maxQaAttempts: 2, qaStallCount: 0 });
    report = { overall: 'IN_PROGRESS', criteria: [] };
    await runQaReview(pipeline, deps);
    expect(pipeline.qaStallCount).toBe(1);
    expect(pipeline.qaRoundHistory).toEqual([]);
    expect(deps.executePhase).toHaveBeenCalledTimes(1);
    expect(deps.savePipelineState).toHaveBeenCalled();

    await runQaReview(pipeline, deps);
    expect(pipeline.qaStallCount).toBe(2);
    expect(deps.writeCompletionSummary).toHaveBeenCalledWith(pipeline, 'qa-incomplete', 'stall');
    expect(pipeline.phase).toBe('failed');
  });

  it('AC11: a PASS never fails on budget, even with both budgets spent', async () => {
    const pipeline = makePipeline({ maxQaAttempts: 2, qaStallCount: 2, qaRoundCount: 9, qaAttempt: 9 });
    report = { overall: 'PASS', criteria: [{ id: 'AC1', criterion: 'AC1', status: 'PASS' }] };
    await runQaReview(pipeline, deps);
    expect(pipeline.phase).toBe('awaiting-review');
    expect(pipeline.qaStallCount).toBe(2); // left alone
    expect(pipeline.qaRoundHistory).toHaveLength(1);
    expect(deps.writeCompletionSummary).not.toHaveBeenCalled();
  });

  it('AC12: the budget is checked before spec-concern routing', async () => {
    const pipeline = makePipeline({
      maxQaAttempts: 2,
      qaStallCount: 1,
      qaRoundHistory: [roundRecord(1, ['AC1'])],
      qaRoundCount: 1,
    });
    report = { ...fail('AC1'), spec_concerns: [{ issue: 'x', reasoning: 'y' }] };
    await runQaReview(pipeline, deps);
    expect(pipeline.phase).toBe('failed');
    expect(deps.autoReviseSpec).not.toHaveBeenCalled();
  });

  it('AC12: with budget left, spec concerns still route to autoReviseSpec', async () => {
    const pipeline = makePipeline();
    report = { ...fail('AC1'), spec_concerns: [{ issue: 'x', reasoning: 'y' }] };
    await runQaReview(pipeline, deps);
    expect(deps.autoReviseSpec).toHaveBeenCalledTimes(1);
    expect(pipeline.phase).not.toBe('failed');
  });

  it('AC15: a rate limit during the QA session gives back the round it took', async () => {
    const pipeline = makePipeline({ qaAttempt: 1, qaRoundCount: 1, qaStallCount: 1, qaRoundHistory: [roundRecord(1, ['AC1'])] });
    waitError = new RateLimitError(Math.floor(Date.now() / 1000) + 60);
    await expect(runQaReview(pipeline, deps)).rejects.toBeInstanceOf(RateLimitError);
    expect(pipeline.qaAttempt).toBe(1);
    expect(pipeline.qaRoundCount).toBe(1);
    expect(pipeline.qaStallCount).toBe(1);
    expect(pipeline.qaRoundHistory).toHaveLength(1);
    expect(deps.savePipelineState).toHaveBeenLastCalledWith(pipeline);
  });

  it('AC15: a rate limit on a wakeup re-entry decrements nothing', async () => {
    const pipeline = makePipeline({
      qaAttempt: 1, qaRoundCount: 1, wakeupCommand: 'sleep 1', wakeupArtifact: 'x.log',
    });
    waitError = new RateLimitError(Math.floor(Date.now() / 1000) + 60);
    await expect(runQaReview(pipeline, deps)).rejects.toBeInstanceOf(RateLimitError);
    expect(pipeline.qaAttempt).toBe(1);
    expect(pipeline.qaRoundCount).toBe(1);
  });

  it('AC15: a rate limit after the outcome was recorded does not decrement again', async () => {
    const pipeline = makePipeline();
    report = fail('AC1');
    deps.executePhase = vi.fn(async () => { throw new RateLimitError(Math.floor(Date.now() / 1000) + 60); });
    await expect(runQaReview(pipeline, deps)).rejects.toBeInstanceOf(RateLimitError);
    expect(pipeline.qaRoundCount).toBe(1);
    expect(pipeline.qaAttempt).toBe(1);
  });

  it('AC15: a non-rate-limit error leaves the counters alone', async () => {
    const pipeline = makePipeline();
    waitError = new Error('boom');
    await expect(runQaReview(pipeline, deps)).rejects.toThrow('boom');
    expect(pipeline.qaRoundCount).toBe(1);
  });
});
