// @vitest-environment node

/**
 * Tests that a targeted human_feedback.md is injected into the correct phase
 * prompt and consumed after that phase runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'fs';
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
  log: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
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

import { runSpecPhase, runPlanPhase } from '../../src/lib/orchestrator/phase-runners';

function makeRoot() {
  const root = join(tmpdir(), `teamai-inject-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  mkdirSync(specPath, { recursive: true });
  return { root, specPath };
}

function basePipeline(specPath: string, phase: string) {
  return {
    taskId: 'task-1',
    title: 't',
    description: 'Build the thing',
    phase,
    specPath,
    worktreePath: join(specPath, '..', 'wt'),
    branch: 'feat/test',
    qaAttempt: 0,
    maxQaAttempts: 3,
    specRevision: 0,
    qaRevision: 0,
    sessionId: undefined as string | undefined,
  };
}

describe('runSpecPhase — human directive injection', () => {
  let ctx: ReturnType<typeof makeRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeRoot();
    mockCreateSession.mockResolvedValue('sess-spec');
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo'); });
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('prepends the override to the analyst prompt and consumes the feedback', async () => {
    writeFileSync(join(ctx.specPath, 'human_feedback.md'),
      '# Human Review Feedback\nTarget: analyst\n\nDerive the formula from first principles\n');

    const pipeline = basePipeline(ctx.specPath, 'spec');
    const deps = {
      projectRoot: ctx.root,
      persistAndEmitPhase: vi.fn(),
      sessionOpts: () => ({ role: 'analyst', cwd: ctx.root, taskId: 'task-1' }),
      waitForCompletion: vi.fn(async () => undefined),
      advancePhase: (p: typeof pipeline, phase: string) => { (p as { phase: string }).phase = phase; },
      rotateOutputLog: vi.fn(),
      phaseHeader: vi.fn(),
      savePipelineState: vi.fn(),
      toAgentPath: (p: string) => p,
      executePhase: vi.fn(async () => undefined),
    };

    await runSpecPhase(pipeline as never, deps as never);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const prompt = mockSendMessage.mock.calls[0][1] as string;
    expect(prompt).toContain('OVERRIDES EVERYTHING');
    expect(prompt).toContain('Derive the formula from first principles');
    expect(prompt).toContain('/spec Build the thing');

    // Consumed after the spec phase
    expect(existsSync(join(ctx.specPath, 'human_feedback.md'))).toBe(false);
  });
});

describe('runPlanPhase — human directive injection', () => {
  let ctx: ReturnType<typeof makeRoot>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeRoot();
    mockCreateSession.mockResolvedValue('sess-plan');
    mockExecFileSync.mockImplementation(() => { throw new Error('not a git repo'); });
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('prepends the override to the planner prompt and consumes the feedback', async () => {
    writeFileSync(join(ctx.specPath, 'human_feedback.md'),
      '# Human Review Feedback\nTarget: planner\n\nSplit the migration into two subtasks\n');

    const pipeline = basePipeline(ctx.specPath, 'plan');
    mkdirSync(pipeline.worktreePath, { recursive: true });

    const deps = {
      projectRoot: ctx.root,
      persistAndEmitPhase: vi.fn(),
      sessionOpts: () => ({ role: 'planner', cwd: ctx.root, taskId: 'task-1' }),
      waitForCompletion: vi.fn(async () => undefined),
      advancePhase: (p: typeof pipeline, phase: string) => { (p as { phase: string }).phase = phase; },
      rotateOutputLog: vi.fn(),
      phaseHeader: vi.fn(),
      savePipelineState: vi.fn(),
      toAgentPath: (p: string) => p,
      executePhase: vi.fn(async () => undefined),
      gitPush: vi.fn(),
      execGit: vi.fn(),
    };

    await runPlanPhase(pipeline as never, deps as never);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const prompt = mockSendMessage.mock.calls[0][1] as string;
    expect(prompt).toContain('OVERRIDES EVERYTHING');
    expect(prompt).toContain('Split the migration into two subtasks');
    expect(prompt).toContain('/plan');

    // Consumed after the plan phase
    expect(existsSync(join(ctx.specPath, 'human_feedback.md'))).toBe(false);
  });

  it('re-plans in place (REPLAN mode) when plan.json already exists', async () => {
    writeFileSync(join(ctx.specPath, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'A', description: 'A', files: ['src/a.ts'], acceptance_criteria: ['a'], completed: true },
      ],
    }));

    const pipeline = basePipeline(ctx.specPath, 'plan');
    mkdirSync(pipeline.worktreePath, { recursive: true });

    const deps = {
      projectRoot: ctx.root,
      persistAndEmitPhase: vi.fn(),
      sessionOpts: () => ({ role: 'planner', cwd: ctx.root, taskId: 'task-1' }),
      waitForCompletion: vi.fn(async () => undefined),
      advancePhase: (p: typeof pipeline, phase: string) => { (p as { phase: string }).phase = phase; },
      rotateOutputLog: vi.fn(),
      phaseHeader: vi.fn(),
      savePipelineState: vi.fn(),
      toAgentPath: (p: string) => p,
      executePhase: vi.fn(async () => undefined),
      gitPush: vi.fn(),
      execGit: vi.fn(),
    };

    await runPlanPhase(pipeline as never, deps as never);

    const prompt = mockSendMessage.mock.calls[0][1] as string;
    expect(prompt).toContain('REPLAN');
    expect(prompt).toContain('PRESERVING');
    expect(prompt).not.toContain('/plan ');
  });
});
