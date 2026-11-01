import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const calls: { file: string; args: string[]; opts: Record<string, unknown> }[] = [];
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
      return { stdout: 'ok', stderr: '' };
    } },
  );
  return { ...actual, execFile };
});
vi.mock('@/lib/tool-checker', () => ({ getToolPath: (n: string) => n }));

import { runSensors } from '@/lib/sensors';

beforeEach(() => { calls.length = 0; });

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
});
