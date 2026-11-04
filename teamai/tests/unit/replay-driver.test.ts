import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const sent: string[] = [];
let onSession: () => void = () => {};
vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    createSession: vi.fn(async () => 'sess'),
    sendMessage: vi.fn((_id: string, msg: string) => { sent.push(msg); }),
    killSession: vi.fn(),
  },
}));
vi.mock('../../src/lib/command-templates', () => ({
  renderCommand: (name: string, args: string) => `${name}\n${args}`,
}));
const runSensors = vi.fn();
vi.mock('../../src/lib/sensors', () => ({ runSensors: (...a: unknown[]) => runSensors(...a) }));
// Container mode is controlled per test; the default is "no Docker".
const containerState = { enabled: false };
vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: () => ({ enabled: containerState.enabled, explicit: true }),
  readContainerRemoteUser: () => 'vscode',
  hostToContainerPath: (p: string, root: string, ws: string) => `${ws}/${p.replace(root, '').replace(/\\/g, '/').replace(/^\//, '')}`,
  containerManager: { getRunningContainer: vi.fn(async () => ({ containerId: 'cid1', remoteWorkspaceFolder: '/workspaces/proj' })) },
}));

import { rebaseResolvingConflicts } from '../../src/lib/orchestrator/phase-runners';
import { driveReplay, replayConfig, CHECKS_WAIVER_FILE } from '../../src/lib/orchestrator/replay-driver';
import { RateLimitError } from '../../src/lib/orchestrator/rate-limit';
import { WorktreeError } from '../../src/lib/orchestrator/errors';

type Kind = 'rebase' | 'cherry-pick';

/**
 * A scripted git. `stops[i]` is how many merger sessions stop i needs before its
 * conflicts are gone (0 = no conflict at that stop). `--continue` / `--skip`
 * move to the next stop; the operation ends after the last one.
 */
function scriptedGit(stops: number[], opts: { kind?: Kind; started?: boolean; emptyCommitAt?: number } = {}) {
  const kind = opts.kind ?? 'rebase';
  const dir = mkdtempSync(join(tmpdir(), 'replay-driver-'));
  const logDir = mkdtempSync(join(tmpdir(), 'replay-driver-log-'));
  let stop = 0;
  let sessionsOnStop = 0;
  let inProgress = opts.started ?? false;
  let emptyAt = opts.emptyCommitAt;
  const calls: string[][] = [];
  const hasConflict = () => inProgress && sessionsOnStop < (stops[stop] ?? 0);

  const advance = () => {
    stop++;
    sessionsOnStop = 0;
    if (stop >= stops.length) inProgress = false;
  };
  onSession = () => { sessionsOnStop++; };

  const execGit = vi.fn(async (args: string[]) => {
    calls.push(args);
    const cmd = args.filter(a => a !== '-c' && !a.startsWith('core.'));
    if (cmd[0] === kind && cmd[1] === '--abort') { inProgress = false; return; }
    if (cmd[0] === kind && cmd[1] === '--skip') { advance(); return; }
    if (cmd[0] === kind && cmd[1] === '--continue') {
      if (emptyAt === stop) { emptyAt = undefined; throw new Error('No changes - did you forget to use git add?'); }
      advance();
      if (inProgress && hasConflict()) throw new Error('CONFLICT');
      return;
    }
    if (cmd[0] === kind) {
      // initial start
      if (stops.length === 1 && (stops[0] ?? 0) === 0) return; // clean
      inProgress = true;
      throw new Error('CONFLICT');
    }
  });
  const execGitCapture = vi.fn(async (args: string[]) => {
    // "In progress" is asked of git (REBASE_HEAD / CHERRY_PICK_HEAD), never of the host filesystem: `dir` holds
    // no .git at all, and in container mode git reports container paths that do not exist on the host.
    if (args[0] === 'rev-parse' && (args.includes('CHERRY_PICK_HEAD') || args.includes('REBASE_HEAD'))) {
      if (!inProgress) throw new Error('fatal: Needed a single revision');
      return '0123456789abcdef0123456789abcdef01234567\n';
    }
    if (args[0] === 'diff') return hasConflict() ? 'src/a.ts\n' : '';
    return '';
  });
  const deps = {
    execGit, execGitCapture,
    sessionOpts: vi.fn(() => ({}) as never),
    waitForCompletion: vi.fn(async () => { onSession(); }),
  };
  const drive = (extra: Record<string, unknown> = {}) => driveReplay(deps as never, {
    kind, worktreePath: dir, taskId: 't1', projectRoot: dir, logDir, request: 'REQ', ...extra,
  });
  const rebase = () => rebaseResolvingConflicts(deps as never, {
    worktreePath: dir, taskId: 't1', projectRoot: dir, targetRef: 'origin/main', targetLabel: 'main', logDir,
  });
  const flat = () => calls.map(a => a.join(' '));
  return { drive, rebase, calls, flat, deps, logDir };
}

