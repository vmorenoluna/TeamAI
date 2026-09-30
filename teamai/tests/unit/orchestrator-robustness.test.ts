/**
 * Orchestrator robustness guardrail tests.
 * Covers QA review guardrails and snapshot restore behaviour:
 *   - QA verifies remote branch matches worktree (unpushed commits)
 *   - Implement phase mandatory git push
 *   - QA respects locked / manual-override qa_report.json
 *   - Snapshot restore on QA bounce and task retry
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, statSync } from 'fs';
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
import { buildSyntheticReworkDescription, isInfraError, tryCherryPickWithRecovery, _recoverSubtaskBranchBeforeDelete, _recoverStBranchCommits, clearWorktreeDirectoryOrThrow, preserveUncommittedWork, relocateStuckWorktree, sweepAbandonedWorktreeRelocations, integrateGroup, runSubtaskSession, persistCompletedSubtasks, reconcileSubtaskCompletionFromDeliverables, repairStuckCherryPick } from '../../src/lib/orchestrator/implement';
import type { ImplementDeps, ImplementPipeline } from '../../src/lib/orchestrator/implement';
import type { PlanSubtask } from '../../src/lib/orchestrator/types';
import { resolveWorktreeDirName } from '../../src/lib/orchestrator/helpers';
import { warn as mockWarn } from '../../src/lib/logger';

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
    specRevision: 1,
    qaRevision: 0,
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

  // A locked/override report is a deliberate human bypass of the pipeline's
  // own judgment — it does NOT also stamp plan.json's subtask completion
  // flags. Reconciliation was removed in favor of the implement-phase
  // completeness gate (which already guarantees plan.json reflects reality
  // before a genuine QA PASS can ever be reached); a manual override that
  // skips QA entirely leaves the kanban's "N/M subtasks" honestly showing
  // whatever was actually completed, rather than papering over it.
  it('does not stamp plan.json completed flags when skipping via locked report', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Done', description: '', files: [], acceptance_criteria: [], completed: true },
        { id: 2, title: 'Stale', description: '', files: [], acceptance_criteria: [] },
        { id: 9999, title: 'QA Rework', description: '', files: [], acceptance_criteria: [], completed: false },
      ],
    }));
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      locked: true,
      criteria: [{ name: 'Feature X', status: 'FAIL', notes: 'Manual override' }],
    }));

    const pipeline = makePipeline(project.taskId, project.taskDir);
    await (orch as AnyOrch).runQaReview(pipeline);

    expect(pipeline.phase).toBe('awaiting-review');
    const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
    expect(plan.subtasks).toHaveLength(3);
    expect(plan.subtasks[0].completed).toBe(true);
    expect(plan.subtasks[1].completed).toBeUndefined();
    expect(plan.subtasks[2].completed).toBe(false);
  });

  it('does not stamp plan.json completed flags when skipping via manual override', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Done', description: '', files: [], acceptance_criteria: [], completed: true },
        { id: 2, title: 'Stale', description: '', files: [], acceptance_criteria: [] },
        { id: 9999, title: 'QA Rework', description: '', files: [], acceptance_criteria: [], completed: false },
      ],
    }));
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      reviewedBy: 'MANUAL OVERRIDE by Jane on 2024-06-01',
      criteria: [{ name: 'Feature X', status: 'FAIL', notes: 'Human set FAIL' }],
    }));

    const pipeline = makePipeline(project.taskId, project.taskDir);
    await (orch as AnyOrch).runQaReview(pipeline);

    expect(pipeline.phase).toBe('awaiting-review');
    const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
    expect(plan.subtasks).toHaveLength(3);
    expect(plan.subtasks[0].completed).toBe(true);
    expect(plan.subtasks[1].completed).toBeUndefined();
    expect(plan.subtasks[2].completed).toBe(false);
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

    // Regression: qa_feedback.md must be written even when the budget is
    // exhausted — a retry's clearArtifacts wipes qa_report.json too, so this
    // is the only in-repo record of why the task failed if nothing else
    // re-derives it before the coder's next implement pass.
    expect(existsSync(join(project.taskDir, 'qa_feedback.md'))).toBe(true);
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

  it('reconciles via a merger when the rebase conflicts, then pushes its result itself before proceeding to QA', async () => {
    // The merger only resolves the conflict and commits locally — it does
    // NOT push (agent sessions run their own git inside the container and
    // have no GitHub credentials to push with). The orchestrator pushes
    // the merger's result itself, host-side, same as the clean-rebase path.
    let pushCalls = 0;
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return 'abc123 Unpushed commit\n';
      if (args && args[0] === 'rebase') {
        if (args[1] === '--abort') return '';
        throw new Error('CONFLICT (content): Merge conflict');
      }
      // Confirms a genuine conflict — required for the merger-spawn path.
      if (args && args[0] === 'diff' && args.includes('--diff-filter=U')) return 'src/conflicted-file.ts\n';
      if (args && args[0] === 'push') {
        pushCalls++;
        // 1st push: the initial precheck, rejected (non-fast-forward) — triggers reconciliation.
        // 2nd push: the orchestrator's own push after the merger resolves, succeeds.
        if (pushCalls === 1) throw new Error('! [rejected]  feat/robustness-test -> feat/robustness-test (non-fast-forward)');
        return '';
      }
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

    // Then the QA session, once the orchestrator has pushed the merger's result
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(2);
    });
    expect(mockSendMessage).toHaveBeenCalledWith('sess-qa-after-merge', expect.stringContaining('/qa-review'));

    fireEvent('event', { sessionId: 'sess-qa-after-merge', event: { type: 'result' } });
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS', criteria: [],
    }));
    await promise;

    expect(pushCalls).toBe(2);
    const logContent = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('spawning merger to resolve via git merge');
    expect(logContent).toContain('Merger resolved divergence from origin/feat/robustness-test');
    expect(logContent).toContain('Pushed the reconciled branch after merger resolution — remote matches worktree');
  });

  it('falls through to the FAIL report when reconciliation cannot resolve the divergence', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return 'abc123 Unpushed commit\n';
      if (args && args[0] === 'rebase') {
        if (args[1] === '--abort') return '';
        throw new Error('CONFLICT (content): Merge conflict');
      }
      // Confirms a genuine conflict — required for the merger-spawn path.
      if (args && args[0] === 'diff' && args.includes('--diff-filter=U')) return 'src/conflicted-file.ts\n';
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

  // ── Post-merger push failure ──
  //
  // The merger only resolves the conflict and commits locally; the
  // orchestrator pushes its result itself (see above). If that push also
  // fails, there's nothing left to retry — fall through to the FAIL report
  // the same way the initial precheck's push failure does elsewhere.

  it('falls through to the FAIL report when the push after merger resolution fails', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return 'abc123 Unpushed commit\n';
      if (args && args[0] === 'rebase') {
        if (args[1] === '--abort') return '';
        throw new Error('CONFLICT (content): Merge conflict');
      }
      // Confirms a genuine conflict — required for the merger-spawn path.
      if (args && args[0] === 'diff' && args.includes('--diff-filter=U')) return 'src/conflicted-file.ts\n';
      // Every push attempt fails — both the initial precheck push and the
      // orchestrator's own push after the merger resolves the conflict.
      if (args && args[0] === 'push') throw new Error('! [rejected]  feat/robustness-test -> feat/robustness-test (non-fast-forward)');
      return '';
    });

    mockCreateSession.mockResolvedValueOnce('sess-merge-push-fails');

    // qaAttempt starts at 2, runQaReview increments to 3 which equals maxQaAttempts (3),
    // so it goes directly to 'failed' without bouncing back to implement.
    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 2 });

    const promise = (orch as AnyOrch).runQaReview(pipeline);

    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalledTimes(1);
    });
    fireEvent('event', { sessionId: 'sess-merge-push-fails', event: { type: 'result' } });

    await promise;

    // Only the merger session ran — QA never gets a chance to run since the
    // push after merger resolution failed.
    expect(mockCreateSession).toHaveBeenCalledTimes(1);

    const reportPath = join(project.taskDir, 'qa_report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('Unpushed commits');
    expect(pipeline.phase).toBe('failed');

    const logContent = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('Push failed after merger resolution');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Unreadable QA report precheck — always writes qa_feedback.md, whether
//  bouncing back to implement or failing outright once the budget is spent
// ═══════════════════════════════════════════════════════════════════════

describe('runQaReview — unreadable QA report precheck', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
    // No unpushed commits — reach the QA session and fail there instead.
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'log') return '';
      return '';
    });
  });

  afterEach(() => {
    project.clean();
  });

  it('bounces back to implement and writes qa_feedback.md when the QA report is unreadable, budget not exhausted', async () => {
    mockCreateSession.mockResolvedValueOnce('sess-qa-unreadable');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    try {
      // maxQaAttempts is 3 (setupProject's pipeline.json) — a single failed
      // round must bounce, not fail outright.
      const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 1 });

      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });
      // No qa_report.json written by the (simulated) QA agent — session
      // completes but leaves nothing readable behind.
      fireEvent('event', { sessionId: 'sess-qa-unreadable', event: { type: 'result' } });
      await promise;

      expect(pipeline.phase).toBe('implement');

      const report = JSON.parse(readFileSync(join(project.taskDir, 'qa_report.json'), 'utf-8'));
      expect(report.overall).toBe('FAIL');
      expect(report.criteria[0].name).toBe('QA report unreadable');

      expect(existsSync(join(project.taskDir, 'qa_feedback.md'))).toBe(true);
      expect(executeSpy).toHaveBeenCalled();
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('advances to failed and still writes qa_feedback.md when the QA report is unreadable, max QA attempts reached', async () => {
    mockCreateSession.mockResolvedValueOnce('sess-qa-unreadable-exhausted');

    const pipeline = makePipeline(project.taskId, project.taskDir, { qaAttempt: 3, maxQaAttempts: 3 });

    const promise = (orch as AnyOrch).runQaReview(pipeline);
    await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });
    fireEvent('event', { sessionId: 'sess-qa-unreadable-exhausted', event: { type: 'result' } });
    await promise;

    expect(pipeline.phase).toBe('failed');

    const report = JSON.parse(readFileSync(join(project.taskDir, 'qa_report.json'), 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('QA report unreadable');

    // Regression: previously only the non-exhausted branch called
    // writeQaFeedback here — the exhausted branch skipped it, leaving no
    // record of why the task failed for a subsequent retry to recover.
    expect(existsSync(join(project.taskDir, 'qa_feedback.md'))).toBe(true);
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

    // The latest QA report is retained for recurrence comparison even on PASS.
    expect(existsSync(join(project.taskDir, 'qa_report_before_bounce.json'))).toBe(true);
  });

  it('creates snapshot when max QA attempts reached (goes to failed — no bounce)', async () => {
    // When overall !== PASS and qaAttempt >= maxQaAttempts, the task goes to failed.
    // The latest report is still retained for recurrence comparison.
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

    // The latest QA report is retained even when the QA budget is exhausted.
    expect(existsSync(join(project.taskDir, 'qa_report_before_bounce.json'))).toBe(true);
  });

  it('increments qaRevision and writes qa_report_v{N}.json on QA PASS', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-revision');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      qaAttempt: 1,
      qaRevision: 0,
    });

    const promise = (orch as AnyOrch).runQaReview(pipeline);
    await vi.waitFor(() => {
      expect(mockSendMessage).toHaveBeenCalled();
    });

    expect(mockCreateSession).toHaveBeenCalled();

    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS',
      criteria: [{ name: 'Login flow', status: 'PASS', notes: 'LGTM' }],
    }));

    fireEvent('event', { sessionId: 'sess-qa-revision', event: { type: 'result' } });
    await promise;

    // qaRevision incremented
    expect(pipeline.qaRevision).toBe(1);
    expect(pipeline.phase).toBe('awaiting-review');

    // Versioned snapshot written
    const versionedPath = join(project.taskDir, 'qa_report_v1.json');
    expect(existsSync(versionedPath)).toBe(true);
    const snapshot = JSON.parse(readFileSync(versionedPath, 'utf-8'));
    expect(snapshot.overall).toBe('PASS');
    expect(snapshot.criteria[0].name).toBe('Login flow');
  });

  it('increments qaRevision and writes qa_report_v{N}.json on consecutive QA cycles', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'fetch') return '';
      if (args && args[0] === 'log') return '';
      return '';
    });

    // Spy on executePhase to prevent cascading into runImplement on FAIL bounce
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    try {
      // ── Cycle 1: QA FAIL, bounce to implement ──
      mockCreateSession.mockResolvedValue('sess-qa-cycle1');

      const pipeline = makePipeline(project.taskId, project.taskDir, {
        qaAttempt: 1,
        qaRevision: 0,
      });

      let promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        criteria: [{ name: 'Bug', status: 'FAIL', notes: 'First failure' }],
      }));

      fireEvent('event', { sessionId: 'sess-qa-cycle1', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;

      // After cycle 1: FAIL bounce -> qaRevision increments
      expect(pipeline.qaRevision).toBe(1);
      expect(existsSync(join(project.taskDir, 'qa_report_v1.json'))).toBe(true);
      const v1 = JSON.parse(readFileSync(join(project.taskDir, 'qa_report_v1.json'), 'utf-8'));
      expect(v1.overall).toBe('FAIL');

      // ── Cycle 2: QA FAIL again, bounce to implement ──
      mockCreateSession.mockResolvedValue('sess-qa-cycle2');
      mockSendMessage.mockClear();
      pipeline.phase = 'qa-review';
      pipeline.qaAttempt = 2;

      promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      });

      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        criteria: [{ name: 'Bug', status: 'FAIL', notes: 'Still broken' }],
      }));

      fireEvent('event', { sessionId: 'sess-qa-cycle2', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;

      // After cycle 2: FAIL bounce -> qaRevision increments to 2
      expect(pipeline.qaRevision).toBe(2);
      expect(existsSync(join(project.taskDir, 'qa_report_v2.json'))).toBe(true);
      const v2 = JSON.parse(readFileSync(join(project.taskDir, 'qa_report_v2.json'), 'utf-8'));
      expect(v2.overall).toBe('FAIL');

      // v1 still exists (never overwritten)
      expect(existsSync(join(project.taskDir, 'qa_report_v1.json'))).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
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
      // `diff --name-only` must return no changes outside each subtask's own
      // assigned file, or the post-session scope check spuriously rejects
      // every subtask (a blanket 'abc123\n' for every git call — the old
      // mock here — reads as an out-of-scope file named "abc123"). That
      // scope rejection used to be harmless (nothing gated cross-group
      // advancement on a single subtask failing), but the cross-group
      // completion barrier now correctly stops the pass right there, so
      // this mock has to reflect a coder session that actually stayed in
      // scope.
      // Each subtask's diff must show ITS OWN assigned file changed (an empty
      // diff now trips the no-op-subtask rejection instead of completing).
      // Subtasks run sequentially, one diff call each, in order 2, 3, 5.
      const diffFilesInOrder = ['src/errors.ts', 'src/rate-limit.ts', 'src/upload.ts'];
      let diffCallIndex = 0;
      mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
        if (Array.isArray(args) && args[0] === 'diff') return (diffFilesInOrder[diffCallIndex++] || '') + '\n';
        return 'abc123\n';
      });
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
        // Base branch hasn't advanced — ensureWorktree's own rebase-then-push
        // (unrelated to what this test is verifying) is a no-op, so the only
        // push this test sees is pushAndVerify's.
        if (args[0] === 'rev-list') return '0\n';
        // The subtask must show its assigned file changed — an empty diff now
        // trips the no-op-subtask rejection instead of completing.
        if (args[0] === 'diff') return 'src/test.ts\n';
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
        // The subtask must show its assigned file changed — an empty diff now
        // trips the no-op-subtask rejection instead of completing and
        // reaching the push step this test actually verifies.
        if (args[0] === 'diff') return 'src/test.ts\n';
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
        // The subtask must show its assigned file changed — an empty diff now
        // trips the no-op-subtask rejection instead of completing and
        // reaching the push-verification step this test actually verifies.
        if (args[0] === 'diff') return 'src/test.ts\n';
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

    // Each subtask must show its own assigned file changed, in dispatch order
    // (1, 2, 3) — an empty diff now trips the no-op-subtask rejection instead
    // of completing.
    const diffFilesInOrder = ['src/login.ts', 'src/auth.ts', 'src/dashboard.ts'];
    let diffCallIndex = 0;
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'diff') return (diffFilesInOrder[diffCallIndex++] || '') + '\n';
      }
      return '';
    });

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

    // Each flagged subtask must show its own assigned file changed, in
    // dispatch order (2, 4) — an empty diff now trips the no-op-subtask
    // rejection instead of completing.
    const diffFilesInOrder = ['src/auth.ts', 'src/api.ts'];
    let diffCallIndex = 0;
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'diff') return (diffFilesInOrder[diffCallIndex++] || '') + '\n';
      }
      return '';
    });

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

    // The flagged subtask must show its own assigned file changed — an empty
    // diff now trips the no-op-subtask rejection instead of completing.
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'diff') return 'src/auth.ts\n';
      }
      return '';
    });

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
      // SESSION CONTEXT header is always present; the key assertion is
      // only 1 session created (the non-flagged subtask must be skipped).

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
        // These tests' subtasks all declare files: ['src/Foo.scala'] — an
        // empty diff now trips the no-op-subtask rejection instead of
        // completing on a successful recovery.
        if (args[0] === 'diff') return 'src/Foo.scala\n';
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

  // Regression coverage for a real production failure: a session went idle
  // between tool calls for a bit over 2 minutes (no tool running, threshold
  // was 2 minutes at the time — since raised to 15, see
  // SESSION_IDLE_STALL_THRESHOLD_MS) and was killed by the idle-stall
  // threshold, but the retry prompt and log line both claimed "no output for
  // over 30 minutes while a tool was running" — hardcoded text that assumed
  // the tool-in-flight threshold regardless of which one actually fired. The
  // coder then reasoned about a nonexistent 30-minute hang instead of the
  // real ~2-minute idle gap, and repeated idle-kills burned through the
  // stall-recovery budget in minutes, not the hours the message implied.
  // stallKind now must be threaded through from the kill call so the message
  // reflects the real cause (and the real threshold, whatever it's set to).
  it('reports the idle threshold accurately, not the hardcoded tool-in-flight text (stallKind regression)', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1,
        title: 'Investigate pitch-height anchoring',
        description: 'Read the relevant files and design the fix',
        files: ['src/Foo.scala'],
        acceptance_criteria: ['Fix designed'],
      }],
    }));

    mockCreateSession
      .mockResolvedValueOnce('sess-idle-stalled')
      .mockResolvedValueOnce('sess-recovered');
    mockGetSession.mockImplementation((id: string) =>
      id === 'sess-idle-stalled' ? { killReason: 'stalled', stallKind: 'idle' } : undefined);

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

      fireEvent('exit', { sessionId: 'sess-idle-stalled', code: null, signal: 'SIGTERM' });
      await vi.advanceTimersByTimeAsync(30);

      await vi.waitFor(() => {
        expect(mockCreateSession).toHaveBeenCalledTimes(2);
        expect(mockSendMessage).toHaveBeenCalledTimes(2);
      });
      const retryPrompt = mockSendMessage.mock.calls[1][1];
      expect(retryPrompt).toContain('SESSION RECOVERED AFTER STALL-KILL (attempt 1/3)');
      expect(retryPrompt).toContain('over 15 minutes while IDLE');
      expect(retryPrompt).not.toContain('over 30 minutes while a tool was running');
      expect(retryPrompt).not.toContain('Your own change caused a genuine hang');

      const outputLog = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
      expect(outputLog).toContain('idle for over 15 minutes with no tool running');
      expect(outputLog).not.toContain('no output 30+min');

      fireEvent('event', { sessionId: 'sess-recovered', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;
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
    promise.catch(() => { /* best-effort */ });
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

      // Spec revision should be incremented (1 → 2: v1 is the initial spec)
      expect(pipeline.specRevision).toBe(2);

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
      await (orch as AnyOrch).rejectTask(project.taskId, 'Fix the bugs please', 'coder');

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
      await (orch as AnyOrch).rejectTask(project.taskId, 'Fix the auth module too', 'coder');

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

  // Regression coverage for task add-per-constraint-soft-score-attributio's
  // third failure: in container mode, a coder session's write only becomes
  // visible on the host once the bind mount syncs — not instantaneous,
  // worse under I/O contention — so a wakeup-file scan taken immediately
  // after the session ends can race a file the coder definitely wrote. The
  // subtask was then wrongly treated as having failed deliverable
  // verification, and the task failed outright minutes later. This test
  // simulates that race directly: the wakeup file doesn't exist at the
  // first scan, but lands before the retry loop gives up.
  it('picks up a wakeup file that lands after the first scan (bind-mount sync race)', async () => {
    // wakeupScanRetryDelayMs defaults to 0 under vitest (see
    // computePipelineConfig) so this test opts back in explicitly with a
    // fast value, rather than relying on the real 2000ms production default.
    writeFileSync(join(project.root, '.teamai', 'pipeline.json'), JSON.stringify({
      phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'],
      maxQaAttempts: 3,
      parallelSubtasks: true,
      wakeupScanRetryDelayMs: 50,
    }));

    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 9,
        title: 'Run production sweep',
        description: 'Launch a long-running sweep',
        files: [],
        acceptance_criteria: ['Sweep completes'],
        files_to_create: ['results/summary.jsonl'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-wakeup-race');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      // Session ends with NO wakeup file present yet — the first scan must
      // find nothing, same as a genuinely-missed race.
      fireEvent('event', { sessionId: 'sess-wakeup-race', event: { type: 'result' } });
      // Flush microtasks up to (but not past) the retry loop's first wait —
      // short enough that the 50ms retry delay hasn't elapsed yet.
      await vi.advanceTimersByTimeAsync(1);

      // The file "arrives" late, as it would once the bind mount syncs.
      writeFileSync(join(project.taskDir, 'subtask_wakeup-st9.json'), JSON.stringify({
        subtask_id: 9,
        wakeup_at: '2026-07-04T14:00:00Z',
        background_command: 'python scripts/optimizer_sweep.py --batch',
        expected_artifact: 'results/summary.jsonl',
      }));

      // Let the retry loop's setTimeout fire and re-scan pick it up.
      await vi.advanceTimersByTimeAsync(200);

      expect(existsSync(join(project.taskDir, 'subtask_wakeup-st9.json'))).toBe(false);
      expect(pipeline.wakeupSubtaskId).toBe(9);
      expect(pipeline.wakeupUntil).toBe('2026-07-04T14:00:00Z');
      // Deliverable verification must NOT have run — the wakeup being
      // detected (even late) should skip it entirely, exactly as an
      // immediate detection would.
      expect(pipeline.deliverableFailCounts?.[9]).toBeUndefined();

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  // Regression coverage for a real production failure (task 585a32e0):
  // Subtask 8 discovered its dependency, Subtask 7, was still blocked on a
  // live background job. Rather than silently completing, it scheduled a
  // wakeup for the ACTUAL blocked subtask (7) — but wrote it to
  // subtask_wakeup-st7.json, not subtask_wakeup-st8.json (its own id).
  // Wakeup-file discovery used to be scoped to only the currently-running
  // subtask's own filename, so this file was invisible: nothing prevented
  // Subtask 8 (which wrote it) from being marked completed:true anyway,
  // and the file just sat on disk, unconsumed, forever. Discovery now
  // scans for ANY subtask_wakeup-st<N>.json, so a session can legitimately
  // schedule a wakeup on behalf of the subtask that's actually blocking
  // progress — and finding one, regardless of which id it names, still
  // means the CURRENT subtask isn't done either.
  it('picks up a wakeup file scheduled for a DIFFERENT subtask than the one currently running', async () => {
    // Only Subtask 8 dispatches here — its dependency on Subtask 7 is
    // deliberately omitted so this test isolates the wakeup-misdirection
    // fix from the separate depends_on runtime-gating fix (covered by its
    // own describe block below), rather than conflating the two.
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 8, title: 'Final regression gate', description: 'Gate', files: [], acceptance_criteria: ['All ACs pass'] },
      ],
    }));

    mockCreateSession.mockResolvedValue('sess-gate');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      // Subtask 8's session, discovering Subtask 7 is what's actually
      // blocked, schedules 7's wakeup instead of its own.
      writeFileSync(join(project.taskDir, 'subtask_wakeup-st7.json'), JSON.stringify({
        subtask_id: 7,
        wakeup_at: '2026-09-03T14:30:00Z',
        background_command: 'python sweep.py',
        expected_artifact: 'scripts/sweep_logs/evidence.log',
      }));

      fireEvent('event', { sessionId: 'sess-gate', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      expect(existsSync(join(project.taskDir, 'subtask_wakeup-st7.json'))).toBe(false);
      expect(pipeline.wakeupSubtaskId).toBe(7);
      expect(pipeline.wakeupUntil).toBe('2026-09-03T14:30:00Z');

      // Subtask 8 itself must NOT be marked complete — its own session
      // said as much by scheduling a wakeup at all, regardless of whose id
      // it named.
      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 8).completed).toBeUndefined();
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

  // Regression coverage for a real production failure (task 585a32e0): a
  // ~2h background sweep was still genuinely running (605-cell solve log
  // still being written) when the wakeup re-entry coder session ran out of
  // turns mid-monitoring and ended WITHOUT writing a fresh wakeup file —
  // never reaching its own "if still running, reschedule" instruction. The
  // orchestrator saw no new wakeup file and, with no files_to_create
  // declared on this subtask (it overwrites an existing evidence file
  // rather than creating a new one), had no other check to catch this —
  // silently declared the subtask complete and moved on, so the analysis
  // subtask that followed ran against months-old evidence instead of the
  // fresh sweep. The fix verifies the declared wakeupArtifact actually
  // advanced past its mtime at the last schedule point before trusting
  // silence as completion; an unchanged artifact auto-reschedules another
  // check instead.
  it('does not trust silent "completion" when the wakeup artifact was never actually produced', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 3,
        title: 'Run fresh sweep and extract evidence',
        description: 'Run the sweep and overwrite the existing evidence file',
        files: ['scripts/sweep_logs/evidence.log'],
        acceptance_criteria: ['Fresh evidence committed'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-wakeup-stuck');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    // The stale evidence file already exists (from before this sweep even
    // started) — its presence alone must not be mistaken for freshness.
    const worktreePath = join(project.root, 'worktrees', 'test-task');
    mkdirSync(join(worktreePath, 'scripts/sweep_logs'), { recursive: true });
    writeFileSync(join(worktreePath, 'scripts/sweep_logs/evidence.log'), 'stale evidence from a prior sweep');
    const staleMtime = statSync(join(worktreePath, 'scripts/sweep_logs/evidence.log')).mtimeMs;

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath,
      wakeupSubtaskId: 3, wakeupCommand: 'python sweep.py', wakeupArtifact: 'scripts/sweep_logs/evidence.log',
      wakeupAttemptCount: 1, wakeupArtifactMtimeAtSchedule: staleMtime,
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      // No fresh wakeup file this session, and the evidence file's mtime is
      // unchanged from when the wakeup was scheduled — nothing was produced.
      fireEvent('event', { sessionId: 'sess-wakeup-stuck', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      // Subtask must NOT be silently marked complete.
      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks[0].completed).toBeUndefined();

      // A follow-up check must be auto-scheduled instead — isolation stays
      // pointed at subtask 3, and the attempt count advanced.
      expect(pipeline.wakeupSubtaskId).toBe(3);
      expect(pipeline.wakeupUntil).toBeDefined();
      expect(pipeline.wakeupAttemptCount).toBe(2);
    } finally {
      executeSpy.mockRestore();
    }
  });

  // Regression coverage for a real production failure: a subtask whose FINAL
  // wakeup re-entry session ended cleanly (no fresh wakeup file written, no
  // deliverable missing) was added to completedIds, but the wakeup-reentry
  // early return skipped the plan.json persistence write — so `completed:
  // true` never landed in plan.json even though the subtask's acceptance
  // criteria had all passed. The UI then showed the subtask as perpetually
  // incomplete. Tested at the runSubtaskSession level so the group-loop's
  // fire-and-forget fallback write (which also sets completed) can't mask the
  // missing per-subtask checkpoint.
  it('persists completed: true in plan.json when a subtask completes via wakeup re-entry', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 3,
        title: 'Run files_to_create-gated sweep',
        description: 'Run the sweep and commit the evidence artifact',
        files: ['scripts/sweep.py'],
        acceptance_criteria: ['Sweep evidence committed'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-wakeup-complete');

    // The background job actually finished and wrote its artifact — mtime
    // check must see this as newer than wakeupArtifactMtimeAtSchedule (a
    // minute in the past here) and trust the completion.
    const worktreePath = join(project.root, 'worktrees', 'test-task');
    mkdirSync(join(worktreePath, 'scripts/sweep_logs'), { recursive: true });
    writeFileSync(join(worktreePath, 'scripts/sweep_logs/evidence.log'), 'sweep evidence');

    // The re-entry session also touched its assigned script file (e.g. a
    // small tweak while investigating the evidence) — an empty diff now
    // trips the no-op-subtask rejection instead of completing.
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'diff') return 'scripts/sweep.py\n';
      }
      return '';
    });

    // Resuming after an earlier, legitimate wakeup cycle on the same subtask.
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath,
      wakeupSubtaskId: 3, wakeupCommand: 'python sweep.py', wakeupArtifact: 'scripts/sweep_logs/evidence.log', wakeupAttemptCount: 1,
      wakeupArtifactMtimeAtSchedule: Date.now() - 60_000,
    });

    const subtask: PlanSubtask = {
      id: 3,
      title: 'Run files_to_create-gated sweep',
      description: 'Run the sweep and commit the evidence artifact',
      files: ['scripts/sweep.py'],
      acceptance_criteria: ['Sweep evidence committed'],
      depends_on: [],
    };

    const ctx = (orch as AnyOrch)._ctx;
    const completedIds: number[] = [];
    const scopeViolations = new Set<number>();
    const sessionMapLock = { current: Promise.resolve() };

    const promise = runSubtaskSession(
      pipeline, ctx, subtask, pipeline.worktreePath,
      join(project.taskDir, 'output.log'),
      false, false, join(project.taskDir, 'human_feedback.md'),
      completedIds, scopeViolations, sessionMapLock,
    );

    await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

    // No fresh wakeup file this session — the subtask completes now.
    fireEvent('event', { sessionId: 'sess-wakeup-complete', event: { type: 'result' } });
    await promise;

    // The wakeup-reentry branch ran and cleared the wakeup state — confirming
    // this exercised the exact completion path that used to skip the write.
    expect(pipeline.wakeupSubtaskId).toBeUndefined();
    expect(pipeline._wakeupJustCompleted).toBe(true);

    // The per-subtask checkpoint write is queued on planWriteLock — await it
    // so the assertion reads the settled plan.json.
    await ctx.planWriteLock.current;

    const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
    expect(plan.subtasks.find((s: any) => s.id === 3).completed).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Post-session scope check — files_to_create must count as in-scope
