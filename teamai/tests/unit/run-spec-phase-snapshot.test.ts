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

  // ── Defensive v1 backfill on a pre-seeded task's first revision ────

  it('backfills spec_v1.md from the pre-revision snapshot when a pre-seeded task (no tracked /spec run) takes its first QA revision', async () => {
    // Task entered tracked execution already at `plan`: spec.md pre-exists,
    // no spec_v1.md was ever written (the non-revision branch never ran).
    // autoReviseSpec wrote the pre-revision marker, then bumped the restored
    // counter (0 → 1) before runSpecPhase executes.
    realWriteFileSync.current!(join(ctx.specPath, 'spec.md'), '# revised spec (v2 content)');
    realWriteFileSync.current!(join(ctx.specPath, 'spec_revision_feedback.md'), 'QA concerns');
    realWriteFileSync.current!(join(ctx.specPath, 'spec_revision_before.md'), '# original spec');
    ctx.pipeline.specRevision = 1;

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    const { readFileSync, existsSync } = await import('fs');
    // v1 = the ORIGINAL spec, recovered from the pre-revision snapshot —
    // not missing, and not clobbered by the revised text.
    expect(existsSync(join(ctx.specPath, 'spec_v1.md'))).toBe(true);
    expect(readFileSync(join(ctx.specPath, 'spec_v1.md'), 'utf-8')).toBe('# original spec');
    // The revision itself archives as v2 (not v1), and the bumped counter
    // is persisted so future revisions keep numbering forward.
    expect(readFileSync(join(ctx.specPath, 'spec_v2.md'), 'utf-8')).toBe('# revised spec (v2 content)');
    expect(ctx.pipeline.specRevision).toBe(2);
    expect(ctx.deps.savePipelineState).toHaveBeenCalled();
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it('backfills a missing spec_v1.md without disturbing the archive index when the counter is already past 1', async () => {
    // Same pre-seeded start, but the restored counter is 2 (e.g. state file
    // survived while v1 was lost) — the revision archives as v2 as usual.
    realWriteFileSync.current!(join(ctx.specPath, 'spec.md'), '# revised spec');
    realWriteFileSync.current!(join(ctx.specPath, 'spec_revision_feedback.md'), 'QA concerns');
    realWriteFileSync.current!(join(ctx.specPath, 'spec_revision_before.md'), '# original spec');
    ctx.pipeline.specRevision = 2;

    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);

    const { readFileSync } = await import('fs');
    expect(readFileSync(join(ctx.specPath, 'spec_v1.md'), 'utf-8')).toBe('# original spec');
    expect(readFileSync(join(ctx.specPath, 'spec_v2.md'), 'utf-8')).toBe('# revised spec');
    expect(ctx.pipeline.specRevision).toBe(2);
  });
});
