/**
 * deleteTaskWorktree: git removal goes through the queued async helper, with
 * normal → --force → manual fallbacks. Validation results are returned
 * synchronously; the removal runs in the background and its outcome is read
 * from the background-result registry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  execGitQueued: vi.fn(),
  removeStale: vi.fn(),
  rm: vi.fn(),
  update: vi.fn(),
  getByIdAsync: vi.fn(async () => ({ id: 't1', branch: 'feat/x' })),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/process-manager', () => ({ processManager: { emit: vi.fn() } }));
vi.mock('@/lib/logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/auto-mode', () => ({ retryAutoMerge: vi.fn() }));
vi.mock('../../src/app/actions/projects', () => ({ getActiveProjectPath: vi.fn(async () => '/test/project') }));
vi.mock('@/lib/task-store', () => ({
  TaskStore: class {
    getByIdAsync = h.getByIdAsync;
    update = h.update;
  },
}));
vi.mock('@/lib/orchestrator', () => ({
  getOrchestrator: vi.fn(() => ({ getWorktreePath: () => '/test/project/.worktrees/x' })),
}));
vi.mock('@/lib/orchestrator/worktree-utils', () => ({
  execGitQueued: h.execGitQueued,
  removeStaleWorktreeRegistration: h.removeStale,
}));
vi.mock('fs', async (orig) => {
  const actual = await orig<typeof import('fs')>();
  return { ...actual, existsSync: vi.fn(() => true) };
});
vi.mock('fs/promises', async (orig) => {
  const actual = await orig<typeof import('fs/promises')>();
  return { ...actual, rm: h.rm };
});

import { deleteTaskWorktree } from '@/app/actions/tasks';
import { getBackgroundResult } from '@/lib/background-actions';

/** Starts the delete and waits for its background work to settle. */
async function deleteAndSettle(): Promise<{ success: boolean; error?: string; result: ReturnType<typeof getBackgroundResult> }> {
  const res = await deleteTaskWorktree('t1');
  expect(res.operationId).toBeTruthy();
  await vi.waitFor(() => expect(getBackgroundResult(res.operationId!).status).not.toBe('pending'));
  return { success: res.success, error: res.error, result: getBackgroundResult(res.operationId!) };
}

describe('deleteTaskWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.removeStale.mockResolvedValue(undefined);
    h.getByIdAsync.mockImplementation(async () => ({ id: 't1', branch: 'feat/x' }));
  });

  it('resolves { success: false, error } when the task read rejects', async () => {
    h.getByIdAsync.mockRejectedValueOnce(new Error('EIO: read failed'));
    expect(await deleteTaskWorktree('t1')).toEqual({ success: false, error: 'EIO: read failed' });
    expect(h.execGitQueued).not.toHaveBeenCalled();
  });

  it('succeeds with a normal remove', async () => {
    h.execGitQueued.mockResolvedValueOnce('');
    expect(await deleteAndSettle()).toMatchObject({ success: true, result: { status: 'ok' } });
    expect(h.execGitQueued).toHaveBeenCalledWith(
      ['worktree', 'remove', '/test/project/.worktrees/x'], '/test/project', '/test/project');
    expect(h.update).toHaveBeenCalledWith('t1', { branch: undefined });
  });

  it('falls back to --force when normal remove rejects', async () => {
    h.execGitQueued.mockRejectedValueOnce(new Error('dirty')).mockResolvedValueOnce('');
    expect(await deleteAndSettle()).toMatchObject({ success: true, result: { status: 'ok' } });
    expect(h.execGitQueued).toHaveBeenLastCalledWith(
      ['worktree', 'remove', '--force', '/test/project/.worktrees/x'], '/test/project', '/test/project');
    expect(h.rm).not.toHaveBeenCalled();
  });

  it('falls back to manual delete when both git removes reject', async () => {
    h.execGitQueued.mockRejectedValue(new Error('locked'));
    h.rm.mockResolvedValue(undefined);
    expect(await deleteAndSettle()).toMatchObject({ success: true, result: { status: 'ok' } });
    expect(h.rm).toHaveBeenCalledWith('/test/project/.worktrees/x', { recursive: true, force: true });
    expect(h.removeStale).toHaveBeenCalledWith('/test/project', '/test/project/.worktrees/x');
  });

  it('reports stderr/message as a failed background result when the manual fallback also fails', async () => {
    h.execGitQueued.mockRejectedValue(new Error('locked'));
    h.rm.mockResolvedValue(undefined);
    h.removeStale.mockRejectedValueOnce(Object.assign(new Error('m'), { stderr: 'prune failed' }));
    expect((await deleteAndSettle()).result).toEqual({ status: 'failed', error: 'prune failed' });
    h.removeStale.mockRejectedValueOnce(new Error('boom'));
    expect((await deleteAndSettle()).result).toEqual({ status: 'failed', error: 'boom' });
    expect(h.update).not.toHaveBeenCalled();
  });
});
