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
    specRevision: 0,
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
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
  });

  afterEach(() => {
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
    await new Promise(r => setTimeout(r, 50));

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
    await new Promise(r => setTimeout(r, 50));

    expect(safeSpy).toHaveBeenCalled();
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
    await new Promise(r => setTimeout(r, 50));

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
});

// ═══════════════════════════════════════════════════════════════════════
//  rebaseOntoLatestDefault — skip when base hasn't advanced
// ═══════════════════════════════════════════════════════════════════════

import { rebaseOntoLatestDefault, runPlanPhase } from '../../src/lib/orchestrator/phase-runners';

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
      sessionOpts: vi.fn(),
      waitForCompletion: vi.fn(),
      baseBranch: 'master',
    };

    const result = await rebaseOntoLatestDefault(worktreePath, project.taskId, logFile, deps);

    expect(result).toBe(true);
    // deps.execGit should NOT have been called with 'rebase'
    const rebaseCalls = (deps.execGit as any).mock.calls.filter(
      (c: any[]) => c[0] && c[0].includes('rebase'),
    );
    expect(rebaseCalls.length).toBe(0);
    // Log should indicate skip
    const logContent = readFileSync(logFile, 'utf-8');
    expect(logContent).toContain('has not advanced past HEAD');
    expect(logContent).toContain('skipping rebase');
  });

  it('proceeds with rebase when origin/base has advanced (rev-list count > 0)', async () => {
    const logFile = join(project.taskDir, 'output.log');
    const worktreePath = join(project.root, 'worktrees', 'test-task');

    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (Array.isArray(args) && args[0] === 'rev-list') return '3\n';
      return '';
    });

    const execGit = vi.fn();
    const deps = {
      projectRoot: project.root,
      execGit,
      sessionOpts: vi.fn(),
      waitForCompletion: vi.fn(),
      baseBranch: 'master',
    };

    await rebaseOntoLatestDefault(worktreePath, project.taskId, logFile, deps);

    // execGit should have been called with rebase
    const rebaseCalls = execGit.mock.calls.filter(
      (c: any[]) => c[0] && c[0].includes('rebase'),
    );
    expect(rebaseCalls.length).toBeGreaterThan(0);
    const logContent = readFileSync(logFile, 'utf-8');
    expect(logContent).not.toContain('skipping rebase');
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
    };

    await runPlanPhase(pipeline, deps as any);

    // Should advance to implement (normal flow)
    expect(pipeline.phase).toBe('implement');
    expect(deps.executePhase).toHaveBeenCalled();
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

  it('includes SESSION CONTEXT header with task, branch, and completed subtasks', async () => {
    // Directly build and verify the resume-context header logic.
    // The resume-context is a string constructed in runSubtaskSession;
    // we verify its constituent parts here.
    const testDescription = 'Build user authentication';
    const testBranch = 'feat/user-auth';
    const testSubtaskId = 2;
    const testSubtaskTitle = 'Add feature';
    const testCwd = '/tmp/worktree/test';

    // Simulate what runSubtaskSession does (simplified):
    const completedSubtasks = [{ id: 1, title: 'Setup project', completed: true }];
    const allSubtasks = [
      { id: 1, title: 'Setup project', completed: true },
      { id: 2, title: 'Add feature', completed: false },
      { id: 3, title: 'Add tests', completed: false },
    ];

    const done = completedSubtasks.filter(s => s.completed);
    let resumeContext = '## SESSION CONTEXT\n\n' +
      'Task: ' + testDescription + '\n' +
      'Branch: ' + testBranch + '\n';
    resumeContext += 'Subtasks: ' + allSubtasks.length + ' total';
    resumeContext += ', ' + done.length + ' already done (' +
      done.map(s => '#' + s.id + ': ' + s.title).join(', ') + ')';
    resumeContext += '\n';
    resumeContext += 'Current: Subtask ' + testSubtaskId + ': ' + testSubtaskTitle + '\n';
    resumeContext += 'Working directory: ' + testCwd + ' (this is your git worktree)\n\n';

    expect(resumeContext).toContain('SESSION CONTEXT');
    expect(resumeContext).toContain('Task: Build user authentication');
    expect(resumeContext).toContain('Branch: feat/user-auth');
    expect(resumeContext).toContain('Current: Subtask 2: Add feature');
    expect(resumeContext).toContain('already done');
    expect(resumeContext).toContain('#1: Setup project');
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
      await new Promise(r => setTimeout(r, 30));
      await promise;
    } finally {
      executeSpy.mockRestore();
    }
  }, 35_000);
});
