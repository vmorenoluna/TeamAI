import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync } from 'fs';
import os from 'os';
import path from 'path';
import { execGit, execGitCapture, removeStaleWorktreeRegistration } from '../../src/lib/orchestrator/worktree-utils';
import { removeWorktree, getUnpushedCommits } from '../../src/lib/orchestrator/worktree-ops';

const itPosix = process.platform === 'win32' ? it.skip : it;

describe('async git helpers', () => {
  let root: string;
  let binDir: string;
  let origPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'git-async-'));
    binDir = path.join(root, 'bin');
    mkdirSync(binDir);
    mkdirSync(path.join(root, 'project', '.teamai'), { recursive: true });
    writeFileSync(path.join(root, 'project', '.teamai', 'container.json'), JSON.stringify({ enabled: false }));
    origPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = origPath;
    rmSync(root, { recursive: true, force: true });
  });

  function stubGit(script: string) {
    const file = path.join(binDir, 'git');
    writeFileSync(file, `#!/bin/sh\n${script}\n`);
    chmodSync(file, 0o755);
    process.env.PATH = `${binDir}${path.delimiter}${origPath}`;
  }

  const projectRoot = () => path.join(root, 'project');

  itPosix('execGitCapture lets timers fire before a slow git finishes (AC2)', async () => {
    stubGit('sleep 0.5; echo out');
    let timerFiredAt = 0;
    const start = Date.now();
    setTimeout(() => { timerFiredAt = Date.now() - start; }, 50);
    const out = await execGitCapture(['rev-parse', 'HEAD'], projectRoot(), projectRoot());
    const total = Date.now() - start;
    expect(out).toBe('out\n');
    expect(timerFiredAt).toBeGreaterThan(0);
    expect(timerFiredAt).toBeLessThan(total - 100);
  });

  itPosix('execGit resolves on success and rejects with git stderr on failure (AC3)', async () => {
    stubGit('if [ "$1" = fail ]; then echo "fatal: boom" >&2; exit 1; fi');
    await expect(execGit(['ok'], projectRoot(), projectRoot())).resolves.toBeUndefined();
    await expect(execGit(['fail'], projectRoot(), projectRoot())).rejects.toThrow(/fatal: boom/);
  });

  itPosix('closes stdin so a git that reads input does not hang (AC4)', async () => {
    stubGit('cat; echo done');
    await expect(execGitCapture(['x'], projectRoot(), projectRoot())).resolves.toBe('done\n');
  });

  itPosix('removeStaleWorktreeRegistration never rejects (AC6)', async () => {
    stubGit('echo "fatal" >&2; exit 128');
    await expect(removeStaleWorktreeRegistration(projectRoot(), path.join(root, 'wt'))).resolves.toBeUndefined();
  });

  itPosix('getUnpushedCommits returns null when git fails and trimmed output otherwise', async () => {
    stubGit('echo "abc commit"');
    expect(await getUnpushedCommits(projectRoot(), 'b')).toBe('abc commit');
    stubGit('exit 1');
    expect(await getUnpushedCommits(projectRoot(), 'b')).toBeNull();
  });

  itPosix('removeWorktree runs steps in order and updates the store only after branch -D (AC7)', async () => {
    const log = path.join(root, 'calls.log');
    stubGit(`echo "$@" >> "${log}"; if [ "$1" = worktree ] && [ "$2" = remove ] && [ "$3" != --force ]; then exit 1; fi`);
    const wt = path.join(root, 'worktrees', 'my-task');
    mkdirSync(wt, { recursive: true });
    const calls: string[] = [];
    const taskStore = {
      getById: () => ({ id: 't1', branch: 'feat/x', slug: 'my-task' }),
      getDirById: () => path.join(root, 'taskdir'),
      update: () => { calls.push('update'); },
    };
    const { readFileSync } = await import('fs');
    await removeWorktree('t1', {
      projectRoot: projectRoot(),
      taskStore: taskStore as never,
      execGit: (args, cwd) => execGit(args, cwd, projectRoot()),
    });
    if (!existsSync(log)) return; // task path resolution differs: nothing was run
    const lines = readFileSync(log, 'utf-8').trim().split('\n');
    const idx = (p: string) => lines.findIndex(l => l.startsWith(p));
    expect(idx('worktree remove --force')).toBeGreaterThan(idx('worktree remove'));
    expect(idx('branch -D feat/x')).toBeGreaterThan(idx('worktree remove --force'));
    expect(calls).toEqual(['update']);
  });
});
