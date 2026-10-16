import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import os from 'os';
import path from 'path';
import { readCommonArtifacts } from '../../src/lib/task-artifacts';

describe('readCommonArtifacts (async)', () => {
  let root: string;
  let repo: string;
  let dir: string;

  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'pipe' });

  beforeEach(() => {
    root = mkdtempSync(path.join(os.tmpdir(), 'rca-'));
    repo = path.join(root, 'repo');
    dir = path.join(root, 'task');
    mkdirSync(repo);
    mkdirSync(dir);
    git('init', '-b', 'main');
    git('config', 'user.email', 't@t.dev');
    git('config', 'user.name', 'T');
    writeFileSync(path.join(repo, 'a.txt'), 'one\n');
    git('add', 'a.txt');
    git('commit', '-m', 'init');
    git('checkout', '-b', 'feat/x');
    writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    git('commit', '-am', 'change');
    git('checkout', 'main');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('returns the base...branch diff from a real repo (AC10)', async () => {
    const r = await readCommonArtifacts(dir, repo, 'feat/x');
    expect(r.diff).toContain('diff --git a/a.txt b/a.txt');
    expect(r.diff).toContain('+two');
  });

  it('falls back to diff.txt when the branch does not exist', async () => {
    writeFileSync(path.join(dir, 'diff.txt'), 'canned');
    const r = await readCommonArtifacts(dir, repo, 'does-not-exist');
    expect(r.diff).toBe('canned');
  });

  it('returns null diff when the branch does not exist and there is no diff.txt', async () => {
    const r = await readCommonArtifacts(dir, repo, 'does-not-exist');
    expect(r.diff).toBeNull();
  });
});
