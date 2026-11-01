import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
const behaviour = { timeOutTheRun: false };
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { promisify } = await import('util');
  const execFile = Object.assign(
    (file: string, args: string[], opts: Record<string, unknown>, cb: (e: Error | null, r: { stdout: string; stderr: string }) => void) => {
      calls.push({ file, args, opts });
      cb(null, { stdout: 'ok', stderr: '' });
    },
    { [promisify.custom]: async (file: string, args: string[], opts: Record<string, unknown>) => {
      calls.push({ file, args, opts });
      // the sensor's own run (not the cleanup `docker exec`) can be made to time out
      if (behaviour.timeOutTheRun && args.includes('sbt test')) {
        throw Object.assign(new Error('timed out'), { killed: true, stdout: '', stderr: '' });
      }
      return { stdout: 'ok', stderr: '' };
    } },
  );
  return { ...actual, execFile };
});
vi.mock('@/lib/tool-checker', () => ({ getToolPath: (n: string) => n }));

import { runSensors } from '@/lib/sensors';

beforeEach(() => { calls.length = 0; behaviour.timeOutTheRun = false; });

describe('runSensors — where the command runs', () => {
  const specPath = () => mkdtempSync(join(tmpdir(), 'sensors-container-'));

  it('runs on the host by default, in the given cwd', async () => {
    const r = await runSensors([{ command: 'sbt test' }], 'post_integration', { cwd: '/host/wt', specPath: specPath(), files: [] });
    expect(r.allPassed).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].file).not.toBe('docker');
    expect(calls[0].opts.cwd).toBe('/host/wt');
  });

  it('runs through `docker exec` inside the container when one is given, with container paths', async () => {
    const r = await runSensors([{ command: 'sbt test' }], 'post_integration', {
      cwd: 'C:\\proj\\.worktrees\\wt', specPath: specPath(), files: [],
      container: {
        containerId: 'abc123', user: 'vscode', cwd: '/workspaces/proj/.worktrees/wt',
        mapPath: (p: string) => '/workspaces/proj/mapped/' + p.split(/[\\/]/).pop(),
      },
    });
    expect(r.allPassed).toBe(true);
    expect(calls).toHaveLength(1);
    const { file, args } = calls[0];
    expect(file).toBe('docker');
    expect(args.slice(0, 5)).toEqual(['exec', '-u', 'vscode', '-w', '/workspaces/proj/.worktrees/wt']);
    expect(args.slice(-4)).toEqual(['abc123', 'sh', '-c', 'sbt test']);
    expect(args).toContain('SENSOR_CWD=/workspaces/proj/.worktrees/wt');
    expect(args.some(a => a.startsWith('SENSOR_OUTPUT=/workspaces/proj/mapped/'))).toBe(true);
  });

  describe('a timed-out containerised run', () => {
    const container = {
      containerId: 'abc123', user: 'vscode', cwd: '/workspaces/proj/wt', mapPath: (p: string) => p,
    };

    it('is stopped inside the container, not just abandoned: the whole process tree tagged with the run id is killed', async () => {
      behaviour.timeOutTheRun = true;
      const r = await runSensors([{ command: 'sbt test', timeout: 5 }], 'post_integration', {
        cwd: '/host/wt', specPath: specPath(), files: [], container,
      });
      expect(r.allPassed).toBe(false);
      expect(r.reports[0].error).toContain('timed out');

      expect(calls).toHaveLength(2);
      const runTag = calls[0].args.find(a => a.startsWith('TEAMAI_SENSOR_RUN='))!;
      expect(runTag).toMatch(/^TEAMAI_SENSOR_RUN=[0-9a-f-]{36}$/);

      // second call: a `docker exec` in the same container that signals every process carrying that tag
      const cleanup = calls[1];
      expect(cleanup.file).toBe('docker');
      expect(cleanup.args.slice(0, 4)).toEqual(['exec', '-u', 'vscode', 'abc123']);
      const script = cleanup.args[cleanup.args.length - 1];
      expect(script).toContain(runTag);
      expect(script).toContain('kill -TERM');
      expect(script).toContain('kill -KILL');
      // tr must receive the two characters backslash-zero / backslash-n, never a raw NUL or newline
      expect(script).toContain("tr '\\0' '\\n'");
      expect(script).not.toContain(String.fromCharCode(0));
    });

    it('does nothing extra when the run finishes (passes or fails normally)', async () => {
      await runSensors([{ command: 'sbt test' }], 'post_integration', {
        cwd: '/host/wt', specPath: specPath(), files: [], container,
      });
      expect(calls).toHaveLength(1);
    });

    it('does not try to reach into a container for a host run', async () => {
      behaviour.timeOutTheRun = true;
      calls.length = 0;
      await runSensors([{ command: 'sbt test' }], 'post_integration', { cwd: '/host/wt', specPath: specPath(), files: [] });
      expect(calls.every(c => c.file !== 'docker')).toBe(true);
    });
  });
});
