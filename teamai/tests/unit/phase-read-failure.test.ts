/**
 * A rejected TaskStore read inside a phase run must fail the task — never an
 * empty/default value that lets the phase continue on missing data.
 *
 *   AC9: the spec phase's backlog check reads the whole board
 *        (TaskStore.getAll); when that read throws, the task ends in `failed`
 *        with failureReason 'run-error' and no agent session is created.
 *
 * Pins existing orchestrator behaviour (AC10): no change under
 * src/lib/orchestrator/ is required for it to pass.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { setupTestProject, makePipeline, makeOrch, type AnyOrch } from '../utils/orchestrator-harness';

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

describe('TaskStore read failure inside a phase (AC9)', () => {
  let project: ReturnType<typeof setupTestProject>;
  let orch: AnyOrch;

  beforeEach(async () => {
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupTestProject({ tmpPrefix: 'teamai-readfail' });
    writeFileSync(join(project.root, '.teamai', 'pipeline.json'), JSON.stringify({
      phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'], maxQaAttempts: 2, backlogCheck: true,
    }));
    const { getOrchestrator } = await import('@/lib/orchestrator');
    orch = makeOrch(project.root, getOrchestrator);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    project.clean(onHandlers);
    vi.resetModules();
  });

  it('fails the task with run-error and creates no session when the board read throws', async () => {
    const { TaskStore } = await import('@/lib/task-store');
    vi.spyOn(TaskStore.prototype, 'getAll').mockImplementation(() => {
      throw Object.assign(new Error('EIO: board read'), { code: 'EIO' });
    });

    const pipeline = makePipeline({
      taskId: project.taskId, title: 'Test Task', description: 'A test task for full coverage', phase: 'spec',
      specPath: project.taskDir, worktreePath: join(project.root, '.teamai', 'worktrees', project.taskId),
      branch: `feat/${project.slug}`, maxQaAttempts: 2,
    });
    orch.pipelines.set(project.taskId, pipeline);
    orch.activeTasks.add(project.taskId);

    await orch._runPipeline(pipeline);

    const taskPath = join(project.taskDir, 'task.json');
    expect(existsSync(taskPath)).toBe(true);
    const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
    expect(task.phase).toBe('failed');
    expect(pipeline.phase).toBe('failed');
    expect(task.failureReason).toBe('run-error');
    expect(JSON.stringify(task.completionSummary)).toContain('EIO: board read');
    expect(mockCreateSession).not.toHaveBeenCalled();
  }, 30_000);
});
