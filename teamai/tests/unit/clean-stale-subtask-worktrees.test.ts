import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from 'vitest';
import { mkdtempSync, mkdirSync, existsSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { cleanStaleSubtaskWorktrees, sweepAbandonedWorktreeRemnants } from '../../src/lib/orchestrator/worktree-ops';
import { removeDirBestEffort } from '../../src/lib/orchestrator/worktree-utils';
import {
  subtaskWorktreeBasePath, pickFreshSubtaskWorktreePath, recordSubtaskWorktree,
  resolveSubtaskWorktreePath, clearSubtaskWorktreeRecord,
} from '../../src/lib/orchestrator/subtask-worktree-paths';

// Lets one test simulate a directory that can't be deleted (a held-open file).
const fsFaults = vi.hoisted(() => ({ rmSyncFails: false }));
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    default: actual,
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      if (fsFaults.rmSyncFails) throw new Error('EBUSY: resource busy or locked');
      return actual.rmSync(...args);
    },
  };
});

describe('subtask worktree stale handling', () => {
  let root: string;
  let projectRoot: string;
  let base: string;
  let specPath: string;
  let pipeline: { worktreePath: string; branch: string; specPath: string };

  let warn: MockInstance;

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    root = mkdtempSync(path.join(os.tmpdir(), 'stale-st-'));
    projectRoot = path.join(root, 'project');
    base = path.join(root, 'worktrees');
    specPath = path.join(projectRoot, '.teamai', 'my-task');
    mkdirSync(specPath, { recursive: true });
    // Pin container mode off so the worktree base is <projectRoot>/../worktrees
    writeFileSync(path.join(projectRoot, '.teamai', 'container.json'), JSON.stringify({ enabled: false }));
    mkdirSync(path.join(base, 'my-task-st1'), { recursive: true });
    pipeline = { worktreePath: path.join(base, 'my-task'), branch: 'feat/my-task', specPath };
  });

  afterEach(() => {
    warn.mockRestore();
    fsFaults.rmSyncFails = false;
    rmSync(root, { recursive: true, force: true });
  });

  describe('cleanStaleSubtaskWorktrees', () => {
    it('removes a leftover directory when git removal fails', async () => {
      const execGit = vi.fn(async () => { throw new Error('git failed'); });
      await cleanStaleSubtaskWorktrees(pipeline, { execGit, projectRoot });
      expect(existsSync(path.join(base, 'my-task-st1'))).toBe(false);
    });

    it('also removes relocated -r<N> variants', async () => {
      mkdirSync(path.join(base, 'my-task-st1-r2'), { recursive: true });
      await cleanStaleSubtaskWorktrees(pipeline, { execGit: vi.fn(async () => { throw new Error('x'); }), projectRoot });
      expect(existsSync(path.join(base, 'my-task-st1-r2'))).toBe(false);
    });

    it('leaves unrelated directories alone', async () => {
      mkdirSync(path.join(base, 'my-task-stale-notes'), { recursive: true });
      mkdirSync(path.join(base, 'other-task-st1'), { recursive: true });
      await cleanStaleSubtaskWorktrees(pipeline, { execGit: vi.fn(async () => { throw new Error('x'); }), projectRoot });
      expect(existsSync(path.join(base, 'my-task-stale-notes'))).toBe(true);
      expect(existsSync(path.join(base, 'other-task-st1'))).toBe(true);
    });

    it('does not throw or wait when a directory cannot be removed', async () => {
      const execGit = vi.fn(async () => { throw new Error('locked'); });
      fsFaults.rmSyncFails = true;
      try {
        await expect(cleanStaleSubtaskWorktrees(pipeline, { execGit, projectRoot })).resolves.toBeUndefined();
        expect(existsSync(path.join(base, 'my-task-st1'))).toBe(true);
        // ...but the failure is not silent.
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(path.join(base, 'my-task-st1')));
        expect(warn).toHaveBeenCalledWith(expect.stringContaining('EBUSY'));
      } finally {
        fsFaults.rmSyncFails = false;
      }
    });

    it('forgets the recorded subtask worktree paths', async () => {
      recordSubtaskWorktree(specPath, 1, path.join(base, 'my-task-st1-r2'));
      await cleanStaleSubtaskWorktrees(pipeline, { execGit: vi.fn(async () => { throw new Error('x'); }), projectRoot });
      expect(resolveSubtaskWorktreePath(specPath, pipeline.worktreePath, 1)).toBeNull();
    });
  });

  describe('pickFreshSubtaskWorktreePath', () => {
    it('uses the canonical path when it is free', () => {
      const p = subtaskWorktreeBasePath(pipeline.worktreePath, 2);
      expect(pickFreshSubtaskWorktreePath(p)).toBe(p);
    });

    it('skips occupied paths without touching them', () => {
      const canonical = subtaskWorktreeBasePath(pipeline.worktreePath, 1);
      mkdirSync(`${canonical}-r2`, { recursive: true });
      expect(pickFreshSubtaskWorktreePath(canonical)).toBe(`${canonical}-r3`);
      expect(existsSync(canonical)).toBe(true);
      expect(existsSync(`${canonical}-r2`)).toBe(true);
    });
  });

  describe('resolveSubtaskWorktreePath', () => {
    it('prefers the recorded relocated path', () => {
      const relocated = `${subtaskWorktreeBasePath(pipeline.worktreePath, 1)}-r2`;
      mkdirSync(relocated, { recursive: true });
      recordSubtaskWorktree(specPath, 1, relocated);
      expect(resolveSubtaskWorktreePath(specPath, pipeline.worktreePath, 1)).toBe(relocated);
    });

    it('falls back to the canonical path, then null', () => {
      expect(resolveSubtaskWorktreePath(specPath, pipeline.worktreePath, 1)).toBe(path.join(base, 'my-task-st1'));
      expect(resolveSubtaskWorktreePath(specPath, pipeline.worktreePath, 9)).toBeNull();
    });

    it('ignores a recorded path that no longer exists', () => {
      recordSubtaskWorktree(specPath, 1, path.join(base, 'gone-r2'));
      expect(resolveSubtaskWorktreePath(specPath, pipeline.worktreePath, 1)).toBe(path.join(base, 'my-task-st1'));
      clearSubtaskWorktreeRecord(specPath);
    });
  });

  describe('removeDirBestEffort', () => {
    it('returns true and stays quiet when the directory is removed', () => {
      expect(removeDirBestEffort(path.join(base, 'my-task-st1'), 'test')).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    });

    it('logs the cause, reports to the task log, and returns false on failure', () => {
      const onFailure = vi.fn();
      fsFaults.rmSyncFails = true;
      expect(removeDirBestEffort(path.join(base, 'my-task-st1'), 'unit test', onFailure)).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('EBUSY'));
      expect(onFailure).toHaveBeenCalledWith(expect.stringContaining('unit test'));
    });
  });

  describe('sweepAbandonedWorktreeRemnants', () => {
    it('removes locked-remnant directories that have no .git', async () => {
      mkdirSync(path.join(base, 'my-task-st1-r2', 'teamai', 'node_modules'), { recursive: true });
      const removed = await sweepAbandonedWorktreeRemnants(projectRoot);
      expect(removed).toContain(path.join(base, 'my-task-st1-r2'));
      expect(removed).toContain(path.join(base, 'my-task-st1'));
      expect(existsSync(path.join(base, 'my-task-st1'))).toBe(false);
    });

    it('logs, and does not report as removed, a remnant that is still locked', async () => {
      fsFaults.rmSyncFails = true;
      expect(await sweepAbandonedWorktreeRemnants(projectRoot)).toEqual([]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('startup sweep'));
    });

    it('never removes a live worktree (has a .git entry)', async () => {
      writeFileSync(path.join(base, 'my-task-st1', '.git'), 'gitdir: /somewhere');
      expect(await sweepAbandonedWorktreeRemnants(projectRoot)).toEqual([]);
      expect(existsSync(path.join(base, 'my-task-st1'))).toBe(true);
    });

    it('never removes directories that do not look like remnants', async () => {
      mkdirSync(path.join(base, 'my-task'), { recursive: true });
      mkdirSync(path.join(base, 'notes'), { recursive: true });
      await sweepAbandonedWorktreeRemnants(projectRoot);
      expect(existsSync(path.join(base, 'my-task'))).toBe(true);
      expect(existsSync(path.join(base, 'notes'))).toBe(true);
    });

    it('does nothing when the worktree base is missing', async () => {
      rmSync(base, { recursive: true, force: true });
      expect(await sweepAbandonedWorktreeRemnants(projectRoot)).toEqual([]);
    });
  });
});
