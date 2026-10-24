/**
 * Retry across the engine boundary. `retryTask` / `retryTaskWithOptions` are thin
 * wrappers: they forward `{ projectPath, ... }` to the `tasks.*` engine handlers and
 * revalidate on success. The handler behaviour (qa_report snapshot, resume phase,
 * budget reset, auto-merge hand-back) is asserted in engine-handlers-tasks.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted shared mocks ──

const mockRevalidatePath = vi.fn();

const h = vi.hoisted(() => ({
  engineCall: vi.fn(),
  moveTaskToPhase: vi.fn().mockResolvedValue(undefined),
  clearPipelineStateFile: vi.fn(),
  retryAutoMerge: vi.fn(),
  useRealClient: false,
}));

let mockProjectPath = '/test/project';

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: vi.fn((name: string) => {
      if (name === 'activeProject') return { value: mockProjectPath };
      return undefined;
    }),
    set: vi.fn(),
    delete: vi.fn(),
  })),
}));

vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidatePath,
}));

vi.mock('@/lib/logger', () => ({
  log: vi.fn(), warn: vi.fn(),
  error: vi.fn(),
}));

// The wrapper contract tests replace the engine client; the IPC test below installs a
// fake engine host on globalThis instead and uses the real client.
vi.mock('@/engine/engine-client', async () => {
  const actual = await vi.importActual<typeof import('@/engine/engine-client')>('@/engine/engine-client');
  return { ...actual, engineCall: (...a: unknown[]) => (h.useRealClient ? (actual.engineCall as (...x: unknown[]) => unknown)(...a) : h.engineCall(...a)) };
});

// Engine-side modules, only reached through the fake host in the IPC test.
vi.mock('@/lib/auto-mode', () => ({ retryAutoMerge: h.retryAutoMerge }));
vi.mock('@/lib/process-manager', () => ({ processManager: { emit: vi.fn(), on: vi.fn(), off: vi.fn() } }));
vi.mock('@/lib/orchestrator', () => ({
  getOrchestrator: vi.fn(() => ({
    moveTaskToPhase: h.moveTaskToPhase,
    clearPipelineStateFile: h.clearPipelineStateFile,
  })),
}));

// ── Real imports ──

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { RESUME_AUTO } from '@/lib/orchestrator/artifacts';

const TEST_DIR = join(
  process.cwd(),
  '.teamai-test-retry-' + Math.random().toString(36).slice(2, 10),
);

/** Seed a failed task with optional qa_report.json */
function seedFailedTask(
  dir: string,
  slug: string,
  options: { qaReport?: Record<string, unknown>; failureReason?: string } = {},
) {
  const taskDir = join(dir, '.teamai', slug);
  mkdirSync(taskDir, { recursive: true });

  const taskId = `task-${slug}`;
  const task = {
    id: taskId,
    title: `Failed Task ${slug}`,
    description: 'a failed task for retry testing',
    phase: 'failed',
    branch: `feat/${slug}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(options.failureReason ? { failureReason: options.failureReason } : {}),
  };
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify(task, null, 2));

  // Write events.jsonl so getResumePhaseForFailedTask has data
  writeFileSync(join(taskDir, 'events.jsonl'),
    JSON.stringify({ phase: 'backlog', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ phase: 'spec', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ phase: 'plan', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ phase: 'implement', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ phase: 'qa-review', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ phase: 'failed', timestamp: new Date().toISOString() }) + '\n',
  );

  if (options.qaReport) {
    writeFileSync(
      join(taskDir, 'qa_report.json'),
      JSON.stringify(options.qaReport, null, 2),
    );
  }

  return { taskId, taskDir };
}

// ── Tests ──

describe('retryTask / retryTaskWithOptions — engine wrappers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.useRealClient = false;
    mockProjectPath = '/test/project';
  });

  it('retryTask forwards the active project, task and operation id to tasks.retryTask', async () => {
    h.engineCall.mockResolvedValue({ success: true, operationId: 'op-9' });
    const { retryTask } = await import('@/app/actions/tasks');

    const result = await retryTask('t1', 'op-9');

    expect(result).toEqual({ success: true, operationId: 'op-9' });
    expect(h.engineCall).toHaveBeenCalledWith('tasks.retryTask', [{ projectPath: '/test/project', taskId: 't1', operationId: 'op-9' }]);
    expect(mockRevalidatePath).toHaveBeenCalledWith('/');
  });

  it('retryTask returns an engine failure unchanged and does not revalidate', async () => {
    h.engineCall.mockResolvedValue({ success: false, error: 'Task is in phase "spec", not "failed"' });
    const { retryTask } = await import('@/app/actions/tasks');

    const result = await retryTask('t1');

    expect(result).toEqual({ success: false, error: 'Task is in phase "spec", not "failed"' });
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it('retryTask rejects when the engine call rejects', async () => {
    h.engineCall.mockRejectedValue(new Error('Pipeline engine is not running'));
    const { retryTask } = await import('@/app/actions/tasks');

    await expect(retryTask('t1')).rejects.toThrow('Pipeline engine is not running');
    expect(mockRevalidatePath).not.toHaveBeenCalled();
  });

  it('retryTaskWithOptions forwards the chosen phase, including the resume-auto sentinel', async () => {
    h.engineCall.mockResolvedValue({ success: true, operationId: 'op-1' });
    const { retryTaskWithOptions } = await import('@/app/actions/tasks');

    await retryTaskWithOptions('t1', 'plan', 'op-1');
    await retryTaskWithOptions('t1', RESUME_AUTO);

    expect(h.engineCall).toHaveBeenNthCalledWith(1, 'tasks.retryTaskWithOptions', [{ projectPath: '/test/project', taskId: 't1', phase: 'plan', operationId: 'op-1' }]);
    expect(h.engineCall).toHaveBeenNthCalledWith(2, 'tasks.retryTaskWithOptions', [{ projectPath: '/test/project', taskId: 't1', phase: RESUME_AUTO, operationId: undefined }]);
    expect(mockRevalidatePath).toHaveBeenCalledTimes(2);
  });
});

describe('retryTask — request crosses the engine boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.moveTaskToPhase.mockResolvedValue(undefined);
    h.useRealClient = true;
    mockProjectPath = TEST_DIR;
  });

  afterEach(() => {
    globalThis.__teamaiEngine = undefined;
    h.useRealClient = false;
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  it('a Retry sent from the API side reaches the orchestrator and resumes at the failed phase', async () => {
    const { taskId } = seedFailedTask(TEST_DIR, 'ipc-retry');
    const { tasksHandlers } = await import('@/engine/handlers/tasks');
    // Stand-in for the engine child: the real client serialises to [params] and the host
    // dispatches to the handler table.
    globalThis.__teamaiEngine = {
      call: async (method, args = []) => tasksHandlers[method](args[0]),
      notify: () => {},
    };
    const { retryTask } = await import('@/app/actions/tasks');

    const result = await retryTask(taskId);
    await vi.waitFor(() => expect(h.moveTaskToPhase).toHaveBeenCalled());

    expect(result.success).toBe(true);
    expect(h.moveTaskToPhase).toHaveBeenCalledWith(taskId, 'qa-review');
    expect(h.clearPipelineStateFile).toHaveBeenCalled();
  }, 20_000);

  it('fails loudly when no engine host is running', async () => {
    const { retryTask } = await import('@/app/actions/tasks');
    await expect(retryTask('t1')).rejects.toThrow('Pipeline engine is not running');
  });
});

describe('read actions — async TaskStore reads', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectPath = TEST_DIR;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  it('getTaskFull throws TaskNotFoundError for a missing task', async () => {
    mkdirSync(join(TEST_DIR, '.teamai'), { recursive: true });
    const { getTaskFull } = await import('@/app/actions/tasks');
    const { TaskNotFoundError } = await import('@/lib/orchestrator/errors');

    const err = await getTaskFull('does-not-exist').catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TaskNotFoundError);
    expect((err as Error).message).toBe('Task does-not-exist not found');
  }, 20_000);

  it('getTaskFull rejects with the underlying error when a task read rejects', async () => {
    const { taskId } = seedFailedTask(TEST_DIR, 'full-read-rejects');
    const { TaskStore } = await import('@/lib/task-store');
    vi.spyOn(TaskStore.prototype, 'getByIdAsync').mockRejectedValue(new Error('EIO: task read failed'));
    const { getTaskFull } = await import('@/app/actions/tasks');
    const { TaskNotFoundError } = await import('@/lib/orchestrator/errors');

    const err = await getTaskFull(taskId).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(TaskNotFoundError);
    expect((err as Error).message).toBe('EIO: task read failed');
  }, 20_000);

  it('getTaskFull returns the seeded task with null artifacts and empty role files', async () => {
    const { taskId } = seedFailedTask(TEST_DIR, 'full-ok');
    const { getTaskFull } = await import('@/app/actions/tasks');

    const full = await getTaskFull(taskId);

    expect(full.task.id).toBe(taskId);
    expect(full.plan).toBeNull();
    expect(full.agentOutput).toBeNull();
    expect(full.sessionMap).toEqual({});
    expect(full.roleFiles).toEqual({});
  }, 20_000);
});
