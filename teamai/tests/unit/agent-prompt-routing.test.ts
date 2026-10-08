// @vitest-environment node

/**
 * Agent prompt routing — characterization of every orchestrator → agent
 * message.
 *
 * For each pipeline state that spawns an agent session, pins:
 *   - which work mode the state selects (fresh spec vs revision, plan vs
 *     replan, implement vs QA-rework, ...)
 *   - the session role and working directory
 *   - the header blocks (wakeup re-entry, deliverable re-verification,
 *     stall recovery, human directive) and the paths/context the agent needs
 *
 * These are the decisions an in-flight task depends on when TeamAI is
 * upgraded mid-pipeline: the same on-disk state (spec_revision_feedback.md,
 * an existing plan.json, qa_feedback.md, a persisted wakeup) must keep
 * selecting the same work with the same inputs. How a mode is encoded on the
 * wire is deliberately NOT pinned here — see tests/utils/agent-prompts.ts.
 *
 * No real agent runs: processManager is mocked and every session "ends" via a
 * stubbed waitForCompletion.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockCreateSession, mockSendMessage, mockKillSession, mockExecFileSync } = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
  mockSendMessage: vi.fn(),
  mockKillSession: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    killSession: (...args: unknown[]) => mockKillSession(...args),
    getSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    getStaleSessions: vi.fn(() => []),
    removeStaleSession: vi.fn(),
    getTerminalSessions: vi.fn(() => []),
    killTerminalSession: vi.fn(),
    writeToSession: vi.fn(),
    terminateSession: vi.fn(),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: { ensureContainer: vi.fn(), getRunningContainer: vi.fn(() => null) },
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

import { runSpecPhase, runPlanPhase, runMergePhase, rebaseOntoLatestDefault } from '../../src/lib/orchestrator/phase-runners';
import { runQaReview } from '../../src/lib/orchestrator/qa-review';
import {
  runSubtaskSession, selectSubtasks, tryCherryPickWithRecovery, buildSyntheticReworkDescription,
} from '../../src/lib/orchestrator/implement';
import { SessionKilledError } from '../../src/lib/orchestrator/errors';
import { promptMode, requestOf } from '../utils/agent-prompts';

// ── Harness ────────────────────────────────────────────────────────────────

/** Thrown by a stubbed waitForCompletion to end a runner right after its
 *  message was captured, so no post-session path runs. */
class StopAfterSend extends Error {}

const stopAfterSend = () => vi.fn(async () => { throw new StopAfterSend(); });

interface Ctx { root: string; specPath: string; worktreePath: string }

