import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';
import { buildCherryPickArgs } from '../../src/lib/orchestrator/implement';

let repo: string;
const git = (...args: string[]) =>
  execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
const commit = (file: string, content: string, msg: string) => {
  writeFileSync(path.join(repo, file), content);
  git('add', '-A');
  git('commit', '-q', '-m', msg);
};

beforeEach(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'cp-merge-'));
  git('init', '-q', '-b', 'base');
  git('config', 'user.email', 't@example.com');
  git('config', 'user.name', 'T');
  git('config', 'commit.gpgsign', 'false');
  commit('a.txt', 'a\n', 'init');
  git('branch', 'feat');
  git('branch', 'feat-st1');
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

describe('buildCherryPickArgs', () => {
  it('returns the plain range when the subtask range has no merge commit', async () => {
    git('checkout', '-q', 'feat-st1');
    commit('s.txt', 's\n', 'subtask work');
    expect(await buildCherryPickArgs(repo, 'feat', 'feat-st1')).toEqual(['cherry-pick', 'feat..feat-st1']);
  });

  it('replays only non-merge commits when a merge commit sits in the range, and the replay succeeds', async () => {
    // Upstream advances; the subtask branch syncs it with a merge commit.
    git('checkout', '-q', 'base');
    commit('up.txt', 'up\n', 'upstream change');
    git('checkout', '-q', 'feat-st1');
    commit('s1.txt', 's1\n', 'subtask work 1');
    git('merge', '-q', '--no-ff', '-m', 'sync upstream', 'base');
    commit('s2.txt', 's2\n', 'subtask work 2');
    // The feature branch took the same upstream change by rebase (same patch, different sha).
    git('checkout', '-q', 'feat');
    git('cherry-pick', 'base');

    // Sanity: a plain range cherry-pick fails on the merge commit.
    expect(() => git('cherry-pick', 'feat..feat-st1')).toThrow();
    git('cherry-pick', '--abort');

    const args = await buildCherryPickArgs(repo, 'feat', 'feat-st1');
    expect(args).not.toBeNull();
    expect(args![0]).toBe('cherry-pick');
    expect(args!.slice(1)).toHaveLength(2);
    git(...args!);
    expect(git('log', '--format=%s', 'feat').split('\n')).toEqual(
      ['subtask work 2', 'subtask work 1', 'upstream change', 'init']);
  });

  it('returns null when every commit in a merge-containing range is already on the feature branch', async () => {
    git('checkout', '-q', 'base');
    commit('up.txt', 'up\n', 'upstream change');
    git('checkout', '-q', 'feat-st1');
    git('merge', '-q', '--no-ff', '-m', 'sync upstream', 'base');
    git('checkout', '-q', 'feat');
    git('cherry-pick', 'base');
    expect(await buildCherryPickArgs(repo, 'feat', 'feat-st1')).toBeNull();
  });
});