beforeEach(() => {
  sent.length = 0;
  onSession = () => {};
  containerState.enabled = false;
  runSensors.mockReset();
  replayConfig.sessionFailureBackoffMs = 0;
  replayConfig.maxConsecutiveSessionFailures = 5;
});

describe('rebaseResolvingConflicts', () => {
  it('returns clean without any merger when the rebase has no conflicts', async () => {
    const g = scriptedGit([0]);
    expect(await g.rebase()).toBe('clean');
    expect(sent).toHaveLength(0);
  });

  it('spawns the merger for the conflicting stop and continues the rebase itself, never merging', async () => {
    const g = scriptedGit([1]);
    expect(await g.rebase()).toBe('resolved');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('resolve-rebase');
    expect(sent[0]).toContain('Rebasing onto: origin/main');
    expect(g.flat().some(c => c.startsWith('add -A'))).toBe(true);
    expect(g.flat().some(c => c.includes('rebase --continue'))).toBe(true);
    expect(g.flat().some(c => c.startsWith('merge') || c.startsWith('commit'))).toBe(false);
  });

  it('aborts and reports failed after retrying a rebase that fails without conflicts, with no merger', async () => {
    const g = scriptedGit([0]);
    g.deps.execGit.mockImplementation(async (args: string[]) => {
      if (args[0] === 'rebase' && args[1] === 'origin/main') throw new Error('fatal: cannot lock ref');
    });
    expect(await g.rebase()).toBe('failed');
    expect(sent).toHaveLength(0);
    expect(g.deps.execGit.mock.calls.filter(c => c[0][0] === 'rebase' && c[0][1] === 'origin/main')).toHaveLength(3);
    expect(g.deps.execGit).toHaveBeenCalledWith(['rebase', '--abort'], expect.any(String));
  });
});

