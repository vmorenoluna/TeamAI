/**
 * devcontainerUpEnv: forward the host `gh` login to `devcontainer up` as
 * GH_TOKEN so a freshly built container can run `gh` in its lifecycle commands.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockGh } = vi.hoisted(() => ({ mockGh: vi.fn() }));

vi.mock('child_process', () => ({
  spawn: vi.fn(),
  execFile: (file: string, args: string[], _opts: unknown, cb: (err: Error | null, stdout: string, stderr: string) => void) => {
    const out = mockGh(file, args) as string | Error;
    if (out instanceof Error) { setImmediate(() => cb(out, '', '')); return; }
    setImmediate(() => cb(null, out, ''));
  },
  ChildProcess: class MockChildProcess {},
}));

vi.mock('../../src/lib/logger', () => ({ log: vi.fn(), error: vi.fn(), warn: vi.fn() }));

import { devcontainerUpEnv, getHostGithubToken } from '../../src/lib/container-manager';

describe('devcontainerUpEnv', () => {
  beforeEach(() => mockGh.mockReset());

  it('forwards the host gh token as GH_TOKEN', async () => {
    mockGh.mockReturnValue('gho_hosttoken\n');
    const env = await devcontainerUpEnv({ PATH: '/bin' });
    expect(env).toEqual({ PATH: '/bin', GH_TOKEN: 'gho_hosttoken' });
    expect(mockGh.mock.calls[0][1]).toEqual(['auth', 'token']);
  });

  it('keeps a GH_TOKEN the user already exported without asking gh', async () => {
    const base = { GH_TOKEN: 'user-token' };
    expect(await devcontainerUpEnv(base)).toBe(base);
    expect(mockGh).not.toHaveBeenCalled();
  });

  it('leaves the environment untouched when gh is missing or logged out', async () => {
    mockGh.mockReturnValue(new Error('not logged in'));
    const base = { PATH: '/bin' };
    expect(await devcontainerUpEnv(base)).toBe(base);
    expect(await getHostGithubToken()).toBe('');
  });
});
