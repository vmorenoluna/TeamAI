// @vitest-environment node

/**
 * runSpecPhase with the backlog check enabled (pipeline.json `backlogCheck`):
 * the spec phase only advances on a verified check, applies its verdicts,
 * and deletes its own ticket when the analyst rejects the premise.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { mockCreateSession } = vi.hoisted(() => ({ mockCreateSession: vi.fn() }));

vi.mock('../../src/lib/logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../src/lib/git-platform', () => ({ resolveBaseBranch: () => 'main' }));
vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(), off: vi.fn(), emit: vi.fn(),
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    sendMessage: vi.fn(), killSession: vi.fn(), getSession: vi.fn(),
    getAllSessions: vi.fn(() => []), getStaleSessions: vi.fn(() => []), removeStaleSession: vi.fn(),
    getTerminalSessions: vi.fn(() => []), killTerminalSession: vi.fn(), writeToSession: vi.fn(), terminateSession: vi.fn(),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

import { runSpecPhase } from '../../src/lib/orchestrator/phase-runners';
import { TaskStore } from '../../src/lib/task-store';
import { checkFile, snapshotFile, type BoardSnapshot } from '../../src/lib/orchestrator/backlog-check';

const TASK = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function makeCtx(agent: (specPath: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'teamai-spec-backlog-'));
  const store = new TaskStore(root);
  store.create(TASK, 'Fix: the thing', 'filed by a coder');
  store.create(OTHER, 'Fix: older duplicate', 'same problem, older wording');
  const specPath = store.getDirById(TASK);
  const pipeline = {
    taskId: TASK, title: 'Fix: the thing', description: 'filed by a coder', phase: 'spec', specPath,
    worktreePath: join(root, 'wt'), branch: 'feat/x', specRevision: 0, sessionId: undefined as string | undefined,
  };
  const deps = {
    projectRoot: root,
    taskStore: store,
    persistAndEmitPhase: vi.fn(),
    sessionOpts: () => ({ role: 'analyst', cwd: root, taskId: TASK }),
    waitForCompletion: vi.fn(async () => agent(specPath)),
    advancePhase: (p: typeof pipeline, phase: string) => { p.phase = phase; },
    rotateOutputLog: vi.fn(), phaseHeader: vi.fn(), savePipelineState: vi.fn(),
    toAgentPath: (p: string) => p,
    executePhase: vi.fn(async () => undefined),
    gitPush: vi.fn(), execGit: vi.fn(),
    getPipelineConfig: () => ({ wakeupScanRetryDelayMs: 0, maxImplementRetries: 3, backlogCheck: true }),
    scheduleWakeup: vi.fn(),
    writeCompletionSummary: vi.fn(),
    removeWorktree: vi.fn(),
  };
  return { root, store, specPath, pipeline, deps };
}

/** A simulated analyst: writes the spec and a check covering the snapshot. */
function analyst(self: 'proceed' | 'reject', otherVerdict = 'supersedes') {
  return (specPath: string) => {
    writeFileSync(join(specPath, 'spec.md'), '# spec');
    writeFileSync(join(specPath, 'spec_summary.md'), 'summary');
    const snap: BoardSnapshot = JSON.parse(readFileSync(join(specPath, snapshotFile('spec')), 'utf-8'));
    writeFileSync(join(specPath, checkFile('spec')), JSON.stringify({
      tickets: snap.tickets.map(t => ({ id: t.id, verdict: otherVerdict, reason: 'same defect, fully covered' })),
      self: { verdict: self, reason: self === 'reject' ? 'already fixed on master by commit abc123' : 'reproduced on master' },
    }));
  };
}

describe('runSpecPhase with the backlog check enabled', () => {
  let ctx: ReturnType<typeof makeCtx>;
  beforeEach(() => { vi.clearAllMocks(); mockCreateSession.mockResolvedValue('sess'); });
  afterEach(() => { try { rmSync(ctx.root, { recursive: true, force: true }); } catch { /* best-effort */ } });

  it('advances to plan and applies the verdicts when the check is valid', async () => {
    ctx = makeCtx(analyst('proceed'));
    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);
    expect(ctx.pipeline.phase).toBe('plan');
    expect(ctx.store.getById(OTHER)!.supersededBy).toBe(TASK);
  });

  it('deletes its own ticket without planning when the analyst rejects the premise', async () => {
    ctx = makeCtx(analyst('reject', 'unrelated'));
    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);
    expect(ctx.store.getById(TASK)).toBeNull();
    expect(ctx.deps.executePhase).not.toHaveBeenCalled();
    expect(ctx.deps.removeWorktree).toHaveBeenCalledWith(TASK);
    expect(ctx.store.getById(OTHER)).not.toBeNull();
  });

  it('fails the task when the analyst never writes a valid check, after the follow-up sessions', async () => {
    ctx = makeCtx(specPath => {
      writeFileSync(join(specPath, 'spec.md'), '# spec');
      writeFileSync(join(specPath, 'spec_summary.md'), 'summary');
    });
    await runSpecPhase(ctx.pipeline as never, ctx.deps as never);
    expect(ctx.pipeline.phase).toBe('failed');
    expect(ctx.deps.writeCompletionSummary).toHaveBeenCalledWith(expect.anything(), 'backlog-check-incomplete', expect.stringContaining('was not written'));
    // 1 spec session + 3 follow-ups
    expect(ctx.deps.waitForCompletion).toHaveBeenCalledTimes(4);
  });
});
