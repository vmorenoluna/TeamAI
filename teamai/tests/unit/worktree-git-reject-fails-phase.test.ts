/**
 * A rejected async git call must fail the enclosing phase run - the task ends
 * in `failed` with a completionSummary, never hung and never advanced.
 *
 *   AC6: every `git worktree add` rejects during the plan phase.
 *   AC9: checkCherryPickInProgress (via repairStuckCherryPick) awaits
 *        execGitCapture, so a reported in-progress cherry-pick takes the
 *        in-progress branch (an un-awaited Promise would always be truthy).
 *
 * No retry affordance is exercised: the existing failure path only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';

const h = await vi.hoisted(async () => {
  const { createExecFileMock, execFileError } = await import('../utils/mock-child-process');
  const { execFileSync: realExecFileSync } = await vi.importActual<typeof import('child_process')>('child_process');
  const state = { worktreeAddCalls: 0 };
  const exec = createExecFileMock({
    handler: (file, args, opts) => {
      if (file === 'git' && args[0] === 'worktree' && args[1] === 'add') {
        state.worktreeAddCalls++;
        throw execFileError(file, args, 'fatal: simulated worktree add failure');
      }
      return realExecFileSync(file, args, { ...opts, encoding: 'utf-8', stdio: 'pipe' } as never) as unknown as string;
    },
  });
  return { exec, state };
});

vi.mock('child_process', async (orig) => {
  const { buildChildProcessMock } = await import('../utils/mock-child-process');
  return buildChildProcessMock(await orig(), h.exec);
});

const mockCreateSession = vi.fn();
const onHandlers: Map<string, Array<(...args: unknown[]) => void>> = new Map();

vi.mock('@/lib/process-manager', () => ({
  processManager: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    sendMessage: vi.fn(),
    killSession: vi.fn(),
    writeToSession: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!onHandlers.has(event)) onHandlers.set(event, []);
      onHandlers.get(event)!.push(handler);
      // Event-driven: the planner session "exits" as soon as a listener for it exists.
      if (event === 'exit') queueMicrotask(() => handler({ sessionId: 'plan-sess', code: 0 }));
    },
    off: (event: string, handler: (...args: unknown[]) => void) => {
      const hs = onHandlers.get(event);
      const i = hs ? hs.indexOf(handler) : -1;
      if (hs && i >= 0) hs.splice(i, 1);
    },
    emit: vi.fn(),
    getSession: vi.fn(),
    getStaleSessions: () => [],
    getAllSessions: () => [],
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('@/lib/container-manager', () => ({
  containerManager: { on: vi.fn(), off: vi.fn(), start: vi.fn(), stop: vi.fn(), getStatus: vi.fn().mockReturnValue('stopped') },
  readContainerConfig: vi.fn().mockReturnValue({ enabled: false }),
  hostToContainerPath: vi.fn((p: string) => p),
}));

type AnyOrch = any;

let root: string;
let taskId: string;

function setupProject() {
  root = join(tmpdir(), `teamai-rejfail-${randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  git('init');
  git('config', 'user.email', 'test@teamai.dev');
  git('config', 'user.name', 'TeamAI Test');
  writeFileSync(join(root, '.gitkeep'), '');
  git('add', '.gitkeep');
  git('commit', '-m', 'initial');

  taskId = randomUUID();
  const taskDir = join(root, '.teamai', taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(root, '.teamai', 'pipeline.json'), JSON.stringify({
    phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'], maxQaAttempts: 2, backlogCheck: false,
  }));
  const now = new Date().toISOString();
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId, title: 'Reject task', description: 'worktree add rejects', phase: 'plan', createdAt: now, updatedAt: now,
  }));
  writeFileSync(join(taskDir, 'spec.md'), '# Spec\n');
  writeFileSync(join(taskDir, 'plan.json'), JSON.stringify({
    subtasks: [{ id: 1, title: 'st', description: 'd', files: ['a.ts'], acceptance_criteria: ['x'], depends_on: [], parallel_group: 1 }],
  }));
  return taskDir;
}

describe('rejected worktree add fails the plan phase (AC6)', () => {
  let orch: AnyOrch;
  let taskDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    onHandlers.clear();
    h.state.worktreeAddCalls = 0;
    taskDir = setupProject();
    mockCreateSession.mockResolvedValue('plan-sess');
    const mod = await import('@/lib/orchestrator');
    orch = mod.getOrchestrator(root);
    orch.pipelines.clear();
    orch.activeTasks.clear();
  });

  afterEach(() => {
    onHandlers.clear();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
    vi.resetModules();
  });

  it('ends in failed with a completionSummary naming the error, not hung or advanced', async () => {
    const pipeline = {
      taskId, title: 'Reject task', description: 'worktree add rejects', phase: 'plan',
      specPath: taskDir, worktreePath: join(root, '.teamai', 'worktrees', taskId), branch: 'feat/reject-task',
      qaAttempt: 0, maxQaAttempts: 2, specRevision: 1, qaRevision: 0,
    };
    orch.pipelines.set(taskId, pipeline);
    orch.activeTasks.add(taskId);

    await orch._runPipeline(pipeline);

    expect(h.state.worktreeAddCalls).toBeGreaterThan(0);
    const task = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf-8'));
    expect(task.phase).toBe('failed');
    expect(pipeline.phase).toBe('failed');
    expect(task.completionSummary).toBeTruthy();
    expect(JSON.stringify(task.completionSummary)).toMatch(/plan phase: [\s\S]*simulated worktree add failure/);
  });
});

describe('checkCherryPickInProgress is awaited (AC9)', () => {
  let dir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    dir = join(tmpdir(), `teamai-cp-${randomUUID().slice(0, 8)}`);
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function makeDeps(capture: (args: string[]) => Promise<string>) {
    return {
      projectRoot: dir,
      execGit: vi.fn(async (args: string[]) => {
        if (args[0] === 'cherry-pick' && args[1] !== '--abort' && args[1] !== '--quit') {
          throw new Error('CONFLICT: could not apply abc123');
        }
      }),
      execGitCapture: vi.fn(capture),
      sessionOpts: vi.fn(() => ({})),
      waitForCompletion: vi.fn(async () => undefined),
    };
  }

  const pipelineFor = () => ({ taskId: 't', specPath: dir, worktreePath: dir, branch: 'feat/x' }) as never;

  it('takes the in-progress branch (spawns the merger) when CHERRY_PICK_HEAD resolves', async () => {
    const { tryCherryPickWithRecovery } = await import('../../src/lib/orchestrator/implement');
    mockCreateSession.mockResolvedValue('merge-sess');
    let headPresent = true;
    const deps = makeDeps(async (args) => {
      if (args[0] === 'rev-parse') return headPresent ? 'abc123\n' : '';
      return '';
    });
    // The merger finishes the cherry-pick: CHERRY_PICK_HEAD is gone afterwards.
    deps.waitForCompletion.mockImplementation(async () => { headPresent = false; });

    const ok = await tryCherryPickWithRecovery(pipelineFor(), deps as never, join(dir, 'output.log'), 'feat/x-st1', 1);

    expect(mockCreateSession).toHaveBeenCalledTimes(1);
    expect(deps.waitForCompletion).toHaveBeenCalledWith('merge-sess');
    expect(ok).toBe(true);
  });

  it('reports a hard failure (no merger) when CHERRY_PICK_HEAD does not resolve', async () => {
    const { tryCherryPickWithRecovery } = await import('../../src/lib/orchestrator/implement');
    const deps = makeDeps(async (args) => {
      if (args[0] === 'rev-parse') throw new Error('fatal: Needed a single revision');
      return '';
    });

    const ok = await tryCherryPickWithRecovery(pipelineFor(), deps as never, join(dir, 'output.log'), 'feat/x-st1', 1);

    expect(mockCreateSession).not.toHaveBeenCalled();
    expect(deps.execGit).toHaveBeenCalledWith(['cherry-pick', '--abort'], dir);
    expect(ok).toBe(false);
  });
});
