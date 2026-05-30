/**
 * Orchestrator robustness guardrail tests.
 * Tests the 5 gaps fixed for pipeline reliability:
 *   Gap 1 — QA verifies remote branch matches worktree (unpushed commits)
 *   Gap 2 — Implement phase mandatory git push
 *   Gap 3 — QA respects locked / manual-override qa_report.json
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createTestProject } from '../utils/test-project';

 
type AnyOrch = any;

// ── Hoisted mocks ──

const { onHandlers, mockCreateSession, mockSendMessage, mockKillSession, mockEmit } = vi.hoisted(() => ({
  onHandlers: new Map<string, Array<(...args: any[]) => void>>(),
  mockCreateSession: vi.fn(),
  mockSendMessage: vi.fn(),
  mockKillSession: vi.fn(),
  mockEmit: vi.fn(),
}));

const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  warn: vi.fn(),
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
    getSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    getStaleSessions: vi.fn(() => []),
    removeStaleSession: vi.fn(),
    getTerminalSessions: vi.fn(() => []),
    killTerminalSession: vi.fn(),
    writeToSession: vi.fn(),
    terminateSession: vi.fn(),
  },
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

/** Fire an event to all registered handlers for the given event type */
function fireEvent(event: string, data: any) {
  const handlers = onHandlers.get(event);
  if (handlers) {
    for (const h of [...handlers]) {
      try { h(data); } catch { /* ignore */ }
    }
  }
}

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

