// @vitest-environment node

/**
 * Tests runSpecPhase's spec_v1.md snapshot write:
 * a failed snapshot write must warn (not swallow).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockWarn, mockWriteFileSync, realWriteFileSync, mockCreateSession, mockSendMessage, mockKillSession } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  mockWriteFileSync: vi.fn(),
  realWriteFileSync: { current: null as null | ((...args: unknown[]) => void) },
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

// Override only writeFileSync with a controllable mock that defaults to the
// real implementation (captured here so tests can delegate selectively).
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  realWriteFileSync.current = actual.writeFileSync as unknown as (...args: unknown[]) => void;
  (mockWriteFileSync as unknown as { mockImplementation: (f: (...a: unknown[]) => void) => void })
    .mockImplementation((...args: unknown[]) => realWriteFileSync.current!(...args));
  return { ...actual, writeFileSync: mockWriteFileSync };
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

describe('runSpecPhase — spec_v1.md snapshot', () => {
  let ctx: ReturnType<typeof makeCtx>;

  beforeEach(() => {
    vi.clearAllMocks();
    ctx = makeCtx();
    mockCreateSession.mockResolvedValue('sess-spec');
  });

  afterEach(() => {
    try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  it('snapshots the spec without warning on success', async () => {
    realWriteFileSync.current!(join(ctx.specPath, 'spec.md'), '# original spec');
    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('warns (does not throw) when the spec snapshot write fails', async () => {
    realWriteFileSync.current!(join(ctx.specPath, 'spec.md'), '# original spec');

    let calls = 0;
    mockWriteFileSync.mockImplementation((...args: unknown[]) => {
      calls += 1;
      // 1st write = updateSessionMap's session_map.json; 2nd = spec_v1.md.
      if (calls === 2) throw new Error('disk full');
      return realWriteFileSync.current!(...args);
    });

    await expect(runSpecPhase(ctx.pipeline as never, ctx.deps as never)).resolves.toBeUndefined();

    expect(mockWarn).toHaveBeenCalledWith(
      'spec',
      expect.stringContaining('Failed to snapshot spec v1'),
      expect.anything(),
    );
  });

  // ── Revision archival never touches spec_v1.md ─────────────────────
  // spec_v1.md is now guaranteed to exist before any revision can run (see
  // ensureSpecV1Snapshot in orchestrator/helpers.ts, called from
  // moveTaskToPhase/resumeTask). These tests document and protect the
  // invariant this simplification relies on: pipeline.specRevision is
  // always >= 2 by the time a revision archives (autoReviseSpec /
  // routeHumanFeedback's analyst target increment it before calling
  // beginSpecRevision), so the plain `spec_v${pipeline.specRevision}.md`
  // write can never land on v1 — even if v1 happens to be missing (e.g. a
  // legacy task that predates the guarantee).

  it('archives a revision at spec_v{specRevision} without touching spec_v1.md when v1 already exists', async () => {
    realWriteFileSync.current!(join(ctx.specPath, 'spec.md'), '# revised spec');
    realWriteFileSync.current!(join(ctx.specPath, 'spec_v1.md'), '# the true original');
    realWriteFileSync.current!(join(ctx.specPath, 'spec_revision_feedback.md'), 'QA concerns');
    realWriteFileSync.current!(join(ctx.specPath, 'spec_revision_before.md'), '# state before this round');
    ctx.pipeline.specRevision = 2;

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    const { readFileSync } = await import('fs');
    expect(readFileSync(join(ctx.specPath, 'spec_v1.md'), 'utf-8')).toBe('# the true original');
    expect(readFileSync(join(ctx.specPath, 'spec_v2.md'), 'utf-8')).toBe('# revised spec');
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('archives at spec_v{specRevision} even when v1 is missing (legacy task predating the guarantee) — never falls back to v1', async () => {
    realWriteFileSync.current!(join(ctx.specPath, 'spec.md'), '# revised spec');
    realWriteFileSync.current!(join(ctx.specPath, 'spec_revision_feedback.md'), 'QA concerns');
    ctx.pipeline.specRevision = 2;

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    const { existsSync, readFileSync } = await import('fs');
    expect(existsSync(join(ctx.specPath, 'spec_v1.md'))).toBe(false);
    expect(readFileSync(join(ctx.specPath, 'spec_v2.md'), 'utf-8')).toBe('# revised spec');
  });
});
