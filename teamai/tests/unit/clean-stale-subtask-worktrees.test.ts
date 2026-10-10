import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { cleanStaleSubtaskWorktrees } from '../../src/lib/orchestrator/worktree-ops';
import { clearWorktreeDirectoryOrThrow } from '../../src/lib/orchestrator/implement';
import { WorktreeError } from '../../src/lib/orchestrator/errors';

describe('cleanStaleSubtaskWorktrees', () => {
  let root: string;
  let projectRoot: string;
  let base: string;
  let pipeline: { worktreePath: string; branch: string };

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'stale-st-'));
    projectRoot = path.join(root, 'project');
    base = path.join(root, 'worktrees');
    mkdirSync(path.join(projectRoot, '.teamai'), { recursive: true });
    // Pin container mode off so the worktree base is <projectRoot>/../worktrees
    writeFileSync(path.join(projectRoot, '.teamai', 'container.json'), JSON.stringify({ enabled: false }));
    mkdirSync(path.join(base, 'my-task-st1'), { recursive: true });
    pipeline = { worktreePath: path.join(base, 'my-task'), branch: 'feat/my-task' };
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('removes a leftover directory when git removal fails', async () => {
    const execGit = vi.fn(() => { throw new Error('git failed'); });
    await cleanStaleSubtaskWorktrees(pipeline, {
      execGit, projectRoot, clearWorktreeDirectory: clearWorktreeDirectoryOrThrow,
    });
    expect(existsSync(path.join(base, 'my-task-st1'))).toBe(false);
  });

  it('throws WORKTREE_LOCKED when the directory cannot be cleared', async () => {
    const clear = vi.fn().mockRejectedValue(new WorktreeError('locked', 'WORKTREE_LOCKED'));
    await expect(cleanStaleSubtaskWorktrees(pipeline, {
      execGit: vi.fn(), projectRoot, clearWorktreeDirectory: clear,
    })).rejects.toMatchObject({ code: 'WORKTREE_LOCKED' });
    expect(clear).toHaveBeenCalledWith(path.join(base, 'my-task-st1'), expect.any(Object));
  });
});
