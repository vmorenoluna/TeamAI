/**
 * deleteTaskWorktree: git removal goes through the queued async helper, with
 * normal → --force → manual fallbacks and unchanged {success,error} results.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  execGitQueued: vi.fn(),
  removeStale: vi.fn(),
  rmSync: vi.fn(),
  update: vi.fn(),
}));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/lib/process-manager', () => ({ processManager: {} }));
vi.mock('@/lib/logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/auto-mode', () => ({ retryAutoMerge: vi.fn() }));
vi.mock('../../src/app/actions/projects', () => ({ getActiveProjectPath: vi.fn(async () => '/test/project') }));
vi.mock('@/lib/task-store', () => ({
  TaskStore: class {
    getById() { return { id: 't1', branch: 'feat/x' }; }
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
  return { ...actual, existsSync: vi.fn(() => true), rmSync: h.rmSync };
});

import { deleteTaskWorktree } from '@/app/actions/tasks';

describe('deleteTaskWorktree', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.removeStale.mockResolvedValue(undefined);
  });

  it('succeeds with a normal remove', async () => {
    h.execGitQueued.mockResolvedValueOnce('');
    expect(await deleteTaskWorktree('t1')).toEqual({ success: true });
    expect(h.execGitQueued).toHaveBeenCalledWith(
      ['worktree', 'remove', '/test/project/.worktrees/x'], '/test/project', '/test/project');
  });

  it('falls back to --force when normal remove rejects', async () => {
    h.execGitQueued.mockRejectedValueOnce(new Error('dirty')).mockResolvedValueOnce('');
    expect(await deleteTaskWorktree('t1')).toEqual({ success: true });
    expect(h.execGitQueued).toHaveBeenLastCalledWith(
      ['worktree', 'remove', '--force', '/test/project/.worktrees/x'], '/test/project', '/test/project');
    expect(h.rmSync).not.toHaveBeenCalled();
  });

  it('falls back to manual delete when both git removes reject', async () => {
    h.execGitQueued.mockRejectedValue(new Error('locked'));
    expect(await deleteTaskWorktree('t1')).toEqual({ success: true });
    expect(h.rmSync).toHaveBeenCalled();
    expect(h.removeStale).toHaveBeenCalledWith('/test/project', '/test/project/.worktrees/x');
  });

  it('returns stderr/message when the manual fallback also fails', async () => {
    h.execGitQueued.mockRejectedValue(new Error('locked'));
    h.removeStale.mockRejectedValueOnce(Object.assign(new Error('m'), { stderr: 'prune failed' }));
    expect(await deleteTaskWorktree('t1')).toEqual({ success: false, error: 'prune failed' });
    h.removeStale.mockRejectedValueOnce(new Error('boom'));
    expect(await deleteTaskWorktree('t1')).toEqual({ success: false, error: 'boom' });
  });
});