function makeCtx(): Ctx {
  const root = join(tmpdir(), `teamai-routing-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, '.teamai', 'task-slug');
  mkdirSync(specPath, { recursive: true });
  return { root, specPath, worktreePath: join(root, '.worktrees', 'task-slug') };
}

function basePipeline(ctx: Ctx, phase: string, overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task-1',
    title: 'Build the thing',
    description: 'Build the thing',
    phase,
    specPath: ctx.specPath,
    worktreePath: ctx.worktreePath,
    branch: 'feat/build-the-thing',
    qaAttempt: 0,
    maxQaAttempts: 3,
    specRevision: 1,
    qaRevision: 0,
    sessionId: undefined as string | undefined,
    ...overrides,
  };
}

const sessionOpts = (role: string, cwd: string, taskId: string) => ({ role, cwd, taskId });

function cascadeDeps(ctx: Ctx, overrides: Record<string, unknown> = {}) {
  return {
    projectRoot: ctx.root,
    persistAndEmitPhase: vi.fn(),
    sessionOpts,
    waitForCompletion: stopAfterSend(),
    advancePhase: (p: { phase: string }, phase: string) => { p.phase = phase; },
    rotateOutputLog: vi.fn(),
    phaseHeader: vi.fn(),
    savePipelineState: vi.fn(),
    toAgentPath: (p: string) => p,
    executePhase: vi.fn(async () => undefined),
    gitPush: vi.fn(),
    execGit: vi.fn(),
    execGitCapture: vi.fn(() => ''),
    getPipelineConfig: () => ({ wakeupScanRetryDelayMs: 0, maxImplementRetries: 3, maxQaAttempts: 3, parallelSubtasks: true }),
    scheduleWakeup: vi.fn(),
    writeCompletionSummary: vi.fn(),
    writeQaFeedback: vi.fn(),
    autoReviseSpec: vi.fn(async () => undefined),
    planWriteLock: { current: Promise.resolve() },
    removeWorktree: vi.fn(),
    buildTicketMessage: () => null,
    ...overrides,
  };
}

function implementDeps(ctx: Ctx, overrides: Record<string, unknown> = {}) {
  return {
    ...cascadeDeps(ctx),
    taskStore: { get: vi.fn(), update: vi.fn(), getAll: vi.fn(() => []) },
    patchWorktreeGitFile: vi.fn(),
    isWorktreeHealthy: () => true,
    cleanStaleSubtaskWorktrees: vi.fn(),
    restoreQaReportFromSnapshot: vi.fn(),
    restoreHumanFeedbackFromSnapshot: vi.fn(),
    getPipelineConfig: () => ({
      maxQaAttempts: 3, parallelSubtasks: true, maxImplementRetries: 3, maxStallRecoveries: 3,
      idleStallMinutes: 10, toolStallMinutes: 30, wakeupScanRetryDelayMs: 0,
    }),
    ...overrides,
  };
}

async function run(fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch (err) { if (!(err instanceof StopAfterSend)) throw err; }
}

/** The n-th session the runner spawned: its options, the full message sent
 *  to it, and the orchestrator-assembled request inside that message (the
 *  part content and header assertions are made against). */
function sent(n = 0): { role: string; cwd: string; message: string; request: string } {
  const opts = mockCreateSession.mock.calls[n][0] as { role: string; cwd: string };
  const message = mockSendMessage.mock.calls[n][1] as string;
  return { role: opts.role, cwd: opts.cwd, message, request: requestOf(message) };
}

function writeDirective(ctx: Ctx, target: string, body: string, subtasks?: string): void {
  writeFileSync(join(ctx.specPath, 'human_feedback.md'),
    `# Human Review Feedback\nTarget: ${target}\n${subtasks ? `Subtasks: ${subtasks}\n` : ''}\n${body}\n`);
}

const WAKEUP = {
  wakeupCommand: 'python scripts/long_job.py --out results/',
  wakeupArtifact: 'results/summary.jsonl',
  wakeupUntil: new Date(Date.now() + 3600_000).toISOString(),
};

let ctx: Ctx;

beforeEach(() => {
  vi.clearAllMocks();
  ctx = makeCtx();
  let n = 0;
  mockCreateSession.mockImplementation(async () => `sess-${++n}`);
  mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo'); });
});

afterEach(() => {
  try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

// ── Spec phase ─────────────────────────────────────────────────────────────

describe('spec phase routing', () => {
  it('fresh task → spec mode, analyst at the project root, with both output paths', async () => {
    await run(() => runSpecPhase(basePipeline(ctx, 'spec') as never, cascadeDeps(ctx) as never));

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const s = sent();
    expect(promptMode(s.message)).toBe('spec');
    expect(s.role).toBe('analyst');
    expect(s.cwd).toBe(ctx.root);
    expect(s.request).toContain('Build the thing');
    expect(s.request).toContain(`${ctx.specPath}/spec.md`);
    expect(s.request).toContain(`${ctx.specPath}/spec_summary.md`);
    expect(s.request).not.toContain('WAKEUP RE-ENTRY');
    expect(s.request).not.toContain('HUMAN DIRECTIVE');
  });

  it('spec_revision_feedback.md present → spec-revise mode reading the archived baseline and the feedback', async () => {
    writeFileSync(join(ctx.specPath, 'spec_revision_feedback.md'), 'concern 1');
    writeFileSync(join(ctx.specPath, 'spec_v1.md'), '# old spec');

    await run(() => runSpecPhase(basePipeline(ctx, 'spec', { specRevision: 2 }) as never, cascadeDeps(ctx) as never));

    const s = sent();
    expect(promptMode(s.message)).toBe('spec-revise');
    expect(s.role).toBe('analyst');
    expect(s.cwd).toBe(ctx.root);
    expect(s.request).toContain('Build the thing');
    expect(s.request).toContain(`${ctx.specPath}/spec_v1.md`);
    expect(s.request).toContain(`${ctx.specPath}/spec_revision_feedback.md`);
    expect(s.request).toContain(`${ctx.specPath}/spec.md`);
    expect(s.request).toContain(`${ctx.specPath}/spec_summary.md`);
  });

  it('revision with an analyst-targeted human directive → spec-revise mode carrying the override', async () => {
    writeFileSync(join(ctx.specPath, 'spec_revision_feedback.md'), 'concern 1');
    writeDirective(ctx, 'analyst', 'Derive the formula from first principles');

    await run(() => runSpecPhase(basePipeline(ctx, 'spec', { specRevision: 2 }) as never, cascadeDeps(ctx) as never));

    const s = sent();
    expect(promptMode(s.message)).toBe('spec-revise');
    expect(s.request).toContain('OVERRIDES EVERYTHING');
    expect(s.request).toContain('Derive the formula from first principles');
  });

  it('wakeup re-entry of a fresh spec → spec mode with the re-entry header for phase_wakeup.json', async () => {
    await run(() => runSpecPhase(basePipeline(ctx, 'spec', WAKEUP) as never, cascadeDeps(ctx) as never));

    const s = sent();
    expect(promptMode(s.message)).toBe('spec');
    expect(s.request).toContain('⚠️ WAKEUP RE-ENTRY');
    expect(s.request).toContain(WAKEUP.wakeupCommand);
    expect(s.request).toContain(WAKEUP.wakeupArtifact);
    expect(s.request).toContain('phase_wakeup.json');
  });

  it('wakeup re-entry of a revision → spec-revise mode with the re-entry header', async () => {
    writeFileSync(join(ctx.specPath, 'spec_revision_feedback.md'), 'concern 1');

    await run(() => runSpecPhase(basePipeline(ctx, 'spec', { specRevision: 2, ...WAKEUP }) as never, cascadeDeps(ctx) as never));

    const s = sent();
    expect(promptMode(s.message)).toBe('spec-revise');
    expect(s.request).toContain('⚠️ WAKEUP RE-ENTRY');
    expect(s.request).toContain(WAKEUP.wakeupCommand);
  });

  it('spec written without spec_summary.md → a spec-summary follow-up session that must not touch spec.md', async () => {
    const waitForCompletion = vi.fn()
      .mockImplementationOnce(async () => { writeFileSync(join(ctx.specPath, 'spec.md'), '# spec'); })
      .mockImplementationOnce(async () => { throw new StopAfterSend(); });

    await run(() => runSpecPhase(basePipeline(ctx, 'spec') as never, cascadeDeps(ctx, { waitForCompletion }) as never));

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    const s = sent(1);
    expect(promptMode(s.message)).toBe('spec-summary');
    expect(s.role).toBe('analyst');
    expect(s.cwd).toBe(ctx.root);
    expect(s.request).toContain(`${ctx.specPath}/spec.md`);
    expect(s.request).toContain(`${ctx.specPath}/spec_summary.md`);
    expect(s.request).toContain('Do not modify spec.md');
  });
});

// ── Plan phase ─────────────────────────────────────────────────────────────

describe('plan phase routing', () => {
  const existingPlan = () => writeFileSync(join(ctx.specPath, 'plan.json'), JSON.stringify({
    subtasks: [
      { id: 1, title: 'A', description: 'A', files: ['src/a.ts'], acceptance_criteria: ['a'], completed: true },
      { id: 2, title: 'B', description: 'B', files: ['src/b.ts'], acceptance_criteria: ['b'] },
    ],
  }));

  it('no plan.json → plan mode, planner at the project root, reading the spec', async () => {
    await run(() => runPlanPhase(basePipeline(ctx, 'plan') as never, cascadeDeps(ctx) as never));

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const s = sent();
    expect(promptMode(s.message)).toBe('plan');
    expect(s.role).toBe('planner');
    expect(s.cwd).toBe(ctx.root);
    expect(s.request).toContain(`${ctx.specPath}/spec.md`);
    expect(s.request).not.toContain('WAKEUP RE-ENTRY');
  });

  it('plan.json present → plan-revise mode, rewriting the plan in place and preserving completed work', async () => {
    existingPlan();

    await run(() => runPlanPhase(basePipeline(ctx, 'plan') as never, cascadeDeps(ctx) as never));

    const s = sent();
    expect(promptMode(s.message)).toBe('plan-revise');
    expect(s.role).toBe('planner');
    expect(s.cwd).toBe(ctx.root);
    expect(s.request).toContain(`${ctx.specPath}/plan.json`);
    expect(s.request).toContain(`${ctx.specPath}/spec.md`);
    expect(s.request).toContain('PRESERVING');
  });

  it('scoped replan (planner directive with Subtasks:) → plan-revise mode carrying the override and its scope', async () => {
    existingPlan();
    writeDirective(ctx, 'planner', 'Re-plan only subtask 2', '2');

    await run(() => runPlanPhase(basePipeline(ctx, 'plan') as never, cascadeDeps(ctx) as never));

    const s = sent();
    expect(promptMode(s.message)).toBe('plan-revise');
    expect(s.request).toContain('OVERRIDES EVERYTHING');
    expect(s.request).toContain('Re-plan only subtask 2');
  });

  it('wakeup re-entry → plan mode with the re-entry header', async () => {
    await run(() => runPlanPhase(basePipeline(ctx, 'plan', WAKEUP) as never, cascadeDeps(ctx) as never));

    const s = sent();
    expect(promptMode(s.message)).toBe('plan');
    expect(s.request).toContain('⚠️ WAKEUP RE-ENTRY');
    expect(s.request).toContain('phase_wakeup.json');
  });
});

// ── QA review ──────────────────────────────────────────────────────────────

describe('qa-review routing', () => {
  it('first pass → qa-review mode, qa-reviewer in the worktree, with the absolute report path', async () => {
    await run(() => runQaReview(basePipeline(ctx, 'qa-review') as never, cascadeDeps(ctx) as never));

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const s = sent();
    expect(promptMode(s.message)).toBe('qa-review');
    expect(s.role).toBe('qa-reviewer');
    expect(s.cwd).toBe(ctx.worktreePath);
    expect(s.request).toContain(`${ctx.specPath}/spec.md`);
    expect(s.request).toContain(`${ctx.specPath}/qa_report.json`);
    expect(s.request).not.toContain('WAKEUP RE-ENTRY');
  });

  it('rework pass (previous qa_report.json exists) → same qa-review mode; the reviewer detects the rework pass itself', async () => {
    writeFileSync(join(ctx.specPath, 'qa_report.json'), JSON.stringify({ overall: 'FAIL', criteria: [], head_at_review: 'abc' }));

    await run(() => runQaReview(basePipeline(ctx, 'qa-review', { qaAttempt: 1 }) as never, cascadeDeps(ctx) as never));

    const s = sent();
    expect(promptMode(s.message)).toBe('qa-review');
    expect(s.request).toContain(`${ctx.specPath}/qa_report.json`);
  });

  it('qa-reviewer-targeted directive → qa-review mode carrying the override', async () => {
    writeDirective(ctx, 'qa-reviewer', 'Re-check criterion 3 by hand');

    await run(() => runQaReview(basePipeline(ctx, 'qa-review') as never, cascadeDeps(ctx) as never));

    const s = sent();
    expect(promptMode(s.message)).toBe('qa-review');
    expect(s.request).toContain('OVERRIDES EVERYTHING');
    expect(s.request).toContain('Re-check criterion 3 by hand');
  });

  it('directive aimed at another agent → qa-review mode carrying it as context, not as an override', async () => {
    writeDirective(ctx, 'coder', 'Use the cached client');

    await run(() => runQaReview(basePipeline(ctx, 'qa-review') as never, cascadeDeps(ctx) as never));

    const s = sent();
    expect(promptMode(s.message)).toBe('qa-review');
    expect(s.request).toContain('Use the cached client');
    expect(s.request).not.toContain('OVERRIDES EVERYTHING');
  });

  it('wakeup re-entry → qa-review mode with the re-entry header and worktree note', async () => {
    await run(() => runQaReview(basePipeline(ctx, 'qa-review', { qaAttempt: 1, ...WAKEUP }) as never, cascadeDeps(ctx) as never));

    const s = sent();
    expect(promptMode(s.message)).toBe('qa-review');
    expect(s.request).toContain('⚠️ WAKEUP RE-ENTRY');
    expect(s.request).toContain('phase_wakeup.json');
    expect(s.request).toContain('this worktree');
  });
});

// ── Implement ──────────────────────────────────────────────────────────────

describe('implement routing', () => {
  const subtask = (overrides: Record<string, unknown> = {}) => ({
    id: 2,
    title: 'Add feature',
    description: 'Build the feature in src/feature.ts',
    files: ['src/feature.ts'],
    acceptance_criteria: ['Feature works'],
    depends_on: [1],
    ...overrides,
  });

  const writePlan = (subtasks: unknown[]) =>
    writeFileSync(join(ctx.specPath, 'plan.json'), JSON.stringify({ subtasks }));

  const runSubtask = (
    pipelineOverrides: Record<string, unknown>,
    st: ReturnType<typeof subtask>,
    hasQaFeedback: boolean,
    depsOverrides: Record<string, unknown> = {},
  ) => {
    const pipeline = basePipeline(ctx, 'implement', pipelineOverrides);
    return run(() => runSubtaskSession(
      pipeline as never, implementDeps(ctx, depsOverrides) as never, st as never, ctx.worktreePath,
      join(ctx.specPath, 'output.log'), hasQaFeedback, false, join(ctx.specPath, 'human_feedback.md'),
      [], new Set(), { current: Promise.resolve() },
    ));
  };

  beforeEach(() => {
    writePlan([
      { id: 1, title: 'Setup', description: 'Init', files: ['src/init.ts'], acceptance_criteria: ['ok'], completed: true },
      subtask(),
    ]);
  });

  it('selectSubtasks: QA rework mode is selected exactly when qa_feedback.md exists', () => {
    const pipeline = basePipeline(ctx, 'implement');
    expect(selectSubtasks(pipeline as never).hasQaFeedback).toBe(false);
    writeFileSync(join(ctx.specPath, 'qa_feedback.md'), '# QA feedback');
    expect(selectSubtasks(pipeline as never).hasQaFeedback).toBe(true);
  });

  it('normal subtask → implement mode, coder in the worktree, with session context and acceptance criteria', async () => {
    await runSubtask({}, subtask(), false);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const s = sent();
    expect(promptMode(s.message)).toBe('implement');
    expect(s.role).toBe('coder');
    expect(s.cwd).toBe(ctx.worktreePath);
    expect(s.request).toContain('Subtask 2: Add feature');
    expect(s.request).toContain('Build the feature in src/feature.ts');
    expect(s.request).toContain('Files: src/feature.ts');
    expect(s.request).toContain('Acceptance criteria: Feature works');
    expect(s.request).toContain('## SESSION CONTEXT');
    expect(s.request).toContain('Branch: feat/build-the-thing');
    expect(s.request).toContain('#1: Setup');
    expect(s.request).toContain(`PROJECT_ROOT=${ctx.root}`);
    expect(s.request).not.toContain('QA FEEDBACK');
    expect(s.request).not.toContain('WAKEUP RE-ENTRY');
    expect(s.request).not.toContain('DELIVERABLE RE-VERIFICATION');
  });

  it('QA feedback present → implement-fix mode listing the subtask\'s QA issues', async () => {
    writeFileSync(join(ctx.specPath, 'qa_report.json'), JSON.stringify({ overall: 'FAIL', criteria: [] }));
    const st = subtask({ acceptance_criteria: ['Feature works', '[QA CORRECTION: handle the empty input]'] });

    await runSubtask({}, st, true);

    const s = sent();
    expect(promptMode(s.message)).toBe('implement-fix');
    expect(s.role).toBe('coder');
    expect(s.cwd).toBe(ctx.worktreePath);
    expect(s.request).toContain('## ⚠️ QA FEEDBACK — FIX THESE FIRST ⚠️');
    expect(s.request).toContain('handle the empty input');
    expect(s.request).toContain('QA issues to fix:');
    expect(s.request).toContain('Only fix the QA issues listed above');
    expect(s.request).toContain('Subtask 2: Add feature');
  });

  it('QA-fallback rework subtask 9999 → implement-fix mode with the targeted-rework description', async () => {
    const st = subtask({
      id: 9999, title: 'QA rework', depends_on: [],
      description: buildSyntheticReworkDescription('criterion X failed'),
    });

    await runSubtask({}, st, true);

    const s = sent();
    expect(promptMode(s.message)).toBe('implement-fix');
    expect(s.request).toContain('THIS IS TARGETED REWORK');
    expect(s.request).toContain('criterion X failed');
  });

  it('missing deliverables from the previous session → implement mode with the re-verification header listing them', async () => {
    const st = subtask({ files_to_create: ['docs/evidence.log'] });

    await runSubtask({ deliverableFailCounts: { 2: 1 } }, st, false);

    const s = sent();
    expect(promptMode(s.message)).toBe('implement');
    expect(s.request).toContain('⚠️ DELIVERABLE RE-VERIFICATION (attempt 1/3)');
    expect(s.request).toContain('docs/evidence.log');
  });

  it('deliverable re-verification offers the wakeup path when a job producing them is still running', async () => {
    const st = subtask({ files_to_create: ['docs/evidence.log'] });

    await runSubtask({ deliverableFailCounts: { 2: 1 } }, st, false);

    const s = sent();
    expect(s.request).toContain('subtask_wakeup-st2.json');
    expect(s.request).toContain('Do not wait on the job in this session');
  });

  it('wakeup re-entry → implement mode with the re-entry header for this subtask\'s wakeup file', async () => {
    await runSubtask({ wakeupSubtaskId: 2, ...WAKEUP }, subtask(), false);

    const s = sent();
    expect(promptMode(s.message)).toBe('implement');
    expect(s.request).toContain('⚠️ WAKEUP RE-ENTRY');
    expect(s.request).toContain('subtask_wakeup-st2.json');
    expect(s.request).toContain(WAKEUP.wakeupCommand);
    expect(s.request).toContain('## SESSION CONTEXT');
  });

  it('wakeup re-entry takes priority over deliverable re-verification', async () => {
    const st = subtask({ files_to_create: ['docs/evidence.log'] });

    await runSubtask({ wakeupSubtaskId: 2, deliverableFailCounts: { 2: 1 }, ...WAKEUP }, st, false);

    const s = sent();
    expect(s.request).toContain('⚠️ WAKEUP RE-ENTRY');
    expect(s.request).not.toContain('DELIVERABLE RE-VERIFICATION');
  });

  it('wakeup re-entry of a QA-rework subtask → implement-fix mode with the re-entry header', async () => {
    writeFileSync(join(ctx.specPath, 'qa_report.json'), JSON.stringify({ overall: 'FAIL', criteria: [] }));

    await runSubtask({ wakeupSubtaskId: 2, ...WAKEUP }, subtask(), true);

    const s = sent();
    expect(promptMode(s.message)).toBe('implement-fix');
    expect(s.request).toContain('⚠️ WAKEUP RE-ENTRY');
  });

  it('coder-targeted human directive → implement mode carrying the override', async () => {
    writeDirective(ctx, 'coder', 'Use the cached client');

    await runSubtask({}, subtask(), false);

    const s = sent();
    expect(promptMode(s.message)).toBe('implement');
    expect(s.request).toContain('OVERRIDES EVERYTHING');
    expect(s.request).toContain('Use the cached client');
  });

  it('session killed for stalling → a fresh implement session headed by the stall-recovery notice', async () => {
    const waitForCompletion = vi.fn()
      .mockImplementationOnce(async () => { throw new SessionKilledError('SIGTERM', 'stalled', 'idle'); })
      .mockImplementationOnce(async () => { throw new StopAfterSend(); });

    await runSubtask({}, subtask(), false, { waitForCompletion });

    expect(mockSendMessage).toHaveBeenCalledTimes(2);
    expect(sent(0).request).not.toContain('SESSION RECOVERED AFTER STALL-KILL');
    const s = sent(1);
    expect(promptMode(s.message)).toBe('implement');
    expect(s.role).toBe('coder');
    expect(s.request).toContain('⚠️ SESSION RECOVERED AFTER STALL-KILL (attempt 1/3)');
    expect(s.request).toContain('Subtask 2: Add feature');
  });

  it('cherry-pick conflict while integrating a parallel subtask → merger resolves it in the task worktree', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'log') return 'abc123 subtask commit\n';
      throw new Error('unexpected git call');
    });
    const execGit = vi.fn((args: string[]) => {
      if (args[0] === 'cherry-pick' && args[1] !== '--abort') throw new Error('CONFLICT (content): Merge conflict in src/a.ts');
    });
    const execGitCapture = vi.fn((args: string[]) => {
      if (args.includes('CHERRY_PICK_HEAD')) return 'deadbeef\n';
      if (args.includes('--diff-filter=U')) return 'src/a.ts\n';
      return '';
    });
    const pipeline = basePipeline(ctx, 'implement');

    await run(() => tryCherryPickWithRecovery(
      pipeline as never, implementDeps(ctx, { execGit, execGitCapture }) as never,
      join(ctx.specPath, 'output.log'), 'feat/build-the-thing-st2', 2,
    ));

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const s = sent();
    expect(promptMode(s.message)).toBe('resolve-cherry-pick');
    expect(s.role).toBe('merger');
    expect(s.cwd).toBe(ctx.worktreePath);
    expect(s.request).toContain('feat/build-the-thing-st2');
    expect(s.request).toContain('feat/build-the-thing');
    expect(s.request).toContain('git cherry-pick --continue');
  });
});

