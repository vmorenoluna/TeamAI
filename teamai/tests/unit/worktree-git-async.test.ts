import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';

// execFile is mocked file-wide; by default it delegates to the real one so the
// real-repo / stub-on-PATH tests exercise real processes. `h.handler` overrides it.
const h = await vi.hoisted(async () => {
  const { createExecFileMock } = await import('../utils/mock-child-process');
  const real = (await vi.importActual<typeof import('child_process')>('child_process')).execFile;
  const state: { handler: null | ((file: string, args: string[]) => unknown) } = { handler: null };
  const exec = createExecFileMock({
    handler: (file, args, opts) => {
      if (state.handler) return state.handler(file, args) as never;
      return new Promise((resolve, reject) => {
        real(file, args, { ...(opts as object), encoding: 'utf-8' }, (err, stdout, stderr) =>
          err ? reject(Object.assign(err, { stdout, stderr })) : resolve({ stdout: String(stdout), stderr: String(stderr) }));
      });
    },
  });
  return { exec, state };
});

vi.mock('child_process', async (orig) => {
  const { buildChildProcessMock } = await import('../utils/mock-child-process');
  return buildChildProcessMock(await orig<typeof import('child_process')>(), h.exec);
});

import { execGit, execGitCapture, execGitQueued, removeStaleWorktreeRegistration } from '../../src/lib/orchestrator/worktree-utils';
import { removeWorktree, getUnpushedCommits } from '../../src/lib/orchestrator/worktree-ops';
import { readCommonArtifacts } from '../../src/lib/task-artifacts';
import { execFileError } from '../utils/mock-child-process';

const itPosix = process.platform === 'win32' ? it.skip : it;

