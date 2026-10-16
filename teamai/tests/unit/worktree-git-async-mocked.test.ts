import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecFile } = vi.hoisted(() => ({ mockExecFile: vi.fn() }));

vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  return { ...actual, execFile: mockExecFile };
});

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(),
  readContainerRemoteUser: vi.fn(() => 'node'),
  hostToContainerPath: vi.fn((p: string) => p.replace('/host/proj', '/workspaces/proj')),
  containerManager: { getRunningContainer: vi.fn() },
}));
vi.mock('../../src/lib/tool-checker', () => ({ getToolPath: (t: string) => t }));

import { execGit, execGitCapture } from '../../src/lib/orchestrator/worktree-utils';
import { readContainerConfig, containerManager } from '../../src/lib/container-manager';

function resolveWith(stdout = '') {
  mockExecFile.mockImplementation((...a: unknown[]) => {
    const cb = a[a.length - 1] as (e: Error | null, out?: { stdout: string; stderr: string }) => void;
    setImmediate(() => cb(null, { stdout, stderr: '' }));
    return { stdin: { end: vi.fn() } };
  });
}

describe('execGit / execGitCapture routing (AC5)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveWith('out');
  });

  it('routes through docker exec when a container is running', async () => {
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
    vi.mocked(containerManager.getRunningContainer).mockReturnValue(
      { containerId: 'c1', remoteWorkspaceFolder: '/workspaces/proj' } as never,
    );
    await execGit(['status'], '/host/proj', '/host/proj');
    const [file, args] = mockExecFile.mock.calls[0];
    expect(file).toBe('docker');
    expect(args).toEqual(['exec', '-u', 'node', '-w', '/workspaces/proj', 'c1', 'git', 'status']);
  });

  it('keeps worktree subcommands on the host even in container mode', async () => {
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
    vi.mocked(containerManager.getRunningContainer).mockReturnValue(
      { containerId: 'c1', remoteWorkspaceFolder: '/workspaces/proj' } as never,
    );
    await execGit(['worktree', 'list'], '/host/proj', '/host/proj');
    const [file, args, opts] = mockExecFile.mock.calls[0];
    expect(file).toBe('git');
    expect(args).toEqual(['worktree', 'list']);
    expect(opts.cwd).toBe('/host/proj');
  });

  it('uses host git when container mode is off, and capture returns untrimmed stdout', async () => {
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });
    const out = await execGitCapture(['rev-parse', 'HEAD'], '/host/proj', '/host/proj');
    expect(out).toBe('out');
    expect(mockExecFile.mock.calls[0][0]).toBe('git');
    expect(mockExecFile.mock.calls[0][2]).toMatchObject({ cwd: '/host/proj', encoding: 'utf-8' });
  });
});
