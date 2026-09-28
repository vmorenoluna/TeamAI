// @vitest-environment node

/**
 * Tests runSpecPhase's spec version handling under the rename-at-revision
 * scheme:
 *
 *  - The FIRST (non-revision) spec run must NOT copy spec.md to spec_v1.md —
 *    the live spec.md IS version 1 until a revision begins.
 *  - The REVISION branch must NOT archive the completed spec as
 *    spec_v{specRevision}.md — beginSpecRevision already renamed the
 *    pre-revision spec to spec_v{specRevision - 1}.md before the session ran,
 *    and the analyst wrote the new content straight to spec.md. Copying again
 *    would double-count the revision in the spec versions UI.
 *  - The no-op guard compares spec.md against spec_v{specRevision - 1}.md
 *    (the renamed baseline), not the old spec_revision_before.md marker.
 *
 * A failed rename warn (not swallow) is covered via the renameSync mock.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockWarn, mockWriteFileSync, realWriteFileSync, mockRenameSync, realRenameSync, mockUnlinkSync, realUnlinkSync, mockCreateSession, mockSendMessage, mockKillSession } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockWriteFileSync: vi.fn(),
  realWriteFileSync: { current: null as null | ((...args: unknown[]) => void) },
  mockRenameSync: vi.fn(),
  realRenameSync: { current: null as null | ((...args: unknown[]) => void) },
  mockUnlinkSync: vi.fn(),
  realUnlinkSync: { current: null as null | ((...args: unknown[]) => void) },
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

// runSpecPhase now calls syncPhaseBaseline, which resolves the base branch
// via git-platform — this fixture's temp dir isn't a real git repo, so
// without this mock every test would shell out for real, fail, and log an
// unrelated "Failed to detect default branch" warn that has nothing to do
// with what this file is testing (spec version snapshotting).
vi.mock('../../src/lib/git-platform', () => ({
  resolveBaseBranch: () => 'main',
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

// Override writeFileSync and renameSync with controllable mocks that default
// to the real implementations (captured here so tests can delegate selectively).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  realWriteFileSync.current = actual.writeFileSync as unknown as (...args: unknown[]) => void;
  realRenameSync.current = actual.renameSync as unknown as (...args: unknown[]) => void;
  realUnlinkSync.current = actual.unlinkSync as unknown as (...args: unknown[]) => void;
  (mockWriteFileSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realWriteFileSync.current!(...args));
  (mockRenameSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realRenameSync.current!(...args));
  (mockUnlinkSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realUnlinkSync.current!(...args));
  return { ...actual, writeFileSync: mockWriteFileSync, renameSync: mockRenameSync, unlinkSync: mockUnlinkSync };
});

import { runSpecPhase } from '../../src/lib/orchestrator/phase-runners';

function makeCtx() {
  const root = join(tmpdir(), `teamai-runspec-${randomUUID().slice(0, 8)}`);
  const specPath = join(root, 'task-slug');
  mkdirSync(specPath, { recursive: true });

  const pipeline = {
    taskId: 'task-1',
    description: 'Build the thing',
    phase: 'spec',
    specPath,
    worktreePath: join(specPath, '..', 'wt'),
    branch: 'feat/test',
    specRevision: 0,
    sessionId: undefined as string | undefined,
  };

  const advancePhaseCalls: Array<{ phase: string; eventExtra?: Record<string, unknown> }> = [];

  const deps = {
    projectRoot: root,
    persistAndEmitPhase: vi.fn(),
    sessionOpts: () => ({ role: 'analyst', cwd: root, taskId: 'task-1' }),
    waitForCompletion: vi.fn(async () => undefined),
    advancePhase: (p: typeof pipeline, phase: string, eventExtra?: Record<string, unknown>) => {
      advancePhaseCalls.push({ phase, eventExtra });
      (p as { phase: string }).phase = phase;
    },
    rotateOutputLog: vi.fn(),
    phaseHeader: vi.fn(),
    savePipelineState: vi.fn(),
    toAgentPath: (p: string) => p,
    executePhase: vi.fn(async () => undefined),
    gitPush: vi.fn(),
    execGit: vi.fn(),
    getPipelineConfig: () => ({ wakeupScanRetryDelayMs: 0, maxImplementRetries: 3 }),
    scheduleWakeup: vi.fn(),
    writeCompletionSummary: vi.fn(),
  };

  return { root, specPath, pipeline, deps, advancePhaseCalls };
}

describe('runSpecPhase — spec versioning (rename-at-revision scheme)', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx();
    mockCreateSession.mockResolvedValue('sess-spec');
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  // ── First (non-revision) run: the live spec IS v1 — no copy ────────

  it('parks in awaiting-review with a reason when the first (non-revision) run produces no spec.md', async () => {
    // No spec.md is ever written — simulates a crashed or interrupted first
    // analyst session.
    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    expect(ctx.pipeline.phase).toBe('awaiting-review');
    expect(ctx.deps.executePhase).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'spec',
      expect.stringContaining('Spec phase produced no spec.md'),
    );
    const rollback = ctx.advancePhaseCalls[ctx.advancePhaseCalls.length - 1];
    expect(rollback.eventExtra?.awaitingReviewReason).toEqual(
      expect.stringContaining('Spec phase produced no spec.md'),
    );
  });

  it('does NOT copy the initial spec to spec_v1.md on a first (non-revision) run', async () => {
    const { writeFileSync, existsSync } = await import('fs');
    writeFileSync(join(ctx.specPath, 'spec.md'), '# brand new spec');
    writeFileSync(join(ctx.specPath, 'spec_summary.md'), 'Summary of the brand new spec.');

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    expect(ctx.pipeline.phase).toBe('plan');
    // No snapshot copy — the live spec.md is the one and only version.
    expect(existsSync(join(ctx.specPath, 'spec_v1.md'))).toBe(false);
    // specRevision is not fabricated by the spec phase.
    expect(ctx.pipeline.specRevision).toBe(0);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('still advances to plan when a legacy spec_v1.md snapshot already exists (no rewrite)', async () => {
    const { writeFileSync, readFileSync } = await import('fs');
    writeFileSync(join(ctx.specPath, 'spec.md'), '# live spec');
    writeFileSync(join(ctx.specPath, 'spec_summary.md'), 'Summary of the live spec.');
    writeFileSync(join(ctx.specPath, 'spec_v1.md'), '# legacy v1 snapshot');

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    expect(ctx.pipeline.phase).toBe('plan');
    // Legacy snapshot is left exactly as it was — never overwritten.
    expect(readFileSync(join(ctx.specPath, 'spec_v1.md'), 'utf-8')).toBe('# legacy v1 snapshot');
  });

  // ── Revision branch: baseline is spec_v{R-1}.md, no post-hoc archive ──

  it('runs the no-op guard against spec_v{R-1}.md and does NOT archive the revised spec', async () => {
    const { writeFileSync, existsSync, readFileSync } = await import('fs');
    // beginSpecRevision renamed the pre-revision spec to spec_v1.md before
    // this session ran; the analyst then wrote the revised content to spec.md.
    writeFileSync(join(ctx.specPath, 'spec_v1.md'), '# original spec\n\nold formula');
    writeFileSync(join(ctx.specPath, 'spec.md'), '# original spec\n\nrevised formula');
    writeFileSync(join(ctx.specPath, 'spec_summary.md'), 'Summary of the revised formula.');
    writeFileSync(join(ctx.specPath, 'spec_revision_feedback.md'), 'revise the formula');
    ctx.pipeline.specRevision = 2;

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    expect(ctx.pipeline.phase).toBe('plan');
    expect(ctx.deps.executePhase).toHaveBeenCalledTimes(1);
    // The pre-revision baseline (v1) survives untouched…
    expect(readFileSync(join(ctx.specPath, 'spec_v1.md'), 'utf-8')).toBe('# original spec\n\nold formula');
    // …the revised content stays live as spec.md — NO spec_v2.md archive copy,
    // so the UI counts exactly one new version (the live spec).
    expect(readFileSync(join(ctx.specPath, 'spec.md'), 'utf-8')).toBe('# original spec\n\nrevised formula');
    expect(existsSync(join(ctx.specPath, 'spec_v2.md'))).toBe(false);
    expect(existsSync(join(ctx.specPath, 'spec_revision_feedback.md'))).toBe(false);
    expect(existsSync(join(ctx.specPath, 'spec_revision_before.md'))).toBe(false);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('parks in awaiting-review and keeps the duplicate spec.md when the revision is a no-op', async () => {
    const { writeFileSync, existsSync, readFileSync } = await import('fs');
    // The analyst "revised" spec.md back to exactly the pre-revision content.
    writeFileSync(join(ctx.specPath, 'spec_v1.md'), '# original spec\n\nold formula');
    writeFileSync(join(ctx.specPath, 'spec.md'), '# original spec\n\nold formula');
    writeFileSync(join(ctx.specPath, 'spec_revision_feedback.md'), 'revise the formula');
    ctx.pipeline.specRevision = 2;

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    expect(ctx.pipeline.phase).toBe('awaiting-review');
    expect(ctx.deps.executePhase).not.toHaveBeenCalled();
    expect(ctx.deps.savePipelineState).toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'spec',
      expect.stringContaining('No-op spec revision detected'),
    );
    // The park must be distinguishable from a genuine QA pass — both land on
    // 'awaiting-review', so a missing reason would look identical to a real
    // pass and invite premature approval (the bug this guards against).
    const rollback = ctx.advancePhaseCalls[ctx.advancePhaseCalls.length - 1];
    expect(rollback.eventExtra?.awaitingReviewReason).toEqual(
      expect.stringContaining('No-op spec revision'),
    );
    // spec.md is left in place (duplicating v1) — the versions UI dedupes it
    // (getTaskFull in tasks.ts), and a follow-up "Request Changes → Analyst"
    // requires spec.md to exist to enter revision mode instead of silently
    // falling back to a from-scratch /spec run.
    expect(readFileSync(join(ctx.specPath, 'spec.md'), 'utf-8')).toBe('# original spec\n\nold formula');
    expect(readFileSync(join(ctx.specPath, 'spec_v1.md'), 'utf-8')).toBe('# original spec\n\nold formula');
    expect(existsSync(join(ctx.specPath, 'spec_revision_feedback.md'))).toBe(false);
  });

  it('treats a missing post-session spec.md as a no-op and parks for human review', async () => {
    const { writeFileSync, existsSync } = await import('fs');
    // Baseline exists but the analyst session produced no spec.md at all.
    writeFileSync(join(ctx.specPath, 'spec_v1.md'), '# original spec');
    writeFileSync(join(ctx.specPath, 'spec_revision_feedback.md'), 'revise the formula');
    ctx.pipeline.specRevision = 2;

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    // Advancing to plan without a spec would break every downstream phase —
    // park instead and let the human retry the revision.
    expect(ctx.pipeline.phase).toBe('awaiting-review');
    expect(ctx.deps.executePhase).not.toHaveBeenCalled();
    expect(existsSync(join(ctx.specPath, 'spec_v1.md'))).toBe(true);
    const rollback = ctx.advancePhaseCalls[ctx.advancePhaseCalls.length - 1];
    expect(rollback.eventExtra?.awaitingReviewReason).toEqual(
      expect.stringContaining('Spec revision produced no spec.md'),
    );
  });

  it('the REVISION prompt points the analyst at the renamed baseline for reading', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(join(ctx.specPath, 'spec_v1.md'), '# original spec');
    writeFileSync(join(ctx.specPath, 'spec.md'), '# original spec');
    writeFileSync(join(ctx.specPath, 'spec_revision_feedback.md'), 'revise the formula');
    ctx.pipeline.specRevision = 2;

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    const sendCalls = mockSendMessage.mock.calls.filter((c: unknown[]) => c[0] === 'sess-spec');
    expect(sendCalls.length).toBeGreaterThanOrEqual(1);
    const prompt = sendCalls[0][1] as string;
    expect(prompt).toContain('REVISION:');
    // The analyst must read the pre-revision snapshot (v1), not a live file
    // that no longer holds the original content.
    expect(prompt).toContain('spec_v1.md');
  });

  // ── Failure surfacing ──────────────────────────────────────────────

  it('does not warn from the spec phase on success paths (no snapshot writes happen here)', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(join(ctx.specPath, 'spec.md'), '# original spec');
    writeFileSync(join(ctx.specPath, 'spec_summary.md'), 'Summary of the original spec.');
    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  // ── spec_summary.md is required, exactly like spec.md ──────────────

  it('parks in awaiting-review when the analyst produces spec.md but no spec_summary.md (first run)', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(join(ctx.specPath, 'spec.md'), '# brand new spec');

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    // A second session is given one focused shot at writing just the
    // summary before the pipeline gives up and parks.
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    expect(ctx.pipeline.phase).toBe('awaiting-review');
    expect(ctx.deps.executePhase).not.toHaveBeenCalled();
    expect(ctx.deps.savePipelineState).toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'spec',
      expect.stringContaining('Spec phase produced no spec_summary.md'),
    );
    const rollback = ctx.advancePhaseCalls[ctx.advancePhaseCalls.length - 1];
    expect(rollback.eventExtra?.awaitingReviewReason).toEqual(
      expect.stringContaining('automatic retry'),
    );
  });

  it('self-heals via a focused retry session when the analyst produces spec.md but no spec_summary.md (first run)', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(join(ctx.specPath, 'spec.md'), '# brand new spec');

    // Simulate the retry session's own analyst turn writing the summary —
    // the second waitForCompletion call is the retry's.
    let waits = 0;
    ctx.deps.waitForCompletion = vi.fn(async () => {
      waits++;
      if (waits === 2) {
        writeFileSync(join(ctx.specPath, 'spec_summary.md'), 'Summary written by the retry.');
      }
      return undefined;
    });

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    expect(waits).toBe(2);
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    expect(ctx.pipeline.phase).toBe('plan');
    expect(ctx.deps.executePhase).toHaveBeenCalledTimes(1);
  });

  it('parks in awaiting-review when a revision produces spec.md but no spec_summary.md', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(join(ctx.specPath, 'spec_v1.md'), '# original spec\n\nold formula');
    writeFileSync(join(ctx.specPath, 'spec.md'), '# original spec\n\nrevised formula');
    writeFileSync(join(ctx.specPath, 'spec_revision_feedback.md'), 'revise the formula');
    ctx.pipeline.specRevision = 2;

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    // A second session is given one focused shot at writing just the
    // summary before the pipeline gives up and parks.
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    expect(ctx.pipeline.phase).toBe('awaiting-review');
    expect(ctx.deps.executePhase).not.toHaveBeenCalled();
    expect(mockWarn).toHaveBeenCalledWith(
      'spec',
      expect.stringContaining('Spec phase produced no spec_summary.md'),
    );
    // This is the production scenario: a revision-mode analyst session wrote
    // spec.md but skipped spec_summary.md, and the pipeline auto-parks here
    // (after the retry above also fails to produce it) instead of advancing
    // to plan. Without a distinguishing reason on the 'awaiting-review'
    // event, this looks identical to a real QA pass and an approver can wave
    // it straight into create-pr, which then fails trying to build the PR
    // body.
    const rollback = ctx.advancePhaseCalls[ctx.advancePhaseCalls.length - 1];
    expect(rollback.eventExtra?.awaitingReviewReason).toEqual(
      expect.stringContaining('automatic retry'),
    );
  });

  it('self-heals via a focused retry session when a revision produces spec.md but no spec_summary.md', async () => {
    const { writeFileSync } = await import('fs');
    writeFileSync(join(ctx.specPath, 'spec_v1.md'), '# original spec\n\nold formula');
    writeFileSync(join(ctx.specPath, 'spec.md'), '# original spec\n\nrevised formula');
    writeFileSync(join(ctx.specPath, 'spec_revision_feedback.md'), 'revise the formula');
    ctx.pipeline.specRevision = 2;

    let waits = 0;
    ctx.deps.waitForCompletion = vi.fn(async () => {
      waits++;
      if (waits === 2) {
        writeFileSync(join(ctx.specPath, 'spec_summary.md'), 'Summary written by the retry.');
      }
      return undefined;
    });

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    expect(waits).toBe(2);
    expect(mockCreateSession).toHaveBeenCalledTimes(2);
    expect(ctx.pipeline.phase).toBe('plan');
  });
});