// ═══════════════════════════════════════════════════════════════════════
// Regression coverage for a real production failure (task 5a2b5b50): the
// scope check compared changed files only against `subtask.files`, never
// `subtask.files_to_create` — a distinct, first-class field that deliverable
// verification already treats as the subtask's assigned deliverable. Any
// subtask whose ENTIRE deliverable was new files (files: [] +
// files_to_create-only — the shape used for "capture this evidence into a
// new file" subtasks) was guaranteed to be flagged as "outside its assigned
// scope" for creating exactly the file it was told to create, discarding
// real, correct work every retry.

describe('runImplement — scope check honors files_to_create', () => {
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

  it('does not flag a subtask that only creates its declared files_to_create deliverable', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 2,
        title: 'Capture evidence',
        description: 'Capture evidence into a new file',
        files: [],
        files_to_create: ['scripts/sweep_logs/evidence.txt'],
        acceptance_criteria: ['Evidence captured'],
      }],
    }));

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'diff') return 'scripts/sweep_logs/evidence.txt\n';
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-scope-ok');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const worktreePath = join(project.root, 'worktrees', 'test-task');
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath,
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      // The deliverable is actually produced before the session ends.
      mkdirSync(join(worktreePath, 'scripts/sweep_logs'), { recursive: true });
      writeFileSync(join(worktreePath, 'scripts/sweep_logs/evidence.txt'), 'evidence');

      fireEvent('event', { sessionId: 'sess-scope-ok', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      const log = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
      expect(log).not.toContain('[SCOPE]');
      expect(log).not.toContain('modified files outside its assigned scope');

      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('still flags a subtask that modifies a file outside both files and files_to_create', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 3,
        title: 'Capture evidence',
        description: 'Capture evidence into a new file',
        files: [],
        files_to_create: ['scripts/sweep_logs/evidence.txt'],
        acceptance_criteria: ['Evidence captured'],
      }],
    }));

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'diff') return 'scripts/sweep_logs/evidence.txt\nsrc/UnrelatedFile.scala\n';
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-scope-violated');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const worktreePath = join(project.root, 'worktrees', 'test-task');
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath,
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      mkdirSync(join(worktreePath, 'scripts/sweep_logs'), { recursive: true });
      writeFileSync(join(worktreePath, 'scripts/sweep_logs/evidence.txt'), 'evidence');

      fireEvent('event', { sessionId: 'sess-scope-violated', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      const log = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
      expect(log).toContain('[SCOPE] Subtask 3 modified files outside its assigned scope');
      expect(log).toContain('src/UnrelatedFile.scala');
    } finally {
      executeSpy.mockRestore();
    }
  });

  // Regression: task detect-mechanical-periodic-melodic-loops. The
  // QA-fallback synthetic subtask (id 9999)'s `files` array is only a
  // best-effort union of the real subtasks' own `files`, seeded because
  // criterion-matching found nothing to target — it isn't an authoritative
  // scope. Rejecting 9999 for fixing exactly what qa_feedback.md named (here,
  // a deliverable no real subtask's `files` happened to list) directly
  // contradicts implement.md's own QA Rework Mode rule ("Fix every listed
  // issue. That's the entire scope.") and burns an attempt on the correct fix.
  it('does not scope-reject subtask 9999 (QA-fallback) for touching files outside its files array', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 9999,
        title: 'QA Rework: fix failing criteria (criterion matching found no flagged subtasks)',
        description: 'Fix every issue in qa_feedback.md',
        files: ['src/main/scala/formell/MelodyConstraintProvider.scala'],
        files_to_create: [],
        depends_on: [],
        acceptance_criteria: ['All criteria listed in the QA feedback above are satisfied'],
        parallel_group: 'QA-REWORK',
        qa_flagged: true,
      }],
    }));

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        // The coder produced the actual deliverable QA named — a path never
        // listed in 9999's own `files` array.
        if (args[0] === 'diff') return 'scripts/sweep_logs/evidence.txt\n';
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-9999-scope');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const worktreePath = join(project.root, 'worktrees', 'test-task');
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath,
    });
    writeFileSync(join(project.taskDir, 'qa_feedback.md'), 'Missing scripts/sweep_logs/evidence.txt');

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      mkdirSync(join(worktreePath, 'scripts/sweep_logs'), { recursive: true });
      writeFileSync(join(worktreePath, 'scripts/sweep_logs/evidence.txt'), 'evidence');

      fireEvent('event', { sessionId: 'sess-9999-scope', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      const log = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
      expect(log).not.toContain('[SCOPE] Subtask 9999 modified files outside its assigned scope');

      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 9999).completed).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Commit guard — sequential subtasks that never git-commit their own work
