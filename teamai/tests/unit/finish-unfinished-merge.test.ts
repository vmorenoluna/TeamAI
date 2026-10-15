import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { finishUnfinishedMerge } from '../../src/lib/orchestrator/phase-runners';

function makeDeps(captures: Record<string, string>) {
  const execGit = vi.fn();
  const execGitCapture = vi.fn((args: string[]) => captures[args[0] === 'diff' ? 'unmerged' : 'status'] ?? '');
  return { execGit, execGitCapture };
}
const logDir = () => mkdtempSync(join(tmpdir(), 'finish-merge-'));

describe('finishUnfinishedMerge', () => {
  it('does nothing when the merger committed everything', () => {
    const deps = makeDeps({});
    expect(finishUnfinishedMerge(deps, '/wt', logDir())).toBe(true);
    expect(deps.execGit).not.toHaveBeenCalled();
  });

  it('commits a staged resolution past the pre-commit hook', () => {
    const deps = makeDeps({ status: 'M  src/a.ts' });
    expect(finishUnfinishedMerge(deps, '/wt', logDir())).toBe(true);
    const commit = deps.execGit.mock.calls.find(c => c[0][0] === 'commit');
    expect(commit?.[0]).toContain('--no-verify');
  });

  it('refuses to push when conflicts remain unmerged', () => {
    const deps = makeDeps({ unmerged: 'src/a.ts' });
    expect(finishUnfinishedMerge(deps, '/wt', logDir())).toBe(false);
    expect(deps.execGit).not.toHaveBeenCalled();
  });
});
