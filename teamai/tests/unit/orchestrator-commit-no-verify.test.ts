import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { execFileSync } from 'child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative } from 'path';
import { autoCommitSubtaskChanges, type ImplementDeps, type ImplementPipeline } from '@/lib/orchestrator/implement';
import type { PlanSubtask } from '@/lib/orchestrator/types';

// implement.ts transitively loads process-manager -> node-pty (native); not needed here.
vi.mock('node-pty', () => ({ spawn: vi.fn() }));

const SRC_LIB = join(__dirname, '..', '..', 'src', 'lib');

function collectTsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...collectTsFiles(full));
    else if (name.endsWith('.ts')) out.push(full);
  }
  return out;
}

describe('orchestrator safety-net commits bypass project hooks (static guard)', () => {
  it('every [\'commit\', <flag>, ...] array uses --no-verify, except the final squash', () => {
    const files = [...collectTsFiles(join(SRC_LIB, 'orchestrator')), join(SRC_LIB, 'orchestrator.ts')];
    const offenders: string[] = [];
    let total = 0;
    for (const file of files) {
      const src = readFileSync(file, 'utf-8');
      const re = /\[\s*'commit'\s*,\s*'([^']*)'/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src)) !== null) {
        total++;
        const flag = m[1];
        const rel = relative(SRC_LIB, file).replace(/\\/g, '/');
        const exempt = flag === '--allow-empty' && rel === 'orchestrator/artifact-commit.ts';
        if (flag !== '--no-verify' && !exempt) {
          const line = src.slice(0, m.index).split('\n').length;
          offenders.push(`${rel}:${line} ['commit', '${flag}', ...]`);
        }
      }
    }
    expect(offenders).toEqual([]);
    expect(total).toBeGreaterThanOrEqual(9);
  });
});

describe('autoCommitSubtaskChanges with failing project hooks (real git)', () => {
  let repo: string;
  let specPath: string;

  const git = (args: string[]) =>
    execFileSync('git', args, { cwd: repo, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'commit-no-verify-'));
    git(['init']);
    git(['config', 'user.name', 'Test']);
    git(['config', 'user.email', 'test@example.com']);
    git(['config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(['add', '-A']);
    git(['commit', '-m', 'initial']);

    const hooks = join(repo, '..', `${repo.split(/[\\/]/).pop()}-hooks`);
    mkdirSync(hooks, { recursive: true });
    for (const name of ['pre-commit', 'commit-msg']) {
      writeFileSync(join(hooks, name), '#!/bin/sh\nexit 1\n');
      chmodSync(join(hooks, name), 0o755);
    }
    git(['config', 'core.hooksPath', hooks]);

    specPath = join(repo, '.teamai', 'task');
    mkdirSync(specPath, { recursive: true });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(`${repo}-hooks`, { recursive: true, force: true });
  });

  it('plain git commit is rejected by the hooks (sanity)', () => {
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    git(['add', '-A']);
    expect(() => git(['commit', '-m', 'x'])).toThrow();
  });

  it('still creates the WIP commit and leaves the tree clean apart from .teamai/', async () => {
    writeFileSync(join(repo, 'a.txt'), 'two\n');
    writeFileSync(join(repo, 'b.txt'), 'new\n');
    const before = git(['rev-list', '--count', 'HEAD']).trim();

    const deps = {
      execGit: (args: string[], cwd: string) => { execFileSync('git', args, { cwd, stdio: 'pipe' }); },
      execGitCapture: (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf-8' }),
    } as unknown as ImplementDeps;
    const pipeline = { specPath } as unknown as ImplementPipeline;
    const subtask = { id: 3, title: 't', description: 'd', files: ['a.txt'] } as unknown as PlanSubtask;

    await autoCommitSubtaskChanges(pipeline, deps, subtask, repo);

    expect(Number(git(['rev-list', '--count', 'HEAD']).trim())).toBe(Number(before) + 1);
    expect(git(['log', '-1', '--format=%s']).startsWith('WIP: auto-commit subtask 3 changes')).toBe(true);
    const dirty = git(['status', '--porcelain']).split('\n').filter(l => l.trim() && !l.includes('.teamai'));
    expect(dirty).toEqual([]);

    const log = readFileSync(join(specPath, 'output.log'), 'utf-8');
    expect(log).toContain('[COMMIT-GUARD] Subtask 3 left uncommitted changes — auto-committed');
    expect(log).not.toContain('Failed to auto-commit');
  });
});
