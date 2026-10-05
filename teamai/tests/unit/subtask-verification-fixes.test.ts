/**
 * Deterministic orchestrator-side verification for two gaps found on task
 * a-later-demo-task:
 *
 * 1. No-op subtask detection: a coder subtask that declares `files` to edit
 *    (and no `files_to_create`) but commits NO changes at all used to sail
 *    through as `completed: true` — nothing rejected it, since the scope
 *    check only looks for changes OUTSIDE scope, not the absence of any
 *    change. Subtask 1 (CS-1) on that task spawned a research sub-agent,
 *    said "waiting for it", and ended without writing a single line — the
 *    missing fix silently propagated through 14 more subtasks.
 *
 * 2. Explicit `subtask_blocked-st<ID>.json` declaration: a coder session that
 *    has already root-caused a genuine defect and decided retrying is
 *    pointless previously had no deterministic way to say so — it could only
 *    narrate the conclusion in its summary, which nothing reads. The
 *    orchestrator kept re-entering the subtask (burning a wasted session)
 *    until an unrelated circuit breaker eventually caught it anyway.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createTestProject } from '../utils/test-project';
import { createFireEvent, AnyOrch } from '../utils/orchestrator-harness';

const { onHandlers, mockCreateSession, mockSendMessage, mockKillSession, mockEmit } = vi.hoisted(() => ({
  onHandlers: new Map<string, Array<(...args: any[]) => void>>(),
  mockCreateSession: vi.fn(),
  mockSendMessage: vi.fn(),
  mockKillSession: vi.fn(),
  mockEmit: vi.fn(),
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

import { Orchestrator } from '../../src/lib/orchestrator';

const fireEvent = createFireEvent(onHandlers);

function setupProject() {
  const { root, clean } = createTestProject();
  mkdirSync(join(root, '.teamai'), { recursive: true });
  const taskId = randomUUID();
  const taskDir = join(root, '.teamai', 'subtask-verification-test');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    title: 'Subtask Verification Test',
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
    title: 'Subtask Verification Test',
    description: 'a test task',
    phase: 'implement',
    specPath,
    worktreePath: join(specPath, '..', 'wt'),
    branch: 'feat/subtask-verification-test',
    qaAttempt: 0,
    maxQaAttempts: 3,
    specRevision: 1,
    qaRevision: 0,
    ...overrides,
  };
}

describe('runImplement — no-op subtask detection', () => {
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

  it('rejects a subtask whose session committed no changes at all, instead of marking it completed', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1, title: 'Fix Chord.containsPitch', description: 'Pitch-class rewrite',
        files: ['src/main/scala/sample-project/core/Chord.scala'], acceptance_criteria: ['Recognizes altered pitches'],
      }],
    }));

    // The session never touched Chord.scala — git diff comes back empty for
    // everything, simulating a coder that read files, dispatched a research
    // sub-agent, and ended without writing a single line.
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === 'diff') return '';
      if (Array.isArray(args) && args[0] === 'status') return '';
      return 'abc123\n';
    });
    mockCreateSession.mockResolvedValue('sess-noop');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      fireEvent('event', { sessionId: 'sess-noop', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks[0].completed).not.toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('does not reject a subtask that declares files_to_create even if its edit-files diff is empty, as long as the deliverable was committed this session', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1, title: 'Generate report', description: 'Write analysis output',
        files: ['scripts/analyze.py'], files_to_create: ['results/report.txt'],
        acceptance_criteria: ['Report exists'],
      }],
    }));

    // scripts/analyze.py (the edit-scope file) is untouched, but the
    // files_to_create deliverable WAS committed this session — the diff
    // must show it for freshness verification to accept it (see the stale
    // no-op regression test below for the case where it's missing from here).
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === 'diff') return 'results/report.txt\n';
      if (Array.isArray(args) && args[0] === 'status') return '';
      return 'abc123\n';
    });
    mockCreateSession.mockResolvedValue('sess-deliverable-only');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      mkdirSync(join(project.root, 'worktrees', 'test-task', 'results'), { recursive: true });
      writeFileSync(join(project.root, 'worktrees', 'test-task', 'results', 'report.txt'), 'done');

      fireEvent('event', { sessionId: 'sess-deliverable-only', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks[0].completed).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('rejects a files_to_create deliverable that exists but is stale from an earlier round, instead of marking it completed', async () => {
    // Regression test for task a-later-demo-task:
    // subtask 15's five files_to_create had existed on disk since a stale
    // commit from an EARLIER, QA-rejected round. This session's coder only
    // stood up background sweep servers and ended before running them —
    // zero commits, zero new changes — yet the subtask was marked completed
    // anyway, because existsSync alone can't distinguish "freshly produced"
    // from "leftover from three rounds ago, carrying stale evidence QA
    // already rejected."
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 15, title: 'Sweep-level verification', description: 'Gate on a fresh sweep',
        files_to_create: ['results/gate-report.txt'], acceptance_criteria: ['All gates pass'],
        qa_flagged: true, completed: false,
      }],
    }));
    writeFileSync(join(project.taskDir, 'qa_feedback.md'), '# QA Feedback\n\nRe-run the sweep — prior evidence was stale.');

    const worktreeDir = join(project.root, 'worktrees', 'test-task');

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === 'diff') return '';
      if (Array.isArray(args) && args[0] === 'status') return '';
      return 'abc123\n';
    });
    mockCreateSession.mockResolvedValue('sess-stale-deliverable');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      worktreePath: worktreeDir,
      maxImplementRetries: 3,
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      // Deliverable already exists on disk (stale, from a prior round), but
      // this session's diff stays empty: the coder committed nothing new.
      // Written here (after worktree setup, mirroring the sibling "committed
      // this session" test above) so test setup doesn't race the real
      // worktree-preparation step.
      mkdirSync(join(worktreeDir, 'results'), { recursive: true });
      writeFileSync(join(worktreeDir, 'results', 'gate-report.txt'), 'stale evidence from an earlier round');

      fireEvent('event', { sessionId: 'sess-stale-deliverable', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks[0].completed).not.toBe(true);
      // The stale file itself is left untouched — this check only flags completion.
      expect(existsSync(join(worktreeDir, 'results', 'gate-report.txt'))).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('accepts a rework subtask when only the deliverable the QA feedback names was re-committed this session', async () => {
    // QA-rework is scoped to the deliverable QA named; the other declared
    // deliverables stay as committed in an earlier pass. Requiring all of them
    // to change made a correct one-file fix fail verification and burn the cap.
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 4, title: 'Run sweep', description: 'Commit sweep artefacts',
        files_to_create: ['results/sweep.log', 'results/sweep.jsonl'], acceptance_criteria: ['Artefacts exist'],
        qa_flagged: true, completed: false,
      }],
    }));
    writeFileSync(join(project.taskDir, 'qa_feedback.md'), '# QA Feedback\n\nFix the headers in results/sweep.log.');

    const worktreeDir = join(project.root, 'worktrees', 'test-task');

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === 'diff') return 'results/sweep.log\n';
      if (Array.isArray(args) && args[0] === 'status') return '';
      return 'abc123\n';
    });
    mockCreateSession.mockResolvedValue('sess-partial-rework');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      worktreePath: worktreeDir,
      maxImplementRetries: 3,
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      mkdirSync(join(worktreeDir, 'results'), { recursive: true });
      writeFileSync(join(worktreeDir, 'results', 'sweep.log'), 'fixed');
      writeFileSync(join(worktreeDir, 'results', 'sweep.jsonl'), 'unchanged from earlier pass');

      fireEvent('event', { sessionId: 'sess-partial-rework', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks[0].completed).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('does not reject a subtask whose summary explicitly declares a [SKIPPED] deferral', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 1, title: 'File follow-up ticket', description: 'Defer to analyst',
        files: ['src/main/scala/sample-project/core/Chord.scala'], acceptance_criteria: ['Ticket filed'],
      }],
    }));

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === 'diff') return '';
      if (Array.isArray(args) && args[0] === 'status') return '';
      return 'abc123\n';
    });
    mockCreateSession.mockImplementation(async (opts: any) => {
      // Write the coder's own session log with the [SKIPPED] marker before
      // the orchestrator reads it back post-session.
      writeFileSync(opts.logFile ?? join(project.taskDir, 'output-st1.log'),
        'Deferring ticket creation.\n[SKIPPED] Ticket creation is the analyst\'s responsibility.\n');
      return 'sess-skipped';
    });
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      fireEvent('event', { sessionId: 'sess-skipped', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks[0].completed).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });
});

describe('runImplement — explicit subtask_blocked declaration', () => {
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
      if (Array.isArray(args) && (args[0] === 'diff' || args[0] === 'status')) return '';
      return 'abc123\n';
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  it('fails the task immediately when the coder writes subtask_blocked-st<ID>.json, without further retries', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 15, title: 'Sweep-level verification', description: 'Gate on a fresh sweep',
        files_to_create: ['results/gate-report.txt'], acceptance_criteria: ['All gates pass'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-blocked');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const promise = (orch as AnyOrch).runImplement(pipeline);
    await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

    writeFileSync(join(project.taskDir, 'subtask_blocked-st15.json'), JSON.stringify({
      reason: 'Subtask #1 was never actually implemented despite being marked completed.',
      blocking_subtask_id: 1,
    }));
    fireEvent('event', { sessionId: 'sess-blocked', event: { type: 'result' } });
    await vi.advanceTimersByTimeAsync(50);
    await promise;

    expect(pipeline.phase).toBe('failed');
    expect(existsSync(join(project.taskDir, 'subtask_blocked-st15.json'))).toBe(false);

    const report = JSON.parse(readFileSync(join(project.taskDir, 'qa_report.json'), 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('Subtask reported a blocking defect');
    expect(report.criteria[0].notes).toContain('never actually implemented');
    expect(report.criteria[0].notes).toContain('subtask 1');

    // Only one session — no wasted re-entry re-verifying the same conclusion.
    expect(mockCreateSession).toHaveBeenCalledTimes(1);
  });

  it('ignores a blocked file for a different subtask ID', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{
        id: 2, title: 'Unrelated subtask', description: 'x',
        files: ['src/other.ts'], acceptance_criteria: ['Works'],
      }],
    }));

    mockCreateSession.mockResolvedValue('sess-not-blocked');
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      // Stale/unrelated blocked file for a different subtask id — must not
      // affect subtask 2's own processing.
      writeFileSync(join(project.taskDir, 'subtask_blocked-st99.json'), JSON.stringify({ reason: 'unrelated' }));
      mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
        if (Array.isArray(args) && args[0] === 'diff') return 'src/other.ts\n';
        if (Array.isArray(args) && args[0] === 'status') return '';
        return 'abc123\n';
      });

      fireEvent('event', { sessionId: 'sess-not-blocked', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(50);
      await promise;

      expect(pipeline.phase).not.toBe('failed');
      // The unrelated blocked file is left untouched (not this subtask's to consume).
      expect(existsSync(join(project.taskDir, 'subtask_blocked-st99.json'))).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });
});