describe('driveReplay', () => {
  it('respawns the merger for as long as the stop still has unmerged files — there is no cap', async () => {
    const g = scriptedGit([12], { started: true });
    await g.drive();
    expect(sent).toHaveLength(12);
  });

  it('resolves every conflicting stop in turn', async () => {
    const g = scriptedGit([1, 0, 2], { started: true });
    // stop 1 has no conflict of its own: the orchestrator continues through it
    await g.drive();
    expect(sent).toHaveLength(3);
  });

  it('skips a replayed commit that became empty after the resolution', async () => {
    const g = scriptedGit([1], { started: true, emptyCommitAt: 0 });
    await g.drive();
    expect(g.flat().some(c => c === 'rebase --skip')).toBe(true);
  });

  it('drives a cherry-pick with the cherry-pick commands and the resolve-cherry-pick command', async () => {
    const g = scriptedGit([1], { kind: 'cherry-pick', started: true, emptyCommitAt: undefined });
    await g.drive();
    expect(sent[0]).toContain('resolve-cherry-pick');
    expect(g.flat().some(c => c.includes('cherry-pick --continue'))).toBe(true);
    expect(g.flat().some(c => c.includes('rebase'))).toBe(false);
  });

  describe('verification', () => {
    const failing = { allPassed: false, reports: [{ passed: false, sensor: 'tests', command: 'npm test', exitCode: 1, stderr: 'boom', stdout: '' }] };
    const passing = { allPassed: true, reports: [] };

    it('runs the project checks after a resolution and sends the failing output back to the merger', async () => {
      const g = scriptedGit([1], { started: true });
      runSensors.mockResolvedValueOnce(failing).mockResolvedValueOnce(passing);
      await g.drive({ sensors: [{ command: 'npm test' }] });
      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain('Verification failed after your previous resolution');
      expect(sent[1]).toContain('npm test');
      expect(sent[1]).toContain('boom');
      expect(runSensors).toHaveBeenCalledTimes(2);
      // the continue happens only after the checks passed
      expect(g.flat().filter(c => c.includes('--continue'))).toHaveLength(1);
    });

    it('keeps respawning the merger while the checks keep failing', async () => {
      const g = scriptedGit([1], { started: true });
      for (let i = 0; i < 6; i++) runSensors.mockResolvedValueOnce(failing);
      runSensors.mockResolvedValue(passing);
      await g.drive({ sensors: [{ command: 'npm test' }] });
      expect(sent).toHaveLength(7);
    });

    it('accepts a failure the merger declared unrelated, and says so in the log', async () => {
      const g = scriptedGit([1], { started: true });
      runSensors.mockImplementation(async () => {
        writeFileSync(join(g.logDir, CHECKS_WAIVER_FILE), 'fails on base too');
        return failing;
      });
      await g.drive({ sensors: [{ command: 'npm test' }] });
      expect(sent).toHaveLength(1);
      expect(existsSync(join(g.logDir, CHECKS_WAIVER_FILE))).toBe(false);
      expect(readFileSync(join(g.logDir, 'output.log'), 'utf-8')).toContain('fails on base too');
    });

    it('runs the checks on the host without Docker', async () => {
      const g = scriptedGit([1], { started: true });
      runSensors.mockResolvedValue(passing);
      await g.drive({ sensors: [{ command: 'npm test' }] });
      expect(runSensors.mock.calls[0][2].container).toBeUndefined();
    });

    it('runs the checks inside the container in container mode, with the worktree mapped to its container path', async () => {
      containerState.enabled = true;
      const g = scriptedGit([1], { started: true });
      runSensors.mockResolvedValue(passing);
      await g.drive({ sensors: [{ command: 'npm test' }], projectRoot: '/host/proj', worktreePath: '/host/proj/.worktrees/wt' });
      const c = runSensors.mock.calls[0][2].container;
      expect(c).toMatchObject({ containerId: 'cid1', user: 'vscode', cwd: '/workspaces/proj/.worktrees/wt' });
      expect(c.mapPath('/host/proj/.teamai/t/sensors/x.json')).toBe('/workspaces/proj/.teamai/t/sensors/x.json');
    });

    it('continues with hooks and the editor disabled through a path that exists on no platform', async () => {
      const g = scriptedGit([1], { started: true });
      await g.drive();
      const cont = g.calls.find(a => a.includes('--continue'))!;
      expect(cont).toContain('core.hooksPath=.teamai-no-hooks');
      expect(cont.join(' ')).not.toContain('/dev/null');
    });

    it('does not run the checks for a stop that had no conflicts', async () => {
      const g = scriptedGit([0, 0], { started: true });
      await g.drive({ sensors: [{ command: 'npm test' }] });
      expect(sent).toHaveLength(0);
      expect(runSensors).not.toHaveBeenCalled();
    });

    it('asks the merger to run the tests itself when no check is configured', async () => {
      const g = scriptedGit([1], { started: true });
      await g.drive({ sensors: [] });
      expect(sent[0]).toContain('No verification command is configured');
      expect(runSensors).not.toHaveBeenCalled();
    });
  });

  describe('merger session failures', () => {
    it('retries a session that crashed and carries on', async () => {
      const g = scriptedGit([1], { started: true });
      g.deps.waitForCompletion.mockRejectedValueOnce(new Error('session exited'));
      await g.drive();
      expect(sent).toHaveLength(2);
    });

    it('throws a WorktreeError and aborts only after the configured number of consecutive failures', async () => {
      const g = scriptedGit([1], { started: true });
      g.deps.waitForCompletion.mockRejectedValue(new Error('session exited'));
      await expect(g.drive()).rejects.toBeInstanceOf(WorktreeError);
      expect(sent).toHaveLength(replayConfig.maxConsecutiveSessionFailures);
      expect(g.flat()).toContain('rebase --abort');
    });

    it('pauses on a rate limit: the rebase is left in progress, with the merger session killed', async () => {
      const g = scriptedGit([1], { started: true });
      g.deps.waitForCompletion.mockRejectedValueOnce(new RateLimitError(123));
      await expect(g.drive()).rejects.toBeInstanceOf(RateLimitError);
      expect(g.flat()).not.toContain('rebase --abort');
      expect(g.flat().some(c => c.includes('--continue'))).toBe(false);
      const { processManager } = await import('../../src/lib/process-manager');
      expect(processManager.killSession).toHaveBeenCalledWith('sess');
    });

    it('resumes the paused rebase instead of restarting it, and verifies the unverified resolution', async () => {
      // the merger had resolved the stop (nothing unmerged) before the rate limit hit
      const g = scriptedGit([0, 0], { started: true });
      runSensors.mockResolvedValue({ allPassed: true, reports: [] });
      await g.drive({ resumed: true, sensors: [{ command: 'npm test' }] });
      expect(runSensors).toHaveBeenCalledTimes(1);
      expect(g.flat().filter(c => c.includes('--continue'))).toHaveLength(2);
      expect(g.flat()).not.toContain('rebase --abort');
    });

    it('rebaseResolvingConflicts picks up a rebase left in progress without starting a new one', async () => {
      const g = scriptedGit([1], { started: true });
      expect(await g.rebase()).toBe('resolved');
      expect(g.deps.execGit.mock.calls.some(c => c[0][0] === 'rebase' && c[0][1] === 'origin/main')).toBe(false);
      expect(sent).toHaveLength(1);
    });

    it('aborts a cherry-pick on a rate limit; its subtask branch is re-integrated on resume', async () => {
      const g = scriptedGit([1], { kind: 'cherry-pick', started: true });
      g.deps.waitForCompletion.mockRejectedValueOnce(new RateLimitError(123));
      await expect(g.drive()).rejects.toBeInstanceOf(RateLimitError);
      expect(g.flat()).toContain('cherry-pick --abort');
    });
  });
});
