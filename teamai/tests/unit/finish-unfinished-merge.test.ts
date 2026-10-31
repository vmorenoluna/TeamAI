import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { finishUnfinishedMerge } from '../../src/lib/orchestrator/phase-runners';

function makeDeps(captures: Record<string, string>) {
  const execGit = vi.fn(async (_args: string[]) => undefined);
  const execGitCapture = vi.fn(async (args: string[]) => captures[args[0] === 'diff' ? 'unmerged' : 'status'] ?? '');
  return { execGit, execGitCapture };
}
const logDir = () => mkdtempSync(join(tmpdir(), 'finish-merge-'));

describe('finishUnfinishedMerge', () => {
  it('does nothing when the merger committed everything', async () => {
    const deps = makeDeps({});
    expect(await finishUnfinishedMerge(deps, '/wt', logDir())).toBe(true);
    expect(deps.execGit).not.toHaveBeenCalled();
  });

  it('commits a staged resolution past the pre-commit hook', async () => {
    const deps = makeDeps({ status: 'M  src/a.ts' });
    expect(await finishUnfinishedMerge(deps, '/wt', logDir())).toBe(true);
    const commit = deps.execGit.mock.calls.find(c => c[0][0] === 'commit');
    expect(commit?.[0]).toContain('--no-verify');
  });

  it('refuses to push when conflicts remain unmerged', async () => {
    const deps = makeDeps({ unmerged: 'src/a.ts' });
    expect(await finishUnfinishedMerge(deps, '/wt', logDir())).toBe(false);
    expect(deps.execGit).not.toHaveBeenCalled();
  });
});

describe('finishUnfinishedMerge — rebase in progress', () => {
  /** Mock git whose rebase advances through `stops` (each with its own unmerged list). */
  function rebasing(stops: string[]) {
    const dir = mkdtempSync(join(tmpdir(), 'finish-rebase-'));
    let stop = 0;
    const execGit = vi.fn(async (args: string[]) => {
      if (args.includes('--continue')) {
        stop++;
        if (stop >= stops.length) rmSync(join(dir, 'rebase-merge'), { recursive: true, force: true });
        else if (stops[stop]) throw new Error('CONFLICT');
      }
    });
    mkdirSync(join(dir, 'rebase-merge'));
    const execGitCapture = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse') return args[2] === 'rebase-merge' ? join(dir, 'rebase-merge') : join(dir, 'rebase-apply');
      if (args[0] === 'diff') return stops[stop] ?? '';
      return '';
    });
    return { deps: { execGit, execGitCapture }, execGit };
  }

  it('continues a resolved rebase to completion without committing a merge', async () => {
    const { deps, execGit } = rebasing(['']);
    expect(await finishUnfinishedMerge(deps, '/wt', logDir())).toBe(true);
    const calls = execGit.mock.calls.map(c => c[0]);
    expect(calls.some(a => a.includes('rebase') && a.includes('--continue'))).toBe(true);
    expect(calls.some(a => a[0] === 'merge')).toBe(false);
  });

  it('continues through every stop the merger resolved', async () => {
    const { deps, execGit } = rebasing(['', '', '']);
    expect(await finishUnfinishedMerge(deps, '/wt', logDir())).toBe(true);
    expect(execGit.mock.calls.filter(c => c[0].includes('--continue'))).toHaveLength(3);
  });

  it('fails when a later stop is left conflicted, so the caller aborts the rebase', async () => {
    const { deps } = rebasing(['', 'src/a.ts']);
    expect(await finishUnfinishedMerge(deps, '/wt', logDir())).toBe(false);
  });
});
