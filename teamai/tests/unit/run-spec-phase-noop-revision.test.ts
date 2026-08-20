// @vitest-environment node

/**
 * Tests runSpecPhase's no-op revision guard: if the analyst's REVISION
 * session completes without actually changing spec.md (compared against
 * the pre-revision spec_revision_before.md marker written by beginSpecRevision
 * before the session started), the pipeline must park in awaiting-review instead
 * of silently advancing to plan and replaying the same QA failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockWarn, mockCreateSession, mockSendMessage, mockKillSession } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockCreateSession: vi.fn(),
  mockSendMessage: vi.fn(),
  mockKillSession: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(),
  warn: mockWarn,
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

import { runSpecPhase } from '../../src/lib/orchestrator/phase-runners';

function makeCtx(specRevision: number) {
  const root = join(tmpdir(), `teamai-runspec-noop-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  mkdirSync(specPath, { recursive: true });

  const pipeline = {
    taskId: 'task-1',
    description: 'Build the thing',
    phase: 'spec',
    specPath,
    worktreePath: join(specPath, '..', 'wt'),
    branch: 'feat/test',
    specRevision,
    sessionId: undefined as string | undefined,
  };

  const deps = {
    projectRoot: root,
    persistAndEmitPhase: vi.fn(),
    sessionOpts: () => ({ role: 'analyst', cwd: root, taskId: 'task-1' }),
    waitForCompletion: vi.fn(async () => undefined),
    advancePhase: (p: typeof pipeline, phase: string) => { (p as { phase: string }).phase = phase; },
    rotateOutputLog: vi.fn(),
    phaseHeader: vi.fn(),
    savePipelineState: vi.fn(),
    toAgentPath: (p: string) => p,
    executePhase: vi.fn(async () => undefined),
  };

  return { root, specPath, pipeline, deps };
}

describe('runSpecPhase — no-op revision guard', () => {
  let ctx: ReturnType<typeof makeCtx>;

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateSession.mockResolvedValue('sess-spec');
  });

  it('parks in awaiting-review when spec.md is unchanged from the pre-revision snapshot', async () => {
    ctx = makeCtx(2);
    // Pre-revision snapshot (written by autoReviseSpec before this session ran)
    // and the "revised" spec.md the analyst session left behind — identical.
    writeFileSync(join(ctx.specPath, 'spec_revision_before.md'), '# original spec\n\nold formula');
    writeFileSync(join(ctx.specPath, 'spec.md'), '# original spec\n\nold formula');
    writeFileSync(join(ctx.specPath, 'spec_revision_feedback.md'), 'revise the formula');

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    expect(ctx.pipeline.phase).toBe('awaiting-review');
    expect(ctx.deps.executePhase).not.toHaveBeenCalled();
    expect(ctx.deps.savePipelineState).toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'spec',
      expect.stringContaining('No-op spec revision detected'),
    );
    // The pre-revision marker is cleaned up after the no-op guard runs.
    expect(existsSync(join(ctx.specPath, 'spec_revision_before.md'))).toBe(false);
  });

  it('advances to plan and archives the revised spec as spec_v2.md when spec.md changed', async () => {
    ctx = makeCtx(2);
    writeFileSync(join(ctx.specPath, 'spec_revision_before.md'), '# original spec\n\nold formula');
    writeFileSync(join(ctx.specPath, 'spec.md'), '# original spec\n\nrevised formula');
    writeFileSync(join(ctx.specPath, 'spec_revision_feedback.md'), 'revise the formula');

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    expect(ctx.pipeline.phase).toBe('plan');
    expect(ctx.deps.executePhase).toHaveBeenCalledTimes(1);
    // spec_v2.md archives the completed revision's content — written only after
    // the no-op guard passes, so an in-flight revision never shows as a version.
    expect(readFileSync(join(ctx.specPath, 'spec_v2.md'), 'utf-8')).toBe('# original spec\n\nrevised formula');
    expect(existsSync(join(ctx.specPath, 'spec_revision_before.md'))).toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('does not run the no-op check on a first (non-revision) spec pass', async () => {
    ctx = makeCtx(0);
    writeFileSync(join(ctx.specPath, 'spec.md'), '# brand new spec');
    // No spec_revision_feedback.md present => isRevision is false.

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    expect(ctx.pipeline.phase).toBe('plan');
    expect(readFileSync(join(ctx.specPath, 'spec_v1.md'), 'utf-8')).toBe('# brand new spec');
    expect(mockWarn).not.toHaveBeenCalled();
  });
});