// ═══════════════════════════════════════════════════════════════════════
// Regression coverage for a real production failure (task
// guard-standalone-melody-endpoint-chord-s): a coder session edited its
// assigned file, ran tests, verified them green, and ended the session
// having never run `git add`/`git commit`. integrateGroup already had a
// safety-net auto-commit, but ONLY for the parallel per-subtask-worktree
// path (subtaskWorktrees.size > 0) — a lone/sequential subtask running
// directly in the main worktree hit no such check anywhere. The uncommitted
// edit sat in the worktree, invisible to the scope check (diffs committed
// history only) and to QA (which reviews the worktree, not git), then was
// silently dropped when create-PR's squash did `git reset --soft` — which
// only restages an already-committed tree — leaving the PR with none of the
// actual code change.

describe('runImplement — commit guard for sequential subtasks', () => {
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

  it('auto-commits a coder session\'s uncommitted edit before the scope check runs', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1,
        title: 'Fix chord-span guard',
        description: 'Add the missing floor guard',
        files: ['src/main/scala/formell/api/util/MelodyContextBuilder.scala'],
        acceptance_criteria: ['Guard prevents zero-width spans'],
      }],
    }));

    const addCalls: string[][] = [];
    const commitCalls: string[][] = [];
    // The subtask never actually committed, so a real `git diff` between
    // preSessionHead and HEAD would see nothing until the orchestrator's own
    // auto-commit guard runs `git commit` — simulate that ordering: `diff`
    // returns empty until a `commit` call has actually happened, matching
    // what real git would show (and what the no-op-subtask check now relies
    // on to distinguish "auto-committed" from "truly untouched").
    let autoCommitted = false;
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'status' && args.includes('--porcelain')) {
          return ' M src/main/scala/formell/api/util/MelodyContextBuilder.scala\n';
        }
        if (args[0] === 'add') { addCalls.push(args); return ''; }
        if (args[0] === 'commit') { commitCalls.push(args); autoCommitted = true; return ''; }
        if (args[0] === 'diff') return autoCommitted ? 'src/main/scala/formell/api/util/MelodyContextBuilder.scala\n' : '';
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-commit-guard');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const worktreePath = join(project.root, 'worktrees', 'test-task');
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath,
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      fireEvent('event', { sessionId: 'sess-commit-guard', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      // The uncommitted edit was auto-committed, excluding .teamai/ like
      // every other safety-net commit in this codebase.
      expect(addCalls.length).toBeGreaterThan(0);
      expect(addCalls[0]).toContain(':!.teamai');
      expect(commitCalls.some(c => c.join(' ').includes('auto-commit subtask 1'))).toBe(true);

      const log = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
      expect(log).toContain('[COMMIT-GUARD] Subtask 1 left uncommitted changes');
      // No scope violation — the only changed file was already the assigned one.
      expect(log).not.toContain('[SCOPE] Subtask 1 modified files outside its assigned scope');

      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  depends_on runtime enforcement across groups
// ═══════════════════════════════════════════════════════════════════════
// Regression coverage for a real production failure (task 585a32e0):
// parallel_group ordering reflects the planner's INTENDED sequencing, but
// nothing at runtime verified a subtask's depends_on were actually
// completed before dispatching it — the group loop just marched through
// every group regardless of whether earlier subtasks succeeded. Subtask 7
// (depends_on a never-completed Subtask 3) and Subtask 8 (depends_on a
// never-completed Subtask 7) both ran anyway, producing a "final
// regression gate" that verified nothing real about work that never
// landed.

describe('runImplement — depends_on gates dispatch across groups', () => {
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

  it('defers a subtask whose dependency never completed instead of dispatching it anyway', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        // Never completes — its files_to_create deliverable is never
        // produced by the mocked session, so it stays incomplete without
        // needing to simulate a full scope violation.
        { id: 1, title: 'Produce artifact', description: 'Produce it', files: [], files_to_create: ['out/artifact.txt'], acceptance_criteria: ['Artifact exists'], parallel_group: 'A' },
        { id: 2, title: 'Consume artifact', description: 'Consume it', files: ['src/b.ts'], acceptance_criteria: ['B done'], depends_on: [1], parallel_group: 'B' },
      ],
    }));

    mockCreateSession.mockResolvedValue('sess-dep-1');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      fireEvent('event', { sessionId: 'sess-dep-1', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      // Only Subtask 1 ever dispatched — Subtask 2 was deferred, never
      // started, because its dependency never completed.
      expect(mockCreateSession).toHaveBeenCalledTimes(1);

      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBeUndefined();
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBeUndefined();

      // The cross-group completion barrier now stops the pass right after
      // group A (subtask 1 didn't complete), before group B is even
      // considered — so subtask 2's own depends_on gate never gets a
      // chance to log its usual deferral message this pass. The
      // functional guarantee (subtask 2 never dispatched) is unchanged;
      // only which log line explains why has moved earlier.
      const log = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
      expect(log).toContain('[GROUP-BARRIER] 1 subtask(s) in this group did not complete (id 1)');
      expect(log).not.toContain('[DEPENDS-ON] Subtask 2 deferred');
    } finally {
      executeSpy.mockRestore();
    }
  });

  // Regression: task add-per-constraint-soft-score-attributio. Subtask 15
  // (group G) did NOT declare subtasks 13/14 (group F) in its own
  // depends_on — its prose said to wait for them, but that's not a field
  // the scheduler reads. With no depends_on edge at all connecting the two
  // groups, the readySubtasks filter for group G had nothing to check
  // against group F's incompleteness — only the group-completion barrier
  // (not a depends_on relationship) stops this.
  it('does not dispatch a later group in the same pass when an earlier group is incomplete and no depends_on links them', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        // Group F: never completes (deliverable missing), no wakeup file.
        { id: 13, title: 'V0 sweep', description: 'x', files: [], files_to_create: ['out/v0.log'], acceptance_criteria: ['V0 exists'], parallel_group: 'F' },
        // Group G: depends_on is empty — does NOT name 13, matching the
        // real plan's under-declared dependency exactly.
        { id: 15, title: 'P1 sweep', description: 'x', files: ['src/p1.ts'], acceptance_criteria: ['P1 exists'], parallel_group: 'G' },
      ],
    }));

    mockCreateSession.mockResolvedValue('sess-undeclared-dep');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      fireEvent('event', { sessionId: 'sess-undeclared-dep', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      // Only subtask 13 (group F) was ever dispatched this pass — group G
      // never got a session, despite having no depends_on gate against 13.
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockSendMessage.mock.calls[0][1]).toContain('Subtask 13');

      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 13).completed).toBeUndefined();
      expect(plan.subtasks.find((s: any) => s.id === 15).completed).toBeUndefined();

      const log = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
      expect(log).toContain('[GROUP-BARRIER] 1 subtask(s) in this group did not complete (id 13)');
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('dispatches a subtask once its dependency completes within the same pass', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Produce artifact', description: 'Produce it', files: ['src/a.ts'], acceptance_criteria: ['A done'], parallel_group: 'A' },
        { id: 2, title: 'Consume artifact', description: 'Consume it', files: ['src/b.ts'], acceptance_criteria: ['B done'], depends_on: [1], parallel_group: 'B' },
      ],
    }));

    // Each subtask must show its own assigned file changed, in dispatch order
    // (1, 2) — an empty diff now trips the no-op-subtask rejection instead of
    // completing.
    const diffFilesInOrder = ['src/a.ts', 'src/b.ts'];
    let diffCallIndex = 0;
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'diff') return (diffFilesInOrder[diffCallIndex++] || '') + '\n';
      }
      return '';
    });

    mockCreateSession
      .mockResolvedValueOnce('sess-dep-a')
      .mockResolvedValueOnce('sess-dep-b');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });
      fireEvent('event', { sessionId: 'sess-dep-a', event: { type: 'result' } });

      await vi.waitFor(() => { expect(mockCreateSession).toHaveBeenCalledTimes(2); });
      fireEvent('event', { sessionId: 'sess-dep-b', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Implement completeness gate — don't push to QA on known-incomplete work
// ═══════════════════════════════════════════════════════════════════════
// Prompted by a real cost, not just a hypothetical: with maxQaAttempts set
// low, a pass that pushes with subtasks the orchestrator already knows
// (from plan.json) are incomplete burns the ENTIRE QA budget confirming
// something no LLM review was needed to discover. Retry implement instead,
// bounded by maxImplementRetries so a task that can never
// structurally converge still fails rather than looping forever.

describe('runImplement — implement completeness gate', () => {
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
        // Base branch hasn't advanced — ensureWorktree's own rebase-then-push
        // is a no-op, so these tests' "no push happened at all" assertions
        // aren't contaminated by a push unrelated to what they're testing.
        if (args[0] === 'rev-list') return '0\n';
      }
      return '';
    });
  });

  afterEach(() => { project.clean(); });
    vi.useRealTimers();

  it('retries implement instead of pushing to QA when a subtask remains incomplete, under the cap', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1, title: 'Produce artifact', description: 'x', files: [],
        files_to_create: ['out/artifact.txt'], acceptance_criteria: ['Artifact exists'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-gate-retry');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });
      fireEvent('event', { sessionId: 'sess-gate-retry', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      // Retried implement — never advanced to qa-review, never pushed.
      expect(pipeline.phase).toBe('implement');
      expect(pipeline.incompleteImplementPassCount).toBe(1);
      const pushCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'git' && Array.isArray(call[1]) && call[1][0] === 'push',
      );
      expect(pushCalls.length).toBe(0);

      const log = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
      expect(log).toContain('[IMPLEMENT-GATE]');
      expect(log).not.toContain('PUSH TO REMOTE');
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('advances directly to failed once the incomplete-pass cap is exceeded, without ever reaching QA', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1, title: 'Produce artifact', description: 'x', files: [],
        files_to_create: ['out/artifact.txt'], acceptance_criteria: ['Artifact exists'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-gate-cap');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    // Already one pass short of the default cap (3) — this pass's failure
    // to complete pushes it over.
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
      incompleteImplementPassCount: 2,
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });
      fireEvent('event', { sessionId: 'sess-gate-cap', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      expect(pipeline.phase).toBe('failed');
      const pushCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'git' && Array.isArray(call[1]) && call[1][0] === 'push',
      );
      expect(pushCalls.length).toBe(0);

      const report = JSON.parse(readFileSync(join(project.taskDir, 'qa_report.json'), 'utf-8'));
      expect(report.overall).toBe('FAIL');
      expect(report.criteria[0].criterion).toBe('Implement completeness gate');

      // This path fails the task without ever running QA — it must still
      // regenerate task.json's completionSummary/failureReason (previously
      // left stale from whatever QA-driven failure happened last, or never
      // set at all) so the UI reflects why THIS run actually failed.
      const task = (orch as AnyOrch).taskStore.getById(project.taskId);
      expect(task?.failureReason).toBe('implement-failure');
      expect(task?.completionSummary).toContain('Implement completeness gate');
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('resets the counter and proceeds to QA normally once a pass fully completes', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{ id: 1, title: 'Do it', description: 'x', files: ['src/a.ts'], acceptance_criteria: ['Done'] }],
    }));

    // The subtask must show its assigned file changed — an empty diff now
    // trips the no-op-subtask rejection instead of completing.
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'rev-list') return '0\n';
        if (args[0] === 'diff') return 'src/a.ts\n';
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-gate-complete');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
      incompleteImplementPassCount: 2,
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });
      fireEvent('event', { sessionId: 'sess-gate-complete', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      expect(pipeline.phase).toBe('qa-review');
      expect(pipeline.incompleteImplementPassCount).toBe(0);
      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });

  // Regression: task detect-mechanical-periodic-melodic-loops. QA flagged
  // subtask 5's missing deliverable but criterion-matching couldn't target
  // subtask 5 itself, so the QA-fallback synthetic subtask (9999) ran
  // instead and produced exactly subtask 5's declared files_to_create.
  // Without reconciliation, subtask 5's own `completed` flag never flips and
  // subtask 6 (depends_on 5, never named in qa_feedback.md so never
  // qa_flagged) is permanently unreachable — the gate retries forever
  // instead of ever running subtask 6.
  it('reconciles subtask 5 completed and flags dependent subtask 6 when the QA-fallback subtask supplies its deliverable', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        {
          id: 5, title: 'Run sweep', description: 'x', files: [],
          files_to_create: ['out/evidence.txt'], acceptance_criteria: ['Evidence exists'],
        },
        {
          id: 6, title: 'Docs entry', description: 'x', files: ['docs/x.md'],
          depends_on: [5], acceptance_criteria: ['Docs updated'],
        },
      ],
    }));
    writeFileSync(join(project.taskDir, 'qa_feedback.md'), 'Missing out/evidence.txt');

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'rev-list') return '0\n';
        // The synthesized 9999 subtask produces subtask 5's own deliverable.
        if (args[0] === 'diff') return 'out/evidence.txt\n';
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-reconcile');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const worktreePath = join(project.root, 'worktrees', 'test-task');
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath,
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      mkdirSync(join(worktreePath, 'out'), { recursive: true });
      writeFileSync(join(worktreePath, 'out', 'evidence.txt'), 'evidence');

      fireEvent('event', { sessionId: 'sess-reconcile', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      // Retried implement (subtask 6 still incomplete) — never failed outright.
      expect(pipeline.phase).toBe('implement');

      const log = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
      expect(log).not.toContain('[SCOPE] Subtask 9999');
      expect(log).toContain('[RECONCILE] Subtask 5 marked completed');
      expect(log).toContain('[RECONCILE] Subtask 6 flagged for the next implement pass');

      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 5).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 6).completed).toBeFalsy();
      expect(plan.subtasks.find((s: any) => s.id === 6).qa_flagged).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });

  // Regression: task add-per-constraint-soft-score-attributio's third
  // retry. qa_feedback.md named an issue the synthetic 9999 subtask fully
  // resolved, but subtask 15 — never named by QA, not a dependent of
  // anything 9999 touched — remained incomplete for its own unrelated
  // reason. Cleanup used to be gated on the ENTIRE plan being complete, so
  // qa_feedback.md never got deleted; every subsequent pass kept finding
  // zero real qa_flagged subtasks and re-synthesizing a fresh 9999 from the
  // same stale feedback, forever, while subtask 15 never got a normal
  // session. The task failed after 3 such passes with "Implement
  // completeness gate" — burning the whole budget on a QA rework that had
  // already succeeded on pass 1.
  it('clears qa_feedback.md once the QA-targeted subtask completes, even though an unrelated subtask remains incomplete', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        {
          id: 1, title: 'Unrelated sweep', description: 'Never named by QA', files: [],
          files_to_create: ['out/never-created.txt'], acceptance_criteria: ['Sweep exists'],
        },
      ],
    }));
    writeFileSync(join(project.taskDir, 'qa_feedback.md'), 'Something unrelated to subtask 1 failed');

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'rev-list') return '0\n';
        if (args[0] === 'diff') return ''; // 9999's rework makes no code changes here
      }
      return '';
    });

    mockCreateSession.mockResolvedValue('sess-qa-target-done');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      // Subtask 1 was never named by qa_feedback.md, so criterion-matching
      // flags nothing real and synthesizes 9999 instead — the only session
      // dispatched this pass.
      expect(mockSendMessage.mock.calls[0][1]).toContain('QA Rework');

      fireEvent('event', { sessionId: 'sess-qa-target-done', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      expect(existsSync(join(project.taskDir, 'qa_feedback.md'))).toBe(false);

      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBeFalsy();
      expect(plan.subtasks.find((s: any) => s.id === 9999)?.qa_flagged).toBeFalsy();

      const log = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
      expect(log).toContain('[QA-REWORK] Targeted subtask(s) 9999 complete — clearing QA feedback');

      // Retried for subtask 1's own normal (non-QA) rework — not failed outright.
      expect(pipeline.phase).toBe('implement');
      expect(executeSpy).toHaveBeenCalled();
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

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[], options?: { cwd?: string }) => {
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
        // Subtask 2's isolated worktree session actually edits+commits its
        // assigned file — an empty diff now trips the no-op-subtask
        // rejection instead of completing. Subtask 1 schedules a wakeup
        // instead of committing anything, so its diff staying empty is
        // correct and doesn't affect completion (wakeupDetected forces
        // skipCompletion regardless of the scope/no-op check's verdict).
        if (args[0] === 'diff') return options?.cwd?.includes('st2') ? 'src/fix.ts\n' : '';
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

  // Regression coverage for a real production failure: the pre-cherry-pick
  // "auto-commit stray changes in the main worktree" check used a raw
  // execFileSync('git', ['status', '--porcelain'], { cwd: pipeline.worktreePath })
  // instead of deps.execGitCapture. The main worktree is routinely
  // container-patched while a pipeline run is active, and a raw host-side
  // git call against a container-patched worktree fails outright — a
  // failure this check silently swallowed (logged, then "proceeding with
  // cherry-pick" regardless). With the check never actually running, stray
  // uncommitted changes were left in place, and the REAL cherry-pick that
  // followed failed instead with "local changes would be overwritten by
  // merge" — a symptom that reads as an unrelated problem.
  //
  // Proving this precisely requires distinguishing "went through
  // deps.execGitCapture" from "shelled out directly" — which integrateGroup
  // is exported to allow (matching tryCherryPickWithRecovery's existing
  // @internal-for-tests pattern), sidestepping the need to simulate a full
  // container-mode routing path through the real Orchestrator just to prove
  // which of two indistinguishable-in-non-container-mode call styles fired.
  it('auto-commits stray uncommitted changes in the main worktree via execGitCapture, not a raw shell-out', async () => {
    const execGitCapture = vi.fn((args: string[]) => {
      if (args[0] === 'status') return ' M stray-file.txt\n';
      return '';
    });
    const execGit = vi.fn();
    const deps = {
      execGit,
      execGitCapture,
      projectRoot: project.root,
      sessionOpts: vi.fn() as any,
    } as unknown as ImplementDeps;

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const subtaskWorktrees = new Map<number, string>([[1, join(project.root, 'worktrees', 'test-task-st1')]]);
    await integrateGroup(
      pipeline, deps,
      [{ id: 1, title: 'x', description: 'x', files: [], acceptance_criteria: [], depends_on: [] }],
      [{ status: 'fulfilled', value: undefined }],
      new Set(), subtaskWorktrees, join(project.root, 'output.log'),
    );

    // The status check must go through execGitCapture (container-aware) —
    // never a raw execFileSync/execGit call for this read.
    expect(execGitCapture).toHaveBeenCalledWith(['status', '--porcelain'], pipeline.worktreePath);

    // A dirty status must result in an auto-commit via execGit (also
    // container-aware) before cherry-picking proceeds.
    expect(execGit).toHaveBeenCalledWith(['add', '-A', '--', '.', ':!.teamai'], pipeline.worktreePath);
    expect(execGit).toHaveBeenCalledWith(['commit', '-m', 'chore: auto-save worktree state before cherry-pick'], pipeline.worktreePath);
  });

  // Regression coverage for a real production failure (task 585a32e0, found
  // by QA's own forensic trace): the auto-commit safety net above only ever
  // covered the MAIN worktree. A per-subtask ISOLATED worktree had no
  // equivalent — cherry-pick only moves what's already committed on the
  // subtask's branch, so an edit the coder made but never committed before
  // its session ended was invisible to it, and the unconditional
  // `git worktree remove --force` cleanup afterward destroyed it silently.
  it('auto-commits stray uncommitted changes in a per-subtask ISOLATED worktree before cherry-picking from it', async () => {
    const execGitCapture = vi.fn((args: string[], cwd: string) => {
      if (args[0] === 'status' && cwd.endsWith('-st2')) return ' M MelodyConstraintProvider.scala\n';
      return '';
    });
    const execGit = vi.fn();
    const deps = {
      execGit,
      execGitCapture,
      projectRoot: project.root,
      sessionOpts: vi.fn() as any,
    } as unknown as ImplementDeps;

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const stWorktreePath = join(project.root, 'worktrees', 'test-task-st2');
    const subtaskWorktrees = new Map<number, string>([[2, stWorktreePath]]);
    await integrateGroup(
      pipeline, deps,
      [{ id: 2, title: 'Fix Scaladoc', description: 'x', files: [], acceptance_criteria: [], depends_on: [] }],
      [{ status: 'fulfilled', value: undefined }],
      new Set(), subtaskWorktrees, join(project.root, 'output.log'),
    );

    expect(execGitCapture).toHaveBeenCalledWith(['status', '--porcelain'], stWorktreePath);
    expect(execGit).toHaveBeenCalledWith(['add', '-A', '--', '.', ':!.teamai'], stWorktreePath);
    expect(execGit).toHaveBeenCalledWith(['commit', '-m', 'chore: auto-save subtask 2 state before cherry-pick'], stWorktreePath);
  });

  it('does NOT auto-commit a per-subtask worktree that has a wakeup pending or a scope violation', async () => {
    const execGitCapture = vi.fn(() => ' M some-file.txt\n');
    const execGit = vi.fn();
    const deps = {
      execGit,
      execGitCapture,
      projectRoot: project.root,
      sessionOpts: vi.fn() as any,
    } as unknown as ImplementDeps;

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
      wakeupSubtaskId: 1,
    });

    const st1Worktree = join(project.root, 'worktrees', 'test-task-st1');
    const st2Worktree = join(project.root, 'worktrees', 'test-task-st2');
    const subtaskWorktrees = new Map<number, string>([[1, st1Worktree], [2, st2Worktree]]);
    await integrateGroup(
      pipeline, deps,
      [
        { id: 1, title: 'Wakeup pending', description: 'x', files: [], acceptance_criteria: [], depends_on: [] },
        { id: 2, title: 'Scope violated', description: 'x', files: [], acceptance_criteria: [], depends_on: [] },
      ],
      [{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }],
      new Set([2]), subtaskWorktrees, join(project.root, 'output.log'),
    );

    expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(['commit']), st1Worktree);
    expect(execGit).not.toHaveBeenCalledWith(expect.arrayContaining(['commit']), st2Worktree);
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

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[], options?: { cwd?: string }) => {
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
        // Subtask 1's isolated worktree session actually edits+commits its
        // assigned file — an empty diff now trips the no-op-subtask
        // rejection instead of completing. Subtask 2 has no files_to_create
        // deliverable on disk either way (that's the actual scenario under
        // test), and its declared files_to_create exempts it from this
        // no-op check regardless of what diff its own session shows.
        if (args[0] === 'diff') return options?.cwd?.includes('st1') ? 'scripts/sweep.py\n' : '';
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

  it('resets wakeupAttemptCount to 1 instead of tripping the circuit breaker when the relaunch uses a materially different command', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{ id: 1, title: 'Run benchmark', description: 'Execute benchmark', files: ['src/bench.ts'], acceptance_criteria: ['Benchmark completes'] }],
    }));

    mockCreateSession.mockResolvedValue('sess-wakeup-progress');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    // Same starting point as the circuit-breaker test above (attempt 2, about
    // to write a 3rd wakeup file) — but this time the engineer diagnosed and
    // fixed a real blocker (a different background_command), which should
    // reset the budget instead of tripping the cap.
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
      wakeupSubtaskId: 1, wakeupAttemptCount: 2, wakeupArtifact: 'results/bench.json', wakeupCommand: 'npm run benchmark',
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      // Engineer relaunches under a DIFFERENT command after fixing a blocker.
      writeFileSync(join(project.taskDir, 'subtask_wakeup.json'), JSON.stringify({
        subtask_id: 1, wakeup_at: '2026-07-05T00:00:00Z',
        background_command: 'npm run benchmark -- --isolated-checkout', expected_artifact: 'results/bench.json',
      }));

      fireEvent('event', { sessionId: 'sess-wakeup-progress', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      // Reset (not tripped) — the task keeps running with a fresh budget.
      expect(pipeline.wakeupAttemptCount).toBe(1);
      expect(pipeline.phase).not.toBe('failed');
      expect(existsSync(join(project.taskDir, 'qa_report.json'))).toBe(false);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('still increments wakeupAttemptCount normally when the relaunch reuses the same command (no progress)', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{ id: 1, title: 'Run benchmark', description: 'Execute benchmark', files: ['src/bench.ts'], acceptance_criteria: ['Benchmark completes'] }],
    }));

    mockCreateSession.mockResolvedValue('sess-wakeup-same-command');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
      wakeupSubtaskId: 1, wakeupAttemptCount: 1, wakeupArtifact: 'results/bench.json', wakeupCommand: 'npm run benchmark',
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      writeFileSync(join(project.taskDir, 'subtask_wakeup.json'), JSON.stringify({
        subtask_id: 1, wakeup_at: '2026-07-05T00:00:00Z',
        background_command: 'npm run benchmark', expected_artifact: 'results/bench.json',
      }));

      fireEvent('event', { sessionId: 'sess-wakeup-same-command', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      expect(pipeline.wakeupAttemptCount).toBe(2);
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
    title: 'test task',
    description: 'test task',
    phase: 'implement',
    specPath: '/test/spec',
    worktreePath: '/test/wt',
    branch: 'feat/test-task',
    qaAttempt: 0,
    maxQaAttempts: 3,
    specRevision: 1,
    qaRevision: 0,
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
      writeCompletionSummary: vi.fn(),
      getPipelineConfig: vi.fn(() => ({ maxQaAttempts: 3, parallelSubtasks: true, maxImplementRetries: 3, maxStallRecoveries: 3, idleStallMinutes: 15, toolStallMinutes: 30 })),
      phaseHeader: vi.fn(),
      planWriteLock: { current: Promise.resolve() },
      scheduleWakeup: vi.fn(),
      ...overrides,
    };
  }

  function makeImplPipeline(overrides: Record<string, any> = {}): ImplementPipeline {
    return {
      taskId: project.taskId,
      title: 'infra test',
      description: 'infra test',
      phase: 'implement',
      specPath: project.taskDir,
      worktreePath: join(project.root, 'worktrees', 'infra-test'),
      branch: 'feat/infra-test',
      qaAttempt: 0,
      maxQaAttempts: 3,
      specRevision: 1,
    qaRevision: 0,
      ...overrides,
    };
  }

  it('falls through to hard-fail when infra error detected but not in container mode', async () => {
    const deps = makeDeps();
    deps.execGit = vi.fn()
      .mockImplementationOnce(() => { throw new Error('fatal: not a git repository: (null)'); });

    // checkCherryPickInProgress → not in progress (no CHERRY_PICK_HEAD).
    // Goes through deps.execGitCapture (container-aware), not raw execFileSync.
    deps.execGitCapture = vi.fn(() => { throw new Error('not found'); });
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

    // CHERRY_PICK_HEAD exists → infra path guard "!checkCherryPickInProgress" is false.
    // Goes through deps.execGitCapture (container-aware), not raw execFileSync.
    deps.execGitCapture = vi.fn(() => 'abc123\n');
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
    deps.execGitCapture = vi.fn(() => { throw new Error('not found'); });
    mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });
    resolveCompletion!();
    const result = await resultPromise;
    expect(result).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  repairStuckCherryPick — clean up a cherry-pick left in progress on the