// ── Merge sessions ─────────────────────────────────────────────────────────

describe('merge routing', () => {
  it('conflicting final merge → merge mode for the feature branch, merger at the project root', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-list') return '0\n';
      throw new Error('git unavailable');
    });
    const execGit = vi.fn((args: string[]) => {
      if (args[0] === 'merge' && args[1] !== '--abort') throw new Error('CONFLICT');
    });

    await run(() => runMergePhase(basePipeline(ctx, 'merge') as never, cascadeDeps(ctx, { execGit }) as never));

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const s = sent();
    expect(promptMode(s.message)).toBe('merge');
    expect(s.role).toBe('merger');
    expect(s.cwd).toBe(ctx.root);
    expect(s.request).toContain('feat/build-the-thing');
  });

  it('rebase onto the base branch with conflicts → merge mode for origin/<base> in the worktree', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'rev-list') return '3\n';
      if (args[0] === 'fetch') return '';
      throw new Error('git unavailable');
    });
    const execGit = vi.fn((args: string[]) => {
      if (args[0] === 'rebase' && args[1] !== '--abort') throw new Error('CONFLICT');
    });
    const execGitCapture = vi.fn((args: string[]) => (args.includes('--diff-filter=U') ? 'src/a.ts\n' : ''));

    await run(() => rebaseOntoLatestDefault(
      ctx.worktreePath, 'task-1', 'feat/build-the-thing', join(ctx.specPath, 'output.log'),
      { ...cascadeDeps(ctx, { execGit, execGitCapture }), baseBranch: 'main' } as never,
    ));

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const s = sent();
    expect(promptMode(s.message)).toBe('merge');
    expect(s.role).toBe('merger');
    expect(s.cwd).toBe(ctx.worktreePath);
    expect(s.request).toContain('origin/main');
  });

  it('QA precheck finds the branch diverged from its own remote → merge mode for origin/<branch>', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'fetch') return '';
      if (args[0] === 'log') return 'abc123 local commit\n';
      if (args[0] === 'rebase' && args[1] !== '--abort') throw new Error('CONFLICT');
      return '';
    });
    const gitPush = vi.fn((args: string[]) => {
      if (args[0] === 'push') throw new Error('! [rejected] (non-fast-forward)');
    });
    const execGitCapture = vi.fn((args: string[]) => (args.includes('--diff-filter=U') ? 'src/a.ts\n' : ''));

    await run(() => runQaReview(
      basePipeline(ctx, 'qa-review') as never, cascadeDeps(ctx, { gitPush, execGitCapture }) as never,
    ));

    const s = sent();
    expect(promptMode(s.message)).toBe('merge');
    expect(s.role).toBe('merger');
    expect(s.cwd).toBe(ctx.worktreePath);
    expect(s.request).toContain('origin/feat/build-the-thing');
  });
});
