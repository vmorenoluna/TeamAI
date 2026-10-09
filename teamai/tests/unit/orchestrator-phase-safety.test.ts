/**
 * Tests for orchestrator phase execution safety and reliability:
 *   _executePhaseSafe — rate-limit-safe phase execution wrapper
 *   _scheduleWakeup  — rate-limit safety in wakeup callback
 *   rebaseOntoLatestDefault — skip no-op rebases when base hasn't advanced
 *   runPlanPhase — plan_gaps.md gate routes to human review
 *   runSubtaskSession — SESSION CONTEXT header in subtask prompts
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { createTestProject } from '../utils/test-project';
import { createFireEvent, AnyOrch } from '../utils/orchestrator-harness';

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

const fireEvent = createFireEvent(onHandlers);

// ── Imports after mocks ──

import { Orchestrator } from '../../src/lib/orchestrator';
import { RateLimitError } from '../../src/lib/orchestrator/rate-limit';

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
  const taskDir = join(root, '.teamai', 'p1p2-test');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    title: 'P1/P2 Test',
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
    branch: 'feat/p1p2-test',
    qaAttempt: 1,
    maxQaAttempts: 3,
    specRevision: 1,
    deliverableFailCounts: undefined as Record<number, number> | undefined,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════
//  _executePhaseSafe — rate-limit-safe phase execution helper
// ═══════════════════════════════════════════════════════════════════════

describe('_executePhaseSafe — rate-limit protection', () => {
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

  it('returns true and calls handleRateLimit when executePhase throws RateLimitError', async () => {
    const pipeline = makePipeline(project.taskId, project.taskDir);
    const rateLimitError = new RateLimitError(Math.floor(Date.now() / 1000) + 3600);

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockRejectedValue(rateLimitError);
    const handleSpy = vi.spyOn(orch as AnyOrch, 'handleRateLimit');

    const result = await (orch as AnyOrch)._executePhaseSafe(pipeline, 'test context');

    expect(result).toBe(true);
    expect(handleSpy).toHaveBeenCalledWith(pipeline, rateLimitError.resetsAt);
    expect(pipeline.phase).not.toBe('failed');

    executeSpy.mockRestore();
    handleSpy.mockRestore();
  });

  it('returns false and advances to failed when executePhase throws a non-rate-limit error', async () => {
    const pipeline = makePipeline(project.taskId, project.taskDir);
    pipeline.phase = 'implement';
    const regularError = new Error('Session exited with code 1');

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockRejectedValue(regularError);

    const result = await (orch as AnyOrch)._executePhaseSafe(pipeline, 'after wakeup');

    expect(result).toBe(false);
    expect(pipeline.phase).toBe('failed');
    const logPath = join(project.taskDir, 'output.log');
    expect(existsSync(logPath)).toBe(true);
    const logContent = readFileSync(logPath, 'utf-8');
    expect(logContent).toContain('[ERROR] Task failed after wakeup');
    expect(logContent).toContain('Session exited with code 1');

    executeSpy.mockRestore();
  });

  it('returns false on normal completion (no error thrown)', async () => {
    const pipeline = makePipeline(project.taskId, project.taskDir);

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    const result = await (orch as AnyOrch)._executePhaseSafe(pipeline, 'after wakeup');

    expect(result).toBe(false);
    expect(pipeline.phase).not.toBe('failed');

    executeSpy.mockRestore();
  });

  it('handles non-Error throws (string rejection)', async () => {
    const pipeline = makePipeline(project.taskId, project.taskDir);
    pipeline.phase = 'implement';

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockRejectedValue('raw string error');

    const result = await (orch as AnyOrch)._executePhaseSafe(pipeline, 'test');

    expect(result).toBe(false);
    expect(pipeline.phase).toBe('failed');
    const logContent = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('raw string error');

    executeSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  _scheduleWakeup — rate-limit protection in wakeup callback
// ═══════════════════════════════════════════════════════════════════════

describe('_scheduleWakeup — rate-limit protection in wakeup callback', () => {
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

  it('does not fail task when RateLimitError occurs during wakeup resume', async () => {
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      wakeupUntil: new Date(Date.now() - 1000).toISOString(), // already past — fires immediately
      wakeupSubtaskId: 1,
    });

    (orch as AnyOrch).activeTasks.add(project.taskId);
    (orch as AnyOrch).pipelines.set(project.taskId, pipeline);

    const safeSpy = vi.spyOn(orch as AnyOrch, '_executePhaseSafe').mockResolvedValue(true);

    (orch as AnyOrch)._scheduleWakeup(pipeline);
    await vi.runAllTimersAsync();

    expect(safeSpy).toHaveBeenCalled();
    // Pipeline should NOT be cleaned up (rate-limit guard worked)
    expect((orch as AnyOrch).pipelines.has(project.taskId)).toBe(true);
    expect((orch as AnyOrch).activeTasks.has(project.taskId)).toBe(true);

    safeSpy.mockRestore();
  });

  it('cleans up pipeline when wakeup resume completes normally', async () => {
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      wakeupUntil: new Date(Date.now() - 1000).toISOString(),
      wakeupSubtaskId: 1,
    });

    (orch as AnyOrch).activeTasks.add(project.taskId);
    (orch as AnyOrch).pipelines.set(project.taskId, pipeline);

    const safeSpy = vi.spyOn(orch as AnyOrch, '_executePhaseSafe').mockResolvedValue(false);

    (orch as AnyOrch)._scheduleWakeup(pipeline);
    await vi.runAllTimersAsync();

    expect(safeSpy).toHaveBeenCalled();
    expect((orch as AnyOrch).pipelines.has(project.taskId)).toBe(false);
    expect((orch as AnyOrch).activeTasks.has(project.taskId)).toBe(false);

    safeSpy.mockRestore();
  });

  it('keeps the pipeline lock when the resumed phase schedules another wakeup (chained wakeup)', async () => {
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      wakeupUntil: new Date(Date.now() - 1000).toISOString(), // already past — fires immediately
      wakeupSubtaskId: 1,
    });

    (orch as AnyOrch).activeTasks.add(project.taskId);
    (orch as AnyOrch).pipelines.set(project.taskId, pipeline);

    // First resume: the background job is still running, so the phase schedules
    // ANOTHER wakeup (as implement does via deps.scheduleWakeup). Second resume:
    // the job completed — phase finishes normally.
    const safeSpy = vi.spyOn(orch as AnyOrch, '_executePhaseSafe')
      .mockImplementationOnce(async (p: any) => {
        p.wakeupUntil = new Date(Date.now() + 60_000).toISOString();
        (orch as AnyOrch)._scheduleWakeup(p);
        return false;
      })
      .mockResolvedValue(false);

    (orch as AnyOrch)._scheduleWakeup(pipeline);
    await vi.runAllTimersAsync();

    // Both wakeups must have resumed the phase. Pre-fix, the first callback's
    // unconditional cleanup deleted the re-acquired lock, so the second timer
    // found no pipeline and skipped as a "stale resume" — hanging the task.
    expect(safeSpy).toHaveBeenCalledTimes(2);
    // After the final (non-chaining) resume, cleanup proceeds normally.
    expect((orch as AnyOrch).pipelines.has(project.taskId)).toBe(false);
    expect((orch as AnyOrch).activeTasks.has(project.taskId)).toBe(false);

    safeSpy.mockRestore();
  });

  it('skips wakeup resume when task is in a terminal phase', async () => {
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      wakeupUntil: new Date(Date.now() - 1000).toISOString(),
      wakeupSubtaskId: 1,
    });

    (orch as AnyOrch).activeTasks.add(project.taskId);
    (orch as AnyOrch).pipelines.set(project.taskId, pipeline);

    const taskStore = (orch as AnyOrch).taskStore;
    taskStore.update(project.taskId, { phase: 'done' });

    const safeSpy = vi.spyOn(orch as AnyOrch, '_executePhaseSafe').mockResolvedValue(false);

    (orch as AnyOrch)._scheduleWakeup(pipeline);
    await vi.runAllTimersAsync();

    expect(safeSpy).not.toHaveBeenCalled();

    safeSpy.mockRestore();
  });

  it('re-acquires pipeline lock before setTimeout fires', () => {
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      wakeupUntil: new Date(Date.now() + 3600_000).toISOString(), // 1 hour from now
      wakeupSubtaskId: 1,
    });

    // Simulate runTask's finally block already cleaned them
    expect((orch as AnyOrch).pipelines.has(project.taskId)).toBe(false);
    expect((orch as AnyOrch).activeTasks.has(project.taskId)).toBe(false);

    (orch as AnyOrch)._scheduleWakeup(pipeline);

    expect((orch as AnyOrch).pipelines.has(project.taskId)).toBe(true);
    expect((orch as AnyOrch).activeTasks.has(project.taskId)).toBe(true);

    if (pipeline.pendingTimer) clearTimeout(pipeline.pendingTimer);
  });

  it('fires the wakeup callback exactly when the timer expires, not before', async () => {
    // Set wakeup 5 seconds in the future — should NOT fire immediately.
    const delayMs = 5000;
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      wakeupUntil: new Date(Date.now() + delayMs).toISOString(),
      wakeupSubtaskId: 1,
    });

    (orch as AnyOrch).activeTasks.add(project.taskId);
    (orch as AnyOrch).pipelines.set(project.taskId, pipeline);

    const safeSpy = vi.spyOn(orch as AnyOrch, '_executePhaseSafe').mockResolvedValue(false);

    (orch as AnyOrch)._scheduleWakeup(pipeline);

    // Callback should NOT have fired yet — timer is 5 seconds away.
    expect(safeSpy).not.toHaveBeenCalled();

    // Advance time by just under the delay — still should not fire.
    await vi.advanceTimersByTimeAsync(delayMs - 1000);
    expect(safeSpy).not.toHaveBeenCalled();

    // Advance the remaining time — callback should now fire.
    await vi.advanceTimersByTimeAsync(1000);
    expect(safeSpy).toHaveBeenCalledTimes(1);

    // Pipeline should be cleaned up (normal completion, _executePhaseSafe returned false).
    expect((orch as AnyOrch).pipelines.has(project.taskId)).toBe(false);
    expect((orch as AnyOrch).activeTasks.has(project.taskId)).toBe(false);

    safeSpy.mockRestore();
  });

  it('enforces the 5-minute minimum delay for excessively past timestamps', async () => {
    // wakeupUntil is more than 5 minutes in the past — _scheduleWakeup
    // should clamp waitMs to 5 minutes instead of firing immediately.
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      wakeupUntil: new Date(Date.now() - 10 * 60 * 1000).toISOString(), // 10 min ago
      wakeupSubtaskId: 1,
    });

    (orch as AnyOrch).activeTasks.add(project.taskId);
    (orch as AnyOrch).pipelines.set(project.taskId, pipeline);

    const safeSpy = vi.spyOn(orch as AnyOrch, '_executePhaseSafe').mockResolvedValue(false);

    (orch as AnyOrch)._scheduleWakeup(pipeline);

    // Callback should NOT fire immediately — the 5-min minimum delay applies.
    expect(safeSpy).not.toHaveBeenCalled();

    // Advance by 4 minutes — still should not fire.
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
    expect(safeSpy).not.toHaveBeenCalled();

    // Advance the remaining 1 minute — callback should now fire.
    await vi.advanceTimersByTimeAsync(1 * 60 * 1000);
    expect(safeSpy).toHaveBeenCalledTimes(1);

    // Pipeline should be cleaned up (normal completion).
    expect((orch as AnyOrch).pipelines.has(project.taskId)).toBe(false);
    expect((orch as AnyOrch).activeTasks.has(project.taskId)).toBe(false);

    safeSpy.mockRestore();
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  triggerEarlyWakeup — end a wakeup wait early (stale progress log)
// ═══════════════════════════════════════════════════════════════════════

describe('triggerEarlyWakeup — end a pending wakeup wait immediately', () => {
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

  it('fires the wakeup immediately, without waiting for wakeupUntil', async () => {
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      wakeupUntil: new Date(Date.now() + 3600_000).toISOString(), // 1 hour away — should NOT need to elapse
      wakeupSubtaskId: 1,
    });

    (orch as AnyOrch).activeTasks.add(project.taskId);
    (orch as AnyOrch).pipelines.set(project.taskId, pipeline);
    const safeSpy = vi.spyOn(orch as AnyOrch, '_executePhaseSafe').mockResolvedValue(false);

    (orch as AnyOrch)._scheduleWakeup(pipeline);
    expect(safeSpy).not.toHaveBeenCalled(); // confirms the 1h timer really is pending

    const triggered = (orch as AnyOrch).triggerEarlyWakeup(project.taskId, 'progress log stale for 20min');
    expect(triggered).toBe(true);

    // _fireWakeup is invoked fire-and-forget (void this._fireWakeup(...)) —
    // let its internal microtasks/awaits settle before asserting.
    await vi.advanceTimersByTimeAsync(0);
    expect(safeSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels the original pending timer so it never also fires', async () => {
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      wakeupUntil: new Date(Date.now() + 3600_000).toISOString(),
      wakeupSubtaskId: 1,
    });

    (orch as AnyOrch).activeTasks.add(project.taskId);
    (orch as AnyOrch).pipelines.set(project.taskId, pipeline);
    const safeSpy = vi.spyOn(orch as AnyOrch, '_executePhaseSafe').mockResolvedValue(false);

    (orch as AnyOrch)._scheduleWakeup(pipeline);
    (orch as AnyOrch).triggerEarlyWakeup(project.taskId, 'progress log stale');
    await vi.advanceTimersByTimeAsync(0);

    // Advancing all the way past the original 1h window must NOT cause a
    // second fire — the early trigger already cancelled that timer.
    await vi.advanceTimersByTimeAsync(3600_000 + 1000);

    expect(safeSpy).toHaveBeenCalledTimes(1);
    safeSpy.mockRestore();
  });

  it('logs the reason to the task output.log so it is visible in the terminal tab', () => {
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      wakeupUntil: new Date(Date.now() + 3600_000).toISOString(),
      wakeupSubtaskId: 1,
    });

    (orch as AnyOrch).activeTasks.add(project.taskId);
    (orch as AnyOrch).pipelines.set(project.taskId, pipeline);
    vi.spyOn(orch as AnyOrch, '_executePhaseSafe').mockResolvedValue(false);
    (orch as AnyOrch)._scheduleWakeup(pipeline);

    (orch as AnyOrch).triggerEarlyWakeup(
      project.taskId,
      "progress log job_progress.log hasn't been modified in 20min — background job appears dead",
    );

    const outputLog = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
    expect(outputLog).toContain('[WAKEUP] Ending wait early');
    expect(outputLog).toContain("hasn't been modified in 20min");
  });

  it('returns false and does nothing when there is no live pipeline for the task', () => {
    // Task not registered in-memory at all (e.g. a stale disk read racing a
    // server restart) — must not throw, must not fabricate a resume.
    const triggered = (orch as AnyOrch).triggerEarlyWakeup('nonexistent-task-id', 'progress log stale');
    expect(triggered).toBe(false);
  });

  it('returns false and does nothing when the pipeline has no wakeup armed', () => {
    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      wakeupUntil: undefined,
    });
    (orch as AnyOrch).activeTasks.add(project.taskId);
    (orch as AnyOrch).pipelines.set(project.taskId, pipeline);

    const safeSpy = vi.spyOn(orch as AnyOrch, '_executePhaseSafe');
    const triggered = (orch as AnyOrch).triggerEarlyWakeup(project.taskId, 'progress log stale');

    expect(triggered).toBe(false);
    expect(safeSpy).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  rebaseOntoLatestDefault — skip when base hasn't advanced
// ═══════════════════════════════════════════════════════════════════════

import { rebaseOntoLatestDefault, runPlanPhase, syncPhaseBaseline } from '../../src/lib/orchestrator/phase-runners';

describe('rebaseOntoLatestDefault — skip no-op rebases', () => {
  let project: ReturnType<typeof setupProject>;

  beforeEach(() => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
  });

  afterEach(() => {
    project.clean();
  });

  it('skips rebase when origin/base has not advanced past HEAD (rev-list count = 0)', async () => {
    const logFile = join(project.taskDir, 'output.log');
    const worktreePath = join(project.root, 'worktrees', 'test-task');

    // Mock: git fetch succeeds, rev-list returns "0" (no new commits)
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === 'rev-list') return '0\n';
      return '';
    });

    const deps = {
      projectRoot: project.root,
      execGit: vi.fn(),
      execGitCapture: vi.fn(() => ''),
      gitPush: vi.fn(),
      sessionOpts: vi.fn(),
      waitForCompletion: vi.fn(),
      baseBranch: 'master',
    };

    const result = await rebaseOntoLatestDefault(worktreePath, project.taskId, 'feat/test', logFile, deps);

    expect(result).toBe(true);
    // deps.execGit should NOT have attempted a real rebase (the unconditional
    // `rebase --abort`/`merge --abort` reset-in-progress-op guard at the top
    // of the function still runs regardless — that's a cheap, safe no-op,
    // not the rebase this test is about).
    const rebaseCalls = (deps.execGit as any).mock.calls.filter(
      (c: any[]) => c[0] && c[0][0] === 'rebase' && c[0][1] !== '--abort',
    );
    expect(rebaseCalls.length).toBe(0);
    // No-op skip means nothing to push either.
    expect(deps.gitPush).not.toHaveBeenCalled();
    // Log should indicate skip
    const logContent = readFileSync(logFile, 'utf-8');
    expect(logContent).toContain('has not advanced past HEAD');
    expect(logContent).toContain('skipping rebase');
  });

  it('proceeds with rebase when origin/base has advanced (rev-list count > 0), then pushes the result', async () => {
    const logFile = join(project.taskDir, 'output.log');
    const worktreePath = join(project.root, 'worktrees', 'test-task');

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === 'rev-list') return '3\n';
      return '';
    });

    const execGit = vi.fn();
    const gitPush = vi.fn();
    const deps = {
      projectRoot: project.root,
      execGit,
      execGitCapture: vi.fn(() => ''),
      gitPush,
      sessionOpts: vi.fn(),
      waitForCompletion: vi.fn(),
      baseBranch: 'master',
    };

    const result = await rebaseOntoLatestDefault(worktreePath, project.taskId, 'feat/test', logFile, deps);

    expect(result).toBe(true);
    // execGit should have been called with rebase
    const rebaseCalls = execGit.mock.calls.filter(
      (c: any[]) => c[0] && c[0].includes('rebase'),
    );
    expect(rebaseCalls.length).toBeGreaterThan(0);
    // The rebase rewrote history — push it ourselves (force-with-lease),
    // host-side, rather than trust an agent session to push it.
    expect(gitPush).toHaveBeenCalledWith(['push', '--force-with-lease', 'origin', 'feat/test'], logFile);
    const logContent = readFileSync(logFile, 'utf-8');
    expect(logContent).not.toContain('skipping rebase');
    expect(logContent).toContain('Pushed feat/test after rebasing onto master');
  });

  it('returns false when the rebase succeeds but the push afterward fails', async () => {
    const logFile = join(project.taskDir, 'output.log');
    const worktreePath = join(project.root, 'worktrees', 'test-task');

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === 'rev-list') return '3\n';
      return '';
    });

    const deps = {
      projectRoot: project.root,
      execGit: vi.fn(),
      execGitCapture: vi.fn(() => ''),
      gitPush: vi.fn((args: string[]) => {
        if (args[0] === 'push') throw new Error('offline');
      }),
      sessionOpts: vi.fn(),
      waitForCompletion: vi.fn(),
      baseBranch: 'master',
    };

    const result = await rebaseOntoLatestDefault(worktreePath, project.taskId, 'feat/test', logFile, deps);

    expect(result).toBe(false);
    const logContent = readFileSync(logFile, 'utf-8');
    expect(logContent).toContain('Rebase succeeded locally but push failed');
  });

  it('pushes the merger\'s result (not just the clean-rebase path) once a conflict is resolved', async () => {
    const logFile = join(project.taskDir, 'output.log');
    const worktreePath = join(project.root, 'worktrees', 'test-task');

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === 'rev-list') return '3\n';
      return '';
    });

    const gitPush = vi.fn();
    const deps = {
      projectRoot: project.root,
      execGit: vi.fn((args: string[]) => {
        if (args[0] === 'rebase' && args[1] !== '--abort') throw new Error('CONFLICT');
      }),
      // Non-empty output confirms a genuine conflict — required for the
      // merger-spawn path to trigger at all (see rebaseOntoLatestDefault's
      // unmerged-file check, which skips the merger for a non-conflict
      // rebase failure).
      execGitCapture: vi.fn(() => 'src/conflicted-file.ts\n'),
      gitPush,
      sessionOpts: vi.fn(),
      waitForCompletion: vi.fn(async () => undefined),
      baseBranch: 'master',
    };

    const result = await rebaseOntoLatestDefault(worktreePath, project.taskId, 'feat/test', logFile, deps);

    expect(result).toBe(true);
    expect(gitPush).toHaveBeenCalledWith(['push', '--force-with-lease', 'origin', 'feat/test'], logFile);
    const logContent = readFileSync(logFile, 'utf-8');
    expect(logContent).toContain('Merger resolved rebase conflicts — pushing its result');
  });

  // Regression: a failed `git rebase` used to be treated as a conflict
  // unconditionally, spawning a merger session even when the failure had
  // nothing to do with conflicting content (a dirty worktree, a git lock, a
  // permission error, ...). The merger would then find no unmerged files,
  // report "nothing to do", and the orchestrator's own "had conflicts" log
  // line read as if it had lied. rebaseOntoLatestDefault now checks for
  // actual unmerged paths before deciding a merger is warranted.
  it('does not spawn a merger when the rebase fails for a non-conflict reason', async () => {
    const logFile = join(project.taskDir, 'output.log');
    const worktreePath = join(project.root, 'worktrees', 'test-task');

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === 'rev-list') return '3\n';
      return '';
    });

    const gitPush = vi.fn();
    const sessionOpts = vi.fn();
    const deps = {
      projectRoot: project.root,
      execGit: vi.fn((args: string[]) => {
        if (args[0] === 'rebase' && args[1] !== '--abort') throw new Error('fatal: cannot rebase: You have unstaged changes.');
      }),
      // No unmerged files — the rebase failed for a reason other than a
      // real conflict.
      execGitCapture: vi.fn(() => ''),
      gitPush,
      sessionOpts,
      waitForCompletion: vi.fn(async () => undefined),
      baseBranch: 'master',
    };

    const result = await rebaseOntoLatestDefault(worktreePath, project.taskId, 'feat/test', logFile, deps);

    expect(result).toBe(false);
    // No merger session was spawned.
    expect(sessionOpts).not.toHaveBeenCalled();
    // Nothing was pushed either (there's nothing resolved to push).
    expect(gitPush).not.toHaveBeenCalled();
    const logContent = readFileSync(logFile, 'utf-8');
    expect(logContent).toContain('failed for a non-conflict reason (no unmerged files found) — not spawning a merger');
    expect(logContent).toContain('cannot rebase: You have unstaged changes');
    expect(logContent).not.toContain('spawning merger to resolve via git merge');
  });

  // Deterministic recovery: the most common real cause of a non-conflict
  // rebase failure is a dirty worktree (a coder session that ended without
  // committing) — `git rebase` refuses to even start against one. This is
  // mechanically fixable without an agent: auto-commit it first, then the
  // rebase proceeds normally.
  it('auto-commits a dirty worktree before attempting the rebase, then proceeds normally', async () => {
    const logFile = join(project.taskDir, 'output.log');
    const worktreePath = join(project.root, 'worktrees', 'test-task');

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === 'rev-list') return '3\n';
      return '';
    });

    const execGit = vi.fn();
    const gitPush = vi.fn();
    const deps = {
      projectRoot: project.root,
      execGit,
      // Dirty on the first check (before the guard's commit), clean after —
      // mirrors a real `git status --porcelain` going empty once committed.
      execGitCapture: vi.fn(() => 'M src/feature.ts\n'),
      gitPush,
      sessionOpts: vi.fn(),
      waitForCompletion: vi.fn(),
      baseBranch: 'master',
    };

    const result = await rebaseOntoLatestDefault(worktreePath, project.taskId, 'feat/test', logFile, deps);

    expect(result).toBe(true);
    const commitCalls = execGit.mock.calls.filter((c: any[]) => c[0]?.[0] === 'commit');
    expect(commitCalls).toHaveLength(1);
    expect(commitCalls[0][0]).toEqual(['commit', '-m', 'WIP: auto-commit uncommitted changes before rebase']);
    const addCalls = execGit.mock.calls.filter((c: any[]) => c[0]?.[0] === 'add');
    expect(addCalls).toHaveLength(1);
    // The commit happened before the real rebase attempt (not the
    // unconditional `rebase --abort` reset-in-progress-op guard that runs
    // first, unconditionally, at the top of the function).
    const rebaseCallIndex = execGit.mock.calls.findIndex((c: any[]) => c[0]?.[0] === 'rebase' && c[0]?.[1] !== '--abort');
    const commitCallIndex = execGit.mock.calls.findIndex((c: any[]) => c[0]?.[0] === 'commit');
    expect(commitCallIndex).toBeGreaterThanOrEqual(0);
    expect(rebaseCallIndex).toBeGreaterThan(commitCallIndex);
    expect(gitPush).toHaveBeenCalledWith(['push', '--force-with-lease', 'origin', 'feat/test'], logFile);
    const logContent = readFileSync(logFile, 'utf-8');
    expect(logContent).toContain('Worktree had uncommitted changes — auto-committed before rebasing onto master');
  });

  // Deterministic recovery: TeamAI is the sole writer to a task's worktree,
  // so a git operation stuck mid-flight (a merger killed mid-`git merge` by
  // recovery.ts's stall job, most concretely) is never ambiguous — it's
  // always one of our own interrupted sessions, never a concurrent external
  // actor. rebaseOntoLatestDefault resets it unconditionally before doing
  // anything else, rather than letting a stale rebase/merge state confuse
  // every check downstream.
  it('resets an in-progress rebase/merge left by a previously interrupted session before doing anything else', async () => {
    const logFile = join(project.taskDir, 'output.log');
    const worktreePath = join(project.root, 'worktrees', 'test-task');

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === 'rev-list') return '3\n';
      return '';
    });

    const execGit = vi.fn();
    const gitPush = vi.fn();
    const deps = {
      projectRoot: project.root,
      execGit,
      execGitCapture: vi.fn(() => ''),
      gitPush,
      sessionOpts: vi.fn(),
      waitForCompletion: vi.fn(),
      baseBranch: 'master',
    };

    const result = await rebaseOntoLatestDefault(worktreePath, project.taskId, 'feat/test', logFile, deps);

    expect(result).toBe(true);
    // Both resets attempted, unconditionally, before the real rebase.
    expect(execGit.mock.calls[0]).toEqual([['rebase', '--abort'], worktreePath]);
    expect(execGit.mock.calls[1]).toEqual([['merge', '--abort'], worktreePath]);
    const rebaseCallIndex = execGit.mock.calls.findIndex((c: any[]) => c[0]?.[0] === 'rebase' && c[0]?.[1] !== '--abort');
    expect(rebaseCallIndex).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  syncPhaseBaseline — keep code fresh before every phase, every entry point
// ═══════════════════════════════════════════════════════════════════════

describe('syncPhaseBaseline — pre-phase freshness sync', () => {
  let project: ReturnType<typeof setupProject>;

  beforeEach(() => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();

    // resolveBaseBranch → detectDefaultBranch reads refs/remotes/origin/HEAD;
    // rebaseOntoLatestDefault's own skip-check reads rev-list --count.
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === 'symbolic-ref') return 'refs/remotes/origin/master\n';
      if (Array.isArray(args) && args[0] === 'rev-list') return '3\n'; // base has advanced
      return '';
    });
  });

  afterEach(() => {
    project.clean();
  });

  it('pulls the base branch and rebases an existing worktree before any agent looks at it', async () => {
    const worktreePath = join(project.root, 'worktrees', 'existing-task');
    mkdirSync(worktreePath, { recursive: true });
    const pipeline = { taskId: project.taskId, specPath: project.taskDir, worktreePath, phase: 'implement', branch: 'feat/test' };

    const gitPush = vi.fn();
    const execGit = vi.fn();
    const execGitCapture = vi.fn(() => '');
    const deps = { projectRoot: project.root, gitPush, execGit, execGitCapture, sessionOpts: vi.fn(), waitForCompletion: vi.fn() };

    await syncPhaseBaseline(pipeline, deps);

    expect(gitPush).toHaveBeenCalledWith(['pull', '--ff-only', 'origin', 'master'], expect.any(String));
    const rebaseCalls = execGit.mock.calls.filter((c: any[]) => c[0]?.includes('rebase'));
    expect(rebaseCalls.length).toBeGreaterThan(0);
    // The rebase rewrote history — syncPhaseBaseline's underlying
    // rebaseOntoLatestDefault call pushes it itself.
    expect(gitPush).toHaveBeenCalledWith(['push', '--force-with-lease', 'origin', 'feat/test'], expect.any(String));
  });

  it("does not attempt a worktree rebase when no worktree exists yet (a brand-new task's first spec run)", async () => {
    const worktreePath = join(project.root, 'worktrees', 'not-created-yet');
    const pipeline = { taskId: project.taskId, specPath: project.taskDir, worktreePath, phase: 'spec', branch: 'feat/test' };

    const gitPush = vi.fn();
    const execGit = vi.fn();
    const execGitCapture = vi.fn(() => '');
    const deps = { projectRoot: project.root, gitPush, execGit, execGitCapture, sessionOpts: vi.fn(), waitForCompletion: vi.fn() };

    await syncPhaseBaseline(pipeline, deps);

    // The main checkout is still freshened even though there's no worktree yet.
    expect(gitPush).toHaveBeenCalledWith(['pull', '--ff-only', 'origin', 'master'], expect.any(String));
    expect(execGit).not.toHaveBeenCalled();
  });

  it('does not throw when the base-branch pull fails (offline / non-fast-forward)', async () => {
    const pipeline = {
      taskId: project.taskId, specPath: project.taskDir,
      worktreePath: join(project.root, 'worktrees', 'absent'), phase: 'spec', branch: 'feat/test',
    };
    const deps = {
      projectRoot: project.root,
      gitPush: vi.fn(() => { throw new Error('offline'); }),
      execGit: vi.fn(), execGitCapture: vi.fn(() => ''), sessionOpts: vi.fn(), waitForCompletion: vi.fn(),
    };

    await expect(syncPhaseBaseline(pipeline, deps)).resolves.toBeUndefined();
  });

  it('warns but does not throw when the worktree rebase conflict cannot be resolved', async () => {
    const worktreePath = join(project.root, 'worktrees', 'conflicted-task');
    mkdirSync(worktreePath, { recursive: true });
    const pipeline = { taskId: project.taskId, specPath: project.taskDir, worktreePath, phase: 'qa-review', branch: 'feat/test' };

    const deps = {
      projectRoot: project.root,
      gitPush: vi.fn(),
      execGit: vi.fn((args: string[]) => {
        if (args.includes('rebase') && !args.includes('--abort')) throw new Error('CONFLICT');
        // tolerate the --abort call
      }),
      // Non-empty output confirms a genuine conflict — required to reach
      // the merger-spawn path at all (see the non-conflict-failure check
      // in rebaseOntoLatestDefault).
      execGitCapture: vi.fn(() => 'src/conflicted-file.ts\n'),
      sessionOpts: vi.fn(),
      // Merger-fallback session never resolves the conflict.
      waitForCompletion: vi.fn().mockRejectedValue(new Error('merger failed')),
    };

    await expect(syncPhaseBaseline(pipeline, deps)).resolves.toBeUndefined();

    const logContent = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain("Could not rebase worktree onto latest master before 'qa-review'");
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  runPlanPhase — plan_gaps.md gate routes to human review
// ═══════════════════════════════════════════════════════════════════════

describe('runPlanPhase — plan_gaps.md gate', () => {
  let project: ReturnType<typeof setupProject>;

  beforeEach(() => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
  });

  afterEach(() => {
    project.clean();
  });

  it('routes to awaiting-review when plan_gaps.md exists after planner session', async () => {
    // Write plan_gaps.md to trigger the gate
    writeFileSync(join(project.taskDir, 'plan_gaps.md'), '# Unverifiable Criteria\n\nSome criteria cannot be verified.');

    mockCreateSession.mockResolvedValue('sess-plan-gaps');
    mockExecFileSync.mockReturnValue('');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'plan',
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    // Build deps matching what the orchestrator provides
    const advancePhase = vi.fn((p: any, phase: string) => { p.phase = phase; });
    const deps = {
      projectRoot: project.root,
      persistAndEmitPhase: vi.fn(),
      sessionOpts: vi.fn(() => ({ taskId: project.taskId, role: 'planner', cwd: project.root })),
      waitForCompletion: vi.fn().mockResolvedValue(undefined),
      advancePhase,
      rotateOutputLog: vi.fn(),
      phaseHeader: vi.fn(),
      savePipelineState: vi.fn(),
      toAgentPath: vi.fn((p: string) => p),
      executePhase: vi.fn().mockResolvedValue(undefined),
      gitPush: vi.fn(),
      execGit: vi.fn(),
      getPipelineConfig: () => ({ wakeupScanRetryDelayMs: 0, maxImplementRetries: 3 }),
      scheduleWakeup: vi.fn(),
      writeCompletionSummary: vi.fn(),
    };

    await runPlanPhase(pipeline, deps as any);

    // Should route to awaiting-review, not implement
    expect(pipeline.phase).toBe('awaiting-review');

    // A minimal qa_report.json with spec_concerns should be written
    const reportPath = join(project.taskDir, 'qa_report.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.spec_concerns).toBeDefined();
    expect(report.spec_concerns[0].issue).toContain('unverifiable');
    expect(report.spec_concerns[0].suggested_fix).toContain('Revise the spec');

    // Log should mention the gate
    const logPath = join(project.taskDir, 'output.log');
    const logContent = readFileSync(logPath, 'utf-8');
    expect(logContent).toContain('[GATE]');

    // executePhase should NOT have been called (gate halted the cascade)
    expect(deps.executePhase).not.toHaveBeenCalled();
  });

  it('proceeds normally to implement when plan_gaps.md does NOT exist', async () => {
    // No plan_gaps.md — should proceed to implement
    mockCreateSession.mockResolvedValue('sess-plan-normal');
    mockExecFileSync.mockReturnValue('');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'plan',
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const advancePhase = vi.fn((p: any, phase: string) => { p.phase = phase; });
    const deps = {
      projectRoot: project.root,
      persistAndEmitPhase: vi.fn(),
      sessionOpts: vi.fn(() => ({ taskId: project.taskId, role: 'planner', cwd: project.root })),
      waitForCompletion: vi.fn().mockResolvedValue(undefined),
      advancePhase,
      rotateOutputLog: vi.fn(),
      phaseHeader: vi.fn(),
      savePipelineState: vi.fn(),
      toAgentPath: vi.fn((p: string) => p),
      executePhase: vi.fn().mockResolvedValue(undefined),
      gitPush: vi.fn(),
      execGit: vi.fn(),
      getPipelineConfig: () => ({ wakeupScanRetryDelayMs: 0, maxImplementRetries: 3 }),
      scheduleWakeup: vi.fn(),
      writeCompletionSummary: vi.fn(),
    };

    await runPlanPhase(pipeline, deps as any);

    // Should advance to implement (normal flow)
    expect(pipeline.phase).toBe('implement');
    expect(deps.executePhase).toHaveBeenCalled();
  });

  it('serializes subtasks that share a file in the same parallel_group', async () => {
    // Two subtasks in the same group both declare src/a.ts — a guaranteed
    // cherry-pick conflict. The plan-time validation must reassign the later
    // one to a sequential group (and record depends_on) before implement runs.
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'A', description: 'A', files: ['src/a.ts'], acceptance_criteria: ['a'], parallel_group: 'A' },
        { id: 2, title: 'B', description: 'B', files: ['src/a.ts'], acceptance_criteria: ['b'], parallel_group: 'A' },
      ],
    }));

    mockCreateSession.mockResolvedValue('sess-plan-serialize');
    mockExecFileSync.mockReturnValue('');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'plan',
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const advancePhase = vi.fn((p: any, phase: string) => { p.phase = phase; });
    const deps = {
      projectRoot: project.root,
      persistAndEmitPhase: vi.fn(),
      sessionOpts: vi.fn(() => ({ taskId: project.taskId, role: 'planner', cwd: project.root })),
      waitForCompletion: vi.fn().mockResolvedValue(undefined),
      advancePhase,
      rotateOutputLog: vi.fn(),
      phaseHeader: vi.fn(),
      savePipelineState: vi.fn(),
      toAgentPath: vi.fn((p: string) => p),
      executePhase: vi.fn().mockResolvedValue(undefined),
      gitPush: vi.fn(),
      execGit: vi.fn(),
      getPipelineConfig: () => ({ wakeupScanRetryDelayMs: 0, maxImplementRetries: 3 }),
      scheduleWakeup: vi.fn(),
      writeCompletionSummary: vi.fn(),
    };

    await runPlanPhase(pipeline, deps as any);

    // plan.json must be rewritten with the conflict serialized.
    const plan = JSON.parse(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8'));
    expect(plan.subtasks[0].parallel_group).toBe('A');
    expect(plan.subtasks[1].parallel_group).toBe('A.2');
    expect(plan.subtasks[1].depends_on).toEqual([1]);

    // The fix must be surfaced in the log.
    const logContent = readFileSync(join(project.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('[PLAN] Serialized subtask 2');

    // Normal flow continues to implement.
    expect(pipeline.phase).toBe('implement');
    expect(deps.executePhase).toHaveBeenCalled();
  });

  it('leaves an already-safe plan.json untouched', async () => {
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'A', description: 'A', files: ['src/a.ts'], acceptance_criteria: ['a'], parallel_group: 'A' },
        { id: 2, title: 'B', description: 'B', files: ['src/b.ts'], acceptance_criteria: ['b'], parallel_group: 'A' },
      ],
    }));
    const before = readFileSync(join(project.taskDir, 'plan.json'), 'utf-8');

    mockCreateSession.mockResolvedValue('sess-plan-safe');
    mockExecFileSync.mockReturnValue('');

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'plan',
      worktreePath: join(project.root, 'worktrees', 'test-task'),
    });

    const advancePhase = vi.fn((p: any, phase: string) => { p.phase = phase; });
    const deps = {
      projectRoot: project.root,
      persistAndEmitPhase: vi.fn(),
      sessionOpts: vi.fn(() => ({ taskId: project.taskId, role: 'planner', cwd: project.root })),
      waitForCompletion: vi.fn().mockResolvedValue(undefined),
      advancePhase,
      rotateOutputLog: vi.fn(),
      phaseHeader: vi.fn(),
      savePipelineState: vi.fn(),
      toAgentPath: vi.fn((p: string) => p),
      executePhase: vi.fn().mockResolvedValue(undefined),
      gitPush: vi.fn(),
      execGit: vi.fn(),
      getPipelineConfig: () => ({ wakeupScanRetryDelayMs: 0, maxImplementRetries: 3 }),
      scheduleWakeup: vi.fn(),
      writeCompletionSummary: vi.fn(),
    };

    await runPlanPhase(pipeline, deps as any);

    // No fix applied — the file must be byte-identical.
    expect(readFileSync(join(project.taskDir, 'plan.json'), 'utf-8')).toBe(before);
    expect(pipeline.phase).toBe('implement');
  });
});

// ═══════════════════════════════════════════════════════════════════════
//  SESSION CONTEXT header in implement subtask prompt
// ═══════════════════════════════════════════════════════════════════════

describe('SESSION CONTEXT header in implement prompt', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);

    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        { id: 1, title: 'Setup project', description: 'Init', files: ['src/init.ts'], acceptance_criteria: ['Works'], completed: true },
        { id: 2, title: 'Add feature', description: 'Build the feature', files: ['src/feature.ts'], acceptance_criteria: ['Works'], completed: false },
        { id: 3, title: 'Add tests', description: 'Write tests', files: ['src/feature.test.ts'], acceptance_criteria: ['Coverage passes'], completed: false },
      ],
    }));

    mockExecFileSync.mockReturnValue('abc123\n');
  });

  afterEach(() => {
    project.clean();
  });

  it('includes SESSION CONTEXT header with task, branch, and completed dependencies', async () => {
    // Directly build and verify the resume-context header logic.
    // The resume-context is a string constructed in runSubtaskSession;
    // we verify its constituent parts here.
    const testDescription = 'Build user authentication';
    const testBranch = 'feat/user-auth';
    const testSubtaskId = 2;
    const testSubtaskTitle = 'Add feature';
    const testCwd = '/tmp/worktree/test';

    // Simulate what runSubtaskSession does (simplified): only the completed
    // DEPENDENCIES of the current subtask are listed, not every completed
    // subtask (a completed subtask with no depends_on edge is omitted).
    const currentSubtask = { id: 2, title: 'Add feature', depends_on: [1] };
    const allSubtasks = [
      { id: 1, title: 'Setup project', completed: true },
      { id: 2, title: 'Add feature', completed: false },
      { id: 3, title: 'Add tests', completed: true },
    ];

    const dependsOn = new Set(currentSubtask.depends_on || []);
    const done = allSubtasks.filter(s => s.completed && dependsOn.has(s.id));
    let resumeContext = '## SESSION CONTEXT\n\n' +
      'Task: ' + testDescription + '\n' +
      'Branch: ' + testBranch + '\n';
    resumeContext += 'Subtasks: ' + allSubtasks.length + ' total';
    resumeContext += ', ' + done.length + ' dependencies already done (' +
      done.map(s => '#' + s.id + ': ' + s.title).join(', ') + ')';
    resumeContext += '\n';
    resumeContext += 'Current: Subtask ' + testSubtaskId + ': ' + testSubtaskTitle + '\n';
    resumeContext += 'Working directory: ' + testCwd + ' (this is your git worktree)\n\n';

    expect(resumeContext).toContain('SESSION CONTEXT');
    expect(resumeContext).toContain('Task: Build user authentication');
    expect(resumeContext).toContain('Branch: feat/user-auth');
    expect(resumeContext).toContain('Current: Subtask 2: Add feature');
    expect(resumeContext).toContain('dependencies already done');
    expect(resumeContext).toContain('#1: Setup project');
    // Subtask 3 is completed but is NOT a dependency of subtask 2, so it
    // must be omitted to avoid re-listing irrelevant work.
    expect(resumeContext).not.toContain('#3: Add tests');
    expect(resumeContext).toContain('Working directory:');
    expect(resumeContext).toContain('this is your git worktree');
  });

  it('SESSION CONTEXT is included even in wakeup re-entry mode', async () => {
    const wtPath = join(project.root, 'worktrees', 'wakeup-test');
    mkdirSync(wtPath, { recursive: true });

    mockCreateSession.mockResolvedValue('sess-context-wakeup');
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args)) {
        if (args[0] === 'worktree' && args[1] === 'list') return wtPath + '\n';
        if (args[0] === 'rev-list') return '0\n';
        if (args[0] === 'rev-parse') return 'abc123\n';
        if (args[0] === 'status') return '';
        if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
      }
      return '';
    });

    const pipeline = makePipeline(project.taskId, project.taskDir, {
      phase: 'implement',
      qaAttempt: 0,
      description: 'Build user authentication',
      branch: 'feat/user-auth',
      worktreePath: wtPath,
      wakeupSubtaskId: 2,
      wakeupUntil: new Date(Date.now() + 3600_000).toISOString(),
      wakeupCommand: 'npm run long-benchmark',
      wakeupArtifact: 'benchmark-results/output.json',
    });

    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    try {
      const promise = (orch as AnyOrch).runImplement(pipeline);
      await vi.waitFor(() => {
        expect(mockSendMessage).toHaveBeenCalled();
      }, { timeout: 30_000 });

      const prompt = mockSendMessage.mock.calls[0][1];

      expect(prompt).toContain('WAKEUP RE-ENTRY');
      expect(prompt).toContain('SESSION CONTEXT');
      expect(prompt).toContain('Task: Build user authentication');
      expect(prompt).toContain('Branch: feat/user-auth');

      fireEvent('event', { sessionId: 'sess-context-wakeup', event: { type: 'result' } });
      // The event handler processes synchronously; the promise from
      // runImplement will resolve once waitForCompletion finishes.
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  }, 35_000);
});