//  main worktree by a previous, interrupted implement session
// ═══════════════════════════════════════════════════════════════════════

describe('repairStuckCherryPick', () => {
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
      writeCompletionSummary: vi.fn(),
      getPipelineConfig: vi.fn(() => ({ maxQaAttempts: 3, parallelSubtasks: true, maxImplementRetries: 3, maxStallRecoveries: 3, idleStallMinutes: 15, toolStallMinutes: 30 })),
      phaseHeader: vi.fn(),
      planWriteLock: { current: Promise.resolve() },
      scheduleWakeup: vi.fn(),
      ...overrides,
    };
  }

  function makeImplPipeline(overrides: Record<string, any> = {}): ImplementPipeline {
    return {
      taskId: project.taskId,
      title: 'cherry-pick repair test',
      description: 'cherry-pick repair test',
      phase: 'implement',
      specPath: project.taskDir,
      worktreePath: join(project.root, 'worktrees', 'cherry-pick-repair-test'),
      branch: 'feat/cherry-pick-repair-test',
      qaAttempt: 0,
      maxQaAttempts: 3,
      specRevision: 1,
      qaRevision: 0,
      ...overrides,
    };
  }

  it('is a no-op when no cherry-pick is in progress', async () => {
    const deps = makeDeps({ execGitCapture: vi.fn(() => { throw new Error('not found'); }) });
    const pipeline = makeImplPipeline();

    await repairStuckCherryPick(pipeline, deps);

    expect(deps.execGit).not.toHaveBeenCalled();
  });

  it('commits pending changes to finish a clean stuck cherry-pick (no conflicts)', async () => {
    // rev-parse CHERRY_PICK_HEAD succeeds (in progress); diff --diff-filter=U
    // returns nothing (no conflicts); status --porcelain shows the pending edit.
    const execGitCapture = vi.fn()
      .mockImplementationOnce(() => 'abc123\n')        // rev-parse CHERRY_PICK_HEAD
      .mockImplementationOnce(() => '')                 // diff --diff-filter=U
      .mockImplementationOnce(() => ' M src/Foo.scala\n'); // status --porcelain
    const deps = makeDeps({ execGitCapture });
    const pipeline = makeImplPipeline();

    await repairStuckCherryPick(pipeline, deps);

    expect(deps.execGit).toHaveBeenCalledWith(['add', '-A', '--', '.', ':!.teamai'], pipeline.worktreePath);
    expect(deps.execGit).toHaveBeenCalledWith(
      ['commit', '-m', 'chore: finish cherry-pick left in progress by an interrupted session'],
      pipeline.worktreePath,
    );
    // Never aborts a clean, preservable cherry-pick — that would discard
    // the interrupted session's real (otherwise unrecoverable) work.
    expect(deps.execGit).not.toHaveBeenCalledWith(['cherry-pick', '--abort'], pipeline.worktreePath);
  });

  it('aborts a stuck cherry-pick left mid unresolved conflict', async () => {
    const execGitCapture = vi.fn()
      .mockImplementationOnce(() => 'abc123\n')          // rev-parse CHERRY_PICK_HEAD
      .mockImplementationOnce(() => 'src/Foo.scala\n');  // diff --diff-filter=U (still conflicted)
    const deps = makeDeps({ execGitCapture });
    const pipeline = makeImplPipeline();

    await repairStuckCherryPick(pipeline, deps);

    expect(deps.execGit).toHaveBeenCalledWith(['cherry-pick', '--abort'], pipeline.worktreePath);
    // Never commits conflict-marker content as if it were resolved.
    expect(deps.execGit).not.toHaveBeenCalledWith(
      expect.arrayContaining(['commit']),
      expect.anything(),
    );
  });

  it('aborts to clear leftover state when CHERRY_PICK_HEAD is set but nothing is pending', async () => {
    const execGitCapture = vi.fn()
      .mockImplementationOnce(() => 'abc123\n') // rev-parse CHERRY_PICK_HEAD
      .mockImplementationOnce(() => '')          // diff --diff-filter=U
      .mockImplementationOnce(() => '');         // status --porcelain (nothing pending)
    const deps = makeDeps({ execGitCapture });
    const pipeline = makeImplPipeline();

    await repairStuckCherryPick(pipeline, deps);

    expect(deps.execGit).toHaveBeenCalledWith(['cherry-pick', '--abort'], pipeline.worktreePath);
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
      writeCompletionSummary: vi.fn(),
      getPipelineConfig: vi.fn(() => ({ maxQaAttempts: 3, parallelSubtasks: true, maxImplementRetries: 3, maxStallRecoveries: 3, idleStallMinutes: 15, toolStallMinutes: 30 })),
      phaseHeader: vi.fn(),
      planWriteLock: { current: Promise.resolve() },
      scheduleWakeup: vi.fn(),
      ...overrides,
    };
  }

  function makeImplPipeline(overrides: Record<string, any> = {}): ImplementPipeline {
    return {
      taskId: project.taskId,
      title: 'recover test',
      description: 'recover test',
      phase: 'implement',
      specPath: project.taskDir,
      worktreePath: join(project.root, 'worktrees', 'recover-test'),
      branch: 'feat/recover-test',
      qaAttempt: 0,
      maxQaAttempts: 3,
      specRevision: 1,
    qaRevision: 0,
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
//  Harden per-subtask branch recreation — verify branch deletion before -b
// ═══════════════════════════════════════════════════════════════════════
// When a prior run left a stale per-subtask branch that can't be deleted
// (the worktree removal silently failed due to a file lock), the `-b` flag
// in `git worktree add -b <stBranch>` crashes with "a branch named X
// already exists". The fix verifies the branch is gone after `git branch -D`
// and falls back to checking out the existing branch (no `-b`) when deletion
// didn't take.

describe('runImplement — per-subtask branch recreation fallback when deletion fails', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    // Ensure container mode stays disabled for this test path.
    const { readContainerConfig, containerManager } = await import('../../src/lib/container-manager');
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });
    vi.mocked(containerManager.ensureContainer).mockResolvedValue({
      containerId: 'test-container', remoteWorkspaceFolder: '/workspaces/test',
    });

    // rev-parse --verify stBranch:
    //   odd calls → throw (branch doesn't exist — _recoverStBranchCommits returns recovered:true)
    //   even calls → return hash (branch still exists — verification after branch -D catches it)
    let revParseCount = 0;
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'rev-parse' && args[1] === '--verify' && args[2] === 'CHERRY_PICK_HEAD') {
          throw new Error('fatal: needed a single revision');
        }
        if (args[0] === 'rev-parse' && args[1] === '--verify') {
          revParseCount++;
          if (revParseCount % 2 === 1) throw new Error('fatal: Needed a single revision');
          return 'abc123\n';
        }
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'branch') return '';
        if (args[0] === 'worktree') return '';
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull'
            || args[0] === 'rebase' || args[0] === 'cherry-pick') return '';
        if (args[0] === 'log') return '';
        if (args[0] === 'status') return '';
        if (args[0] === 'add') return '';
        if (args[0] === 'commit') return '';
      }
      return '';
    });

    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Fix A', description: 'Fix module A', files: ['src/a.ts'], acceptance_criteria: ['A works'], parallel_group: 1 },
        { id: 2, title: 'Fix B', description: 'Fix module B', files: ['src/b.ts'], acceptance_criteria: ['B works'], parallel_group: 1 },
      ],
    }));
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('falls back to existing-branch checkout when branch deletion silently fails (revert-then-restore proof)', async () => {
    // Simulate: prior run created per-subtask branches/wortrees, was
    // interrupted, and the worktree removal on resume can't fully clean up
    // (file lock). git branch -D is swallowed by best-effort catch, and
    // without the verification step, `worktree add -b` crashes.
    mockCreateSession
      .mockResolvedValueOnce('sess-br-st1')
      .mockResolvedValueOnce('sess-br-st2');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalledTimes(2); });

      fireEvent('event', { sessionId: 'sess-br-st1', event: { type: 'result' } });
      fireEvent('event', { sessionId: 'sess-br-st2', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // Must not crash — the fix falls back to checking out the existing
      // branch rather than throwing on "a branch named X already exists".
      expect(pipeline.phase).not.toBe('failed');

      // The worktree-add calls must use the fallback path (no -b) for both subtasks.
      const worktreeAddCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'git' && Array.isArray(call[1]) && call[1][0] === 'worktree' && call[1][1] === 'add',
      );
      // There should be two per-subtask worktree-add calls in the st-worktree paths,
      // neither with -b.
      const stWorktreeAdds = worktreeAddCalls.filter(
        (c: any[]) => typeof c[1][2] === 'string' && c[1][2].includes('-st'),
      );
      expect(stWorktreeAdds.length).toBe(2);
      for (const call of stWorktreeAdds) {
        expect(call[1]).not.toContain('-b');
        // Should be: ['worktree', 'add', stWorktreePath, stBranch]
        expect(call[1][2]).toContain('-st');
        expect(call[1][3]).toContain('-st');
      }

      // The fallback log message must appear — distinctly worded from the
      // "branch preserved by recovery decision" case (canRecreate === false).
      const logContent = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
      expect(logContent).toContain('still exists after deletion attempt');
      expect(logContent).toContain('worktree removal likely incomplete');

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('logs the failure instead of silently swallowing when worktree removal fails', async () => {
    mockCreateSession
      .mockResolvedValueOnce('sess-log-st1')
      .mockResolvedValueOnce('sess-log-st2');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    // Wrap the beforeEach mock so `git worktree remove --force` throws (a file
    // lock), but every other git call behaves as before.
    const baseImpl = mockExecFileSync.getMockImplementation() as ((cmd: string, args?: string[]) => string) | undefined;
    mockExecFileSync.mockImplementation((cmd: string, args?: string[]) => {
      if (cmd === 'git' && Array.isArray(args) && args[0] === 'worktree' && args[1] === 'remove') {
        throw new Error('fatal: cannot remove worktree (file locked)');
      }
      return baseImpl ? baseImpl(cmd, args) : '';
    });

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalledTimes(2); });

      fireEvent('event', { sessionId: 'sess-log-st1', event: { type: 'result' } });
      fireEvent('event', { sessionId: 'sess-log-st2', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // The removal failure must be visible in the task log, not swallowed.
      const logContent = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
      expect(logContent).toContain('Failed to remove per-subtask worktree');

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('always clears the git-level worktree registration by bare name, even when the host directory was never created (container-patched registration)', async () => {
    // In this mocked harness no real `git worktree add` ever creates a host
    // directory, so existsSync(stWorktreePath) is false throughout — the
    // same state a container-patched worktree registration produces for
    // real (its gitdir points to a container-only path, so nothing is ever
    // visible on the host). The registration cleanup must not depend on
    // the host directory existing, or a stale registration for a branch
    // like this one is never cleared and every retry keeps colliding with
    // it (the exact failure this test guards against).
    mockCreateSession
      .mockResolvedValueOnce('sess-reg-st1')
      .mockResolvedValueOnce('sess-reg-st2');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalledTimes(2); });

      fireEvent('event', { sessionId: 'sess-reg-st1', event: { type: 'result' } });
      fireEvent('event', { sessionId: 'sess-reg-st2', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);

      // removeStaleWorktreeRegistration resolves to the bare worktree name
      // (not the full host path) — a container-patched registration's
      // recorded path no longer matches what the host computed, only the
      // basename resolves in that case (verified empirically against a
      // real repo).
      const basenameRemoveCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'git' && Array.isArray(call[1]) &&
          call[1][0] === 'worktree' && call[1][1] === 'remove' && call[1][2] === '--force' &&
          typeof call[1][3] === 'string' && !call[1][3].includes('\\') && !call[1][3].includes('/') &&
          call[1][3].includes('-st'),
      );
      expect(basenameRemoveCalls.some((c: any[]) => c[1][3] === 'test-task-st1')).toBe(true);
      expect(basenameRemoveCalls.some((c: any[]) => c[1][3] === 'test-task-st2')).toBe(true);

      await promise;
    } finally {
      executeSpy.mockRestore();
    }
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

// ═══════════════════════════════════════════════════════════════════════════
//  persistCompletedSubtasks — plan.json checkpoint + subtask-progress emit
// ═══════════════════════════════════════════════════════════════════════════

describe('persistCompletedSubtasks', () => {
  let project: ReturnType<typeof setupProject>;

  beforeEach(() => {
    vi.clearAllMocks();
    project = setupProject();
  });

  afterEach(() => {
    project.clean();
  });

  it('writes completed: true to plan.json and emits subtask-progress', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Already done', description: '', files: [], acceptance_criteria: [], completed: true },
        { id: 2, title: 'Just finished', description: '', files: [], acceptance_criteria: [] },
      ],
    }));

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const deps = {
      planWriteLock: { current: Promise.resolve() },
      projectRoot: project.root,
    } as unknown as ImplementDeps;

    persistCompletedSubtasks(pipeline, deps, [2]);

    // The write is queued on the plan-write lock — await it before asserting.
    await deps.planWriteLock.current;

    const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
    expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBe(true);
    expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(true);

    // The helper always emits subtask-progress (the emitProgress flag was
    // removed along with the now-redundant group-loop fallback), so the
    // kanban counter updates live with the freshly-persisted counts.
    expect(mockEmit).toHaveBeenCalledWith('subtask-progress', expect.objectContaining({
      taskId: project.taskId,
      completed: 2,
      total: 2,
      projectRoot: project.root,
    }));
  });

  it('does not throw or emit when plan.json is missing (best-effort)', async () => {
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const deps = {
      planWriteLock: { current: Promise.resolve() },
      projectRoot: project.root,
    } as unknown as ImplementDeps;

    // No plan.json written — the helper must silently no-op, not throw or emit.
    expect(() => persistCompletedSubtasks(pipeline, deps, [1])).not.toThrow();
    await deps.planWriteLock.current;
    expect(mockEmit).not.toHaveBeenCalled();
  });

  it('warns (does not throw) when the checkpoint write fails', async () => {
    // Malformed plan.json → the JSON.parse inside the checkpoint throws, which
    // previously was swallowed silently.
    writeFileSync(join(project.taskDir, 'plan.json'), '{ not valid json');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement', qaAttempt: 0, worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const deps = {
      planWriteLock: { current: Promise.resolve() },
      projectRoot: project.root,
    } as unknown as ImplementDeps;

    expect(() => persistCompletedSubtasks(pipeline, deps, [1])).not.toThrow();
    await deps.planWriteLock.current;

    expect(mockWarn).toHaveBeenCalledWith(
      'implement',
      expect.stringContaining('Failed to persist completed subtasks'),
      expect.anything(),
    );
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  reconcileSubtaskCompletionFromDeliverables — QA-fallback completion sync
// ═══════════════════════════════════════════════════════════════════════
// Regression coverage for task detect-mechanical-periodic-melodic-loops: the
// QA-fallback synthetic subtask (id 9999) fixed subtask 5's deliverables
// without subtask 5 itself ever running, so subtask 5's `completed` flag
// stayed false forever — the implement-completeness gate then failed the
// task no matter how many correct 9999 rework attempts the coder made, and
// subtask 6 (depends_on 5, never named in qa_feedback.md) was permanently
// unreachable.

describe('reconcileSubtaskCompletionFromDeliverables', () => {
  let project: ReturnType<typeof setupProject>;
  let worktreePath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    project = setupProject();
    worktreePath = join(project.root, 'worktrees', 'test-task');
    mkdirSync(worktreePath, { recursive: true });
  });

  afterEach(() => {
    project.clean();
  });

  it('marks a subtask completed when its declared files_to_create all exist, even though it never ran', () => {
    mkdirSync(join(worktreePath, 'scripts', 'sweep_logs'), { recursive: true });
    writeFileSync(join(worktreePath, 'scripts', 'sweep_logs', 'a.log'), 'x');
    writeFileSync(join(worktreePath, 'scripts', 'sweep_logs', 'b.log'), 'x');

    const subtasks = [
      {
        id: 5, title: 'Run sweep', description: '', files: [], acceptance_criteria: [],
        files_to_create: ['scripts/sweep_logs/a.log', 'scripts/sweep_logs/b.log'],
        completed: false,
      },
    ] as any[];

    const changed = reconcileSubtaskCompletionFromDeliverables(subtasks, worktreePath, project.taskDir);

    expect(changed).toBe(true);
    expect(subtasks[0].completed).toBe(true);
  });

  it('leaves a subtask incomplete when only some of its files_to_create exist', () => {
    mkdirSync(join(worktreePath, 'scripts', 'sweep_logs'), { recursive: true });
    writeFileSync(join(worktreePath, 'scripts', 'sweep_logs', 'a.log'), 'x');
    // b.log deliberately missing — sweep still in flight.

    const subtasks = [
      {
        id: 5, title: 'Run sweep', description: '', files: [], acceptance_criteria: [],
        files_to_create: ['scripts/sweep_logs/a.log', 'scripts/sweep_logs/b.log'],
        completed: false,
      },
    ] as any[];

    const changed = reconcileSubtaskCompletionFromDeliverables(subtasks, worktreePath, project.taskDir);

    expect(changed).toBe(false);
    expect(subtasks[0].completed).toBeFalsy();
  });

  it('flags a not-yet-complete dependent whose depends_on just got satisfied by reconciliation', () => {
    writeFileSync(join(worktreePath, 'evidence.log'), 'x');

    const subtasks = [
      {
        id: 5, title: 'Run sweep', description: '', files: [], acceptance_criteria: [],
        files_to_create: ['evidence.log'], completed: false,
      },
      {
        id: 6, title: 'Docs entry', description: '', files: ['docs/x.md'], acceptance_criteria: [],
        depends_on: [5], completed: false,
      },
    ] as any[];

    const changed = reconcileSubtaskCompletionFromDeliverables(subtasks, worktreePath, project.taskDir);

    expect(changed).toBe(true);
    expect(subtasks[0].completed).toBe(true);
    expect(subtasks[1].completed).toBeFalsy();
    expect(subtasks[1].qa_flagged).toBe(true);
  });

  it('does not flag a dependent whose OTHER dependencies are still incomplete', () => {
    writeFileSync(join(worktreePath, 'evidence.log'), 'x');

    const subtasks = [
      { id: 4, title: 'Other prereq', description: '', files: [], acceptance_criteria: [], completed: false },
      {
        id: 5, title: 'Run sweep', description: '', files: [], acceptance_criteria: [],
        files_to_create: ['evidence.log'], completed: false,
      },
      {
        id: 6, title: 'Docs entry', description: '', files: ['docs/x.md'], acceptance_criteria: [],
        depends_on: [4, 5], completed: false,
      },
    ] as any[];

    reconcileSubtaskCompletionFromDeliverables(subtasks, worktreePath, project.taskDir);

    expect(subtasks[1].completed).toBe(true);
    expect(subtasks[2].qa_flagged).toBeFalsy();
  });

  it('never marks the synthetic subtask 9999 completed via this path', () => {
    writeFileSync(join(worktreePath, 'evidence.log'), 'x');

    const subtasks = [
      {
        id: 9999, title: 'QA Rework', description: '', files: [], acceptance_criteria: [],
        files_to_create: ['evidence.log'], completed: false,
      },
    ] as any[];

    const changed = reconcileSubtaskCompletionFromDeliverables(subtasks, worktreePath, project.taskDir);

    expect(changed).toBe(false);
    expect(subtasks[0].completed).toBeFalsy();
  });

  it('returns false and touches nothing when every subtask is already completed or has no files_to_create', () => {
    const subtasks = [
      { id: 1, title: 'Done', description: '', files: [], acceptance_criteria: [], completed: true },
      { id: 2, title: 'No deliverable', description: '', files: ['src/a.ts'], acceptance_criteria: [], completed: false },
    ] as any[];

    const changed = reconcileSubtaskCompletionFromDeliverables(subtasks, worktreePath, project.taskDir);

    expect(changed).toBe(false);
  });
});