function makePipeline(taskId: string, specPath: string, overrides: Record<string, any> = {}) {
  return {
    taskId,
    description: 'test',
    phase: 'qa-review' as string,
    specPath,
    worktreePath: '/test/wt',
    branch: 'feat/robustness-test',
    qaAttempt: 1,
    maxQaAttempts: 3,
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
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => {
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
    await new Promise(r => setTimeout(r, 20));

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
    await new Promise(r => setTimeout(r, 20));

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
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => {
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
    await new Promise(r => setTimeout(r, 20));

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
    await new Promise(r => setTimeout(r, 20));

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
    await new Promise(r => setTimeout(r, 20));

    // Should proceed with QA normally (first push — no remote to compare against)
    expect(mockCreateSession).toHaveBeenCalled();

    fireEvent('event', { sessionId: 'sess-qa-first-push', event: { type: 'result' } });
    writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS', criteria: [],
    }));
    await promise;
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  Gap 5b — Snapshot qa_report.json before bouncing to implement
// ═══════════════════════════════════════════════════════════════════════

describe('runQaReview — Gap 5b: snapshot qa_report.json on QA FAIL bounce', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => {
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
      await new Promise(r => setTimeout(r, 20));

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
      await new Promise(r => setTimeout(r, 30));

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
    await new Promise(r => setTimeout(r, 20));

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
    await new Promise(r => setTimeout(r, 20));

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
      worktreePath: project.root,
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await new Promise(r => setTimeout(r, 20));

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
      await new Promise(r => setTimeout(r, 30));
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
      worktreePath: project.root,
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await new Promise(r => setTimeout(r, 20));

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
      await new Promise(r => setTimeout(r, 30));
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
      worktreePath: project.root,
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await new Promise(r => setTimeout(r, 20));

      // qa_report.json should NOT have been created
      expect(existsSync(join(project.taskDir, 'qa_report.json'))).toBe(false);
      expect(existsSync(join(project.taskDir, 'qa_report_before_failed.json'))).toBe(false);

      fireEvent('event', { sessionId: 'sess-impl-no-snap', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));
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
      worktreePath: project.root,
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await new Promise(r => setTimeout(r, 20));

      // qa_report.json should still contain the original PASS content (not overwritten)
      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(report.overall).toBe('PASS');
      expect(report.criteria[0].status).toBe('PASS');

      fireEvent('event', { sessionId: 'sess-impl-exists', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));
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
      worktreePath: project.root,
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await new Promise(r => setTimeout(r, 20));

      // The implement subtask should still be started (guard didn't block)
      expect(mockCreateSession).toHaveBeenCalled();

      // The raw snapshot content is restored byte-for-byte — the guard does not
      // validate JSON; it preserves whatever was in the snapshot file.
      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      const restored = readFileSync(reportPath, 'utf-8');
      expect(restored).toBe('not valid json {{{');

      fireEvent('event', { sessionId: 'sess-impl-malformed', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));
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
      worktreePath: project.root,
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await new Promise(r => setTimeout(r, 20));

      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(report.overall).toBe('FAIL');
      expect(report.locked).toBe(true);
      expect(report.reviewedBy).toContain('manual override');
      expect(report.criteria[0].fix_needed).toBe('Add null guards');
      expect(report.additional_issues[0].description).toContain('Memory leak');

      fireEvent('event', { sessionId: 'sess-impl-complex', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));
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
      worktreePath: project.root,
    });

    try {
      // Start QA — it'll create a session, wait for completion
      const qaPromise = (orch as AnyOrch).runQaReview(pipeline);
      await new Promise(r => setTimeout(r, 20));

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
      await new Promise(r => setTimeout(r, 30));

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
      onHandlers.clear(); // prevent stale event handlers from Phase 1 leaking into Phase 2
      mockExecFileSync.mockReturnValue('abc123\n'); // for git push/rev-parse
      mockCreateSession.mockResolvedValue('sess-e2e-impl');

      pipeline.phase = 'implement';
      pipeline.qaAttempt = 1;
      const executeSpy2 = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

      try {
        const implPromise = (orch as AnyOrch).runImplement(pipeline);
        await new Promise(r => setTimeout(r, 20));

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
        await new Promise(r => setTimeout(r, 30));
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
      worktreePath: project.root,
    });

    try {
      const qaPromise = (orch as AnyOrch).runQaReview(pipeline);
      await new Promise(r => setTimeout(r, 20));

      const originalReport = {
        overall: 'FAIL',
        criteria: [{ name: 'Bug', status: 'FAIL', notes: 'Null pointer', fix_needed: 'Add null check' }],
      };
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify(originalReport));

      fireEvent('event', { sessionId: 'sess-e2e-qa2', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

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
      mockExecFileSync.mockReturnValue('abc123\n');
      mockCreateSession.mockResolvedValue('sess-e2e-impl2');

      pipeline.phase = 'implement';
      pipeline.qaAttempt = 1;
      const executeSpy2 = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

      try {
        const implPromise = (orch as AnyOrch).runImplement(pipeline);
        await new Promise(r => setTimeout(r, 20));

        // The existing qa_report.json should be UNCHANGED (not overwritten by snapshot)
        const existing = JSON.parse(readFileSync(reportPath, 'utf-8'));
        expect(existing.overall).toBe('FAIL');
        expect(existing.criteria[0].name).toBe('Bug');
        expect(existing.criteria[0].notes).toBe('Null pointer');

        // The bounce snapshot should still exist
        expect(existsSync(bounceSnapshotPath)).toBe(true);

        fireEvent('event', { sessionId: 'sess-e2e-impl2', event: { type: 'result' } });
        await new Promise(r => setTimeout(r, 30));
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
      worktreePath: project.root,
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
        await new Promise(r => setTimeout(r, 20));

        // qa_report.json restored from Gap 1 bounce snapshot
        expect(existsSync(reportPath)).toBe(true);
        const restored = JSON.parse(readFileSync(reportPath, 'utf-8'));
        expect(restored.criteria[0].name).toBe('Unpushed commits');
        expect(restored.overall).toBe('FAIL');

        fireEvent('event', { sessionId: 'sess-e2e-gap1-impl', event: { type: 'result' } });
        await new Promise(r => setTimeout(r, 30));
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
      worktreePath: project.root,
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    try {
      const implPromise = (orch as AnyOrch).runImplement(pipeline);
      await new Promise(r => setTimeout(r, 20));

      // qa_report.json restored with locked:true preserved
      const reportPath = join(project.taskDir, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(true);
      const restored = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(restored.locked).toBe(true);
      expect(restored.reviewedBy).toContain('manual override');
      expect(restored.criteria[0].name).toBe('UX Review');

      // Complete implement
      fireEvent('event', { sessionId: 'sess-e2e-locked-impl', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));
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
      worktreePath: project.root,
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
});

// ═══════════════════════════════════════════════════════════════════════
//  Gap 2 — Implement phase mandatory git push
// ═══════════════════════════════════════════════════════════════════════

describe('runImplement — Gap 2: mandatory git push before QA', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
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
      worktreePath: project.root,
    });

    try {
      // Start runImplement asynchronously — the implement subtask's waitForCompletion
      // hangs until we fire the result event from outside.
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await new Promise(r => setTimeout(r, 20));

      // The implement subtask should have been started
      expect(mockCreateSession).toHaveBeenCalled();

      // Resolve the implement subtask
      fireEvent('event', { sessionId: 'sess-impl-push', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 50));

      // After implement subtask completes, git push should have been called
      const pushCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[1] && Array.isArray(call[1]) && call[1][0] === 'push',
      );
      expect(pushCalls.length).toBeGreaterThanOrEqual(1);
      expect(pushCalls[0][1]).toContain('--force-with-lease');

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
      worktreePath: project.root,
    });

    const promise = (orch as AnyOrch).runImplement(pipeline);
    await new Promise(r => setTimeout(r, 20));

    // Fire event to resolve the implement subtask
    fireEvent('event', { sessionId: 'sess-impl-pushfail', event: { type: 'result' } });
    await new Promise(r => setTimeout(r, 50));

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
      worktreePath: project.root,
    });

    const promise = (orch as AnyOrch).runImplement(pipeline);
    await new Promise(r => setTimeout(r, 20));

    fireEvent('event', { sessionId: 'sess-impl-divergent', event: { type: 'result' } });
    await new Promise(r => setTimeout(r, 50));

    // Should fail because heads don't match
    expect(pipeline.phase).toBe('failed');

    const reportPath = join(project.taskDir, 'qa_report.json');
    expect(existsSync(reportPath)).toBe(true);

    await promise;
  });
});
