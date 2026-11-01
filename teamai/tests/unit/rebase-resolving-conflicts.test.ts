import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const sent: string[] = [];
let onSession: () => void = () => {};
vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    createSession: vi.fn(async () => 'sess'),
    sendMessage: vi.fn((_id: string, msg: string) => { sent.push(msg); onSession(); }),
    killSession: vi.fn(),
  },
}));
vi.mock('../../src/lib/command-templates', () => ({
  renderCommand: (name: string, args: string) => `${name} ${args}`,
}));

import { rebaseResolvingConflicts, MAX_REBASE_RESOLVER_SESSIONS_PER_STOP } from '../../src/lib/orchestrator/phase-runners';

/**
 * A scripted git: `stops[i]` is how many merger sessions stop i needs before its
 * conflicts are gone (0 = no conflict at that stop). The first stop is hit by
 * `git rebase`; each `--continue` moves to the next one.
 */
function scriptedGit(stops: number[], opts: { emptyCommitAt?: number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'rebase-driver-'));
  const logDir = mkdtempSync(join(tmpdir(), 'rebase-driver-log-'));
  let stop = 0;
  let sessionsOnStop = 0;
  let inProgress = false;
  const calls: string[][] = [];
  const hasConflict = () => inProgress && sessionsOnStop < (stops[stop] ?? 0);

  const advance = () => {
    stop++;
    sessionsOnStop = 0;
    if (stop >= stops.length) {
      inProgress = false;
      rmSync(join(dir, 'rebase-merge'), { recursive: true, force: true });
    }
  };

  onSession = () => { sessionsOnStop++; };
  const execGit = vi.fn(async (args: string[]) => {
    calls.push(args);
    const cmd = args.filter(a => a !== '-c' && !a.startsWith('core.'));
    if (cmd[0] === 'rebase' && cmd[1] === '--abort') { inProgress = false; return; }
    if (cmd[0] === 'rebase' && cmd[1] === '--skip') { advance(); return; }
    if (cmd[0] === 'rebase' && cmd[1] === '--continue') {
      if (opts.emptyCommitAt === stop) { opts.emptyCommitAt = undefined; throw new Error('No changes - did you forget to use git add?'); }
      advance();
      if (inProgress && hasConflict()) throw new Error('CONFLICT');
      return;
    }
    if (cmd[0] === 'rebase') {
      if ((stops[0] ?? 0) === 0 && stops.length === 1) return; // clean
      inProgress = true;
      mkdirSync(join(dir, 'rebase-merge'), { recursive: true });
      if (hasConflict()) throw new Error('CONFLICT');
      // a leading conflict-free stops are walked by the orchestrator via --continue
      throw new Error('stopped');
    }
  });
  const execGitCapture = vi.fn(async (args: string[]) => {
    if (args[0] === 'rev-parse') return join(dir, args[2]);
    if (args[0] === 'diff') return hasConflict() ? 'src/a.ts\n' : '';
    return '';
  });
  const deps = {
    execGit, execGitCapture,
    sessionOpts: vi.fn(() => ({}) as never),
    waitForCompletion: vi.fn(async () => undefined),
  };
  const run = () => rebaseResolvingConflicts(deps as never, {
    worktreePath: dir, taskId: 't1', targetRef: 'origin/main', targetLabel: 'main', logDir,
  });
  return { run, calls, deps, logDir };
}

beforeEach(() => { sent.length = 0; onSession = () => {}; });

describe('rebaseResolvingConflicts', () => {
  it('returns clean without any merger when the rebase has no conflicts', async () => {
    const g = scriptedGit([0]);
    expect(await g.run()).toBe('clean');
    expect(sent).toHaveLength(0);
  });

  it('spawns the merger for a conflicting stop, then continues the rebase itself', async () => {
    const g = scriptedGit([1]);
    expect(await g.run()).toBe('resolved');
    expect(sent).toEqual(['resolve-rebase origin/main']);
    const flat = g.calls.map(a => a.join(' '));
    expect(flat.some(c => c.startsWith('add -A'))).toBe(true);
    expect(flat.some(c => c.includes('rebase --continue'))).toBe(true);
    expect(flat.some(c => c.startsWith('merge') || c.startsWith('commit'))).toBe(false);
  });

  it('keeps spawning the merger while the stop still has unmerged files', async () => {
    const g = scriptedGit([3]);
    expect(await g.run()).toBe('resolved');
    expect(sent).toHaveLength(3);
  });

  it('resolves every conflicting stop in turn', async () => {
    const g = scriptedGit([1, 1, 2]);
    expect(await g.run()).toBe('resolved');
    expect(sent).toHaveLength(4);
  });

  it('skips a replayed commit that became empty after the resolution', async () => {
    const g = scriptedGit([1], { emptyCommitAt: 0 });
    expect(await g.run()).toBe('resolved');
    expect(g.calls.some(a => a.includes('--skip'))).toBe(true);
  });

  it('aborts the rebase and fails when the merger never resolves the stop', async () => {
    const g = scriptedGit([99]);
    expect(await g.run()).toBe('failed');
    expect(sent).toHaveLength(MAX_REBASE_RESOLVER_SESSIONS_PER_STOP);
    expect(g.calls.some(a => a.join(' ') === 'rebase --abort')).toBe(true);
    expect(readFileSync(join(g.logDir, 'output.log'), 'utf-8')).toContain('still unmerged after');
  });

  it('aborts and fails without a merger when the rebase fails for a non-conflict reason', async () => {
    const g = scriptedGit([0]);
    g.deps.execGit.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rebase' && args[1] === 'origin/main') throw new Error('fatal: cannot lock ref');
    });
    expect(await g.run()).toBe('failed');
    expect(sent).toHaveLength(0);
    expect(g.deps.execGit).toHaveBeenCalledWith(['rebase', '--abort'], expect.any(String));
  });

  it('aborts and fails when the merger session itself fails', async () => {
    const g = scriptedGit([1]);
    g.deps.waitForCompletion.mockRejectedValueOnce(new Error('session exited'));
    expect(await g.run()).toBe('failed');
    expect(g.calls.some(a => a.join(' ') === 'rebase --abort')).toBe(true);
  });
});
