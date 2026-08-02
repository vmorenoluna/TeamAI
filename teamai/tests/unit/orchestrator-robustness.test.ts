/**
 * Orchestrator robustness guardrail tests.
 * Covers QA review guardrails and snapshot restore behaviour:
 *   - QA verifies remote branch matches worktree (unpushed commits)
 *   - Implement phase mandatory git push
 *   - QA respects locked / manual-override qa_report.json
 *   - Snapshot restore on QA bounce and task retry
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createTestProject } from '../utils/test-project';

import { createFireEvent, AnyOrch } from '../utils/orchestrator-harness';

// ── Hoisted mocks ──

const { onHandlers, mockCreateSession, mockSendMessage, mockKillSession, mockEmit, mockGetSession } = vi.hoisted(() => ({
  onHandlers: new Map<string, Array<(...args: any[]) => void>>(),
  mockCreateSession: vi.fn(),
  mockSendMessage: vi.fn(),
  mockKillSession: vi.fn(),
  mockEmit: vi.fn(),
  mockGetSession: vi.fn(),
}));

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
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!onHandlers.has(event)) onHandlers.set(event, []);
      onHandlers.get(event)!.push(handler);
      return vi.fn();
    },
    off: vi.fn(),
    emit: (...args: any[]) => mockEmit(...args),
    createSession: (...args: any[]) => mockCreateSession(...args),
    sendMessage: (...args: any[]) => mockSendMessage(...args),
    killSession: (...args: any[]) => mockKillSession(...args),
    getSession: (...args: any[]) => mockGetSession(...args),
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

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: {
    ensureContainer: vi.fn(),
    getRunningContainer: vi.fn(() => null),
  },
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

// ── Imports after mocks ──

import { Orchestrator } from '../../src/lib/orchestrator';
import { buildSyntheticReworkDescription, isInfraError, tryCherryPickWithRecovery, _recoverSubtaskBranchBeforeDelete, _recoverStBranchCommits, clearWorktreeDirectoryOrThrow, preserveUncommittedWork, relocateStuckWorktree, sweepAbandonedWorktreeRelocations } from '../../src/lib/orchestrator/implement';
import type { ImplementDeps, ImplementPipeline } from '../../src/lib/orchestrator/implement';
import { resolveWorktreeDirName } from '../../src/lib/orchestrator/helpers';

const fireEvent = createFireEvent(onHandlers);

// ── Helpers ──

function setupProject() {
  const { root, clean } = createTestProject();
  mkdirSync(join(root, '.teamai'), { recursive: true });
  writeFileSync(join(root, '.teamai', 'pipeline.json'), JSON.stringify({
    phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'],
    maxQaAttempts: 3,
    parallelSubtasks: true,
  }));

  const taskId = randomUUID();
  const taskDir = join(root, '.teamai', 'robustness-test');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    title: 'Robustness Test',
    description: 'a test task',
    phase: 'implement',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  return { root, taskId, taskDir, clean };
}

function makePipeline(taskId: string, specPath: string, overrides: Record<string, any> = {}): any {
  return {
    taskId,
    description: 'test',
    phase: 'qa-review' as string,
    specPath,
    worktreePath: '/test/wt',
    branch: 'feat/robustness-test',
    qaAttempt: 1,
    maxQaAttempts: 3,
    specRevision: 0,
    deliverableFailCounts: undefined as Record<number, number> | undefined,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  Gap 3 — QA skips when qa_report.json is locked / manual override
// ═══════════════════════════════════════════════════════════════════════

describe('runQaReview — Gap 3: locked / manual override QA reports', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('skips QA review when qa_report.json has locked: true', async () => {
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      locked: true,
      criteria: [{ name: 'Feature X', status: 'FAIL', notes: 'Manual override' }],
    }));

    const pipeline = makePipeline(project.taskId, project.taskDir);
    await (orch as AnyOrch).runQaReview(pipeline);

    // QA session should NOT have been created
    expect(mockCreateSession).not.toHaveBeenCalled();
    // Should have advanced to awaiting-review (skipping QA)
    expect(pipeline.phase).toBe('awaiting-review');
  });

  it('skips QA review when reviewedBy contains "manual override" (case insensitive)', async () => {
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      reviewedBy: 'MANUAL OVERRIDE by Jane on 2024-06-01',
      criteria: [{ name: 'Feature X', status: 'FAIL', notes: 'Human set FAIL' }],
    }));

    const pipeline = makePipeline(project.taskId, project.taskDir);
    await (orch as AnyOrch).runQaReview(pipeline);

    // QA session should NOT have been created
    expect(mockCreateSession).not.toHaveBeenCalled();
    // Should have advanced to awaiting-review
    expect(pipeline.phase).toBe('awaiting-review');
  });

  it('proceeds with normal QA when qa_report.json has no lock or override', async () => {
    // No qa_report.json at all — should proceed normally
    const pipeline = makePipeline(project.taskId, project.taskDir);
    mockCreateSession.mockResolvedValue('sess-qa-normal');

    // Don't await — runQaReview will call waitForCompletion and hang
    const promise = (orch as AnyOrch).runQaReview(pipeline);
    // Wait for sendMessage (synchronous call right before waitForCompletion)
    // so the event listener is registered before we fire the result event.
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    expect(mockCreateSession).toHaveBeenCalled();
    // Clean up by resolving the session
    fireEvent('event', { sessionId: 'sess-qa-normal', event: { type: 'result' } });
    // Need a qa_report.json to avoid read error
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS', criteria: [],
    }));
    await promise;
  });

  it('handles malformed qa_report.json gracefully and proceeds with fresh QA', async () => {
    writeFileSync(join(project.taskDir, 'qa_report.json'), 'not valid json {{{');

    const pipeline = makePipeline(project.taskId, project.taskDir);
    mockCreateSession.mockResolvedValue('sess-qa-malformed');

    const promise = (orch as AnyOrch).runQaReview(pipeline);
    // Wait for sendMessage (synchronous call right before waitForCompletion)
    // so the event listener is registered before we fire the result event.
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    // Should still create a QA session (malformed JSON doesn't block)
    expect(mockCreateSession).toHaveBeenCalled();

    fireEvent('event', { sessionId: 'sess-qa-malformed', event: { type: 'result' } });
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS', criteria: [],
    }));
    await promise;
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Gap 1 — Pre-QA unpushed commits verification
// ═══════════════════════════════════════════════════════════════════════

describe('runQaReview — Gap 1: unpushed commits detection', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('bounces back to implement when unpushed commits detected and qaAttempt < maxQaAttempts', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return 'abc123 Unpushed commit\n';
      if (args && args[0] === 'push') throw new Error('push failed');
      return '';
    });

    // Spy on executePhase to prevent cascading into runImplement (which needs plan.json,
    // subtask sessions, etc.). We just want to verify the bounce-back decision.
    // Wrapped in try/finally to guarantee mockRestore() on assertion failure — executePhase
    // lives on Orchestrator.prototype so a leaked spy would break all subsequent tests.
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    try {
      const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

      await (orch as AnyOrch).runQaReview(pipeline);

      // FAIL report should be written
      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(report.overall).toBe('FAIL');
      expect(report.criteria[0].name).toBe('Unpushed commits');
      expect(report.criteria[0].notes).toContain('Unpushed commits detected');

      // Should bounce back to implement (qaAttempt < maxQaAttempts)
      expect(pipeline.phase).toBe('implement');

      // ── Gap 5b: qa_report_before_bounce.json snapshot should be created ──
      const bounceSnapshotPath = join(project.taskDir, 'qa_report_before_bounce.json');
      expect(existsSync(bounceSnapshotPath)).toBe(true);
      const bounceSnapshot = JSON.parse(readFileSync(bounceSnapshotPath, 'utf-8'));
      expect(bounceSnapshot.overall).toBe('FAIL');
      expect(bounceSnapshot.criteria[0].name).toBe('Unpushed commits');

      // QA feedback should be written
      const feedbackPath = join(project.taskDir, 'qa_feedback.md');
      expect(existsSync(feedbackPath)).toBe(true);

      // executePhase was called to cascade to implement (we short-circuited it)
      expect(executeSpy).toHaveBeenCalled();

      // QA agent should NOT have run
      expect(mockCreateSession).not.toHaveBeenCalled();
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('writes FAIL report when unpushed commits are detected and push fails', async () => {
    // Mock: git fetch succeeds (no output needed)
    // Mock: git log origin/branch..branch returns unpushed commits
    // Mock: git push fails
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return 'abc123 Unpushed commit 1\ndef456 Unpushed commit 2\n';
      if (args && args[0] === 'push') throw new Error('remote rejected — non-fast-forward');
      return '';
    });

    // qaAttempt starts at 2, runQaReview increments to 3 which equals maxQaAttempts (3),
    // so it goes directly to 'failed' without bouncing back to implement.
    // This avoids the cascade into runImplement which would need plan.json and subtask sessions.
    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 2 });

    await (orch as AnyOrch).runQaReview(pipeline);

    // Check that a FAIL report was written
    const reportPath = join(project.taskDir, 'qa_report.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('Unpushed commits');
    expect(report.criteria[0].notes).toContain('Unpushed commits detected');

    // Task should fail (qaAttempt reached max)
    expect(pipeline.phase).toBe('failed');
    expect(mockCreateSession).not.toHaveBeenCalled(); // QA agent never ran
  });

  it('auto-pushes unpushed commits and proceeds with normal QA when push succeeds', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return 'abc123 Unpushed commit\n';
      if (args && args[0] === 'push') return ''; // push succeeds
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-autopush');

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

    const promise = (orch as AnyOrch).runQaReview(pipeline);
    // Wait for sendMessage (synchronous call right before waitForCompletion)
    // so the event listener is registered before we fire the result event.
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    // QA session should be created since auto-push succeeded
    expect(mockCreateSession).toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith('sess-qa-autopush', expect.stringContaining('/qa-review'));

    fireEvent('event', { sessionId: 'sess-qa-autopush', event: { type: 'result' } });
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS', criteria: [],
    }));
    await promise;
  });

  it('advances to failed when unpushed and max QA attempts reached', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return 'abc123 Unpushed commit\n';
      if (args && args[0] === 'push') throw new Error('push failed');
      return '';
    });

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 3, maxQaAttempts: 3 });

    await (orch as AnyOrch).runQaReview(pipeline);

    // Should fail (max attempts reached)
    expect(pipeline.phase).toBe('failed');
    expect(mockCreateSession).not.toHaveBeenCalled();

    const reportPath = join(project.taskDir, 'qa_report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('Unpushed commits');
  });

  it('proceeds normally when no unpushed commits exist', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return ''; // empty = no unpushed commits
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-clean');

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

    const promise = (orch as AnyOrch).runQaReview(pipeline);
    // Wait for sendMessage (synchronous call right before waitForCompletion)
    // so the event listener is registered before we fire the result event.
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    expect(mockCreateSession).toHaveBeenCalled();

    fireEvent('event', { sessionId: 'sess-qa-clean', event: { type: 'result' } });
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS', criteria: [],
    }));
    await promise;
  });

  it('handles missing remote branch gracefully (first push scenario)', async () => {
    // git fetch and git log both throw — branch doesn't exist on remote
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') throw new Error('no remote branch');
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-first-push');

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

    const promise = (orch as AnyOrch).runQaReview(pipeline);
    // Wait for sendMessage (synchronous call right before waitForCompletion)
    // so the event listener is registered before we fire the result event.
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    // Should proceed with QA normally (first push — no remote to compare against)
    expect(mockCreateSession).toHaveBeenCalled();

    fireEvent('event', { sessionId: 'sess-qa-first-push', event: { type: 'result' } });
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS', criteria: [],
    }));
    await promise;
  });

  // ── Diverged-branch reconciliation ──
  //
  // A non-fast-forward push rejection means the branch has diverged from
  // its own remote counterpart (not the same as an unrelated push failure
  // like a network/auth error) — a plain retry can never succeed, and
  // without reconciliation the task bounces to implement, finds every
  // subtask already complete, skips straight back to this exact same
  // precheck, and fails identically every time until the QA attempt cap is
  // burned on a problem the bounce loop never actually touches.

  it('reconciles via a clean rebase onto origin/<branch> and proceeds to normal QA after retrying the push', async () => {
    let pushCalls = 0;
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return 'abc123 Unpushed commit\n';
      if (args && args[0] === 'rebase') return ''; // clean rebase — no conflict
      if (args && args[0] === 'push') {
        pushCalls++;
        if (pushCalls === 1) throw new Error('! [rejected]  feat/robustness-test -> feat/robustness-test (non-fast-forward)');
        return ''; // retry after reconciliation succeeds
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-after-clean-rebase');

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

    const promise = (orch as AnyOrch).runQaReview(pipeline);
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    // Only the QA session should have been created — no merger needed for a clean rebase
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(mockSendMessage).toHaveBeenCalledWith('sess-qa-after-clean-rebase', expect.stringContaining('/qa-review'));

    fireEvent('event', { sessionId: 'sess-qa-after-clean-rebase', event: { type: 'result' } });
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS', criteria: [],
    }));
    await promise;

    expect(pushCalls).toBe(2);
    const logContent = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('Push rejected (non-fast-forward) — reconciling with origin before retrying');
    expect(logContent).toContain('Pushed after reconciling with origin');
  });

  it('reconciles via a merger when the rebase conflicts, verifies the merger pushed, then proceeds to normal QA', async () => {
    // The merger's own /merge skill pushes the resolved branch as its final
    // step (.claude/commands/merge.md step 6) — the orchestrator never
    // retries the push itself for this path, it just re-checks. Simulate
    // that by having `git log origin/branch..branch` return commits before
    // the merger runs and empty afterward.
    let logCalls = 0;
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') {
        logCalls++;
        return logCalls === 1 ? 'abc123 Unpushed commit\n' : '';
      }
      if (args && args[0] === 'rebase') {
        if (args[1] === '--abort') return '';
        throw new Error('CONFLICT (content): Merge conflict');
      }
      if (args && args[0] === 'push') throw new Error('! [rejected]  feat/robustness-test -> feat/robustness-test (non-fast-forward)');
      return '';
    });

    mockCreateSession
      .mockResolvedValueOnce('sess-merge')
      .mockResolvedValueOnce('sess-qa-after-merge');

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

    const promise = (orch as AnyOrch).runQaReview(pipeline);

    // Merger session runs first
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
    expect(mockSendMessage).toHaveBeenCalledWith('sess-merge', expect.stringContaining('/merge origin/feat/robustness-test'));
    fireEvent('event', { sessionId: 'sess-merge', event: { type: 'result' } });

    // Then the QA session, once the merger's own push is verified
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });
    expect(mockSendMessage).toHaveBeenCalledWith('sess-qa-after-merge', expect.stringContaining('/qa-review'));

    fireEvent('event', { sessionId: 'sess-qa-after-merge', event: { type: 'result' } });
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS', criteria: [],
    }));
    await promise;

    // Only 2 log calls: the initial precheck, and one verification check
    // after the merger — no polling needed since it settled immediately.
    expect(logCalls).toBe(2);
    const logContent = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('spawning merger to resolve via git merge');
    expect(logContent).toContain('Merger resolved divergence from origin/feat/robustness-test');
    expect(logContent).toContain('Merger pushed the reconciled branch — remote matches worktree');
  });

  it('falls through to the FAIL report when reconciliation cannot resolve the divergence', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return 'abc123 Unpushed commit\n';
      if (args && args[0] === 'rebase') {
        if (args[1] === '--abort') return '';
        throw new Error('CONFLICT (content): Merge conflict');
      }
      if (args && args[0] === 'push') throw new Error('! [rejected]  feat/robustness-test -> feat/robustness-test (non-fast-forward)');
      return '';
    });

    // Merger session itself fails to even start
    mockCreateSession.mockRejectedValue(new Error('session creation failed'));

    // qaAttempt starts at 2, runQaReview increments to 3 which equals maxQaAttempts (3),
    // so it goes directly to 'failed' without bouncing back to implement — same pattern
    // as the pre-existing "writes FAIL report..." test above.
    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 2 });

    await (orch as AnyOrch).runQaReview(pipeline);

    const reportPath = join(project.taskDir, 'qa_report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('Unpushed commits');

    expect(pipeline.phase).toBe('failed');

    const logContent = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('Merger could not resolve divergence');
  });

  // ── Post-merger push verification ──
  //
  // The merger's own /merge skill pushes the resolved branch as its final
  // step, so the orchestrator doesn't retry the push itself — it just
  // re-checks whether the branch is actually up to date. waitForCompletion
  // resolving is a session/turn-ended signal, not a git-durability
  // guarantee, so this re-check gets a couple of cheap retries (not an
  // arbitrary blind wait) before concluding the push didn't land.

  it('retries the re-check a couple of times before confirming the merger settled', async () => {
    let logCalls = 0;
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') {
        logCalls++;
        // Initial precheck (call 1) and the first re-check (call 2) both
        // still show the old, unpushed state; the second re-check (call 3)
        // reflects the merger's push having landed.
        return logCalls < 3 ? 'abc123 Unpushed commit\n' : '';
      }
      if (args && args[0] === 'rebase') {
        if (args[1] === '--abort') return '';
        throw new Error('CONFLICT (content): Merge conflict');
      }
      if (args && args[0] === 'push') throw new Error('! [rejected]  feat/robustness-test -> feat/robustness-test (non-fast-forward)');
      return '';
    });

    mockCreateSession
      .mockResolvedValueOnce('sess-merge-retry')
      .mockResolvedValueOnce('sess-qa-after-retry');

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

    const promise = (orch as AnyOrch).runQaReview(pipeline);

    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
    fireEvent('event', { sessionId: 'sess-merge-retry', event: { type: 'result' } });

    // One re-check comes back still-unpushed before the second settles —
    // advance past the single 500ms delay between them.
    await vi.advanceTimersByTimeAsync(500);

    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });
    expect(mockSendMessage).toHaveBeenCalledWith('sess-qa-after-retry', expect.stringContaining('/qa-review'));

    fireEvent('event', { sessionId: 'sess-qa-after-retry', event: { type: 'result' } });
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS', criteria: [],
    }));
    await promise;

    expect(logCalls).toBe(3);
  });

  it('gives up and falls through to the FAIL report when the merger push never settles within the recheck cap', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return 'abc123 Unpushed commit\n'; // never settles
      if (args && args[0] === 'rebase') {
        if (args[1] === '--abort') return '';
        throw new Error('CONFLICT (content): Merge conflict');
      }
      if (args && args[0] === 'push') throw new Error('! [rejected]  feat/robustness-test -> feat/robustness-test (non-fast-forward)');
      return '';
    });

    mockCreateSession.mockResolvedValueOnce('sess-merge-never-settles');

    // qaAttempt starts at 2, runQaReview increments to 3 which equals maxQaAttempts (3),
    // so it goes directly to 'failed' without bouncing back to implement.
    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 2 });

    const promise = (orch as AnyOrch).runQaReview(pipeline);

    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
    fireEvent('event', { sessionId: 'sess-merge-never-settles', event: { type: 'result' } });

    // Exhaust the recheck cap (MERGED_RECHECK_MAX_ATTEMPTS = 2, 500ms apart).
    await vi.advanceTimersByTimeAsync(1000);

    await promise;

    // Only the merger session ran — QA never gets a chance to run since the
    // push was never confirmed.
    expect(mockCreateSession).toHaveBeenCalledTimes(1);

    const reportPath = join(project.taskDir, 'qa_report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('Unpushed commits');
    expect(pipeline.phase).toBe('failed');

    const logContent = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain("Branch still diverged from origin/feat/robustness-test after the merger's push — giving up");
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Gap 5b — Snapshot qa_report.json before bouncing to implement
// ═══════════════════════════════════════════════════════════════════════

describe('runQaReview — Gap 5b: snapshot qa_report.json on QA FAIL bounce', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('snapshots qa_report.json to qa_report_before_bounce.json when QA FAIL causes bounce back to implement', async () => {
    // Mock git operations to pass Gap 1 checks (no unpushed commits)
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return ''; // no unpushed commits
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-fail-bounce');

    // Spy on executePhase to prevent cascading into runImplement
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

    try {
      const promise = (orch as AnyOrch).runQaReview(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      expect(mockCreateSession).toHaveBeenCalled();

      // QA agent runs and writes a FAIL report
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        criteria: [
          { name: 'Login flow', status: 'FAIL', notes: 'Missing error handling', fix_needed: 'Add try/catch' },
          { name: 'API rate limit', status: 'FAIL', notes: 'No retry logic', fix_needed: 'Add exponential backoff' },
        ],
        additional_issues: [
          { description: 'N+1 query in getUsers', file: 'src/api.ts', severity: 'high', fix_needed: 'Use batch query' },
        ],
      }));

      // Fire the result event so waitForCompletion resolves
      fireEvent('event', { sessionId: 'sess-qa-fail-bounce', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);

      // Should bounce back to implement (qaAttempt < maxQaAttempts)
      expect(pipeline.phase).toBe('implement');

      // ── Gap 5b: qa_report_before_bounce.json snapshot should exist ──
      const bounceSnapshotPath = join(project.taskDir, 'qa_report_before_bounce.json');
      expect(existsSync(bounceSnapshotPath)).toBe(true);

      // Snapshot should be a byte-for-byte copy
      const snapshot = JSON.parse(readFileSync(bounceSnapshotPath, 'utf-8'));
      expect(snapshot.overall).toBe('FAIL');
      expect(snapshot.criteria).toHaveLength(2);
      expect(snapshot.criteria[0].name).toBe('Login flow');
      expect(snapshot.criteria[0].fix_needed).toBe('Add try/catch');
      expect(snapshot.criteria[1].name).toBe('API rate limit');
      expect(snapshot.additional_issues[0].description).toContain('N+1 query');
      expect(snapshot.additional_issues[0].fix_needed).toBe('Use batch query');

      // The original qa_report.json should still exist (not deleted)
      expect(existsSync(join(project.taskDir, 'qa_report.json'))).toBe(true);

      // QA feedback should be written
      expect(existsSync(join(project.taskDir, 'qa_feedback.md'))).toBe(true);

      // executePhase was called to cascade to implement
      expect(executeSpy).toHaveBeenCalled();

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('does not create snapshot when QA PASSES (no bounce)', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-pass');

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

    const promise = (orch as AnyOrch).runQaReview(pipeline);
    // Wait for sendMessage (synchronous call right before waitForCompletion)
    // so the event listener is registered before we fire the result event.
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    expect(mockCreateSession).toHaveBeenCalled();

    // QA passes — no bounce needed
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS',
      criteria: [{ name: 'Login flow', status: 'PASS', notes: 'LGTM' }],
    }));

    fireEvent('event', { sessionId: 'sess-qa-pass', event: { type: 'result' } });
    await promise;

    // Should advance to awaiting-review (PASS — no bounce)
    expect(pipeline.phase).toBe('awaiting-review');

    // No bounce — no snapshot should be created
    expect(existsSync(join(project.taskDir, 'qa_report_before_bounce.json'))).toBe(false);
  });

  it('does not create snapshot when max QA attempts reached (goes to failed — no bounce)', async () => {
    // When overall !== PASS and qaAttempt >= maxQaAttempts, the task goes to failed.
    // The snapshot is only created on bounce — it should NOT exist when failing directly.
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-max-fail');

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 3, maxQaAttempts: 3 });

    const promise = (orch as AnyOrch).runQaReview(pipeline);
    // Wait for sendMessage (synchronous call right before waitForCompletion)
    // so the event listener is registered before we fire the result event.
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    expect(mockCreateSession).toHaveBeenCalled();

    // QA fails — and qaAttempt >= maxQaAttempts (after increment, qaAttempt=4 >= 3)
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      criteria: [{ name: 'Login flow', status: 'FAIL', notes: 'Still broken' }],
    }));

    fireEvent('event', { sessionId: 'sess-qa-max-fail', event: { type: 'result' } });
    await promise;

    // Should advance to failed (max attempts reached — no bounce)
    expect(pipeline.phase).toBe('failed');

    // No bounce means no bounce snapshot
    expect(existsSync(join(project.taskDir, 'qa_report_before_bounce.json'))).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Gap 4b — runImplement restores qa_report.json from snapshot
// ═══════════════════════════════════════════════════════════════════════

describe('runImplement — Gap 4b: restore qa_report.json from snapshot', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    // Write plan.json with a single subtask so runImplement can proceed
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1,
        title: 'Test subtask',
        description: 'Test description',
        files: ['src/test.ts'],
        acceptance_criteria: ['Works'],
      }],
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('restores qa_report.json from qa_report_before_failed.json when qa_report.json is missing', async () => {
    // Write a snapshot but NOT qa_report.json
    const snapshotContent = JSON.stringify({
      overall: 'FAIL',
      criteria: [
        { name: 'Feature X', status: 'FAIL', notes: 'Missing edge case handling' },
        { name: 'Performance', status: 'FAIL', notes: 'N+1 query in getUsers' },
      ],
    });
    writeFileSync(join(project.taskDir, 'qa_report_before_failed.json'), snapshotContent);

    mockExecFileSync.mockReturnValue('abc123\n'); // for git push/rev-parse
    mockCreateSession.mockResolvedValue('sess-impl-restore');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // qa_report.json should now exist (restored from snapshot)
      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(report.overall).toBe('FAIL');
      expect(report.criteria).toHaveLength(2);
      expect(report.criteria[0].name).toBe('Feature X');
      expect(report.criteria[1].name).toBe('Performance');

      // The snapshot file should still exist (not deleted)
      expect(existsSync(join(project.taskDir, 'qa_report_before_failed.json'))).toBe(true);

      // Resolve the implement subtask so the test can clean up
      fireEvent('event', { sessionId: 'sess-impl-restore', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('restores qa_report.json from qa_report_before_bounce.json when that is the only snapshot available', async () => {
    // Only the bounce snapshot exists (not the retryTask snapshot)
    const snapshotContent = JSON.stringify({
      overall: 'FAIL',
      criteria: [
        { name: 'Auth module', status: 'FAIL', notes: 'Broken session handling', fix_needed: 'Fix session token refresh' },
      ],
      additional_issues: [
        { description: 'Missing CSRF token', file: 'src/auth.ts', severity: 'high' },
      ],
    });
    writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), snapshotContent);

    mockExecFileSync.mockReturnValue('abc123\n');
    mockCreateSession.mockResolvedValue('sess-impl-bounce-snap');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // qa_report.json should now exist (restored from bounce snapshot)
      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(report.overall).toBe('FAIL');
      expect(report.criteria[0].name).toBe('Auth module');
      expect(report.additional_issues[0].description).toContain('Missing CSRF token');

      // The bounce snapshot should still exist
      expect(existsSync(join(project.taskDir, 'qa_report_before_bounce.json'))).toBe(true);

      fireEvent('event', { sessionId: 'sess-impl-bounce-snap', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('does nothing when neither qa_report.json nor snapshot exists', async () => {
    // Neither file exists — should proceed normally
    mockExecFileSync.mockReturnValue('abc123\n');
    mockCreateSession.mockResolvedValue('sess-impl-no-snap');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // qa_report.json should NOT have been created
      expect(existsSync(join(project.taskDir, 'qa_report.json'))).toBe(false);
      expect(existsSync(join(project.taskDir, 'qa_report_before_failed.json'))).toBe(false);

      fireEvent('event', { sessionId: 'sess-impl-no-snap', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('does not overwrite qa_report.json when it already exists', async () => {
    // Both files exist — the existing qa_report.json should be preserved
    const existingContent = JSON.stringify({
      overall: 'PASS',
      criteria: [{ name: 'Feature X', status: 'PASS', notes: 'All good' }],
    });
    writeFileSync(join(project.taskDir, 'qa_report.json'), existingContent);

    const snapshotContent = JSON.stringify({
      overall: 'FAIL',
      criteria: [{ name: 'Feature X', status: 'FAIL', notes: 'Old failure' }],
    });
    writeFileSync(join(project.taskDir, 'qa_report_before_failed.json'), snapshotContent);

    mockExecFileSync.mockReturnValue('abc123\n');
    mockCreateSession.mockResolvedValue('sess-impl-exists');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // qa_report.json should still contain the original PASS content (not overwritten)
      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(report.overall).toBe('PASS');
      expect(report.criteria[0].status).toBe('PASS');

      fireEvent('event', { sessionId: 'sess-impl-exists', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('restores raw snapshot content even when it is not valid JSON (byte-for-byte copy)', async () => {
    // The guard copies snapshot bytes verbatim — JSON validity is not validated.
    // Malformed content is still restored so the engineer can see what was there.
    writeFileSync(join(project.taskDir, 'qa_report_before_failed.json'), 'not valid json {{{');

    mockExecFileSync.mockReturnValue('abc123\n');
    mockCreateSession.mockResolvedValue('sess-impl-malformed');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // The implement subtask should still be started (guard didn't block)
      expect(mockCreateSession).toHaveBeenCalled();

      // The raw snapshot content is restored byte-for-byte — the guard does not
      // validate JSON; it preserves whatever was in the snapshot file.
      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      const restored = readFileSync(reportPath, 'utf-8');
      expect(restored).toBe('not valid json {{{');

      fireEvent('event', { sessionId: 'sess-impl-malformed', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('restores qa_report.json even when snapshot has different structure (real-world resilience)', async () => {
    // A real-world snapshot might have additional fields (locked, reviewedBy, etc.)
    const snapshotContent = JSON.stringify({
      overall: 'FAIL',
      locked: true,
      reviewedBy: 'manual override by reviewer',
      criteria: [
        { name: 'Edge cases', status: 'FAIL', notes: 'Missing null checks', fix_needed: 'Add null guards' },
      ],
      additional_issues: [
        { description: 'Memory leak in event listener', file: 'src/app.ts', severity: 'high', fix_needed: 'Add cleanup' },
      ],
    });
    writeFileSync(join(project.taskDir, 'qa_report_before_failed.json'), snapshotContent);

    mockExecFileSync.mockReturnValue('abc123\n');
    mockCreateSession.mockResolvedValue('sess-impl-complex');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(report.overall).toBe('FAIL');
      expect(report.locked).toBe(true);
      expect(report.reviewedBy).toContain('manual override');
      expect(report.criteria[0].fix_needed).toBe('Add null guards');
      expect(report.additional_issues[0].description).toContain('Memory leak');

      fireEvent('event', { sessionId: 'sess-impl-complex', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('also restores qa_report.json from snapshot in resumeTask path when hasPlan=true', async () => {
    // resumeTask goes to implement when plan.json exists. The guard should
    // restore qa_report.json from snapshot before the pipeline starts.
    writeFileSync(join(project.taskDir, 'spec.md'), '# Test spec');
    // plan.json already written in beforeEach

    const snapshotContent = JSON.stringify({
      overall: 'FAIL',
      criteria: [
        { name: 'Resume test', status: 'FAIL', notes: 'Should be restored on resume' },
      ],
    });
    writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), snapshotContent);
    // No qa_report.json — it was deleted

    // Spy on runTask to prevent actual pipeline execution
    const runTaskSpy = vi.spyOn(orch as AnyOrch, 'runTask').mockResolvedValue(undefined);

    try {
      await (orch as AnyOrch).resumeTask(project.taskId);

      // qa_report.json should have been restored before runTask was called
      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(report.criteria[0].name).toBe('Resume test');

      // Should have called runTask with implement as startPhase (hasPlan=true)
      expect(runTaskSpy).toHaveBeenCalledWith(project.taskId, expect.any(String), 'implement');
    } finally {
      runTaskSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  E2E — Full QA→implement bounce→restore cycle
// ═══════════════════════════════════════════════════════════════════════

describe('E2E — QA→implement bounce→restore full cycle', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    // Write spec.md and plan.json so the pipeline can proceed through all phases
    writeFileSync(join(project.taskDir, 'spec.md'), '# E2E Bounce Test Spec\n\nA feature that needs QA review.');
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1,
        title: 'Implement feature',
        description: 'Build the feature',
        files: ['src/feature.ts'],
        acceptance_criteria: ['Works correctly'],
      }],
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  // ── Test 1: Normal QA FAIL bounce → delete qa_report.json → Gap 4b restores from bounce snapshot ──

  it('restores qa_report.json from bounce snapshot after QA FAIL bounce when engineer deletes it', async () => {
    // Phase 1 — runQaReview: QA fails, bounces to implement, Gap 5b creates qa_report_before_bounce.json
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return ''; // no unpushed commits (pass Gap 1)
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-e2e-qa1');

    // Spy on executePhase to prevent cascading after QA bounce
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    // Create pipeline at the qa-review phase; qaAttempt=1 so bounce-back happens
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'qa-review',
      qaAttempt: 1,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      // Start QA — it'll create a session, wait for completion
      const qaPromise = (orch as AnyOrch).runQaReview(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      expect(mockCreateSession).toHaveBeenCalled();

      // QA agent writes a FAIL report with real-world structure
      const failReport = {
        overall: 'FAIL',
        criteria: [
          { name: 'Login flow', status: 'FAIL', notes: 'Missing error handling on 401', fix_needed: 'Add try/catch around API calls' },
          { name: 'Rate limiting', status: 'FAIL', notes: 'No retry with backoff', fix_needed: 'Implement exponential backoff' },
          { name: 'Accessibility', status: 'PASS', notes: 'ARIA labels are correct' },
        ],
        additional_issues: [
          { description: 'N+1 query in getUserList', file: 'src/api/users.ts', severity: 'high', fix_needed: 'Batch the queries with Promise.all' },
        ],
      };
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(failReport));

      // Fire result event — waitForCompletion resolves, QA processes the report
      fireEvent('event', { sessionId: 'sess-e2e-qa1', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);

      // ── Assert Phase 1 results ──
      // Pipeline bounced to implement (qaAttempt < maxQaAttempts)
      expect(pipeline.phase).toBe('implement');

      // Gap 5b: bounce snapshot created
      const bounceSnapshotPath = join(project.taskDir, 'qa_report_before_bounce.json');
      expect(existsSync(bounceSnapshotPath)).toBe(true);

      // QA feedback written
      expect(existsSync(join(project.taskDir, 'qa_feedback.md'))).toBe(true);

      // executePhase was called to cascade to implement
      expect(executeSpy).toHaveBeenCalled();

      await qaPromise;

      // ── Simulate: engineer accidentally deletes qa_report.json ──
      // (This is what the Gap 4b guard is designed to protect against)
      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      unlinkSync(reportPath);
      expect(existsSync(reportPath)).toBe(false);

      // ── Phase 2 — runImplement: Gap 4b restores qa_report.json from snapshot ──
      // Reset mocks for the implement phase
      mockExecFileSync.mockReset();
      mockCreateSession.mockReset();
      mockSendMessage.mockClear();
      onHandlers.clear(); // prevent stale event handlers from Phase 1 leaking into Phase 2
      mockExecFileSync.mockReturnValue('abc123\n'); // for git push/rev-parse
      mockCreateSession.mockResolvedValue('sess-e2e-impl');

      pipeline.phase = 'implement';
      pipeline.qaAttempt = 1;
      const executeSpy2 = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

      try {
        const implPromise = (orch as AnyOrch).runImplement(pipeline);
        // Wait for sendMessage (synchronous call right before waitForCompletion)
        // so the event listener is registered before we fire the result event.
        await vi.waitFor(() => {
          expect(mockSendMessage).toHaveBeenCalled();
        });

        // ── Assert Phase 2 results ──
        // qa_report.json should be restored from the bounce snapshot
        expect(existsSync(reportPath)).toBe(true);
        const restored = JSON.parse(readFileSync(reportPath, 'utf-8'));
        expect(restored.overall).toBe('FAIL');
        expect(restored.criteria).toHaveLength(3);
        expect(restored.criteria[0].name).toBe('Login flow');
        expect(restored.criteria[0].fix_needed).toBe('Add try/catch around API calls');
        expect(restored.criteria[1].name).toBe('Rate limiting');
        expect(restored.criteria[1].fix_needed).toBe('Implement exponential backoff');
        expect(restored.criteria[2].name).toBe('Accessibility');
        expect(restored.criteria[2].status).toBe('PASS');
        expect(restored.additional_issues).toHaveLength(1);
        expect(restored.additional_issues[0].description).toContain('N+1 query');
        expect(restored.additional_issues[0].fix_needed).toBe('Batch the queries with Promise.all');

        // The snapshot should still exist (guard does not delete it)
        expect(existsSync(bounceSnapshotPath)).toBe(true);

        // The implement subtask should have been started
        expect(mockCreateSession).toHaveBeenCalled();

        // Fire result event to complete implement
        fireEvent('event', { sessionId: 'sess-e2e-impl', event: { type: 'result' } });
        await vi.advanceTimersByTimeAsync(30);
        await implPromise;
      } finally {
        executeSpy2.mockRestore();
      }
    } finally {
      executeSpy.mockRestore();
    }
  });

  // ── Test 2: QA FAIL bounce → qa_report.json NOT deleted → Gap 4b does nothing → original preserved ──

  it('preserves existing qa_report.json during implement when not deleted (no-op guard)', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-e2e-qa2');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'qa-review',
      qaAttempt: 1,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const qaPromise = (orch as AnyOrch).runQaReview(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const originalReport = {
        overall: 'FAIL',
        criteria: [{ name: 'Bug', status: 'FAIL', notes: 'Null pointer', fix_needed: 'Add null check' }],
      };
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(originalReport));

      fireEvent('event', { sessionId: 'sess-e2e-qa2', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);

      expect(pipeline.phase).toBe('implement');

      // Bounce snapshot exists
      const bounceSnapshotPath = join(project.taskDir, 'qa_report_before_bounce.json');
      expect(existsSync(bounceSnapshotPath)).toBe(true);

      await qaPromise;

      // ── qa_report.json is NOT deleted (normal case) ──
      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);

      // ── Phase 2: runImplement — Gap 4b should NOT overwrite existing report ──
      mockExecFileSync.mockReset();
      mockCreateSession.mockReset();
      mockSendMessage.mockClear();
      mockExecFileSync.mockReturnValue('abc123\n');
      mockCreateSession.mockResolvedValue('sess-e2e-impl2');

      pipeline.phase = 'implement';
      pipeline.qaAttempt = 1;
      const executeSpy2 = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

      try {
        const implPromise = (orch as AnyOrch).runImplement(pipeline);
        // Wait for sendMessage (synchronous call right before waitForCompletion)
        // so the event listener is registered before we fire the result event.
        await vi.waitFor(() => {
          expect(mockSendMessage).toHaveBeenCalled();
        });

        // The existing qa_report.json should be UNCHANGED (not overwritten by snapshot)
        const existing = JSON.parse(readFileSync(reportPath, 'utf-8'));
        expect(existing.overall).toBe('FAIL');
        expect(existing.criteria[0].name).toBe('Bug');
        expect(existing.criteria[0].notes).toBe('Null pointer');

        // The bounce snapshot should still exist
        expect(existsSync(bounceSnapshotPath)).toBe(true);

        fireEvent('event', { sessionId: 'sess-e2e-impl2', event: { type: 'result' } });
        await vi.advanceTimersByTimeAsync(30);
        await implPromise;
      } finally {
        executeSpy2.mockRestore();
      }
    } finally {
      executeSpy.mockRestore();
    }
  });

  // ── Test 3: Gap 1 unpushed bounce → snapshot → delete → Gap 4b restores ──

  it('restores qa_report.json from bounce snapshot after Gap 1 unpushed-commits bounce', async () => {
    // Gap 1: unpushed commits detected, push fails
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return 'abc123 Unpushed commit\n';
      if (args && args[0] === 'push') throw new Error('push rejected');
      return '';
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'qa-review',
      qaAttempt: 1,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      await (orch as AnyOrch).runQaReview(pipeline);

      // Gap 1: FAIL report written
      const gap1Report = JSON.parse(readFileSync(join(project.taskDir, 'qa_report.json'), 'utf-8'));
      expect(gap1Report.criteria[0].name).toBe('Unpushed commits');

      // Bounced to implement (qaAttempt < maxQaAttempts)
      expect(pipeline.phase).toBe('implement');

      // Gap 5b: bounce snapshot should exist even for Gap 1 bounce
      const bounceSnapshotPath = join(project.taskDir, 'qa_report_before_bounce.json');
      expect(existsSync(bounceSnapshotPath)).toBe(true);

      // QA feedback written
      expect(existsSync(join(project.taskDir, 'qa_feedback.md'))).toBe(true);

      executeSpy.mockRestore();

      // ── Delete qa_report.json (simulate engineer cleanup) ──
      const reportPath = join(project.taskDir, 'qa_report.json');
      unlinkSync(reportPath);
      expect(existsSync(reportPath)).toBe(false);

      // ── Phase 2: runImplement — Gap 4b restores from bounce snapshot ──
      mockExecFileSync.mockReset();
      mockCreateSession.mockReset();
      mockExecFileSync.mockReturnValue('abc123\n');
      mockCreateSession.mockResolvedValue('sess-e2e-gap1-impl');

      pipeline.phase = 'implement';
      pipeline.qaAttempt = 1;
      const executeSpy2 = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

      try {
        const implPromise = (orch as AnyOrch).runImplement(pipeline);
        // Wait for sendMessage (synchronous call right before waitForCompletion)
        // so the event listener is registered before we fire the result event.
        await vi.waitFor(() => {
          expect(mockSendMessage).toHaveBeenCalled();
        });

        // qa_report.json restored from Gap 1 bounce snapshot
        expect(existsSync(reportPath)).toBe(true);
        const restored = JSON.parse(readFileSync(reportPath, 'utf-8'));
        expect(restored.criteria[0].name).toBe('Unpushed commits');
        expect(restored.overall).toBe('FAIL');

        fireEvent('event', { sessionId: 'sess-e2e-gap1-impl', event: { type: 'result' } });
        await vi.advanceTimersByTimeAsync(30);
        await implPromise;
      } finally {
        executeSpy2.mockRestore();
      }
    } finally {
      executeSpy.mockRestore();
    }
  });

  // ── Test 4: resumeTask path — bounce snapshot exists, delete report, resumeTask restores it ──

  it('restores qa_report.json from bounce snapshot during resumeTask after QA bounce', async () => {
    // Simulate: a QA FAIL → bounce happened earlier, leaving:
    //   - qa_report_before_bounce.json (snapshot exists)
    //   - qa_report.json deleted (engineer cleaned up)
    //   - spec.md and plan.json exist
    //   - task phase is 'implement' in the store

    const failReport = {
      overall: 'FAIL',
      criteria: [
        { name: 'Security audit', status: 'FAIL', notes: 'No CSRF protection', fix_needed: 'Add CSRF tokens' },
      ],
    };
    writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), JSON.stringify(failReport));

    // qa_report.json does NOT exist (deleted)
    expect(existsSync(join(project.taskDir, 'qa_report.json'))).toBe(false);

    // Update task phase to 'implement' so resumeTask starts from implement
    const taskStore = (orch as AnyOrch).taskStore;
    taskStore.update(project.taskId, { phase: 'implement' });

    // Spy on runTask to prevent actual pipeline execution
    const runTaskSpy = vi.spyOn(orch as AnyOrch, 'runTask').mockResolvedValue(undefined);

    try {
      await (orch as AnyOrch).resumeTask(project.taskId);

      // qa_report.json should have been restored from bounce snapshot BEFORE runTask
      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      const restored = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(restored.overall).toBe('FAIL');
      expect(restored.criteria[0].name).toBe('Security audit');
      expect(restored.criteria[0].fix_needed).toBe('Add CSRF tokens');

      // The snapshot should still exist
      expect(existsSync(join(project.taskDir, 'qa_report_before_bounce.json'))).toBe(true);

      // runTask called with implement as startPhase (hasPlan=true)
      expect(runTaskSpy).toHaveBeenCalledWith(project.taskId, expect.any(String), 'implement');
    } finally {
      runTaskSpy.mockRestore();
    }
  });

  // ── Test 5: Locked report restored → Gap 3 detects lock on QA re-run ──

  it('preserves locked:true through restore cycle so Gap 3 skips QA on re-run', async () => {
    // A human reviewer locked the report during a previous QA cycle.
    // The report was bounced, snapshot was created, then the report was deleted.
    // On restore, Gap 4b should preserve locked:true so Gap 3 still fires.

    const lockedReport = {
      overall: 'FAIL',
      locked: true,
      reviewedBy: 'Human QA Lead — manual override',
      criteria: [
        { name: 'UX Review', status: 'FAIL', notes: 'Button placement disagrees with design spec' },
      ],
    };
    writeFileSync(join(project.taskDir, 'qa_report_before_bounce.json'), JSON.stringify(lockedReport));

    // qa_report.json deleted
    expect(existsSync(join(project.taskDir, 'qa_report.json'))).toBe(false);

    // ── Phase 1: runImplement — Gap 4b restores locked report ──
    mockExecFileSync.mockReset();
    mockCreateSession.mockReset();
    mockExecFileSync.mockReturnValue('abc123\n');
    mockCreateSession.mockResolvedValue('sess-e2e-locked-impl');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    try {
      const implPromise = (orch as AnyOrch).runImplement(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // qa_report.json restored with locked:true preserved
      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      const restored = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(restored.locked).toBe(true);
      expect(restored.reviewedBy).toContain('manual override');
      expect(restored.criteria[0].name).toBe('UX Review');

      // Complete implement
      fireEvent('event', { sessionId: 'sess-e2e-locked-impl', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await implPromise;
    } finally {
      executeSpy.mockRestore();
    }

    // ── Phase 2: runQaReview — Gap 3 detects locked:true and skips QA ──
    mockExecFileSync.mockReset();
    mockCreateSession.mockReset();
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    const qaPipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'qa-review',
      qaAttempt: 1,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    await (orch as AnyOrch).runQaReview(qaPipeline);

    // Gap 3: QA session should NOT have been created (locked report)
    expect(mockCreateSession).not.toHaveBeenCalled();

    // Should skip to awaiting-review
    expect(qaPipeline.phase).toBe('awaiting-review');

    // The locked report should still be intact
    const finalReport = JSON.parse(readFileSync(join(project.taskDir, 'qa_report.json'), 'utf-8'));
    expect(finalReport.locked).toBe(true);
  });

  // ── Test 6: Full targeted re-run — QA FAIL bounces → only flagged subtasks run → QA PASS → done ──

  it('full cycle: QA FAIL → bounce → only flagged subtasks re-run → QA PASS', async () => {
    // Setup: 5 subtasks. QA criteria match only subtasks 2, 3, and 5.
    // After bounce, only those 3 should re-run. The other 2 should stay completed.
    const planPath = join(project.taskDir, 'plan.json');
    writeFileSync(planPath, JSON.stringify({
      subtasks: [
        { id: 1, title: 'Login page', description: 'Build login form', files: ['src/login.ts'], acceptance_criteria: ['Form submits correctly'], completed: true },
        { id: 2, title: 'Error handling', description: 'Add error handling', files: ['src/errors.ts'], acceptance_criteria: ['Error handling for API failures'], completed: true },
        { id: 3, title: 'Rate limiter', description: 'Add rate limiting', files: ['src/rate-limit.ts'], acceptance_criteria: ['Rate limiting prevents abuse'], completed: true },
        { id: 4, title: 'Dashboard', description: 'Build dashboard', files: ['src/dashboard.ts'], acceptance_criteria: ['Charts render correctly'], completed: true },
        { id: 5, title: 'File upload', description: 'Add upload', files: ['src/upload.ts'], acceptance_criteria: ['Error handling for large files'], completed: true },
      ],
    }));

    // ── Phase 1: runQaReview — QA FAIL, _writeQaFeedback patches plan.json ──
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return ''; // no unpushed commits
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-e2e-qa-fail');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'qa-review',
      qaAttempt: 1,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const qaPromise = (orch as AnyOrch).runQaReview(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      expect(mockCreateSession).toHaveBeenCalled();

      // QA writes a FAIL report — criteria match subtasks 2 ("Error handling"),
      // 3 ("Rate limiting"), and 5 ("Error handling for large files").
      // Subtask 1 (login) and 4 (dashboard) should NOT be flagged.
      const failReport = {
        overall: 'FAIL',
        criteria: [
          { name: 'Error handling', status: 'FAIL', notes: 'No error handling found', fix_needed: 'Add try/catch in all API calls' },
          { name: 'Rate limiting', status: 'FAIL', notes: 'Rate limiter not enforced', fix_needed: 'Add token bucket algorithm' },
        ],
      };
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(failReport));

      fireEvent('event', { sessionId: 'sess-e2e-qa-fail', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);

      // Phase 1 assertions
      expect(pipeline.phase).toBe('implement');
      expect(existsSync(join(project.taskDir, 'qa_report_before_bounce.json'))).toBe(true);
      expect(existsSync(join(project.taskDir, 'qa_feedback.md'))).toBe(true);

      // _writeQaFeedback should have patched plan.json — subtasks 2, 3, 5 flagged
      const patchedPlan = JSON.parse(readFileSync(planPath, 'utf-8'));
      expect(patchedPlan.subtasks[0].qa_flagged).toBeUndefined(); // subtask 1: no match
      expect(patchedPlan.subtasks[1].qa_flagged).toBe(true);       // subtask 2: "Error handling"
      expect(patchedPlan.subtasks[2].qa_flagged).toBe(true);       // subtask 3: "Rate limiting"
      expect(patchedPlan.subtasks[3].qa_flagged).toBeUndefined(); // subtask 4: no match
      expect(patchedPlan.subtasks[4].qa_flagged).toBe(true);       // subtask 5: "Error handling for large files"

      await qaPromise;
      executeSpy.mockRestore();

      // ── Phase 2: runImplement — only flagged subtasks (2, 3, 5) should run ──
      mockExecFileSync.mockReset();
      mockCreateSession.mockReset();
      mockSendMessage.mockReset();
      onHandlers.clear();
      mockExecFileSync.mockReturnValue('abc123\n');
      mockCreateSession
        .mockResolvedValueOnce('sess-e2e-impl-2')
        .mockResolvedValueOnce('sess-e2e-impl-3')
        .mockResolvedValueOnce('sess-e2e-impl-5');

      pipeline.phase = 'implement';
      pipeline.qaAttempt = 1;
      const executeSpy2 = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

      try {
        const implPromise = (orch as AnyOrch).runImplement(pipeline);
        // Wait for sendMessage (synchronous call right before waitForCompletion)
        // so the event listener is registered before we fire the result event.
        await vi.waitFor(() => {
          expect(mockSendMessage).toHaveBeenCalled();
        });

        // Resolve all 3 flagged subtasks sequentially (groups loop is sequential)
        fireEvent('event', { sessionId: 'sess-e2e-impl-2', event: { type: 'result' } });
        await vi.advanceTimersByTimeAsync(20);
        fireEvent('event', { sessionId: 'sess-e2e-impl-3', event: { type: 'result' } });
        await vi.advanceTimersByTimeAsync(20);
        fireEvent('event', { sessionId: 'sess-e2e-impl-5', event: { type: 'result' } });
        await vi.advanceTimersByTimeAsync(30);

        // Only 3 subtasks should be started (the flagged ones)
        expect(mockCreateSession).toHaveBeenCalledTimes(3);

        // Verify the right subtasks ran
        const sendCalls = mockSendMessage.mock.calls;
        expect(sendCalls).toHaveLength(3);
        expect(sendCalls[0][1]).toContain('Subtask 2');
        expect(sendCalls[1][1]).toContain('Subtask 3');
        expect(sendCalls[2][1]).toContain('Subtask 5');

        // QA feedback should be prepended to each prompt
        expect(sendCalls[0][1]).toContain('QA FEEDBACK');
        expect(sendCalls[0][1]).toContain('Add try/catch in all API calls');

        // Non-flagged subtasks (1 and 4) should NOT have had sessions created
        const allSessionCalls = mockCreateSession.mock.calls;
        expect(allSessionCalls).toHaveLength(3);

        await implPromise;
      } finally {
        executeSpy2.mockRestore();
      }

      // qa_flagged markers should be cleaned up
      const planAfter = JSON.parse(readFileSync(planPath, 'utf-8'));
      for (const s of planAfter.subtasks) {
        expect(s.qa_flagged).toBeUndefined();
      }
      // qa_feedback.md should be deleted
      expect(existsSync(join(project.taskDir, 'qa_feedback.md'))).toBe(false);

      // Pipeline should have advanced to qa-review
      expect(pipeline.phase).toBe('qa-review');

      // ── Phase 3: runQaReview — QA PASS → awaiting-review → done ──
      mockExecFileSync.mockReset();
      mockCreateSession.mockReset();
      mockSendMessage.mockClear();
      onHandlers.clear();
      mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
        if (args && args[0] === 'fetch') return '';
        if (args && args[0] === 'log') return '';
        return '';
      });
      mockCreateSession.mockResolvedValue('sess-e2e-qa-pass');

      // Gap 3: no lock on the restored report
      const currentReport = JSON.parse(readFileSync(join(project.taskDir, 'qa_report.json'), 'utf-8'));
      expect(currentReport.locked).toBeUndefined();

      const qa2Promise = (orch as AnyOrch).runQaReview(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      expect(mockCreateSession).toHaveBeenCalled(); // QA ran again

      // QA passes this time
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'PASS',
        criteria: [
          { name: 'Error handling', status: 'PASS', notes: 'Try/catch added correctly' },
          { name: 'Rate limiting', status: 'PASS', notes: 'Token bucket works' },
        ],
      }));

      fireEvent('event', { sessionId: 'sess-e2e-qa-pass', event: { type: 'result' } });
      await qa2Promise;

      // Final state: awaiting-review (task is done from the pipeline's perspective)
      expect(pipeline.phase).toBe('awaiting-review');
    } finally {
      executeSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Gap 2 — Implement phase mandatory git push
// ═══════════════════════════════════════════════════════════════════════

describe('runImplement — Gap 2: mandatory git push before QA', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    // Write plan.json with a single subtask so runImplement can proceed
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1,
        title: 'Test subtask',
        description: 'Test description',
        files: ['src/test.ts'],
        acceptance_criteria: ['Works'],
      }],
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('pushes commits and verifies remote HEAD matches local HEAD before advancing to qa-review', async () => {
    const localHead = 'abc123def456';
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'rev-parse') return localHead + '\n';
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-impl-push');

    // Spy on executePhase to short-circuit the cascade into runQaReview after push
    // succeeds, so the promise resolves cleanly instead of hanging in waitForCompletion.
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      // Start runImplement asynchronously — the implement subtask's waitForCompletion
      // hangs until we fire the result event from outside.
      const promise = (orch as AnyOrch).runImplement(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // The implement subtask should have been started
      expect(mockCreateSession).toHaveBeenCalled();

      // Resolve the implement subtask
      fireEvent('event', { sessionId: 'sess-impl-push', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // After implement subtask completes, git push should have been called
      const pushCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[1] && Array.isArray(call[1]) && call[1][0] === 'push',
      );
      expect(pushCalls.length).toBeGreaterThanOrEqual(1);
      expect(pushCalls[0][1]).toContain('--force');

      // The rev-parse verification should have been called (local + remote)
      const revParseCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[1] && Array.isArray(call[1]) && call[1][0] === 'rev-parse',
      );
      expect(revParseCalls.length).toBeGreaterThanOrEqual(2);

      // After push succeeds, it should advance to qa-review
      expect(pipeline.phase).toBe('qa-review');

      // executePhase was called to cascade (we short-circuited it)
      expect(executeSpy).toHaveBeenCalled();

      // Promise resolves cleanly since executePhase is spied
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('fails the task when git push fails', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push') throw new Error('remote: Permission denied');
        if (args[0] === 'pull') return '';
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-impl-pushfail');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const promise = (orch as AnyOrch).runImplement(pipeline);
    // Wait for sendMessage (synchronous call right before waitForCompletion)
    // so the event listener is registered before we fire the result event.
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    // Fire event to resolve the implement subtask
    fireEvent('event', { sessionId: 'sess-impl-pushfail', event: { type: 'result' } });
    await vi.advanceTimersByTimeAsync(50);

    // After push failure, task should go to 'failed'
    expect(pipeline.phase).toBe('failed');

    // Should NOT have advanced to qa-review
    expect(pipeline.phase).not.toBe('qa-review');

    // A FAIL report should have been written with push failure info
    const reportPath = join(project.taskDir, 'qa_report.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('Git push verification');
    expect(report.criteria[0].notes).toContain('Permission denied');

    await promise;
  });

  it('fails the task when push succeeds but remote HEAD differs from local HEAD', async () => {
    const localHead = 'abc123';
    const remoteHead = 'def456';

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push') return '';
        if (args[0] === 'fetch' && args[1] && args[1].includes('feat/')) return '';
        if (args[0] === 'rev-parse') {
          // First call: local HEAD, second call: remote HEAD
          const arg = args[1] as string;
          if (arg.startsWith('origin/')) return remoteHead + '\n';
          return localHead + '\n';
        }
        if (args[0] === 'pull') return '';
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-impl-divergent');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const promise = (orch as AnyOrch).runImplement(pipeline);
    // Wait for sendMessage (synchronous call right before waitForCompletion)
    // so the event listener is registered before we fire the result event.
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    fireEvent('event', { sessionId: 'sess-impl-divergent', event: { type: 'result' } });
    await vi.advanceTimersByTimeAsync(50);

    // Should fail because heads don't match
    expect(pipeline.phase).toBe('failed');

    const reportPath = join(project.taskDir, 'qa_report.json');
    expect(existsSync(reportPath)).toBe(true);

    await promise;
  });

  it('skips push failure and continues to qa-review when a PR already exists for the branch', async () => {
    // Scenario: git push fails (worktree was cleaned up after PR creation),
    // but a PR already exists for this branch. The push guard should detect
    // the existing PR via `gh pr list` and treat the failure as non-fatal,
    // advancing to qa-review instead of failed.
    const existingPrUrl = 'https://github.com/shopforge/demo/pull/162';

    mockExecFileSync.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === 'gh' && Array.isArray(args) && args[0] === 'pr' && args[1] === 'list') {
        // gh pr list returns the existing PR URL
        return existingPrUrl + '\n';
      }
      if (Array.isArray(args)) {
        if (args[0] === 'push') throw new Error('src refspec feat/robustness-test does not match any');
        if (args[0] === 'pull') return '';
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-impl-pr-exists');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Resolve the implement subtask
      fireEvent('event', { sessionId: 'sess-impl-pr-exists', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // Should NOT be failed — PR exists, push failure is non-fatal
      expect(pipeline.phase).not.toBe('failed');
      expect(pipeline.phase).toBe('qa-review');

      // No FAIL report should have been written — the PR-exists path logs a
      // warning and continues, it does not write a qa_report.json at all.
      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(false);

      // executePhase was called to cascade to qa-review
      expect(executeSpy).toHaveBeenCalled();

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('still fails when push fails AND no PR exists for the branch', async () => {
    // Scenario: push fails AND gh pr list returns empty (no PR exists).
    // This is the normal failure case — push should be treated as fatal.
    mockExecFileSync.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === 'gh' && Array.isArray(args) && args[0] === 'pr' && args[1] === 'list') {
        return ''; // empty — no PR exists
      }
      if (Array.isArray(args)) {
        if (args[0] === 'push') throw new Error('remote: Permission denied');
        if (args[0] === 'pull') return '';
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-impl-no-pr');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const promise = (orch as AnyOrch).runImplement(pipeline);
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    fireEvent('event', { sessionId: 'sess-impl-no-pr', event: { type: 'result' } });
    await vi.advanceTimersByTimeAsync(50);

    // Should fail — no PR exists, push failure is fatal
    expect(pipeline.phase).toBe('failed');

    const reportPath = join(project.taskDir, 'qa_report.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('Git push verification');

    await promise;
  });

  it('handles gh CLI unavailable gracefully — still fails when push fails and pr check throws', async () => {
    // Scenario: push fails AND gh CLI is not available (throws).
    // The prExists check is a best-effort fallback — if it throws,
    // fall through to the normal failure path.
    mockExecFileSync.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === 'gh' && Array.isArray(args) && args[0] === 'pr' && args[1] === 'list') {
        throw new Error('gh: command not found');
      }
      if (Array.isArray(args)) {
        if (args[0] === 'push') throw new Error('remote: Permission denied');
        if (args[0] === 'pull') return '';
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-impl-no-gh');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const promise = (orch as AnyOrch).runImplement(pipeline);
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    fireEvent('event', { sessionId: 'sess-impl-no-gh', event: { type: 'result' } });
    await vi.advanceTimersByTimeAsync(50);

    // Should fail — gh unavailable, normal failure path
    expect(pipeline.phase).toBe('failed');

    const reportPath = join(project.taskDir, 'qa_report.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('Git push verification');
    expect(report.criteria[0].notes).toContain('Permission denied');

    await promise;
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Safety-net commit excludes .teamai/ (Bug 1 fix)
// ═══════════════════════════════════════════════════════════════════════

describe('runImplement — safety-net commit excludes .teamai/ (Bug 1)', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    // Write plan.json with 2 subtasks sharing the same parallel_group
    // to trigger isMultiGroup=true and the safety-net commit path.
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        {
          id: 1,
          title: 'Fix login bug',
          description: 'Fix null pointer in login form',
          files: ['src/login.ts'],
          acceptance_criteria: ['No crash on null input'],
          parallel_group: 'bug-fixes',
        },
        {
          id: 2,
          title: 'Fix dashboard bug',
          description: 'Fix chart rendering error',
          files: ['src/dashboard.ts'],
          acceptance_criteria: ['Charts render correctly'],
          parallel_group: 'bug-fixes',
        },
      ],
    }));

    // Mock git operations:
    // - git status --porcelain returns dirty to trigger safety-net
    // - cherry-pick, push, fetch, pull, rebase all succeed silently
    // - rev-parse returns a commit hash
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        const argStr = args.join(' ');
        if (argStr.includes('status') && argStr.includes('--porcelain')) {
          return '?? stray-dirty-file.txt\n';
        }
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull'
            || args[0] === 'rebase' || args[0] === 'cherry-pick') {
          return '';
        }
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'branch') return '';
        if (args[0] === 'worktree') return '';
      }
      return '';
    });

    // Create 2 coder sessions (one per subtask)
    mockCreateSession
      .mockResolvedValueOnce('sess-safety-net-st1')
      .mockResolvedValueOnce('sess-safety-net-st2');
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clean up only the mocks this describe block modified to prevent state
    // leakage. Do NOT use vi.resetAllMocks() — it nukes all hoisted mocks
    // (readContainerConfig, dockerAvailable, etc.) and breaks downstream tests.
    mockExecFileSync.mockReset();
    mockCreateSession.mockReset();
    project.clean();
  });

  it('uses git add with .teamai/ pathspec exclusion when worktree is dirty', async () => {
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);

      // Wait for both coder sessions to start (sendMessage called for each)
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledTimes(2);
      });

      // Resolve both coder sessions so the groups loop can complete
      fireEvent('event', { sessionId: 'sess-safety-net-st1', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(20);
      fireEvent('event', { sessionId: 'sess-safety-net-st2', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // Verify the safety-net commit used git add with .teamai/ pathspec exclusion
      const addCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) =>
          call[0] === 'git' &&
          Array.isArray(call[1]) &&
          call[1].includes('add') &&
          call[1].includes('-A'),
      );
      expect(addCalls.length).toBeGreaterThan(0);

      // The safety-net add command must include the .teamai/ exclusion pathspec
      expect(addCalls[0][1]).toContain(':!.teamai');

      // It must NOT be a bare `git add -A` without any filter
      const bareAddCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) =>
          call[0] === 'git' &&
          Array.isArray(call[1]) &&
          call[1].length === 2 &&
          call[1][0] === 'add' &&
          call[1][1] === '-A',
      );
      expect(bareAddCalls.length).toBe(0);

      // The commit message should match the safety-net pattern
      const commitCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) =>
          call[0] === 'git' &&
          Array.isArray(call[1]) &&
          call[1].includes('commit') &&
          (call[1] as string[]).some((a: string) => a.includes('auto-save worktree state')),
      );
      expect(commitCalls.length).toBe(1);

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Targeted re-run — only QA-flagged subtasks on bounce-back
// ═══════════════════════════════════════════════════════════════════════

describe('runImplement — targeted re-run: only QA-flagged subtasks on bounce-back', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    // Mock git operations to pass push verification
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
      }
      return '';
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('only re-runs subtasks flagged with qa_flagged: true on bounce-back', async () => {
    // Scenario: 3 subtasks, only subtask 2 was flagged by QA
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Add login', description: 'Build login page', files: ['src/login.ts'], acceptance_criteria: ['Works'], completed: true },
        { id: 2, title: 'Fix auth', description: 'Fix auth module', files: ['src/auth.ts'], acceptance_criteria: ['No 401 errors [QA CORRECTION: Add token refresh]'], qa_flagged: true, completed: true },
        { id: 3, title: 'Add dashboard', description: 'Build dashboard', files: ['src/dashboard.ts'], acceptance_criteria: ['Data loads'], completed: true },
      ],
    }));

    // QA feedback exists (simulates bounce-back)
    writeFileSync(join(project.taskDir, 'qa_feedback.md'), '# QA Feedback\n\nFix auth module');

    mockCreateSession.mockResolvedValue('sess-targeted');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 1,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Only ONE subtask should be run (subtask 2 — the flagged one)
      expect(mockCreateSession).toHaveBeenCalledTimes(1);

      // Verify it was called for the right subtask
      const sendCalls = mockSendMessage.mock.calls;
      expect(sendCalls.length).toBe(1);
      expect(sendCalls[0][1]).toContain('Subtask 2');
      expect(sendCalls[0][1]).toContain('Fix auth');

      // Resolve the subtask
      fireEvent('event', { sessionId: 'sess-targeted', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('runs ALL subtasks on first implement when no QA feedback exists', async () => {
    // Scenario: 3 subtasks, NO qa_feedback.md — this is the first implement run
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Add login', description: 'Build login page', files: ['src/login.ts'], acceptance_criteria: ['Works'] },
        { id: 2, title: 'Fix auth', description: 'Fix auth module', files: ['src/auth.ts'], acceptance_criteria: ['No 401 errors'] },
        { id: 3, title: 'Add dashboard', description: 'Build dashboard', files: ['src/dashboard.ts'], acceptance_criteria: ['Data loads'] },
      ],
    }));

    // NO qa_feedback.md — first run
    expect(existsSync(join(project.taskDir, 'qa_feedback.md'))).toBe(false);

    mockCreateSession
      .mockResolvedValueOnce('sess-full-1')
      .mockResolvedValueOnce('sess-full-2')
      .mockResolvedValueOnce('sess-full-3');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Resolve subtask 1 so the loop can proceed to subtask 2
      fireEvent('event', { sessionId: 'sess-full-1', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(20);

      // Resolve subtask 2
      fireEvent('event', { sessionId: 'sess-full-2', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(20);

      // Resolve subtask 3
      fireEvent('event', { sessionId: 'sess-full-3', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);

      // ALL 3 subtasks should be started
      expect(mockCreateSession).toHaveBeenCalledTimes(3);

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('does not crash when a planner-authored subtask omits files (create-only via files_to_create)', async () => {
    // Regression: a subtask whose only file interaction is CREATING a new
    // file (files_to_create) has no reason for the planner to also include
    // an empty `files: []` — but runSubtaskSession's prompt builder used to
    // do an unguarded `subtask.files.join(', ')`, crashing the entire
    // implement phase with "Cannot read properties of undefined (reading
    // 'join')" the moment a real planner session omitted the field. Selected
    // subtasks must be normalized so files/acceptance_criteria/depends_on
    // are always arrays regardless of what the planner actually wrote.
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        {
          id: 1,
          title: 'Run sweep and commit evidence log',
          description: 'Run the sweep and commit the evidence artifact.',
          files_to_create: ['scripts/sweep_logs/evidence.log'],
          depends_on: [],
          acceptance_criteria: ['Evidence file is committed'],
          // `files` deliberately omitted — this is the exact shape that crashed.
        },
      ],
    }));

    mockCreateSession.mockResolvedValueOnce('sess-no-files');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // The prompt must have built successfully (no crash) with an empty
      // Files: line rather than throwing on undefined.join().
      const prompt = mockSendMessage.mock.calls[0][1];
      expect(prompt).toContain('Files: \n');

      fireEvent('event', { sessionId: 'sess-no-files', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);

      await expect(promise).resolves.toBeUndefined();
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('synthesises a targeted rework subtask when QA feedback exists but no subtasks are flagged', async () => {
    // Scenario: QA feedback exists, but criterion matching flagged no subtasks.
    // The orchestrator synthesises a single targeted rework subtask from the
    // qa_feedback.md content rather than re-running all original subtasks.
    // Re-running all subtasks sends the engineer back to stale "add X" descriptions
    // for features that already exist, causing no-op implementations.
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Add login', description: 'Build login page', files: ['src/login.ts'], acceptance_criteria: ['Works'], completed: true },
        { id: 2, title: 'Fix auth', description: 'Fix auth module', files: ['src/auth.ts'], acceptance_criteria: ['No 401 errors'], completed: true },
      ],
    }));

    // QA feedback exists but no subtask has qa_flagged — synthetic rework path
    writeFileSync(join(project.taskDir, 'qa_feedback.md'), '# QA Feedback\n\nAuth module broken');

    mockCreateSession.mockResolvedValue('sess-synthetic');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 1,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Only ONE session should be created — the synthetic rework subtask
      expect(mockCreateSession).toHaveBeenCalledTimes(1);

      // Verify the prompt contains the QA feedback content (source of truth)
      const prompt = mockSendMessage.mock.calls[0][1];
      expect(prompt).toContain('Auth module broken');
      expect(prompt).toContain('QA Rework');
      expect(prompt).toContain('QA feedback (source of truth)');
      // Verify the ALL PLAN SUBTASKS ARE DONE header is present
      expect(prompt).toContain('ALL PLAN SUBTASKS ARE DONE');

      // Resolve the synthetic subtask
      fireEvent('event', { sessionId: 'sess-synthetic', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);

      await promise;

      // The synthesized subtask must be persisted into plan.json, not just
      // held in memory — getTaskFull() reads output-st<id>.log only for ids
      // present in plan.subtasks, so without this the UI's terminal tab can
      // never discover output-st9999.log and stays stuck showing whichever
      // real subtask last ran.
      const planAfter = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      const synthetic = planAfter.subtasks.find((s: { id: number }) => s.id === 9999);
      expect(synthetic).toBeDefined();
      expect(synthetic.completed).toBe(true);
      // qa_flagged is cleared by the post-completion cleanup, same as any
      // other subtask that finishes successfully (see the dedicated
      // "cleans up qa_flagged markers" test below).
      expect(synthetic.qa_flagged).toBeUndefined();
      // Original subtasks are untouched
      expect(planAfter.subtasks.find((s: { id: number }) => s.id === 1).completed).toBe(true);
      expect(planAfter.subtasks.find((s: { id: number }) => s.id === 2).completed).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('re-synthesises a fresh rework subtask on a second bounce instead of replaying the persisted one', async () => {
    // Scenario: a first QA-fallback bounce already persisted subtask 9999
    // (completed, describing stale feedback). A second bounce arrives with
    // NEW qa_feedback.md content and still no real subtask flagged. The
    // fallback must synthesise fresh content from the current feedback —
    // not skip synthesis because a completed 9999 entry already exists.
    const planPath = join(project.taskDir, 'plan.json');
    writeFileSync(planPath, JSON.stringify({
      subtasks: [
        { id: 1, title: 'Add login', description: 'Build login page', files: ['src/login.ts'], acceptance_criteria: ['Works'], completed: true },
        {
          id: 9999,
          title: 'QA Rework: fix failing criteria (criterion matching found no flagged subtasks)',
          description: 'STALE — from the first bounce',
          files: ['src/login.ts'],
          depends_on: [],
          acceptance_criteria: ['All criteria listed in the QA feedback above are satisfied'],
          parallel_group: 'QA-REWORK',
          qa_flagged: true,
          completed: true,
        },
      ],
    }));

    writeFileSync(join(project.taskDir, 'qa_feedback.md'), '# QA Feedback\n\nSecond bounce — brand new failure');

    mockCreateSession.mockResolvedValue('sess-synthetic-2');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 2,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Fresh synthesis must run — not a no-op skip because 9999 already exists
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      const prompt = mockSendMessage.mock.calls[0][1];
      expect(prompt).toContain('Second bounce — brand new failure');
      expect(prompt).not.toContain('STALE — from the first bounce');

      fireEvent('event', { sessionId: 'sess-synthetic-2', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;

      // plan.json must have exactly one 9999 entry (upserted, not duplicated)
      // and it must carry the new description, not the stale one.
      const planAfter = JSON.parse(readFileSync(planPath, 'utf-8'));
      const syntheticEntries = planAfter.subtasks.filter((s: { id: number }) => s.id === 9999);
      expect(syntheticEntries).toHaveLength(1);
      expect(syntheticEntries[0].description).not.toContain('STALE — from the first bounce');
      expect(syntheticEntries[0].completed).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('cleans up qa_flagged markers from plan.json after bounce-back implement completes', async () => {
    // Scenario: subtask was flagged, implement runs and completes — qa_flagged should be removed
    const planPath = join(project.taskDir, 'plan.json');
    writeFileSync(planPath, JSON.stringify({
      subtasks: [
        { id: 1, title: 'Fix bug', description: 'Fix the bug', files: ['src/bug.ts'], acceptance_criteria: ['Bug fixed [QA CORRECTION: Add tests]'], qa_flagged: true, completed: true },
      ],
    }));

    writeFileSync(join(project.taskDir, 'qa_feedback.md'), '# QA Feedback\n\nFix the bug');

    mockCreateSession.mockResolvedValue('sess-cleanup');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 1,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);

      // Wait for sendMessage to be called before firing the result event.
      // sendMessage happens right before waitForCompletion, so by the time
      // this resolves, the orchestrator has registered its event listener.
      // Waiting for mockCreateSession is too early — createSession is async
      // and the orchestrator hasn't reached waitForCompletion yet.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Now it's safe — the orchestrator is in waitForCompletion
      fireEvent('event', { sessionId: 'sess-cleanup', event: { type: 'result' } });
      await promise;

      // qa_flagged should be removed from plan.json
      const planAfter = JSON.parse(readFileSync(planPath, 'utf-8'));
      expect(planAfter.subtasks[0].qa_flagged).toBeUndefined();

      // qa_feedback.md should be deleted
      expect(existsSync(join(project.taskDir, 'qa_feedback.md'))).toBe(false);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('resets completed only for subtasks that are re-run, not all subtasks', async () => {
    // Scenario: 3 subtasks, 2 are qa_flagged. Only those 2 should have completed reset.
    const planPath = join(project.taskDir, 'plan.json');
    writeFileSync(planPath, JSON.stringify({
      subtasks: [
        { id: 1, title: 'Add login', description: 'Login', files: ['src/login.ts'], acceptance_criteria: ['Works'], completed: true },
        { id: 2, title: 'Fix auth', description: 'Auth fix', files: ['src/auth.ts'], acceptance_criteria: ['No 401 [QA CORRECTION: Refresh token]'], qa_flagged: true, completed: true },
        { id: 3, title: 'Add dashboard', description: 'Dashboard', files: ['src/dashboard.ts'], acceptance_criteria: ['Loads'], completed: true },
        { id: 4, title: 'Fix API', description: 'API fix', files: ['src/api.ts'], acceptance_criteria: ['Returns 200 [QA CORRECTION: Handle errors]'], qa_flagged: true, completed: true },
      ],
    }));

    writeFileSync(join(project.taskDir, 'qa_feedback.md'), '# QA Feedback\n\nFix auth and API');

    mockCreateSession
      .mockResolvedValueOnce('sess-multi-1')
      .mockResolvedValueOnce('sess-multi-2');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 1,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Resolve both subtasks so the groups loop can complete
      fireEvent('event', { sessionId: 'sess-multi-1', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(20);
      fireEvent('event', { sessionId: 'sess-multi-2', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);

      // Only 2 subtasks should be started (the flagged ones)
      expect(mockCreateSession).toHaveBeenCalledTimes(2);

      const sendCalls = mockSendMessage.mock.calls;
      expect(sendCalls[0][1]).toContain('Subtask 2');
      expect(sendCalls[1][1]).toContain('Subtask 4');

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('_writeQaFeedback flags ALL subtasks whose acceptance criteria match a FAIL criterion', async () => {
    // Scenario: QA criterion "Missing error handling" matches subtasks 1, 3, and 5.
    // All three should get qa_flagged: true (not just the first one).
    const planPath = join(project.taskDir, 'plan.json');
    writeFileSync(planPath, JSON.stringify({
      subtasks: [
        { id: 1, title: 'Login form', description: 'Build login', files: ['src/login.ts'], acceptance_criteria: ['Error handling for failed logins'] },
        { id: 2, title: 'Dashboard', description: 'Build dashboard', files: ['src/dashboard.ts'], acceptance_criteria: ['Data loads within 2s'] },
        { id: 3, title: 'API client', description: 'Build API client', files: ['src/api.ts'], acceptance_criteria: ['Error handling on network failures', 'Retry with backoff'] },
        { id: 4, title: 'Settings page', description: 'Build settings', files: ['src/settings.ts'], acceptance_criteria: ['Form validation works'] },
        { id: 5, title: 'File upload', description: 'Build upload', files: ['src/upload.ts'], acceptance_criteria: ['Progress bar shows', 'Error handling for large files'] },
      ],
    }));

    const pipeline = makePipeline(project.taskId, project.taskDir);
    const report = {
      overall: 'FAIL',
      criteria: [
        { name: 'Error handling', status: 'FAIL', notes: 'No error handling found', fix_needed: 'Add try/catch around all API calls' },
      ],
    };

    (orch as AnyOrch)._ctx.writeQaFeedback(pipeline, report);

    // Verify qa_feedback.md was written
    expect(existsSync(join(project.taskDir, 'qa_feedback.md'))).toBe(true);

    // Verify plan.json was patched — subtasks 1, 3, and 5 should be flagged
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    expect(plan.subtasks[0].qa_flagged).toBe(true); // subtask 1: "Error handling for failed logins"
    expect(plan.subtasks[1].qa_flagged).toBeUndefined(); // subtask 2: no error handling mention
    expect(plan.subtasks[2].qa_flagged).toBe(true); // subtask 3: "Error handling on network failures"
    expect(plan.subtasks[3].qa_flagged).toBeUndefined(); // subtask 4: no error handling mention
    expect(plan.subtasks[4].qa_flagged).toBe(true); // subtask 5: "Error handling for large files"

    // Subtask 1's acceptance criteria should be patched with QA correction
    expect(plan.subtasks[0].acceptance_criteria[0]).toContain('[QA CORRECTION: Add try/catch around all API calls]');
  });

  it('only runs flagged subtasks within a parallel_group, skipping non-flagged members', async () => {
    // Scenario: 3 subtasks. SubTask 1 (flagged) and SubTask 2 (not flagged)
    // share the same parallel_group "critical-fixes". SubTask 3 is in a
    // different group and also not flagged.
    // Only SubTask 1 should run — SubTask 2 stays skipped despite being
    // in the same parallel group.
    const planPath = join(project.taskDir, 'plan.json');
    writeFileSync(planPath, JSON.stringify({
      subtasks: [
        { id: 1, title: 'Fix auth bug', description: 'Fix the auth null pointer', files: ['src/auth.ts'], acceptance_criteria: ['No crash on null session [QA CORRECTION: Add null guard]'], parallel_group: 'critical-fixes', qa_flagged: true, completed: true },
        { id: 2, title: 'Refactor logger', description: 'Extract logger interface', files: ['src/logger.ts'], acceptance_criteria: ['Passes existing tests'], parallel_group: 'critical-fixes', completed: true },
        { id: 3, title: 'Update docs', description: 'Update API docs', files: ['docs/api.md'], acceptance_criteria: ['All routes documented'], completed: true },
      ],
    }));

    writeFileSync(join(project.taskDir, 'qa_feedback.md'), '# QA Feedback\n\nFix auth null pointer');

    mockCreateSession.mockResolvedValue('sess-parallel-group');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 1,
      maxQaAttempts: 3,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      // Wait for sendMessage (synchronous call right before waitForCompletion)
      // so the event listener is registered before we fire the result event.
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Only ONE subtask should run — the flagged one (subtask 1).
      // SubTask 2 is in the same parallel_group but not flagged — skip it.
      expect(mockCreateSession).toHaveBeenCalledTimes(1);

      const sendCalls = mockSendMessage.mock.calls;
      expect(sendCalls.length).toBe(1);
      expect(sendCalls[0][1]).toContain('Subtask 1');
      expect(sendCalls[0][1]).toContain('Fix auth bug');
      // SESSION CONTEXT header lists all subtask titles, so these
      // appearing is expected. The key assertion is only 1 session created.

      expect(sendCalls[0][1]).toContain('SESSION CONTEXT');
      // Resolve the subtask
      fireEvent('event', { sessionId: 'sess-parallel-group', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Synthetic subtask 9999 — buildSyntheticReworkDescription unit tests
// ═══════════════════════════════════════════════════════════════════════

describe('buildSyntheticReworkDescription', () => {
  it('includes the ALL PLAN SUBTASKS ARE DONE header', () => {
    const result = buildSyntheticReworkDescription('Fix the auth module');
    expect(result).toContain('ALL PLAN SUBTASKS ARE DONE');
  });

  it('includes the QA feedback content verbatim', () => {
    const qaContent = '# QA Feedback\n\n- Fix null pointer in auth.ts\n- Add error handling to API calls';
    const result = buildSyntheticReworkDescription(qaContent);
    expect(result).toContain(qaContent);
  });

  it('tells the engineer not to re-read the spec', () => {
    const result = buildSyntheticReworkDescription('Some issue');
    expect(result).toContain('Do NOT re-read the spec');
  });

  it('tells the engineer not to re-implement completed subtasks', () => {
    const result = buildSyntheticReworkDescription('Some issue');
    expect(result).toContain('do NOT re-read or re-implement them');
  });

  it('includes the "source of truth" label for QA feedback', () => {
    const result = buildSyntheticReworkDescription('Fix bug');
    expect(result).toContain('QA feedback (source of truth)');
  });

  it('labels the rework as targeted, not fresh implementation', () => {
    const result = buildSyntheticReworkDescription('Fix bug');
    expect(result).toContain('TARGETED REWORK, NOT FRESH IMPLEMENTATION');
  });

  it('handles empty QA content gracefully', () => {
    const result = buildSyntheticReworkDescription('');
    expect(result).toContain('ALL PLAN SUBTASKS ARE DONE');
    expect(result).toContain('QA feedback (source of truth)');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  ADR 005 — Deliverable verification circuit breaker
// ═══════════════════════════════════════════════════════════════════════

describe('runImplement — deliverable verification circuit breaker (ADR 005)', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    // Mock git operations to pass push verification
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
      }
      return '';
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('increments deliverableFailCounts when files_to_create are missing after session ends', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1,
        title: 'Create output files',
        description: 'Generate reports',
        files: ['src/report.ts'],
        acceptance_criteria: ['Report is generated'],
        files_to_create: ['output/report.json', 'output/summary.md'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-deliverable');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // No deliverable files created in the worktree — will fail verification
      expect(existsSync(join(project.root, 'output/report.json'))).toBe(false);

      fireEvent('event', { sessionId: 'sess-deliverable', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // Counter should be incremented
      expect(pipeline.deliverableFailCounts).toBeDefined();
      expect(pipeline.deliverableFailCounts![1]).toBe(1);

      // Subtask should NOT be marked complete
      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks[0].completed).toBeUndefined();

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('injects DELIVERABLE RE-VERIFICATION header into subtask prompt on re-run', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 2,
        title: 'Generate docs',
        description: 'Create documentation',
        files: ['src/docs.ts'],
        acceptance_criteria: ['Docs generated'],
        files_to_create: ['docs/api.md'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-deliverable-reentry');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
      deliverableFailCounts: { 2: 2 },
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // The prompt should contain the re-verification header
      const prompt = mockSendMessage.mock.calls[0][1];
      expect(prompt).toContain('DELIVERABLE RE-VERIFICATION');
      expect(prompt).toContain('attempt 2/3');
      expect(prompt).toContain('docs/api.md');
      expect(prompt).toContain('You MUST create these files');

      fireEvent('event', { sessionId: 'sess-deliverable-reentry', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('advances to failed after 3 consecutive files_to_create failures (circuit breaker)', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 3,
        title: 'Run benchmark',
        description: 'Execute benchmark and save results',
        files: ['src/bench.ts'],
        acceptance_criteria: ['Benchmark completes'],
        files_to_create: ['results/benchmark.json'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-deliverable-broken');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
      deliverableFailCounts: { 3: 2 },
    });

    const promise = (orch as AnyOrch).runImplement(pipeline);
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    fireEvent('event', { sessionId: 'sess-deliverable-broken', event: { type: 'result' } });
    await vi.advanceTimersByTimeAsync(50);

    // After 3rd failure, task should be 'failed'
    expect(pipeline.phase).toBe('failed');

    // Counter should be at 3
    expect(pipeline.deliverableFailCounts![3]).toBe(3);

    // A failure qa_report.json should be written
    const reportPath = join(project.taskDir, 'qa_report.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('Deliverable verification');
    expect(report.criteria[0].notes).toContain('3 times');
    expect(report.criteria[0].notes).toContain('results/benchmark.json');

    await promise;
  });

  it('resets deliverableFailCounts entry when subtask passes verification', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 4,
        title: 'Generate output',
        description: 'Create output file',
        files: ['src/output.ts'],
        acceptance_criteria: ['Output exists'],
        files_to_create: ['output.txt'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-deliverable-pass');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
      deliverableFailCounts: { 4: 1 },
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Create the deliverable file BEFORE firing the result event
      mkdirSync(join(project.root, "worktrees", "test-task"), { recursive: true });
      writeFileSync(join(project.root, "worktrees", "test-task", "output.txt"), "deliverable content");
      expect(existsSync(join(project.root, 'worktrees', 'test-task', 'output.txt'))).toBe(true);

      fireEvent('event', { sessionId: 'sess-deliverable-pass', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // Counter entry should be deleted on pass
      expect(pipeline.deliverableFailCounts?.[4]).toBeUndefined();

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('does NOT increment deliverable counter when THIS session schedules a fresh wakeup', async () => {
    // Deliverate verification must be gated on whether THIS session actually
    // scheduled a wakeup (wakeupDetected), not on whether pipeline.wakeupSubtaskId
    // was already set walking in — a stale carry-over from an earlier cycle must
    // NOT suppress the check (see the wakeup re-entry regression test above,
    // "still verifies files_to_create on a wakeup re-entry session that ends
    // without scheduling a fresh wakeup"). This test covers the legitimate case:
    // the job is still genuinely running and the session correctly reschedules.
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 5,
        title: 'Wakeup subtask',
        description: 'Long-running task',
        files: ['src/long.ts'],
        acceptance_criteria: ['Task completes'],
        files_to_create: ['output/data.json'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-deliverable-wakeup');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });
    // Simulate wakeup already active from an earlier cycle.
    (pipeline as any).wakeupSubtaskId = 5;

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // THIS session reschedules — job is still running, writes a fresh wakeup file.
      writeFileSync(join(project.taskDir, 'subtask_wakeup-st5.json'), JSON.stringify({
        subtask_id: 5,
        wakeup_at: '2026-07-04T12:00:00Z',
        background_command: 'python long_job.py',
        expected_artifact: 'output/data.json',
      }));

      fireEvent('event', { sessionId: 'sess-deliverable-wakeup', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // Counter should NOT be incremented (a fresh wakeup was scheduled this session)
      expect(pipeline.deliverableFailCounts).toBeUndefined();

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('handles partial file creation — counter increments when some files are missing', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 6,
        title: 'Multi-file output',
        description: 'Generate multiple files',
        files: ['src/multi.ts'],
        acceptance_criteria: ['All files generated'],
        files_to_create: ['out/a.json', 'out/b.json', 'out/c.json'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-partial-files');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      // Create only 1 of 3 files
      mkdirSync(join(project.root, "worktrees", "test-task"), { recursive: true });
      mkdirSync(join(project.root, "worktrees", "test-task", "out"), { recursive: true });
      writeFileSync(join(project.root, 'worktrees', 'test-task', 'out/a.json'), '{}');
      expect(existsSync(join(project.root, 'worktrees', 'test-task', 'out/a.json'))).toBe(true);
      expect(existsSync(join(project.root, 'worktrees', 'test-task', 'out/b.json'))).toBe(false);
      expect(existsSync(join(project.root, 'worktrees', 'test-task', 'out/c.json'))).toBe(false);

      fireEvent('event', { sessionId: 'sess-partial-files', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // Counter should increment (any missing file triggers it)
      expect(pipeline.deliverableFailCounts![6]).toBe(1);

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('re-entry prompt lists ALL files_to_create even when only some are missing', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 7,
        title: 'Multi-file re-verify',
        description: 'Generate files',
        files: ['src/gen.ts'],
        acceptance_criteria: ['All files exist'],
        files_to_create: ['out/x.txt', 'out/y.txt'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-multi-reentry');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
      deliverableFailCounts: { 7: 1 },
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const prompt = mockSendMessage.mock.calls[0][1];
      // Should list ALL files from files_to_create
      expect(prompt).toContain('out/x.txt');
      expect(prompt).toContain('out/y.txt');
      expect(prompt).toContain('DELIVERABLE RE-VERIFICATION');

      fireEvent('event', { sessionId: 'sess-multi-reentry', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('does NOT show DELIVERABLE RE-VERIFICATION header when counter is 0 (first run)', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 8,
        title: 'First run subtask',
        description: 'Normal run',
        files: ['src/normal.ts'],
        acceptance_criteria: ['Works'],
        files_to_create: ['normal-output.txt'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-first-run');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
      // No deliverableFailCounts set — first run
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      const prompt = mockSendMessage.mock.calls[0][1];
      expect(prompt).not.toContain('DELIVERABLE RE-VERIFICATION');

      fireEvent('event', { sessionId: 'sess-first-run', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  runSubtaskSession — stall-detector-kill recovery
// ═══════════════════════════════════════════════════════════════════════
//
// getStalledSessions' tool-in-flight ceiling (30min) kills a session that's
// legitimately still working, not just a hung one. Without recovery, that
// kill propagates straight to 'failed' with no chance for the coder to
// react — the killed process might have actually finished, or the coder
// might just need to diagnose a genuine hang it introduced. These tests
// cover the retry-with-fresh-session loop, the cap, and that a deliberate
// stop (no kill reason) is never auto-retried.

describe('runImplement — stall-detector-kill recovery', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
      }
      return '';
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('retries with a fresh session and completes when a stall-killed session recovers', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1,
        title: 'Run full test suite',
        description: 'Run the full sbt test suite',
        files: ['src/Foo.scala'],
        acceptance_criteria: ['Tests pass'],
      }],
    }));

    mockCreateSession
      .mockResolvedValueOnce('sess-stalled')
      .mockResolvedValueOnce('sess-recovered');
    // Only the FIRST session was killed for stalling — the retry session,
    // if it were also killed, wouldn't carry this reason.
    mockGetSession.mockImplementation((id: string) =>
      id === 'sess-stalled' ? { killReason: 'stalled' } : undefined);

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalledTimes(1);
      });

      // First attempt's prompt carries no recovery header.
      expect(mockSendMessage.mock.calls[0][1]).not.toContain('SESSION RECOVERED AFTER STALL-KILL');

      // Kill it as the stall-detector would: exit with a signal, no result event.
      fireEvent('exit', { sessionId: 'sess-stalled', code: null, signal: 'SIGTERM' });
      await vi.advanceTimersByTimeAsync(30);

      // A second, fresh session must have been created and messaged.
      await vi.waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalledTimes(2);
        expect(mockSendMessage).toHaveBeenCalledTimes(2);
      });
      const retryPrompt = mockSendMessage.mock.calls[1][1];
      expect(retryPrompt).toContain('SESSION RECOVERED AFTER STALL-KILL (attempt 1/3)');
      expect(retryPrompt).toContain('Your own change caused a genuine hang');
      expect(pipeline.stallRecoveryCounts).toEqual({ 1: 1 });

      // The retry session completes normally.
      fireEvent('event', { sessionId: 'sess-recovered', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;

      // Successful completion clears the counter and marks the subtask done.
      expect(pipeline.stallRecoveryCounts![1]).toBeUndefined();
      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks[0].completed).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('advances to failed with a FAIL qa_report.json after exceeding maxStallRecoveries', async () => {
    writeFileSync(join(project.root, '.teamai', 'pipeline.json'), JSON.stringify({
      phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'],
      maxQaAttempts: 3,
      parallelSubtasks: true,
      maxStallRecoveries: 1,
    }));
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1,
        title: 'Run full test suite',
        description: 'Run the full sbt test suite',
        files: ['src/Foo.scala'],
        acceptance_criteria: ['Tests pass'],
      }],
    }));

    // maxStallRecoveries: 1 means the cap is hit on the very first kill — no
    // retry session is ever created, so only one value is ever consumed here.
    // (A leftover, never-consumed mockResolvedValueOnce would survive
    // vi.clearAllMocks() — it only clears call history, not queued
    // implementations — and leak into the next test's first createSession
    // call, causing a session-id mismatch there.)
    mockCreateSession.mockResolvedValueOnce('sess-1');
    mockGetSession.mockReturnValue({ killReason: 'stalled' });

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const promise = (orch as AnyOrch).runImplement(pipeline);
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    // maxStallRecoveries: 1 — the first kill already brings attemptCount to
    // 1, which meets the cap, so this fails immediately with no retry session.
    fireEvent('exit', { sessionId: 'sess-1', code: null, signal: 'SIGTERM' });
    await vi.advanceTimersByTimeAsync(50);

    expect(pipeline.phase).toBe('failed');
    expect(pipeline.stallRecoveryCounts).toEqual({ 1: 1 });
    expect(mockCreateSession).toHaveBeenCalledTimes(1); // no retry session was created

    const reportPath = join(project.taskDir, 'qa_report.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('Session repeatedly stalled');
    expect(report.criteria[0].notes).toContain('1 time(s)');

    await promise;
  });

  it('does not retry a deliberate stop (no kill reason) — propagates exactly as before', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1,
        title: 'Run full test suite',
        description: 'Run the full sbt test suite',
        files: ['src/Foo.scala'],
        acceptance_criteria: ['Tests pass'],
      }],
    }));

    mockCreateSession.mockResolvedValueOnce('sess-stopped');
    // No killReason set — simulates stopTask/cancelPipeline, not the stall detector.
    mockGetSession.mockReturnValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const promise = (orch as AnyOrch).runImplement(pipeline);
    // Attach a no-op catch immediately — the assertion below observes the
    // same promise via expect().rejects, but without this, the rejection
    // (which fires as soon as the exit event below is processed) races an
    // as-yet-unattached handler and vitest reports it as an unhandled
    // rejection even though the test itself passes.
    promise.catch(() => {});
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });

    fireEvent('exit', { sessionId: 'sess-stopped', code: null, signal: 'SIGTERM' });
    await vi.advanceTimersByTimeAsync(50);

    // No retry session, no stall-recovery bookkeeping, no "Session repeatedly
    // stalled" report — the error must propagate unhandled, same as pre-fix.
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(pipeline.stallRecoveryCounts).toBeUndefined();

    await expect(promise).rejects.toThrow('Session killed by signal SIGTERM');
  });
});

describe('review-actions — unified counter reset (ADR 005)', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('autoReviseSpec resets deliverableFailCounts alongside qaAttempt', async () => {
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      spec_concerns: [{
        issue: 'Spec is wrong',
        reasoning: 'The formula is incorrect',
        suggested_fix: 'Use the correct formula',
      }],
    }));
    writeFileSync(join(project.taskDir, 'spec.md'), '# Old Spec');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'qa-review',
      qaAttempt: 2,
      maxQaAttempts: 3,
      deliverableFailCounts: { 3: 2 },
    });

    try {
      await (orch as AnyOrch)._autoReviseSpec(pipeline);

      // All counters should be reset
      expect(pipeline.qaAttempt).toBe(0);
      expect(pipeline.deliverableFailCounts).toEqual({});

      // Spec revision should be incremented
      expect(pipeline.specRevision).toBe(1);

      // Should advance to spec phase
      expect(pipeline.phase).toBe('spec');
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('rejectTask resets deliverableFailCounts alongside qaAttempt', async () => {
    // Setup task in awaiting-review phase
    (orch as AnyOrch).taskStore.update(project.taskId, { phase: 'awaiting-review' });

    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      criteria: [{ name: 'Bug', status: 'FAIL', notes: 'Still broken' }],
    }));

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'awaiting-review',
      qaAttempt: 2,
      maxQaAttempts: 3,
      deliverableFailCounts: { 5: 2 },
    });

    // Register the pipeline so rejectTask finds it
    (orch as AnyOrch).pipelines.set(project.taskId, pipeline);

    try {
      await (orch as AnyOrch).rejectTask(project.taskId, 'Fix the bugs please');

      // All counters should be reset
      expect(pipeline.qaAttempt).toBe(0);
      expect(pipeline.deliverableFailCounts).toEqual({});

      // Should bounce back to implement
      expect(pipeline.phase).toBe('implement');

      // human_feedback.md should be written
      expect(existsSync(join(project.taskDir, 'human_feedback.md'))).toBe(true);

      // human_feedback_before_bounce.md snapshot should exist
      expect(existsSync(join(project.taskDir, 'human_feedback_before_bounce.md'))).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('rejectTask preserves existing qa_report.json while adding change request entry', async () => {
    (orch as AnyOrch).taskStore.update(project.taskId, { phase: 'awaiting-review' });

    const originalReport = {
      overall: 'FAIL',
      criteria: [
        { name: 'Bug A', status: 'FAIL', notes: 'Needs fix' },
      ],
    };
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(originalReport));

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'awaiting-review',
      qaAttempt: 1,
      maxQaAttempts: 3,
      deliverableFailCounts: { 1: 3 },
    });
    (orch as AnyOrch).pipelines.set(project.taskId, pipeline);

    try {
      await (orch as AnyOrch).rejectTask(project.taskId, 'Fix the auth module too');

      // Report should still exist with original criteria + new change request
      const report = JSON.parse(readFileSync(join(project.taskDir, 'qa_report.json'), 'utf-8'));
      expect(report.overall).toBe('FAIL');
      expect(report.criteria.length).toBe(2); // original + change request
      expect(report.criteria[0].name).toBe('Bug A');
      expect(report.criteria[1].name).toBe('Change Request');
      expect(report.criteria[1].notes).toBe('Fix the auth module too');
    } finally {
      executeSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  ADR 005 — Pipeline state persistence for new fields
// ═══════════════════════════════════════════════════════════════════════

describe('pipeline-state — persistence of ADR 005 fields', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('savePipelineState includes deliverableFailCounts', () => {
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'qa-review',
      qaAttempt: 2,
      maxQaAttempts: 3,
      deliverableFailCounts: { 3: 2 },
    });

    (orch as AnyOrch)._ctx.savePipelineState(pipeline);

    const statePath = join(project.taskDir, '.pipeline_state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));

    expect(state.qaAttempt).toBe(2);
    expect(state.deliverableFailCounts).toEqual({ 3: 2 });
  });

  it('restorePipelineState recovers deliverableFailCounts after crash', () => {
    // Simulate a crash: save state, then restore
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 1,
      maxQaAttempts: 3,
      deliverableFailCounts: { 7: 1 },
    });

    (orch as AnyOrch)._ctx.savePipelineState(pipeline);

    // Verify state file exists
    const statePath = join(project.taskDir, '.pipeline_state.json');
    expect(existsSync(statePath)).toBe(true);

    // Simulate crash recovery: restore state
    const restored = (orch as AnyOrch)._restorePipelineState(project.taskId, project.taskDir);
    expect(restored).not.toBeNull();
    expect(restored.qaAttempt).toBe(1);
    expect(restored.deliverableFailCounts).toEqual({ 7: 1 });

    // State file should be deleted after restore
    expect(existsSync(statePath)).toBe(false);
  });

  it('restorePipelineState returns null when no saved state exists', () => {
    const restored = (orch as AnyOrch)._restorePipelineState(project.taskId, project.taskDir);
    expect(restored).toBeNull();
  });

  it('deliverableFailCounts survives crash and resume (full cycle)', async () => {
    // Phase 1: implement runs, subtask fails deliverable verification twice
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 10,
        title: 'Crash-recovery subtask',
        description: 'Will fail deliverable check',
        files: ['src/crash.ts'],
        acceptance_criteria: ['File created'],
        files_to_create: ['crash-output.txt'],
      }],
    }));

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-crash-verify');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      // Run 1: deliverable verification fails
      const promise1 = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });
      fireEvent('event', { sessionId: 'sess-crash-verify', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      expect(pipeline.deliverableFailCounts![10]).toBe(1);

      await promise1;

      // Save state (simulating what happens between passes)
      (orch as AnyOrch)._ctx.savePipelineState(pipeline);

      // Simulate crash: clear pipeline from memory
      (orch as AnyOrch).pipelines.delete(project.taskId);

      // Restore state
      const restored = (orch as AnyOrch)._restorePipelineState(project.taskId, project.taskDir);
      expect(restored.deliverableFailCounts).toBeDefined();
      expect(restored.deliverableFailCounts![10]).toBe(1);

      // Verify the counter survived the crash
      const counterValue = restored.deliverableFailCounts![10];
      expect(counterValue).toBe(1);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('deliverableFailCounts survives crash recovery and restore', () => {
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'qa-review',
      qaAttempt: 2,
      maxQaAttempts: 3,
    });

    // Save
    (orch as AnyOrch)._ctx.savePipelineState(pipeline);

    // Simulate crash — destroy pipeline from memory
    (orch as AnyOrch).pipelines.delete(project.taskId);

    // Restore
    const restored = (orch as AnyOrch)._restorePipelineState(project.taskId, project.taskDir);
    expect(restored.qaAttempt).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  ADR 002 — Wakeup lifecycle: detection, isolation, prompt, circuit breaker
// ═══════════════════════════════════════════════════════════════════════

describe('runImplement — wakeup file detection (ADR 002)', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\\n';
      }
      return '';
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('detects subtask_wakeup.json after session ends, sets wakeup fields, and deletes the file', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1,
        title: 'Run benchmark sweep',
        description: 'Execute benchmark and save results',
        files: ['src/bench.ts'],
        acceptance_criteria: ['Benchmark completes'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-wakeup-detect');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      writeFileSync(join(project.taskDir, 'subtask_wakeup.json'), JSON.stringify({
        subtask_id: 1,
        wakeup_at: '2026-07-04T12:00:00Z',
        background_command: 'python sweep.py --output results/',
        expected_artifact: 'results/summary.jsonl',
      }));

      fireEvent('event', { sessionId: 'sess-wakeup-detect', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // Wakeup file should be deleted after reading
      expect(existsSync(join(project.taskDir, 'subtask_wakeup.json'))).toBe(false);

      // Pipeline wakeup fields should be set
      expect(pipeline.wakeupSubtaskId).toBe(1);
      expect(pipeline.wakeupUntil).toBe('2026-07-04T12:00:00Z');
      expect(pipeline.wakeupCommand).toBe('python sweep.py --output results/');
      expect(pipeline.wakeupArtifact).toBe('results/summary.jsonl');
      expect(pipeline.wakeupAttemptCount).toBe(1);

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('detects subtask_wakeup-st<id>.json during a QA-rework (cleanup) session, not just first-pass (regression)', async () => {
    // A coder session running with QA feedback present (hasQaFeedback=true) can
    // legitimately need to start a long background verification job — e.g.
    // re-running a sweep after fixing the code — just like a first-pass
    // session. The wakeup-file check used to be gated behind `!hasQaFeedback`,
    // so a rework session's wakeup file was silently ignored: the orchestrator
    // advanced straight to QA before the background job finished, and QA
    // failed the subtask against incomplete/stale evidence — burning a QA
    // attempt on a false negative unrelated to code or spec quality.
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 2,
        title: 'Run post-fix isolation sweep and commit evidence',
        description: 'Re-verify the fix against a fresh sweep',
        files: ['src/bench.ts'],
        acceptance_criteria: ['Evidence artifact committed'],
        qa_flagged: true,
      }],
    }));
    writeFileSync(join(project.taskDir, 'qa_feedback.md'), '# QA Feedback\n\nSubtask 2: evidence artifact is stale.\n');

    mockCreateSession.mockResolvedValue('sess-wakeup-qa-rework');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 1,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      writeFileSync(join(project.taskDir, 'subtask_wakeup-st2.json'), JSON.stringify({
        subtask_id: 2,
        wakeup_at: '2026-07-04T12:00:00Z',
        background_command: 'python scripts/optimizer_sweep.py --batch',
        expected_artifact: 'scripts/sweep_logs/evidence.log',
      }));

      fireEvent('event', { sessionId: 'sess-wakeup-qa-rework', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // Wakeup file should be detected and deleted, exactly as in the
      // first-pass case — hasQaFeedback must not suppress this.
      expect(existsSync(join(project.taskDir, 'subtask_wakeup-st2.json'))).toBe(false);
      expect(pipeline.wakeupSubtaskId).toBe(2);
      expect(pipeline.wakeupUntil).toBe('2026-07-04T12:00:00Z');
      expect(pipeline.wakeupCommand).toBe('python scripts/optimizer_sweep.py --batch');
      expect(pipeline.wakeupArtifact).toBe('scripts/sweep_logs/evidence.log');
      expect(pipeline.wakeupAttemptCount).toBe(1);

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('handles malformed subtask_wakeup.json gracefully', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{ id: 1, title: 'Normal subtask', description: 'Do work', files: ['src/work.ts'], acceptance_criteria: ['Works'] }],
    }));

    mockCreateSession.mockResolvedValue('sess-wakeup-malformed');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, { phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task') });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      writeFileSync(join(project.taskDir, 'subtask_wakeup.json'), 'not valid json {{{');

      fireEvent('event', { sessionId: 'sess-wakeup-malformed', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      expect(existsSync(join(project.taskDir, 'subtask_wakeup.json'))).toBe(false);
      expect(pipeline.wakeupSubtaskId).toBeUndefined();

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('detects per-subtask subtask_wakeup-st<id>.json (BUG-10)', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 4,
        title: 'Run benchmark sweep',
        description: 'Execute benchmark and save results',
        files: ['src/bench.ts'],
        acceptance_criteria: ['Benchmark completes'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-wakeup-st');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      writeFileSync(join(project.taskDir, 'subtask_wakeup-st4.json'), JSON.stringify({
        subtask_id: 4,
        wakeup_at: '2026-07-04T12:00:00Z',
        background_command: 'python sweep.py',
        expected_artifact: 'results/summary.jsonl',
      }));

      fireEvent('event', { sessionId: 'sess-wakeup-st', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      expect(existsSync(join(project.taskDir, 'subtask_wakeup-st4.json'))).toBe(false);
      expect(pipeline.wakeupSubtaskId).toBe(4);
      expect(pipeline.wakeupUntil).toBe('2026-07-04T12:00:00Z');

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('adopts the EARLIEST wakeup when two parallel subtasks both schedule one (BUG-10)', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Sweep A', description: 'Run sweep A', files: ['src/a.ts'], acceptance_criteria: ['A done'], parallel_group: 1 },
        { id: 2, title: 'Sweep B', description: 'Run sweep B', files: ['src/b.ts'], acceptance_criteria: ['B done'], parallel_group: 1 },
      ],
    }));

    mockCreateSession
      .mockResolvedValueOnce('sess-wake-a')
      .mockResolvedValueOnce('sess-wake-b');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalledTimes(2); });

      // Subtask 1 schedules a LATER wakeup; subtask 2 an EARLIER one.
      writeFileSync(join(project.taskDir, 'subtask_wakeup-st1.json'), JSON.stringify({
        subtask_id: 1,
        wakeup_at: '2026-07-04T12:00:00Z',
        background_command: 'python sweep_a.py',
        expected_artifact: 'results/a.jsonl',
      }));
      writeFileSync(join(project.taskDir, 'subtask_wakeup-st2.json'), JSON.stringify({
        subtask_id: 2,
        wakeup_at: '2026-07-04T10:00:00Z',
        background_command: 'python sweep_b.py',
        expected_artifact: 'results/b.jsonl',
      }));

      fireEvent('event', { sessionId: 'sess-wake-a', event: { type: 'result' } });
      fireEvent('event', { sessionId: 'sess-wake-b', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // Both per-subtask files consumed — neither handler deleted the other's file early
      expect(existsSync(join(project.taskDir, 'subtask_wakeup-st1.json'))).toBe(false);
      expect(existsSync(join(project.taskDir, 'subtask_wakeup-st2.json'))).toBe(false);

      // Earliest wakeup wins regardless of handler completion order
      expect(pipeline.wakeupSubtaskId).toBe(2);
      expect(pipeline.wakeupUntil).toBe('2026-07-04T10:00:00Z');
      expect(pipeline.wakeupAttemptCount).toBe(2);

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });
});

describe('runImplement — wakeup subtask isolation (ADR 002)', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\\n';
      }
      return '';
    });
  });

  afterEach(() => { project.clean(); });
    vi.useRealTimers();

  it('only re-enters the wakeup subtask — deferred subtasks are excluded', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Install deps', description: 'Install dependencies', files: ['package.json'], acceptance_criteria: ['Deps installed'], completed: true },
        { id: 2, title: 'Run benchmark', description: 'Execute benchmark', files: ['src/bench.ts'], acceptance_criteria: ['Benchmark runs'] },
        { id: 3, title: 'Analyze results', description: 'Analyze benchmark data', files: ['src/analyze.ts'], acceptance_criteria: ['Analysis complete'] },
        { id: 4, title: 'Generate report', description: 'Generate final report', files: ['src/report.ts'], acceptance_criteria: ['Report generated'] },
        { id: 5, title: 'Clean up', description: 'Remove temp files', files: ['cleanup.sh'], acceptance_criteria: ['Temp files removed'] },
      ],
    }));

    mockCreateSession.mockResolvedValue('sess-wakeup-isolate');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
      wakeupSubtaskId: 3, wakeupCommand: 'python analyze.py', wakeupArtifact: 'results/analysis.json', wakeupAttemptCount: 1,
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      const prompt = mockSendMessage.mock.calls[0][1];
      expect(prompt).toContain('Subtask 3');
      expect(prompt).not.toContain('Subtask 1');

      fireEvent('event', { sessionId: 'sess-wakeup-isolate', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });
});

describe('runImplement — wakeup re-entry prompt (ADR 002)', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\\n';
      }
      return '';
    });
  });

  afterEach(() => { project.clean(); });
    vi.useRealTimers();

  it('injects WAKEUP RE-ENTRY header with background command and expected artifact', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{ id: 2, title: 'Run data sweep', description: 'Execute data analysis sweep', files: ['src/sweep.ts'], acceptance_criteria: ['Sweep completes'] }],
    }));

    mockCreateSession.mockResolvedValue('sess-wakeup-prompt');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
      wakeupSubtaskId: 2, wakeupCommand: 'python sweep.py --data large-dataset.csv', wakeupArtifact: 'output/sweep-results.json', wakeupAttemptCount: 1,
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      const prompt = mockSendMessage.mock.calls[0][1];
      expect(prompt).toContain('WAKEUP RE-ENTRY');
      expect(prompt).toContain('python sweep.py --data large-dataset.csv');
      expect(prompt).toContain('output/sweep-results.json');

      fireEvent('event', { sessionId: 'sess-wakeup-prompt', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  // Regression coverage for a real production failure: a subtask goes through
  // several legitimate wakeup cycles (pipeline.wakeupSubtaskId stays set
  // across all of them), then its FINAL re-entry session ends normally
  // without writing a fresh subtask_wakeup-st<id>.json — the job may have
  // silently died, or the coder assumed some other notification would
  // resume it. Before this fix, the deliverable-existence check was gated on
  // `pipeline.wakeupSubtaskId != null`, which was still true from the
  // EARLIER wakeup cycles even though THIS session detected no wakeup file
  // — so the check was skipped and the subtask was marked complete with its
  // required files_to_create never having been produced.
  it('still verifies files_to_create on a wakeup re-entry session that ends without scheduling a fresh wakeup', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 4,
        title: 'Run isolation sweep and commit evidence',
        description: 'Run the sweep and commit the evidence artifact',
        files: ['scripts/sweep.py'],
        acceptance_criteria: ['Evidence committed'],
        files_to_create: ['scripts/sweep_logs/evidence.log'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-wakeup-silent-drop');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    // Pipeline enters this session already mid-wakeup, as if resuming after
    // an earlier, legitimate wakeup cycle on the same subtask.
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
      wakeupSubtaskId: 4, wakeupCommand: 'python sweep.py', wakeupArtifact: 'scripts/sweep_logs/evidence.log', wakeupAttemptCount: 2,
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      // No fresh wakeup file written this session, and the expected
      // deliverable was never produced.
      expect(existsSync(join(project.root, 'scripts/sweep_logs/evidence.log'))).toBe(false);

      fireEvent('event', { sessionId: 'sess-wakeup-silent-drop', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // The deliverable check must still have run and caught the missing file.
      expect(pipeline.deliverableFailCounts).toBeDefined();
      expect(pipeline.deliverableFailCounts![4]).toBe(1);

      // Subtask must NOT be silently marked complete.
      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks[0].completed).toBeUndefined();

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Wakeup inside a multi-subtask parallel group (ADR 002 x parallel groups)
// ═══════════════════════════════════════════════════════════════════════
// Regression coverage for a real production failure: a group with 2
// subtasks where one schedules a wakeup (long-running sweep, no commits
// yet) and the other finishes normally. Before this fix, integrateGroup
// cherry-picked BOTH subtasks immediately — the wakeup subtask's branch had
// zero commits, so `git cherry-pick <empty range>` hard-failed with "empty
// commit set passed" and the whole task was marked failed.

describe('runImplement — wakeup inside a multi-subtask group defers only the pending subtask', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        // Subtask 2 actually finishes and commits — its cherry-pick range is
        // non-empty. (Subtask 1's range is never queried: it's excluded from
        // cherry-pick before tryCherryPickWithRecovery's empty-range check
        // even runs, because its wakeup is still pending.)
        if (args[0] === 'log' && typeof args[1] === 'string' && args[1].endsWith('-st2')) {
          return 'def2222 constraint fix\n';
        }
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull'
            || args[0] === 'rebase' || args[0] === 'cherry-pick') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'branch') return '';
        if (args[0] === 'worktree') return '';
        if (args[0] === 'status') return '';
      }
      return '';
    });

    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Run baseline sweep', description: 'Run pre-fix sweep and commit evidence', files: ['scripts/sweep.py'], acceptance_criteria: ['Sweep runs'], parallel_group: 1 },
        { id: 2, title: 'Implement fix', description: 'Implement the suppression constraint', files: ['src/fix.ts'], acceptance_criteria: ['Constraint added'], parallel_group: 1 },
      ],
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('cherry-picks and completes the finished sibling, leaves the wakeup subtask branch untouched, and pauses instead of failing', async () => {
    mockCreateSession
      .mockResolvedValueOnce('sess-group-st1')
      .mockResolvedValueOnce('sess-group-st2');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalledTimes(2); });

      // Subtask 1's sweep hasn't finished — it schedules a wakeup instead of
      // committing anything. Subtask 2 finishes normally.
      writeFileSync(join(project.taskDir, 'subtask_wakeup-st1.json'), JSON.stringify({
        subtask_id: 1,
        wakeup_at: '2026-07-04T12:00:00Z',
        background_command: 'python sweep.py',
        expected_artifact: 'results/sweep.jsonl',
        progress_log_path: 'sweep_progress.log',
      }));

      fireEvent('event', { sessionId: 'sess-group-st1', event: { type: 'result' } });
      fireEvent('event', { sessionId: 'sess-group-st2', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // Pipeline pauses for the wakeup — it must NOT fail.
      expect(pipeline.phase).not.toBe('failed');
      expect(pipeline.wakeupSubtaskId).toBe(1);
      expect(pipeline.wakeupUntil).toBe('2026-07-04T12:00:00Z');

      // Subtask 2 (finished) was cherry-picked; subtask 1 (still pending) was not.
      const cherryPickCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'git' && Array.isArray(call[1]) && call[1][0] === 'cherry-pick' && call[1][1] !== '--abort',
      );
      expect(cherryPickCalls.some((c: any[]) => (c[1][1] as string).endsWith('-st2'))).toBe(true);
      expect(cherryPickCalls.some((c: any[]) => (c[1][1] as string).endsWith('-st1'))).toBe(false);

      // Subtask 2's branch was force-deleted twice (once during initial
      // per-subtask worktree setup, once during post-cherry-pick cleanup);
      // subtask 1's branch was only ever touched by setup — cleanup skipped
      // it because its wakeup is still pending.
      const branchDeleteCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'git' && Array.isArray(call[1]) && call[1][0] === 'branch' && call[1][1] === '-D',
      );
      const st1Deletes = branchDeleteCalls.filter((c: any[]) => (c[1][2] as string).endsWith('-st1'));
      const st2Deletes = branchDeleteCalls.filter((c: any[]) => (c[1][2] as string).endsWith('-st2'));
      expect(st1Deletes.length).toBe(1);
      expect(st2Deletes.length).toBe(2);

      // Subtask 2 marked complete in plan.json; subtask 1 is not.
      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBeFalsy();

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('resumes the wakeup subtask in its preserved isolated worktree once the group has collapsed to just that subtask', async () => {
    // Simulate: subtask 2 already completed/integrated in a prior round;
    // subtask 1 is the sole remaining subtask, resuming after its wakeup fired.
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Run baseline sweep', description: 'Run pre-fix sweep and commit evidence', files: ['scripts/sweep.py'], acceptance_criteria: ['Sweep runs'], parallel_group: 1 },
        { id: 2, title: 'Implement fix', description: 'Implement the suppression constraint', files: ['src/fix.ts'], acceptance_criteria: ['Constraint added'], parallel_group: 1, completed: true },
      ],
    }));

    const worktreePath = join(project.root, 'worktrees', 'test-task');
    const stWorktreePath = worktreePath + '-st1';
    mkdirSync(stWorktreePath, { recursive: true });

    mockCreateSession.mockResolvedValueOnce('sess-resume-st1');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath,
      wakeupSubtaskId: 1, wakeupCommand: 'python sweep.py', wakeupArtifact: 'results/sweep.jsonl', wakeupAttemptCount: 1,
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockCreateSession).toHaveBeenCalled(); });

      // The resumed session must run in the preserved isolated worktree —
      // not fall back to the main pipeline worktree, where the sweep's
      // progress log and expected artifact don't exist.
      expect(mockCreateSession.mock.calls[0][0].cwd).toBe(stWorktreePath);

      fireEvent('event', { sessionId: 'sess-resume-st1', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Empty cherry-pick range — any non-completed subtask, not just wakeups
// ═══════════════════════════════════════════════════════════════════════
// Regression coverage for a second real production failure on the same
// ticket: after the wakeup fix above, a QA-rework pass hit the identical
// "empty commit set passed" crash for a completely different reason — a
// subtask that failed its deliverable-verification check (never wrote its
// declared files_to_create) made zero commits, same as a still-pending
// wakeup subtask, but wasn't excluded from cherry-pick because it isn't a
// wakeup. tryCherryPickWithRecovery now checks for an empty commit range
// before ever invoking `git cherry-pick`, so this is fixed at the git-
// operation layer rather than by enumerating every "didn't complete" reason.

describe('runImplement — deliverable-verification failure inside a multi-subtask group', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        // Simulate real git: CHERRY_PICK_HEAD doesn't exist when nothing is mid-cherry-pick.
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'CHERRY_PICK_HEAD') {
          throw new Error('fatal: needed a single revision');
        }
        // Subtask 2 made no commits — cherry-picking its (would-be) empty
        // range is exactly what crashed with "empty commit set passed" in
        // production. Subtask 1 has a real commit to integrate.
        if (args[0] === 'log' && typeof args[1] === 'string') {
          if (args[1].endsWith('-st2')) return '';
          if (args[1].endsWith('-st1')) return 'abc1111 evidence commit\n';
        }
        if (args[0] === 'cherry-pick' && args[1] !== '--abort' && typeof args[1] === 'string' && args[1].endsWith('-st2')) {
          throw new Error('error: empty commit set passed\nfatal: cherry-pick failed');
        }
        if (args[0] === 'cherry-pick' && args[1] === '--abort') {
          throw new Error('error: no cherry-pick or revert in progress\nfatal: cherry-pick failed');
        }
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull'
            || args[0] === 'rebase' || args[0] === 'cherry-pick') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'branch') return '';
        if (args[0] === 'worktree') return '';
        if (args[0] === 'status') return '';
      }
      return '';
    });

    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Run baseline sweep', description: 'Run pre-fix sweep and commit evidence', files: ['scripts/sweep.py'], acceptance_criteria: ['Sweep runs'], parallel_group: 1 },
        {
          id: 2, title: 'Implement fix', description: 'Implement the suppression constraint',
          files: ['src/fix.ts'], acceptance_criteria: ['Constraint added'], parallel_group: 1,
          files_to_create: ['scripts/sweep_logs/post-fix-abab-fix.log'],
        },
      ],
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('skips the empty cherry-pick instead of crashing the whole group', async () => {
    mockCreateSession
      .mockResolvedValueOnce('sess-deliv-st1')
      .mockResolvedValueOnce('sess-deliv-st2');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalledTimes(2); });

      // Neither subtask writes the declared deliverable file (nothing on
      // disk creates it in this mocked environment) — subtask 2's session
      // just ends without having produced it.
      fireEvent('event', { sessionId: 'sess-deliv-st1', event: { type: 'result' } });
      fireEvent('event', { sessionId: 'sess-deliv-st2', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // Must not crash the task — this is the exact bug being fixed.
      expect(pipeline.phase).not.toBe('failed');

      // Subtask 1 (real commit) was actually cherry-picked; subtask 2's
      // empty range was skipped before ever calling `git cherry-pick`.
      const cherryPickCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'git' && Array.isArray(call[1]) && call[1][0] === 'cherry-pick' && call[1][1] !== '--abort',
      );
      expect(cherryPickCalls.some((c: any[]) => (c[1][1] as string).endsWith('-st1'))).toBe(true);
      expect(cherryPickCalls.some((c: any[]) => (c[1][1] as string).endsWith('-st2'))).toBe(false);

      // Subtask 1 completed; subtask 2 failed deliverable verification and stayed incomplete.
      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBeFalsy();
      expect(pipeline.deliverableFailCounts?.[2]).toBe(1);

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });
});

describe('runImplement — wakeup circuit breaker (ADR 002)', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\\n';
      }
      return '';
    });
  });

  afterEach(() => { project.clean(); });
    vi.useRealTimers();

  it('increments wakeupAttemptCount on each wakeup cycle', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{ id: 1, title: 'Long running task', description: 'Execute long process', files: ['src/long.ts'], acceptance_criteria: ['Process completes'] }],
    }));

    mockCreateSession.mockResolvedValue('sess-wakeup-increment');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, { phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'), wakeupAttemptCount: 0 });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      writeFileSync(join(project.taskDir, 'subtask_wakeup.json'), JSON.stringify({
        subtask_id: 1, wakeup_at: '2026-07-04T12:00:00Z', background_command: 'npm run benchmark', expected_artifact: 'results/bench.json',
      }));

      fireEvent('event', { sessionId: 'sess-wakeup-increment', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      expect(pipeline.wakeupAttemptCount).toBe(1);

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('fails task when wakeupAttemptCount reaches 3 (circuit breaker)', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{ id: 1, title: 'Run benchmark', description: 'Execute benchmark', files: ['src/bench.ts'], acceptance_criteria: ['Benchmark completes'] }],
    }));

    mockCreateSession.mockResolvedValue('sess-wakeup-cap');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    // Start at attempt 2 — writing a wakeup file pushes it to 3, tripping the circuit breaker
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
      wakeupSubtaskId: 1, wakeupAttemptCount: 2, wakeupArtifact: 'results/bench.json', wakeupCommand: 'npm run benchmark',
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      // Engineer writes a 3rd wakeup file — pushes counter 2→3
      // wakeupDetected=true prevents wakeup completion, so post-groups circuit breaker fires
      writeFileSync(join(project.taskDir, 'subtask_wakeup.json'), JSON.stringify({
        subtask_id: 1, wakeup_at: '2026-07-05T00:00:00Z',
        background_command: 'npm run benchmark', expected_artifact: 'results/bench.json',
      }));

      fireEvent('event', { sessionId: 'sess-wakeup-cap', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      // Circuit breaker fires in post-groups: wakeupAttemptCount>=3 → failed
      expect(pipeline.phase).toBe('failed');

      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(report.overall).toBe('FAIL');
      expect(report.criteria[0].name).toBe('Wakeup attempt limit exceeded');
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('clears wakeup state and bounces back after successful wakeup completion', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{ id: 3, title: 'Generate artifact', description: 'Create the artifact file', files: ['src/gen.ts'], acceptance_criteria: ['Artifact created'] }],
    }));

    mockCreateSession.mockResolvedValue('sess-wakeup-success');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
      wakeupSubtaskId: 3, wakeupUntil: '2026-07-04T12:00:00Z', wakeupCommand: 'python generate.py', wakeupArtifact: 'output/artifact.json', wakeupAttemptCount: 2,
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      expect(mockSendMessage.mock.calls[0][1]).toContain('WAKEUP RE-ENTRY');

      fireEvent('event', { sessionId: 'sess-wakeup-success', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // Wakeup state should be cleared
      expect(pipeline.wakeupUntil).toBeUndefined();
      expect(pipeline.wakeupSubtaskId).toBeUndefined();
      expect(pipeline.wakeupCommand).toBeUndefined();
      expect(pipeline.wakeupArtifact).toBeUndefined();
      expect(pipeline.wakeupAttemptCount).toBe(0);

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });
});

describe('runImplement — wakeup state persistence (ADR 002)', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => { project.clean(); });
    vi.useRealTimers();

  it('wakeup fields are persisted in pipeline_state.json', () => {
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      wakeupSubtaskId: 2, wakeupUntil: '2026-07-04T15:00:00Z', wakeupCommand: 'npm run sweep', wakeupArtifact: 'data/output.jsonl', wakeupAttemptCount: 2,
    });

    (orch as AnyOrch)._ctx.savePipelineState(pipeline);

    const statePath = join(project.taskDir, '.pipeline_state.json');
    expect(existsSync(statePath)).toBe(true);
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    expect(state.wakeupSubtaskId).toBe(2);
    expect(state.wakeupUntil).toBe('2026-07-04T15:00:00Z');
    expect(state.wakeupCommand).toBe('npm run sweep');
    expect(state.wakeupArtifact).toBe('data/output.jsonl');
    expect(state.wakeupAttemptCount).toBe(2);
  });

  it('wakeup fields survive crash recovery', () => {
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      wakeupSubtaskId: 5, wakeupUntil: '2026-07-04T18:00:00Z', wakeupCommand: 'python long-script.py', wakeupArtifact: 'reports/final.md', wakeupAttemptCount: 1,
    });

    (orch as AnyOrch)._ctx.savePipelineState(pipeline);
    (orch as AnyOrch).pipelines.delete(project.taskId);

    const restored = (orch as AnyOrch)._restorePipelineState(project.taskId, project.taskDir);
    expect(restored.wakeupSubtaskId).toBe(5);
    expect(restored.wakeupUntil).toBe('2026-07-04T18:00:00Z');
    expect(restored.wakeupCommand).toBe('python long-script.py');
    expect(restored.wakeupArtifact).toBe('reports/final.md');
    expect(restored.wakeupAttemptCount).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Defect 3 — isInfraError: detect Docker/infra errors vs git errors
// ═══════════════════════════════════════════════════════════════════════

describe('Defect 3 — isInfraError (infra vs git error detection)', () => {
  it('detects "not a git repository" as infra error', () => {
    expect(isInfraError('fatal: not a git repository: (null)')).toBe(true);
  });

  it('detects "No such container" as infra error', () => {
    expect(isInfraError('docker: Error response from daemon: No such container: abc123')).toBe(true);
  });

  it('detects "Cannot connect to the Docker daemon" as infra error', () => {
    expect(isInfraError('Cannot connect to the Docker daemon at unix:///var/run/docker.sock')).toBe(true);
  });

  it('detects "spawn docker ENOENT" as infra error', () => {
    expect(isInfraError('spawn docker ENOENT')).toBe(true);
  });

  it('does NOT flag non-docker ENOENT as infra error', () => {
    // spawn git ENOENT is a host tool issue, not a container-infra problem
    expect(isInfraError('Error: spawn git ENOENT')).toBe(false);
    // file-not-found errors are genuine git problems, not infra
    expect(isInfraError("ENOENT: no such file or directory, open 'src/foo.ts'")).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isInfraError('FATAL: NOT A GIT REPOSITORY')).toBe(true);
    expect(isInfraError('Cannot Connect To The Docker Daemon')).toBe(true);
    expect(isInfraError('No Such Container: deadbeef')).toBe(true);
  });

  it('does NOT flag genuine git errors', () => {
    expect(isInfraError('error: could not apply abc123... some commit')).toBe(false);
    expect(isInfraError('CONFLICT (content): Merge conflict in src/file.ts')).toBe(false);
    expect(isInfraError('fatal: refusing to merge unrelated histories')).toBe(false);
    expect(isInfraError('error: Your local changes would be overwritten')).toBe(false);
    expect(isInfraError('')).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  clearWorktreeDirectoryOrThrow — retry a locked worktree dir, then throw
// ═══════════════════════════════════════════════════════════════════════
//
// git worktree remove --force can deregister a worktree from git's own
// bookkeeping while the directory itself survives on disk — a file
// locked open by an orphaned process (a background server/sweep from an
// earlier, incompletely-torn-down run) blocks deletion on Windows even
// with force:true. Left unhandled, the next `worktree add` at the same
// path crashes on "already exists" with no indication why. This retries
// a few times (a lock can clear on its own shortly after the owning
// process finishes) before throwing a clear, actionable WorktreeError.

describe('clearWorktreeDirectoryOrThrow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves without retrying when the directory clears on the first attempt', async () => {
    let exists = true;
    const rm = vi.fn(() => { exists = false; });
    const pruneWorktrees = vi.fn();

    await clearWorktreeDirectoryOrThrow('/test/wt', { exists: () => exists, rm, pruneWorktrees });

    expect(rm).toHaveBeenCalledTimes(1);
    expect(pruneWorktrees).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the directory does not exist to begin with', async () => {
    const rm = vi.fn();
    const pruneWorktrees = vi.fn();

    await clearWorktreeDirectoryOrThrow('/test/wt', { exists: () => false, rm, pruneWorktrees });

    expect(rm).not.toHaveBeenCalled();
    expect(pruneWorktrees).not.toHaveBeenCalled();
  });

  it('retries after a delay and succeeds once the lock clears on a later attempt', async () => {
    let rmCalls = 0;
    const rm = vi.fn(() => { rmCalls++; });
    const pruneWorktrees = vi.fn();
    // Still exists after the first two rm attempts (locked); the third clears it.
    const exists = vi.fn(() => rmCalls < 3);

    const promise = clearWorktreeDirectoryOrThrow('/test/wt', { exists, rm, pruneWorktrees });

    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(rm).toHaveBeenCalledTimes(3);
    expect(pruneWorktrees).toHaveBeenCalledTimes(3);
  });

  it('throws a WorktreeError with an actionable message when the directory never clears', async () => {
    const rm = vi.fn();
    const pruneWorktrees = vi.fn();

    const promise = clearWorktreeDirectoryOrThrow('/test/wt', { exists: () => true, rm, pruneWorktrees });
    const assertion = expect(promise).rejects.toMatchObject({
      name: 'WorktreeError',
      code: 'WORKTREE_LOCKED',
      message: expect.stringContaining('/test/wt'),
    });

    // Exhaust every retry (WORKTREE_CLEANUP_MAX_ATTEMPTS = 3, 1s apart — 2 delays).
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);

    await assertion;
    // 3 attempts total, no delay after the last one.
    expect(rm).toHaveBeenCalledTimes(3);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Worktree relocation — resolveWorktreeDirName, preserveUncommittedWork,
//  relocateStuckWorktree, sweepAbandonedWorktreeRelocations
// ═══════════════════════════════════════════════════════════════════════
//
// When a worktree directory survives every removal attempt
// (clearWorktreeDirectoryOrThrow exhausts its retries — verified in
// production to be a Windows-side file lock from an IDE indexer or
// antivirus scanner, not anything a container process can cause), the
// pipeline relocates to a suffixed directory instead of failing the task
// outright. These tests cover: the path resolver every worktree-path
// computation must go through, the safety step that preserves in-flight
// uncommitted work before the old directory is abandoned, the relocation
// logic itself, and the opportunistic sweeper that reclaims abandoned
// relocations on a later run.

function minimalImplPipeline(overrides: Partial<ImplementPipeline> = {}): ImplementPipeline {
  return {
    taskId: 'task-1',
    description: 'test task',
    phase: 'implement',
    specPath: '/test/spec',
    worktreePath: '/test/wt',
    branch: 'feat/test-task',
    qaAttempt: 0,
    maxQaAttempts: 3,
    specRevision: 0,
    ...overrides,
  };
}

describe('resolveWorktreeDirName', () => {
  it('prefers worktreeDirName when set, even if slug is also present', () => {
    expect(resolveWorktreeDirName({ slug: 'my-slug', description: 'desc', worktreeDirName: 'my-slug-r2' })).toBe('my-slug-r2');
  });

  it('falls back to slug when worktreeDirName is unset', () => {
    expect(resolveWorktreeDirName({ slug: 'my-slug', description: 'desc' })).toBe('my-slug');
  });

  it('falls back to slugify(description) when neither slug nor worktreeDirName is set', () => {
    expect(resolveWorktreeDirName({ description: 'My Cool Task' })).toBe('my-cool-task');
  });
});

describe('preserveUncommittedWork', () => {
  it('does nothing when the worktree is already clean', () => {
    const execGit = vi.fn();
    const deps = { execGitCapture: vi.fn(() => ''), execGit } as unknown as ImplementDeps;

    preserveUncommittedWork(minimalImplPipeline(), deps);

    expect(execGit).not.toHaveBeenCalled();
  });

  it('commits uncommitted and untracked changes when the worktree is dirty', () => {
    const execGit = vi.fn();
    const deps = { execGitCapture: vi.fn(() => ' M tracked.txt\n?? new.txt\n'), execGit } as unknown as ImplementDeps;
    const pipeline = minimalImplPipeline({ worktreePath: '/test/wt' });

    preserveUncommittedWork(pipeline, deps);

    expect(execGit).toHaveBeenNthCalledWith(1, ['add', '-A'], '/test/wt');
    expect(execGit).toHaveBeenNthCalledWith(2, ['commit', '-m', expect.stringContaining('WIP')], '/test/wt');
  });

  it('is best-effort — swallows errors instead of throwing', () => {
    const execGit = vi.fn();
    const deps = {
      execGitCapture: vi.fn(() => { throw new Error('git not available'); }),
      execGit,
    } as unknown as ImplementDeps;

    expect(() => preserveUncommittedWork(minimalImplPipeline(), deps)).not.toThrow();
    expect(execGit).not.toHaveBeenCalled();
  });
});

describe('relocateStuckWorktree', () => {
  let project: ReturnType<typeof setupProject>;
  let worktreeBase: string;

  beforeEach(() => {
    project = setupProject();
    worktreeBase = join(project.root, 'worktrees');
    mkdirSync(worktreeBase, { recursive: true });
  });

  afterEach(() => {
    project.clean();
  });

  it('relocates to the first available -rN suffix and persists it on the task', () => {
    const stuckPath = join(worktreeBase, 'my-task');
    const update = vi.fn();
    const deps = { taskStore: { update } } as unknown as ImplementDeps;
    const pipeline = minimalImplPipeline({ taskId: 'task-1', specPath: project.taskDir, worktreePath: stuckPath });

    relocateStuckWorktree(pipeline, deps);

    expect(pipeline.worktreePath).toBe(join(worktreeBase, 'my-task-r2'));
    expect(update).toHaveBeenCalledWith('task-1', { worktreeDirName: 'my-task-r2' });
  });

  it('skips occupied slots and picks the first free one', () => {
    mkdirSync(join(worktreeBase, 'my-task-r2'));
    const stuckPath = join(worktreeBase, 'my-task');
    const deps = { taskStore: { update: vi.fn() } } as unknown as ImplementDeps;
    const pipeline = minimalImplPipeline({ specPath: project.taskDir, worktreePath: stuckPath });

    relocateStuckWorktree(pipeline, deps);

    expect(pipeline.worktreePath).toBe(join(worktreeBase, 'my-task-r3'));
  });

  it('throws WorktreeError when every relocation slot is occupied', () => {
    for (let n = 2; n <= 5; n++) mkdirSync(join(worktreeBase, `my-task-r${n}`));
    const stuckPath = join(worktreeBase, 'my-task');
    const deps = { taskStore: { update: vi.fn() } } as unknown as ImplementDeps;
    const pipeline = minimalImplPipeline({ specPath: project.taskDir, worktreePath: stuckPath });

    expect(() => relocateStuckWorktree(pipeline, deps)).toThrow(/every relocation.*slot.*occupied/i);
  });

  it('does not stack suffixes when relocating an already-relocated worktree', () => {
    const stuckPath = join(worktreeBase, 'my-task-r2'); // already relocated once on a prior run
    mkdirSync(stuckPath); // stuck path is, by definition, still occupied on disk
    const update = vi.fn();
    const deps = { taskStore: { update } } as unknown as ImplementDeps;
    const pipeline = minimalImplPipeline({ specPath: project.taskDir, worktreePath: stuckPath });

    relocateStuckWorktree(pipeline, deps);

    // Computed from the base name ("my-task"), not "my-task-r2-r2"
    expect(pipeline.worktreePath).toBe(join(worktreeBase, 'my-task-r3'));
  });
});

describe('sweepAbandonedWorktreeRelocations', () => {
  let project: ReturnType<typeof setupProject>;
  let worktreeBase: string;

  beforeEach(() => {
    vi.clearAllMocks();
    project = setupProject();
    worktreeBase = join(project.root, 'worktrees');
    mkdirSync(worktreeBase, { recursive: true });
  });

  afterEach(() => {
    project.clean();
  });

  it('deletes an abandoned relocation directory that is not registered as a live worktree', () => {
    const activePath = join(worktreeBase, 'my-task');
    const abandonedPath = join(worktreeBase, 'my-task-r2');
    mkdirSync(abandonedPath);
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'worktree' && args[1] === 'list') return `worktree ${activePath}\nbranch refs/heads/feat/my-task\n\n`;
      return '';
    });
    const pipeline = minimalImplPipeline({ worktreePath: activePath });
    const deps = { projectRoot: project.root } as unknown as ImplementDeps;

    sweepAbandonedWorktreeRelocations(pipeline, deps);

    expect(existsSync(abandonedPath)).toBe(false);
  });

  it('never deletes the currently active worktreePath, even if it is itself a relocated path', () => {
    const activePath = join(worktreeBase, 'my-task-r2');
    mkdirSync(activePath);
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'worktree' && args[1] === 'list') return `worktree ${activePath}\n\n`;
      return '';
    });
    const pipeline = minimalImplPipeline({ worktreePath: activePath });
    const deps = { projectRoot: project.root } as unknown as ImplementDeps;

    sweepAbandonedWorktreeRelocations(pipeline, deps);

    expect(existsSync(activePath)).toBe(true);
  });

  it('does not delete a relocation directory that is still registered as a live git worktree', () => {
    const activePath = join(worktreeBase, 'my-task');
    const liveOtherPath = join(worktreeBase, 'my-task-r2'); // e.g. a concurrently-running pipeline
    mkdirSync(liveOtherPath);
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'worktree' && args[1] === 'list') return `worktree ${activePath}\n\nworktree ${liveOtherPath}\n\n`;
      return '';
    });
    const pipeline = minimalImplPipeline({ worktreePath: activePath });
    const deps = { projectRoot: project.root } as unknown as ImplementDeps;

    sweepAbandonedWorktreeRelocations(pipeline, deps);

    expect(existsSync(liveOtherPath)).toBe(true);
  });

  it('ignores directories that do not match the -rN relocation naming pattern', () => {
    const activePath = join(worktreeBase, 'my-task');
    const unrelatedPath = join(worktreeBase, 'my-task-staging');
    mkdirSync(unrelatedPath);
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'worktree' && args[1] === 'list') return `worktree ${activePath}\n\n`;
      return '';
    });
    const pipeline = minimalImplPipeline({ worktreePath: activePath });
    const deps = { projectRoot: project.root } as unknown as ImplementDeps;

    sweepAbandonedWorktreeRelocations(pipeline, deps);

    expect(existsSync(unrelatedPath)).toBe(true);
  });

  it('is a no-op when git worktree list fails — never risks deleting something possibly in use', () => {
    const activePath = join(worktreeBase, 'my-task');
    const abandonedPath = join(worktreeBase, 'my-task-r2');
    mkdirSync(abandonedPath);
    mockExecFileSync.mockImplementation(() => { throw new Error('git not available'); });
    const pipeline = minimalImplPipeline({ worktreePath: activePath });
    const deps = { projectRoot: project.root } as unknown as ImplementDeps;

    expect(() => sweepAbandonedWorktreeRelocations(pipeline, deps)).not.toThrow();
    expect(existsSync(abandonedPath)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Defect 3 — tryCherryPickWithRecovery: infra-vs-conflict routing
// ═══════════════════════════════════════════════════════════════════════
// Note: The full infra retry loop (ensureContainer + setTimeout backoff)
// is tested indirectly via integration tests. These unit tests verify the
// core routing decisions (infra vs conflict) without exercising the async
// retry loop which requires careful mock orchestration.

describe('Defect 3 — tryCherryPickWithRecovery (error routing)', () => {
  let project: ReturnType<typeof setupProject>;

  beforeEach(() => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
  });

  afterEach(() => {
    project.clean();
  });

  function makeDeps(overrides: Partial<ImplementDeps> = {}): ImplementDeps {
    return {
      projectRoot: project.root,
      taskStore: { update: vi.fn() } as any,
      execGit: vi.fn(),
      execGitCapture: vi.fn(() => ''),
      gitPush: vi.fn(),
      persistAndEmitPhase: vi.fn(),
      advancePhase: vi.fn(),
      savePipelineState: vi.fn(),
      executePhase: vi.fn(),
      sessionOpts: vi.fn() as any,
      waitForCompletion: vi.fn(),
      patchWorktreeGitFile: vi.fn(),
      isWorktreeHealthy: vi.fn(() => true),
      cleanStaleSubtaskWorktrees: vi.fn(),
      restoreQaReportFromSnapshot: vi.fn(),
      restoreHumanFeedbackFromSnapshot: vi.fn(),
      writeQaFeedback: vi.fn(),
      getPipelineConfig: vi.fn(() => ({ maxQaAttempts: 3, parallelSubtasks: true, maxDeliverableFails: 3, maxWakeupAttempts: 10, maxStallRecoveries: 3 })),
      phaseHeader: vi.fn(),
      planWriteLock: { current: Promise.resolve() },
      scheduleWakeup: vi.fn(),
      ...overrides,
    };
  }

  function makeImplPipeline(overrides: Record<string, any> = {}): ImplementPipeline {
    return {
      taskId: project.taskId,
      description: 'infra test',
      phase: 'implement',
      specPath: project.taskDir,
      worktreePath: join(project.root, 'worktrees', 'infra-test'),
      branch: 'feat/infra-test',
      qaAttempt: 0,
      maxQaAttempts: 3,
      specRevision: 0,
      ...overrides,
    };
  }

  it('falls through to hard-fail when infra error detected but not in container mode', async () => {
    const deps = makeDeps();
    deps.execGit = vi.fn()
      .mockImplementationOnce(() => { throw new Error('fatal: not a git repository: (null)'); });

    // checkCherryPickInProgress → not in progress (no CHERRY_PICK_HEAD)
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });

    // readContainerConfig returns enabled: false (default mock) — not in container mode
    const { readContainerConfig } = await import('../../src/lib/container-manager');
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });

    const pipeline = makeImplPipeline();
    const result = await tryCherryPickWithRecovery(pipeline, deps, join(project.root, 'output.log'), 'feat/infra-test-st1', 1);

    // Not in container mode → infra retry path skipped → hard fail
    expect(result).toBe(false);
  });

  it('does NOT enter infra retry path for genuine git merge conflicts', async () => {
    const deps = makeDeps();
    deps.execGit = vi.fn()
      .mockImplementationOnce(() => { throw new Error('CONFLICT (content): Merge conflict in file.ts'); });

    // CHERRY_PICK_HEAD exists → infra path guard "!checkCherryPickInProgress" is false
    mockExecFileSync.mockReturnValue('abc123\n');

    const { readContainerConfig, containerManager } = await import('../../src/lib/container-manager');
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });

    // The merger agent path will spawn a session and call waitForCompletion.
    // Mock waitForCompletion to hang (it'll be cleaned up by afterEach).
    // The key assertion: ensureContainer was NOT called (no infra retry).
    let resolveCompletion: () => void;
    deps.waitForCompletion = vi.fn(() => new Promise<void>(r => { resolveCompletion = r; }));
    mockCreateSession.mockResolvedValue('sess-merger-conflict');

    const pipeline = makeImplPipeline();
    const resultPromise = tryCherryPickWithRecovery(pipeline, deps, join(project.root, 'output.log'), 'feat/infra-test-st1', 1);

    // Wait for the merger agent to be spawned
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    // Infra retry path was NOT entered (CHERRY_PICK_HEAD existed, so the
    // guard "!checkCherryPickInProgress && isInfraError" was false)
    expect(containerManager.ensureContainer).not.toHaveBeenCalled();

    // Now simulate merger resolving the conflict
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    resolveCompletion!();
    const result = await resultPromise;
    expect(result).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Defect 4 — _recoverSubtaskBranchBeforeDelete: auto-recover commits
// ═══════════════════════════════════════════════════════════════════════

describe('Defect 4 — _recoverSubtaskBranchBeforeDelete (plain git)', () => {
  let project: ReturnType<typeof setupProject>;

  beforeEach(() => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
  });

  afterEach(() => {
    project.clean();
  });

  function makeDeps(overrides: Partial<ImplementDeps> = {}): ImplementDeps {
    return {
      projectRoot: project.root,
      taskStore: { update: vi.fn() } as any,
      execGit: vi.fn(),
      execGitCapture: vi.fn(() => ''),
      gitPush: vi.fn(),
      persistAndEmitPhase: vi.fn(),
      advancePhase: vi.fn(),
      savePipelineState: vi.fn(),
      executePhase: vi.fn(),
      sessionOpts: vi.fn() as any,
      waitForCompletion: vi.fn(),
      patchWorktreeGitFile: vi.fn(),
      isWorktreeHealthy: vi.fn(() => true),
      cleanStaleSubtaskWorktrees: vi.fn(),
      restoreQaReportFromSnapshot: vi.fn(),
      restoreHumanFeedbackFromSnapshot: vi.fn(),
      writeQaFeedback: vi.fn(),
      getPipelineConfig: vi.fn(() => ({ maxQaAttempts: 3, parallelSubtasks: true, maxDeliverableFails: 3, maxWakeupAttempts: 10, maxStallRecoveries: 3 })),
      phaseHeader: vi.fn(),
      planWriteLock: { current: Promise.resolve() },
      scheduleWakeup: vi.fn(),
      ...overrides,
    };
  }

  function makeImplPipeline(overrides: Record<string, any> = {}): ImplementPipeline {
    return {
      taskId: project.taskId,
      description: 'recover test',
      phase: 'implement',
      specPath: project.taskDir,
      worktreePath: join(project.root, 'worktrees', 'recover-test'),
      branch: 'feat/recover-test',
      qaAttempt: 0,
      maxQaAttempts: 3,
      specRevision: 0,
      ...overrides,
    };
  }

  it('returns true when subtask is already completed (skip)', async () => {
    const deps = makeDeps();
    const pipeline = makeImplPipeline();
    const subtask = { id: 1, title: 'S1', description: '', files: [], acceptance_criteria: [], completed: true };

    const result = await _recoverSubtaskBranchBeforeDelete(pipeline, deps, '/tmp/log', 'feat/recover-test-st1', subtask);

    expect(result).toBe(true); // safe to delete — subtask was already integrated
    expect(mockExecFileSync).not.toHaveBeenCalled(); // no git calls needed
  });

  it('returns true when st-branch does not exist', async () => {
    const deps = makeDeps();
    const pipeline = makeImplPipeline();
    const subtask = { id: 1, title: 'S1', description: '', files: [], acceptance_criteria: [], completed: false };

    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });

    const result = await _recoverSubtaskBranchBeforeDelete(pipeline, deps, '/tmp/log', 'feat/recover-test-st1', subtask);

    expect(result).toBe(true); // safe — nothing to recover
  });

  it('returns true when st-branch exists but has no unintegrated commits (already on pipeline.branch)', async () => {
    const deps = makeDeps();
    const pipeline = makeImplPipeline();
    const subtask = { id: 1, title: 'S1', description: '', files: [], acceptance_criteria: [], completed: false };

    // rev-parse succeeds (branch exists), log returns empty (no unintegrated commits)
    mockExecFileSync
      .mockReturnValueOnce('abc123\n') // rev-parse
      .mockReturnValueOnce(''); // log — empty

    const result = await _recoverSubtaskBranchBeforeDelete(pipeline, deps, '/tmp/log', 'feat/recover-test-st1', subtask);

    expect(result).toBe(true); // already integrated, safe
  });

  it('attempts cherry-pick and returns true on success', async () => {
    const deps = makeDeps();
    const pipeline = makeImplPipeline();
    const subtask = { id: 1, title: 'S1', description: '', files: [], acceptance_criteria: [], completed: false };

    // rev-parse succeeds, log returns commits
    mockExecFileSync
      .mockReturnValueOnce('abc123\n') // rev-parse
      .mockReturnValueOnce('abc123 unintegrated commit\n'); // log

    deps.execGit = vi.fn(); // succeeds (doesn't throw)

    const result = await _recoverSubtaskBranchBeforeDelete(pipeline, deps, '/tmp/log', 'feat/recover-test-st1', subtask);

    expect(result).toBe(true);
    expect(deps.execGit).toHaveBeenCalledWith(
      ['cherry-pick', 'feat/recover-test..feat/recover-test-st1'],
      pipeline.worktreePath,
    );
  });

  it('returns false when cherry-pick conflicts, preserving branch for merger', async () => {
    const deps = makeDeps();
    const pipeline = makeImplPipeline();
    const subtask = { id: 1, title: 'S1', description: '', files: [], acceptance_criteria: [], completed: false };

    // rev-parse succeeds, log returns commits
    mockExecFileSync
      .mockReturnValueOnce('abc123\n')
      .mockReturnValueOnce('abc123 unintegrated commit\n');

    deps.execGit = vi.fn()
      .mockImplementationOnce(() => { throw new Error('CONFLICT'); }); // cherry-pick fails

    const result = await _recoverSubtaskBranchBeforeDelete(pipeline, deps, '/tmp/log', 'feat/recover-test-st1', subtask);

    expect(result).toBe(false); // preservation
    // Should have called cherry-pick --abort
    expect(deps.execGit).toHaveBeenCalledWith(['cherry-pick', '--abort'], pipeline.worktreePath);
  });

  it('returns false when git log comparison fails (err on side of preservation)', async () => {
    const deps = makeDeps();
    const pipeline = makeImplPipeline();
    const subtask = { id: 1, title: 'S1', description: '', files: [], acceptance_criteria: [], completed: false };

    // rev-parse succeeds, log throws (e.g., pipeline.branch doesn't exist as a ref)
    mockExecFileSync
      .mockReturnValueOnce('abc123\n') // rev-parse
      .mockImplementationOnce(() => { throw new Error('bad revision'); }); // log fails

    const result = await _recoverSubtaskBranchBeforeDelete(pipeline, deps, '/tmp/log', 'feat/recover-test-st1', subtask);

    // Err on side of preservation — don't delete branch if we can't verify
    expect(result).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  _recoverStBranchCommits — direct tests
// ═══════════════════════════════════════════════════════════════════════

describe('_recoverStBranchCommits (shared helper)', () => {
  let project: ReturnType<typeof setupProject>;

  beforeEach(() => {
    vi.clearAllMocks();
    project = setupProject();
  });

  afterEach(() => {
    project.clean();
  });

  it('returns recovered:true with empty commits when st-branch does not exist', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });

    const execGitFn = vi.fn();
    const result = await _recoverStBranchCommits(
      project.root, execGitFn, '/tmp/log',
      'feat/main', 'feat/main-st1', '/tmp/worktree', 1,
    );

    expect(result).toEqual({ recovered: true, commits: [] });
    expect(execGitFn).not.toHaveBeenCalled();
    // Should have called git rev-parse only
    expect(mockExecFileSync).toHaveBeenCalledWith('git', ['rev-parse', '--verify', 'feat/main-st1'], expect.anything());
  });

  it('returns recovered:true with empty commits when branch exists but no unintegrated commits', async () => {
    mockExecFileSync
      .mockReturnValueOnce('abc123\n')  // rev-parse
      .mockReturnValueOnce('');          // log — empty = no unintegrated commits

    const execGitFn = vi.fn();
    const result = await _recoverStBranchCommits(
      project.root, execGitFn, '/tmp/log',
      'feat/main', 'feat/main-st1', '/tmp/worktree', 1,
    );

    expect(result).toEqual({ recovered: true, commits: [] });
    expect(execGitFn).not.toHaveBeenCalled();
  });

  it('returns recovered:false with empty commits when git log throws', async () => {
    mockExecFileSync
      .mockReturnValueOnce('abc123\n')                    // rev-parse
      .mockImplementationOnce(() => { throw new Error('bad revision'); }); // log fails

    const execGitFn = vi.fn();
    const result = await _recoverStBranchCommits(
      project.root, execGitFn, '/tmp/log',
      'feat/main', 'feat/main-st1', '/tmp/worktree', 1,
    );

    expect(result).toEqual({ recovered: false, commits: [] });
    expect(execGitFn).not.toHaveBeenCalled(); // cherry-pick not attempted
  });

  it('cherry-picks successfully and returns commits', async () => {
    mockExecFileSync
      .mockReturnValueOnce('abc123\n')                         // rev-parse
      .mockReturnValueOnce('abc123 fix bug\ndef456 add test\n'); // log

    const execGitFn = vi.fn(); // doesn't throw = cherry-pick success
    const result = await _recoverStBranchCommits(
      project.root, execGitFn, '/tmp/log',
      'feat/main', 'feat/main-st1', '/tmp/worktree', 1,
    );

    expect(result.recovered).toBe(true);
    expect(result.commits).toEqual(['abc123 fix bug', 'def456 add test']);
    expect(execGitFn).toHaveBeenCalledWith(
      ['cherry-pick', 'feat/main..feat/main-st1'],
      '/tmp/worktree',
    );
  });

  it('aborts and returns recovered:false with commits on cherry-pick conflict', async () => {
    mockExecFileSync
      .mockReturnValueOnce('abc123\n')                         // rev-parse
      .mockReturnValueOnce('abc123 fix bug\n');                 // log

    const execGitFn = vi.fn()
      .mockImplementationOnce(() => { throw new Error('CONFLICT'); }); // cherry-pick fails

    const result = await _recoverStBranchCommits(
      project.root, execGitFn, '/tmp/log',
      'feat/main', 'feat/main-st1', '/tmp/worktree', 1,
    );

    expect(result.recovered).toBe(false);
    expect(result.commits).toEqual(['abc123 fix bug']); // commits still returned for logging
    // Should have aborted the cherry-pick
    expect(execGitFn).toHaveBeenCalledWith(['cherry-pick', '--abort'], '/tmp/worktree');
  });

  it('passes correct git args to execFileSync (rev-parse in projectRoot, log with range)', async () => {
    mockExecFileSync
      .mockReturnValueOnce('abc\n')
      .mockReturnValueOnce('');

    const execGitFn = vi.fn();
    await _recoverStBranchCommits(
      project.root, execGitFn, '/tmp/log',
      'feat/main', 'feat/main-st1', '/tmp/worktree', 42,
    );

    // Verify rev-parse was called with correct args
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['rev-parse', '--verify', 'feat/main-st1'],
      expect.objectContaining({ cwd: project.root }),
    );
    // Verify log was called with the correct range
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git', ['log', 'feat/main..feat/main-st1', '--oneline'],
      expect.objectContaining({ cwd: project.root }),
    );
  });

  // ── Infra-retry path (Defect 3 parity — gap found in code review) ──────
  // _recoverStBranchCommits shares the "dead container is retryable, not a
  // genuine conflict" logic added for Defect 3's tryCherryPickWithRecovery,
  // but had its own separate cherry-pick call site that didn't originally
  // apply it. These tests exercise that retry loop directly (with fake
  // timers to skip the real backoff delay), rather than punting on it like
  // the equivalent Defect 3 tests do.

  it('recovers after reprovisioning the container on an infra-class cherry-pick failure', async () => {
    vi.useFakeTimers();
    try {
      mockExecFileSync
        .mockReturnValueOnce('abc123\n') // rev-parse
        .mockReturnValueOnce('abc123 unintegrated commit\n'); // log

      const { readContainerConfig, containerManager } = await import('../../src/lib/container-manager');
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(containerManager.ensureContainer).mockResolvedValue({
        containerId: 'cont-recovered', remoteWorkspaceFolder: '/workspaces/project',
      });

      let cherryPickAttempt = 0;
      const execGitFn = vi.fn((args: string[]) => {
        if (args[0] === 'cherry-pick' && args[1] !== '--abort') {
          cherryPickAttempt++;
          if (cherryPickAttempt === 1) {
            throw new Error('fatal: not a git repository: (null)');
          }
          return; // retry succeeds
        }
        // '--abort' — no-op
      });

      const resultPromise = _recoverStBranchCommits(
        project.root, execGitFn, '/tmp/log',
        'feat/main', 'feat/main-st1', '/tmp/worktree', 1,
      );
      await vi.advanceTimersByTimeAsync(1000); // skip the 1s backoff
      const result = await resultPromise;

      expect(result).toEqual({ recovered: true, commits: ['abc123 unintegrated commit'] });
      expect(containerManager.ensureContainer).toHaveBeenCalledTimes(1);
      expect(cherryPickAttempt).toBe(2); // 1 failed attempt + 1 successful retry
    } finally {
      vi.useRealTimers();
    }
  });

  it('exhausts infra retries and returns recovered:false when the container never comes back', async () => {
    vi.useFakeTimers();
    try {
      mockExecFileSync
        .mockReturnValueOnce('abc123\n') // rev-parse
        .mockReturnValueOnce('abc123 unintegrated commit\n'); // log

      const { readContainerConfig, containerManager } = await import('../../src/lib/container-manager');
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(containerManager.ensureContainer).mockResolvedValue({
        containerId: 'cont-still-broken', remoteWorkspaceFolder: '/workspaces/project',
      });

      const execGitFn = vi.fn((args: string[]) => {
        if (args[0] === 'cherry-pick' && args[1] !== '--abort') {
          throw new Error('fatal: not a git repository: (null)'); // always fails
        }
      });

      const resultPromise = _recoverStBranchCommits(
        project.root, execGitFn, '/tmp/log',
        'feat/main', 'feat/main-st1', '/tmp/worktree', 1,
      );
      await vi.advanceTimersByTimeAsync(1000); // 1st retry backoff
      await vi.advanceTimersByTimeAsync(1000); // 2nd retry backoff
      const result = await resultPromise;

      // Preserved (not deleted) — commits are still reported for logging,
      // matching the non-infra conflict path's contract.
      expect(result).toEqual({ recovered: false, commits: ['abc123 unintegrated commit'] });
      expect(containerManager.ensureContainer).toHaveBeenCalledTimes(2); // both retries attempted
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not attempt infra retry when container mode is disabled', async () => {
    mockExecFileSync
      .mockReturnValueOnce('abc123\n') // rev-parse
      .mockReturnValueOnce('abc123 unintegrated commit\n'); // log

    const { readContainerConfig, containerManager } = await import('../../src/lib/container-manager');
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });

    const execGitFn = vi.fn(() => {
      throw new Error('fatal: not a git repository: (null)');
    });

    const result = await _recoverStBranchCommits(
      project.root, execGitFn, '/tmp/log',
      'feat/main', 'feat/main-st1', '/tmp/worktree', 1,
    );

    expect(result).toEqual({ recovered: false, commits: ['abc123 unintegrated commit'] });
    expect(containerManager.ensureContainer).not.toHaveBeenCalled();
  });
});