describe('async git primitives', () => {
  let root: string;
  let project: string;
  let origPath: string | undefined;

  beforeEach(() => {
    h.state.handler = null;
    h.exec.mockClear();
    root = mkdtempSync(path.join(os.tmpdir(), 'git-async-'));
    project = path.join(root, 'project');
    mkdirSync(path.join(project, '.teamai'), { recursive: true });
    writeFileSync(path.join(project, '.teamai', 'container.json'), JSON.stringify({ enabled: false }));
    origPath = process.env.PATH;
  });

  afterEach(() => {
    process.env.PATH = origPath;
    rmSync(root, { recursive: true, force: true });
  });

  function stubGit(script: string) {
    const bin = path.join(root, 'bin');
    mkdirSync(bin, { recursive: true });
    const file = path.join(bin, 'git');
    writeFileSync(file, `#!/bin/sh\n${script}\n`);
    chmodSync(file, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${origPath}`;
  }

  function initRepo() {
    const git = (...a: string[]) => execFileSync('git', a, { cwd: project, stdio: 'pipe' });
    git('init', '-b', 'main');
    git('config', 'user.email', 't@t.dev');
    git('config', 'user.name', 'T');
    writeFileSync(path.join(project, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-m', 'init');
    return git;
  }

  describe('AC3 — errors and output', () => {
    it('execGit rejects with git stderr in the message', async () => {
      initRepo();
      const err = await execGit(['rev-parse', '--verify', 'no-such-ref'], project, project).catch(e => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(/Command failed/);
      expect(err.message).toMatch(/fatal|Needed a single revision/i);
      expect(typeof err.stderr).toBe('string');
      expect(err.stderr.length).toBeGreaterThan(0);
    });

    it('execGitCapture rev-parse HEAD resolves a 40-hex SHA plus newline', async () => {
      initRepo();
      expect(await execGitCapture(['rev-parse', 'HEAD'], project, project)).toMatch(/^[0-9a-f]{40}\n$/);
    });
  });

  describe('AC4 — event loop is not blocked', () => {
    itPosix('timers keep firing during a slow git call', async () => {
      stubGit('sleep 0.3; echo out');
      let ticks = 0;
      const timer = setInterval(() => { ticks++; }, 10);
      const start = Date.now();
      const out = await execGitCapture(['rev-parse', 'HEAD'], project, project);
      clearInterval(timer);
      expect(Date.now() - start).toBeGreaterThanOrEqual(200);
      expect(out).toBe('out\n');
      expect(ticks).toBeGreaterThanOrEqual(5);
    });

    it('closes the child stdin right after spawn', async () => {
      h.state.handler = () => 'done\n';
      await execGitCapture(['x'], project, project);
      const child = h.exec.mock.results[0].value as { stdin: { end: ReturnType<typeof vi.fn> } };
      expect(child.stdin.end).toHaveBeenCalledTimes(1);
    });
  });

  describe('R1 — execFile options', () => {
    it('uses utf-8, a 32 MiB maxBuffer and no timeout', async () => {
      h.state.handler = () => 'ok';
      await execGitCapture(['status'], project, project);
      const opts = h.exec.mock.calls[0][2] as Record<string, unknown>;
      expect(opts).toMatchObject({ encoding: 'utf-8', maxBuffer: 32 * 1024 * 1024 });
      expect(opts).not.toHaveProperty('timeout');
    });
  });

  describe('AC5 — per-project worktree/branch queue', () => {
    function recorder() {
      const events: string[] = [];
      const releases: Array<() => void> = [];
      h.state.handler = (_f, args) => new Promise((resolve, reject) => {
        const id = args.join(' ');
        events.push(`start ${id}`);
        releases.push(() => {
          events.push(`finish ${id}`);
          if (id.includes('fail')) reject(execFileError('git', args, 'fatal: boom'));
          else resolve('');
        });
      });
      return { events, releases };
    }
    const tick = () => new Promise(r => setTimeout(r, 20));

    it('serializes two worktree add calls for one projectRoot (FIFO)', async () => {
      const { events, releases } = recorder();
      const a = execGit(['worktree', 'add', 'one'], project, project);
      const b = execGit(['worktree', 'add', 'two'], project, project);
      await tick();
      expect(events).toEqual(['start worktree add one']);
      releases[0]();
      await a;
      await tick();
      expect(events).toEqual(['start worktree add one', 'finish worktree add one', 'start worktree add two']);
      releases[1]();
      await b;
    });

    it('a rejected first command does not stall the second', async () => {
      const { events, releases } = recorder();
      const a = execGit(['worktree', 'add', 'fail'], project, project);
      const aSettled = a.catch(e => e);
      const b = execGitQueued(['branch', '-D', 'x'], project, project);
      await tick();
      releases[0]();
      expect(await aSettled).toBeInstanceOf(Error);
      await tick();
      expect(events).toContain('start branch -D x');
      releases[1]();
      await b;
    });

    it('does not serialize other commands, nor different projects', async () => {
      const { events } = recorder();
      void execGit(['status'], project, project);
      void execGit(['log'], project, project);
      void execGit(['worktree', 'add', 'p2'], path.join(root, 'other'), path.join(root, 'other'));
      void execGit(['worktree', 'add', 'p1'], project, project);
      await tick();
      expect(events.sort()).toEqual(['start log', 'start status', 'start worktree add p1', 'start worktree add p2']);
    });
  });

  describe('R1 — removeStaleWorktreeRegistration / getUnpushedCommits', () => {
    it('removeStaleWorktreeRegistration never rejects', async () => {
      h.state.handler = (_f, args) => { throw execFileError('git', args, 'fatal'); };
      await expect(removeStaleWorktreeRegistration(project, path.join(root, 'wt'))).resolves.toBeUndefined();
    });

    it('getUnpushedCommits is trimmed output, or null on failure', async () => {
      h.state.handler = () => 'abc commit\n';
      expect(await getUnpushedCommits(project, 'b')).toBe('abc commit');
      h.state.handler = (_f, args) => { throw execFileError('git', args, 'fatal'); };
      expect(await getUnpushedCommits(project, 'b')).toBeNull();
    });
  });

  describe('AC7 — removeWorktree best-effort ordering', () => {
    it('both removes rejecting: manual delete + registration cleanup, branch -D, branch cleared, resolves', async () => {
      const wt = path.join(root, 'worktrees', 'my-task');
      mkdirSync(wt, { recursive: true });
      const calls: string[] = [];
      h.state.handler = (_f, args) => {
        calls.push(args.join(' '));
        if (args[0] === 'worktree' && args[1] === 'remove' && args[2] === wt) throw execFileError('git', args, 'fatal: locked');
        if (args[0] === 'worktree' && args[1] === 'remove' && args[2] === '--force' && args[3] === wt) throw execFileError('git', args, 'fatal: locked');
        return '';
      };
      const update = vi.fn(() => { calls.push('update'); });
      const taskStore = {
        getById: () => ({ id: 't1', branch: 'feat/x', slug: 'my-task' }),
        getDirById: () => path.join(root, 'taskdir'),
        update,
      };
      await removeWorktree('t1', {
        projectRoot: project,
        taskStore: taskStore as never,
        execGit: (args, cwd) => execGit(args, cwd, project),
      });
      expect(existsSync(wt)).toBe(false);
      expect(calls).toEqual([
        'log origin/feat/x..feat/x --oneline',
        `worktree remove ${wt}`,
        `worktree remove --force ${wt}`,
        'worktree remove --force my-task',
        'branch -D feat/x',
        'update',
      ]);
      expect(update).toHaveBeenCalledWith('t1', { branch: undefined });
    });
  });

  describe('AC8 — readCommonArtifacts', () => {
    it('falls back to diff.txt when git diff fails, and never rejects', async () => {
      const dir = path.join(root, 'task');
      mkdirSync(dir);
      h.state.handler = (_f, args) => { throw execFileError('git', args, 'fatal: bad revision'); };
      writeFileSync(path.join(dir, 'diff.txt'), 'canned');
      expect((await readCommonArtifacts(dir, project, 'feat/x')).diff).toBe('canned');
      rmSync(path.join(dir, 'diff.txt'));
      expect((await readCommonArtifacts(dir, project, 'feat/x')).diff).toBeNull();
    });
  });

  it('AC1 — no sync child_process API or Sync twins in the converted modules', () => {
    for (const f of ['src/lib/orchestrator/worktree-utils.ts', 'src/lib/orchestrator/worktree-ops.ts', 'src/lib/task-artifacts.ts']) {
      const src = readFileSync(path.join(process.cwd(), f), 'utf-8');
      expect(src).not.toMatch(/execFileSync|execSync|spawnSync|execGitSync|execGitCaptureSync/);
    }
  });
});
