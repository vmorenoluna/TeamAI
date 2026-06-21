/**
 * Tests for worktree .git path-patching — _patchWorktreeGitFile,
 * _restoreWorktreeGitFileToHostPaths, and their integration with
 * _execGit and _commitArtifactsToWorktree.
 *
 * Design principle: No OS assumptions are hardcoded. The container
 * workspace path comes from docker inspect at runtime; the host project
 * root is the actual value passed to the orchestrator. Tests verify
 * both methods are idempotent no-ops when paths are already correct,
 * and that they correctly rewrite paths when the execution context
 * changes (host git ↔ container git via docker exec).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Hoisted mocks ──

const { mockWarn, onHandlers } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  onHandlers: new Map<string, Array<(...args: any[]) => void>>(),
}));

const mockOn = vi.hoisted(() => vi.fn());
const mockOff = vi.hoisted(() => vi.fn());
const mockEmit = vi.hoisted(() => vi.fn());
const mockCreateSession = vi.hoisted(() => vi.fn());
const mockSendMessage = vi.hoisted(() => vi.fn());
const mockKillSession = vi.hoisted(() => vi.fn());
const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  warn: mockWarn,
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!onHandlers.has(event)) onHandlers.set(event, []);
      onHandlers.get(event)!.push(handler);
      return mockOn(event, handler);
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      const handlers = onHandlers.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
      return mockOff(event, handler);
    },
    emit: (...args: any[]) => mockEmit(...args),
    createSession: (...args: any[]) => mockCreateSession(...args),
    sendMessage: (...args: any[]) => mockSendMessage(...args),
    killSession: (...args: any[]) => mockKillSession(...args),
    getSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    getStaleSessions: vi.fn(() => []),
    removeStaleSession: vi.fn(),
    getTerminalSessions: vi.fn(() => []),
    killTerminalSession: vi.fn(),
    writeToSession: vi.fn(),
    terminateSession: vi.fn(),
  },
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: {
    ensureContainer: vi.fn(),
    getRunningContainer: vi.fn(() => null),
  },
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

// ── Imports after mocks ──

import { getOrchestrator } from '../../src/lib/orchestrator';
import { readContainerConfig, containerManager, hostToContainerPath, readContainerRemoteUser } from '../../src/lib/container-manager';

type AnyOrch = any;

// ── Helpers ──

function setupTestEnv() {
  const root = join(tmpdir(), `teamai-wtp-${randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });

  // Create the git metadata directory structure
  const gitDir = join(root, '.git');
  const worktreesDir = join(gitDir, 'worktrees');
  mkdirSync(worktreesDir, { recursive: true });

  // Create a simulated worktree
  const worktreePath = join(root, '.worktrees', 'my-feature');
  mkdirSync(worktreePath, { recursive: true });

  const worktreeName = 'my-feature';

  const clean = () => {
    onHandlers.clear();
    vi.clearAllMocks();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  };

  return { root, worktreePath, worktreeName, clean };
}

function makeOrch(root: string): any {
  const orch = getOrchestrator(root);
  (orch as any).pipelines.clear();
  (orch as any).activeTasks.clear();
  return orch;
}

// ── Tests ──

describe('_restoreWorktreeGitFileToHostPaths', () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    vi.resetAllMocks();
    onHandlers.clear();
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });
    vi.mocked(containerManager.getRunningContainer).mockReturnValue(null);
    vi.mocked(readContainerRemoteUser).mockReturnValue('node');
  });

  afterEach(() => {
    if (env) env.clean();
  });

  it('returns early (no-op) when the .git file does not exist', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    // Don't create .git file — method should return without error
    expect(() => (orch as AnyOrch)._restoreWorktreeGitFileToHostPaths(env.worktreePath)).not.toThrow();
  });

  it('returns early when .git file does not start with "gitdir:"', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    writeFileSync(join(env.worktreePath, '.git'), 'not a gitdir file\n');
    (orch as AnyOrch)._restoreWorktreeGitFileToHostPaths(env.worktreePath);
    // File should be unchanged
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe('not a gitdir file\n');
  });

  it('returns early when gitdir path has no /worktrees/ segment', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    writeFileSync(join(env.worktreePath, '.git'), 'gitdir: /some/random/path\n');
    (orch as AnyOrch)._restoreWorktreeGitFileToHostPaths(env.worktreePath);
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe('gitdir: /some/random/path\n');
  });

  it('is a no-op when gitdir is already a host-style path', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const hostRoot = env.root.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${hostGitdir}\n`);
    // Create the back-reference dir so the method can find it
    const worktreeMetaDir = join(env.root, '.git', 'worktrees', env.worktreeName);
    mkdirSync(worktreeMetaDir, { recursive: true });
    writeFileSync(join(worktreeMetaDir, 'gitdir'), `${hostRoot}/.worktrees/my-feature/.git\n`);

    (orch as AnyOrch)._restoreWorktreeGitFileToHostPaths(env.worktreePath);

    // File should be unchanged — already correct
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe(`gitdir: ${hostGitdir}\n`);
  });

  it('rewrites a container-style gitdir back to host-style paths', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerGitdir = `/workspaces/project/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${containerGitdir}\n`);

    // Create the back-reference metadata directory
    const worktreeMetaDir = join(env.root, '.git', 'worktrees', env.worktreeName);
    mkdirSync(worktreeMetaDir, { recursive: true });
    writeFileSync(join(worktreeMetaDir, 'gitdir'), `/workspaces/project/.worktrees/my-feature/.git\n`);

    (orch as AnyOrch)._restoreWorktreeGitFileToHostPaths(env.worktreePath);

    // .git file should now contain host-style path
    const hostRoot = env.root.replace(/\\/g, '/');
    const expectedGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);

    // Back-reference should also be rewritten to host path
    const expectedBackRef = `${env.worktreePath.replace(/\\/g, '/')}/.git`;
    expect(readFileSync(join(worktreeMetaDir, 'gitdir'), 'utf-8').trim()).toBe(expectedBackRef);
  });

  it('rewrites a Windows-style gitdir (backslashes) to forward-slash host path', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    // Simulate a Windows host path with backslashes in the gitdir
    const windowsGitdir = `C:\\\\Users\\\\test\\\\project\\.git\\worktrees\\${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${windowsGitdir}\n`);

    // Create the back-reference metadata directory
    const worktreeMetaDir = join(env.root, '.git', 'worktrees', env.worktreeName);
    mkdirSync(worktreeMetaDir, { recursive: true });

    (orch as AnyOrch)._restoreWorktreeGitFileToHostPaths(env.worktreePath);

    // .git file should now contain host-style path with forward slashes
    const hostRoot = env.root.replace(/\\/g, '/');
    const expectedGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);
  });

  it('handles missing back-reference file gracefully (does not throw)', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerGitdir = `/workspaces/project/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${containerGitdir}\n`);

    // Do NOT create the back-reference metadata directory — simulate
    // a scenario where the metadata was pruned but the .git file still
    // has a container path

    expect(() => (orch as AnyOrch)._restoreWorktreeGitFileToHostPaths(env.worktreePath)).not.toThrow();

    // .git file should still be rewritten (the main fix)
    const hostRoot = env.root.replace(/\\/g, '/');
    const expectedGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);
  });
});

describe('_patchWorktreeGitFile', () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    vi.resetAllMocks();
    onHandlers.clear();
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });
    vi.mocked(containerManager.getRunningContainer).mockReturnValue(null);
    vi.mocked(readContainerRemoteUser).mockReturnValue('node');
    // Default: hostToContainerPath is identity
    vi.mocked(hostToContainerPath).mockImplementation((p: string) => p);
  });

  afterEach(() => {
    if (env) env.clean();
  });

  it('returns early (no-op) when the .git file does not exist', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    expect(() =>
      (orch as AnyOrch)._patchWorktreeGitFile(env.worktreePath, '/workspaces/project')
    ).not.toThrow();
  });

  it('returns early when .git file does not start with "gitdir:"', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    writeFileSync(join(env.worktreePath, '.git'), 'regular git repo\n');
    (orch as AnyOrch)._patchWorktreeGitFile(env.worktreePath, '/workspaces/project');
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe('regular git repo\n');
  });

  it('returns early when gitdir path has no /worktrees/ segment', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    writeFileSync(join(env.worktreePath, '.git'), 'gitdir: /some/random/path\n');
    (orch as AnyOrch)._patchWorktreeGitFile(env.worktreePath, '/workspaces/project');
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe('gitdir: /some/random/path\n');
  });

  it('is a no-op when gitdir is already the correct container path', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWorkspace = '/workspaces/project';
    const correctGitdir = `${containerWorkspace}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${correctGitdir}\n`);

    // Create the back-reference metadata
    const worktreeMetaDir = join(env.root, '.git', 'worktrees', env.worktreeName);
    mkdirSync(worktreeMetaDir, { recursive: true });
    writeFileSync(join(worktreeMetaDir, 'gitdir'), `${containerWorkspace}/.worktrees/my-feature/.git\n`);

    (orch as AnyOrch)._patchWorktreeGitFile(env.worktreePath, containerWorkspace);

    // File should be unchanged — already correct
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe(`gitdir: ${correctGitdir}\n`);
  });

  it('rewrites a host-style gitdir to a container-style path', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWorkspace = '/workspaces/project';

    // Write a host-style gitdir
    const hostRoot = env.root.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${hostGitdir}\n`);

    // Create the back-reference metadata
    const worktreeMetaDir = join(env.root, '.git', 'worktrees', env.worktreeName);
    mkdirSync(worktreeMetaDir, { recursive: true });
    writeFileSync(join(worktreeMetaDir, 'gitdir'), `${env.worktreePath.replace(/\\/g, '/')}/.git\n`);

    // hostToContainerPath should translate the worktree path
    vi.mocked(hostToContainerPath).mockReturnValue(`${containerWorkspace}/.worktrees/my-feature`);

    (orch as AnyOrch)._patchWorktreeGitFile(env.worktreePath, containerWorkspace);

    // .git file should now contain the container path
    const expectedGitdir = `${containerWorkspace}/.git/worktrees/${env.worktreeName}`;
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);

    // Back-reference should be rewritten to container path
    expect(readFileSync(join(worktreeMetaDir, 'gitdir'), 'utf-8').trim()).toBe(
      `${containerWorkspace}/.worktrees/my-feature/.git`
    );
  });

  it('handles Windows-style host gitdir (with backslashes) by normalising to forward slashes', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWorkspace = '/workspaces/project';

    // Write a Windows-style gitdir with backslashes
    const windowsGitdir = `C:\\\\Users\\\\test\\\\project\\.git\\worktrees\\${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${windowsGitdir}\n`);

    // Create the back-reference metadata
    const worktreeMetaDir = join(env.root, '.git', 'worktrees', env.worktreeName);
    mkdirSync(worktreeMetaDir, { recursive: true });

    vi.mocked(hostToContainerPath).mockReturnValue(`${containerWorkspace}/.worktrees/my-feature`);

    (orch as AnyOrch)._patchWorktreeGitFile(env.worktreePath, containerWorkspace);

    // Should still work — the backslash normalisation in the regex handles it
    const expectedGitdir = `${containerWorkspace}/.git/worktrees/${env.worktreeName}`;
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);
  });

  it('handles missing back-reference file gracefully (does not throw)', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWorkspace = '/workspaces/project';

    const hostRoot = env.root.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${hostGitdir}\n`);

    // Do NOT create the back-reference metadata dir

    expect(() =>
      (orch as AnyOrch)._patchWorktreeGitFile(env.worktreePath, containerWorkspace)
    ).not.toThrow();

    // .git file should still be rewritten
    const expectedGitdir = `${containerWorkspace}/.git/worktrees/${env.worktreeName}`;
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);
  });

  it('uses hostToContainerPath for the back-reference path translation', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWorkspace = '/workspaces/project';

    const hostRoot = env.root.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${hostGitdir}\n`);

    const worktreeMetaDir = join(env.root, '.git', 'worktrees', env.worktreeName);
    mkdirSync(worktreeMetaDir, { recursive: true });
    writeFileSync(join(worktreeMetaDir, 'gitdir'), 'old content\n');

    const htcpSpy = vi.mocked(hostToContainerPath);
    htcpSpy.mockReturnValue('/workspaces/project/.worktrees/my-feature');

    (orch as AnyOrch)._patchWorktreeGitFile(env.worktreePath, containerWorkspace);

    // hostToContainerPath should have been called with the worktree path,
    // project root, and container workspace
    expect(htcpSpy).toHaveBeenCalledWith(
      env.worktreePath,
      env.root,
      containerWorkspace
    );
  });
});

describe('_execGit — worktree patching integration', () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    vi.resetAllMocks();
    onHandlers.clear();
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });
    vi.mocked(containerManager.getRunningContainer).mockReturnValue(null);
    vi.mocked(readContainerRemoteUser).mockReturnValue('node');
    vi.mocked(hostToContainerPath).mockImplementation((p: string) => p);
  });

  afterEach(() => {
    if (env) env.clean();
  });

  describe('container mode — docker exec path', () => {
    beforeEach(() => {
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(containerManager.getRunningContainer).mockReturnValue({
        containerId: 'cont-test',
        remoteWorkspaceFolder: '/workspaces/project',
      } as any);
    });

    it('calls _patchWorktreeGitFile before docker exec', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);

      // Create the worktree .git file with host paths — should trigger patching
      writeFileSync(join(env.worktreePath, '.git'), 'gitdir: /some/host/path/.git/worktrees/my-feature\n');

      mockExecFileSync.mockReturnValue('');

      (orch as AnyOrch)._execGit(['status'], env.worktreePath);

      // Verify the .git file was patched to container paths
      const content = readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim();
      expect(content).toBe('gitdir: /workspaces/project/.git/worktrees/my-feature');

      // docker exec should have been called
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['exec', '-u', 'node', '-w', expect.any(String), 'cont-test', 'git', 'status']),
      );
    });

    it('does not call docker exec for worktree commands (routes to host)', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);

      writeFileSync(join(env.worktreePath, '.git'), 'gitdir: /some/host/path/.git/worktrees/my-feature\n');

      mockExecFileSync.mockReturnValue('');

      (orch as AnyOrch)._execGit(['worktree', 'add', env.worktreePath], env.root);

      // Should call host git directly (not docker exec) — worktree add/remove
      // always runs on host
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'add']),
        expect.any(Object),
      );
    });

    it('restores container paths to host paths when worktree command bypasses docker exec', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);

      // Write a container-style gitdir in the worktree .git file
      writeFileSync(join(env.worktreePath, '.git'), 'gitdir: /workspaces/project/.git/worktrees/my-feature\n');

      mockExecFileSync.mockReturnValue('');

      // Worktree commands skip docker exec and fall through to host git.
      // Use the worktree path as cwd (common for commands like rebase/status).
      (orch as AnyOrch)._execGit(['worktree', 'remove', env.worktreePath], env.worktreePath);

      // .git file should have been restored to host paths by the fallback
      const hostRoot = env.root.replace(/\\/g, '/');
      const expectedGitdir = `${hostRoot}/.git/worktrees/my-feature`;
      expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);

      // Host git should have been called (not docker exec)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object),
      );
    });

    it('maps absolute project-root-prefixed args to container paths', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);

      writeFileSync(join(env.worktreePath, '.git'), 'gitdir: /some/host/path/.git/worktrees/my-feature\n');

      const mapSpy = vi.mocked(hostToContainerPath);
      mapSpy.mockClear(); // Reset previous call count from _patchWorktreeGitFile

      mockExecFileSync.mockReturnValue('');

      const absoluteFilePath = join(env.root, 'src', 'main.ts');
      (orch as AnyOrch)._execGit(['add', absoluteFilePath], env.worktreePath);

      // hostToContainerPath should have been called for the file arg
      expect(mapSpy).toHaveBeenCalledWith(
        absoluteFilePath,
        env.root,
        '/workspaces/project',
      );
    });

    it('uses readContainerRemoteUser for the docker exec -u flag', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);

      writeFileSync(join(env.worktreePath, '.git'), 'gitdir: /some/host/path/.git/worktrees/my-feature\n');
      vi.mocked(readContainerRemoteUser).mockReturnValue('customuser');

      mockExecFileSync.mockReturnValue('');

      (orch as AnyOrch)._execGit(['status'], env.worktreePath);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['exec', '-u', 'customuser', '-w', expect.any(String), 'cont-test', 'git', 'status']),
      );
    });
  });

  describe('host git fallback path', () => {
    it('calls _restoreWorktreeGitFileToHostPaths before host git execution', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);

      // Write a container-style gitdir — should trigger restoration
      writeFileSync(join(env.worktreePath, '.git'), 'gitdir: /workspaces/project/.git/worktrees/my-feature\n');

      mockExecFileSync.mockReturnValue('');

      (orch as AnyOrch)._execGit(['status'], env.worktreePath);

      // .git file should have been restored to host paths
      const hostRoot = env.root.replace(/\\/g, '/');
      const expectedGitdir = `${hostRoot}/.git/worktrees/my-feature`;
      expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);

      // Host git should have been called
      expect(mockExecFileSync).toHaveBeenCalledWith('git', ['status'], { cwd: env.worktreePath });
    });

    it('falls back to host git: restores worktree .git to host paths when container enabled but not running', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);

      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(containerManager.getRunningContainer).mockReturnValue(null); // no running container

      writeFileSync(join(env.worktreePath, '.git'), 'gitdir: /workspaces/project/.git/worktrees/my-feature\n');

      mockExecFileSync.mockReturnValue('');

      (orch as AnyOrch)._execGit(['status'], env.worktreePath);

      // Should still have restored to host paths via the fallback path
      const hostRoot = env.root.replace(/\\/g, '/');
      const expectedGitdir = `${hostRoot}/.git/worktrees/my-feature`;
      expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);
    });

    it('calls direct host git when container is disabled', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);

      vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });

      mockExecFileSync.mockReturnValue('');

      (orch as AnyOrch)._execGit(['status'], env.worktreePath);

      expect(mockExecFileSync).toHaveBeenCalledWith('git', ['status'], { cwd: env.worktreePath });
    });

    it('does not throw when cwd has no .git file (non-worktree directory like projectRoot)', () => {
      // _execGit is sometimes called with this.projectRoot (e.g. in removeWorktree),
      // which may not have a worktree-style .git file. Both patching methods
      // gracefully return when no .git file exists in the cwd.
      env = setupTestEnv();
      const orch = makeOrch(env.root);

      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(containerManager.getRunningContainer).mockReturnValue({
        containerId: 'cont-test',
        remoteWorkspaceFolder: '/workspaces/project',
      } as any);

      // env.root has a real .git directory (not a worktree .git file),
      // so existsSync(join(env.root, '.git')) is true (it's a dir) but
      // readFileSync on it would fail (it's a directory). The patching
      // methods should handle this gracefully.
      mockExecFileSync.mockReturnValue('');

      expect(() =>
        (orch as AnyOrch)._execGit(['status'], env.root)
      ).not.toThrow();
    });
  });
});

describe('_commitArtifactsToWorktree — host git path patching', () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    vi.resetAllMocks();
    onHandlers.clear();
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });
    vi.mocked(containerManager.getRunningContainer).mockReturnValue(null);
    vi.mocked(readContainerRemoteUser).mockReturnValue('node');
    vi.mocked(hostToContainerPath).mockImplementation((p: string) => p);
  });

  afterEach(() => {
    if (env) env.clean();
  });

  it('calls _restoreWorktreeGitFileToHostPaths before committing with host git', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    // Set up the task directory with artifact files
    const taskDir = join(env.root, '.teamai', randomUUID().slice(0, 8));
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
      id: 'test-task',
      title: 'Test Task',
      description: 'test-description',
      phase: 'merge',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    writeFileSync(join(taskDir, 'spec.md'), '# Spec');

    // Write a container-style gitdir in the worktree .git file
    writeFileSync(join(env.worktreePath, '.git'), 'gitdir: /workspaces/project/.git/worktrees/my-feature\n');

    mockExecFileSync.mockReturnValue('');

    const pipeline = {
      taskId: 'test-task',
      description: 'test-description',
      phase: 'merge',
      specPath: taskDir,
      worktreePath: env.worktreePath,
      branch: 'feat/test',
      qaAttempt: 0,
      maxQaAttempts: 3,
    };

    (orch as AnyOrch)._commitArtifactsToWorktree(pipeline);

    // .git file should have been restored to host paths BEFORE git add was called
    const hostRoot = env.root.replace(/\\/g, '/');
    const expectedGitdir = `${hostRoot}/.git/worktrees/my-feature`;
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);

    // git add and commit should use host git (not docker exec)
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['add', '.teamai/']),
      expect.objectContaining({ cwd: env.worktreePath }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['commit', '-m', expect.stringContaining('TeamAI pipeline artifacts')]),
      expect.objectContaining({ cwd: env.worktreePath }),
    );
  });

  it('handles container-mode artifact commit: restores host paths first, then commits via host git', () => {
    // Even when container mode is enabled, _commitArtifactsToWorktree
    // writes files via Node.js on the host filesystem, so it must
    // restore host paths and use host git.
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
    vi.mocked(containerManager.getRunningContainer).mockReturnValue({
      containerId: 'cont-test',
      remoteWorkspaceFolder: '/workspaces/project',
    } as any);

    const taskDir = join(env.root, '.teamai', randomUUID().slice(0, 8));
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
      id: 'test-task',
      title: 'Test Task',
      description: 'test-description',
      phase: 'merge',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));
    writeFileSync(join(taskDir, 'spec.md'), '# Spec');

    // Write a container-style gitdir — _commitArtifactsToWorktree should
    // restore it to host paths before running host git
    writeFileSync(join(env.worktreePath, '.git'), 'gitdir: /workspaces/project/.git/worktrees/my-feature\n');

    mockExecFileSync.mockReturnValue('');

    const pipeline = {
      taskId: 'test-task',
      description: 'test-description',
      phase: 'merge',
      specPath: taskDir,
      worktreePath: env.worktreePath,
      branch: 'feat/test',
      qaAttempt: 0,
      maxQaAttempts: 3,
    };

    (orch as AnyOrch)._commitArtifactsToWorktree(pipeline);

    // .git file must be restored to host paths — artifact commit always
    // runs on host git, even in container mode
    const hostRoot = env.root.replace(/\\/g, '/');
    const expectedGitdir = `${hostRoot}/.git/worktrees/my-feature`;
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);

    // Must use host git, NOT docker exec
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['add', '.teamai/']),
      expect.any(Object),
    );
    // Should NOT have called docker exec
    const dockerCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => c[0] === 'docker'
    );
    expect(dockerCalls.length).toBe(0);
  });
});

describe('_patchWorktreeGitFile and _restoreWorktreeGitFileToHostPaths — idempotency round-trip', () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    vi.resetAllMocks();
    onHandlers.clear();
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });
    vi.mocked(containerManager.getRunningContainer).mockReturnValue(null);
    vi.mocked(readContainerRemoteUser).mockReturnValue('node');
  });

  afterEach(() => {
    if (env) env.clean();
  });

  it('repeated calls are safe: patching already-patched content is a no-op', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWorkspace = '/workspaces/project';

    // Write a host-style gitdir
    const hostRoot = env.root.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${hostGitdir}\n`);

    const worktreeMetaDir = join(env.root, '.git', 'worktrees', env.worktreeName);
    mkdirSync(worktreeMetaDir, { recursive: true });

    vi.mocked(hostToContainerPath).mockReturnValue(`${containerWorkspace}/.worktrees/my-feature`);

    // Patch to container (first call)
    (orch as AnyOrch)._patchWorktreeGitFile(env.worktreePath, containerWorkspace);
    const afterFirst = readFileSync(join(env.worktreePath, '.git'), 'utf-8');
    expect(afterFirst).toContain(containerWorkspace);

    // Patch to container AGAIN (should be no-op)
    (orch as AnyOrch)._patchWorktreeGitFile(env.worktreePath, containerWorkspace);
    const afterSecond = readFileSync(join(env.worktreePath, '.git'), 'utf-8');
    expect(afterSecond).toBe(afterFirst);
  });

  it('repeated restore calls are safe: restoring already-host paths is a no-op', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    const hostRoot = env.root.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${hostGitdir}\n`);

    const worktreeMetaDir = join(env.root, '.git', 'worktrees', env.worktreeName);
    mkdirSync(worktreeMetaDir, { recursive: true });
    writeFileSync(join(worktreeMetaDir, 'gitdir'), `${env.worktreePath.replace(/\\/g, '/')}/.git\n`);

    // Restore to host (first call)
    (orch as AnyOrch)._restoreWorktreeGitFileToHostPaths(env.worktreePath);
    const afterFirst = readFileSync(join(env.worktreePath, '.git'), 'utf-8');
    expect(afterFirst).toContain(hostGitdir);

    // Restore to host AGAIN (should be no-op)
    (orch as AnyOrch)._restoreWorktreeGitFileToHostPaths(env.worktreePath);
    const afterSecond = readFileSync(join(env.worktreePath, '.git'), 'utf-8');
    expect(afterSecond).toBe(afterFirst);
  });

  it('round-trip: patch to container, then restore to host produces original host path (both .git and back-reference)', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWorkspace = '/workspaces/project';

    const hostRoot = env.root.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${hostGitdir}\n`);

    const worktreeMetaDir = join(env.root, '.git', 'worktrees', env.worktreeName);
    mkdirSync(worktreeMetaDir, { recursive: true });
    const hostBackRef = `${env.worktreePath.replace(/\\/g, '/')}/.git`;
    writeFileSync(join(worktreeMetaDir, 'gitdir'), `${hostBackRef}\n`);

    const containerWorktreePath = `${containerWorkspace}/.worktrees/my-feature`;
    vi.mocked(hostToContainerPath).mockReturnValue(containerWorktreePath);

    // Step 1: Patch to container
    (orch as AnyOrch)._patchWorktreeGitFile(env.worktreePath, containerWorkspace);
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toContain(containerWorkspace);
    // Back-reference should be rewritten to container path
    expect(readFileSync(join(worktreeMetaDir, 'gitdir'), 'utf-8').trim()).toBe(`${containerWorktreePath}/.git`);

    // Step 2: Restore to host
    (orch as AnyOrch)._restoreWorktreeGitFileToHostPaths(env.worktreePath);
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${hostGitdir}`);
    // Back-reference should be restored to host path
    expect(readFileSync(join(worktreeMetaDir, 'gitdir'), 'utf-8').trim()).toBe(hostBackRef);
  });
});

describe('_isWorktreeHealthy — container-mode path detection', () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    vi.resetAllMocks();
    onHandlers.clear();
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });
    vi.mocked(containerManager.getRunningContainer).mockReturnValue(null);
    vi.mocked(readContainerRemoteUser).mockReturnValue('node');
  });

  afterEach(() => {
    if (env) env.clean();
  });

  it('returns true when .git file contains a container path but the host gitdir exists', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });

    // Write a container-style gitdir in the worktree
    const containerGitdir = `/workspaces/project/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${containerGitdir}\n`);

    // Create the host-side gitdir (worktree metadata directory) so the check passes
    const hostGitdir = join(env.root, '.git', 'worktrees', env.worktreeName);
    mkdirSync(hostGitdir, { recursive: true });

    expect((orch as AnyOrch)._isWorktreeHealthy(env.worktreePath)).toBe(true);
  });

  it('returns false when .git file has container path but host gitdir does not exist', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });

    const containerGitdir = `/workspaces/project/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${containerGitdir}\n`);

    // Do NOT create the host gitdir

    expect((orch as AnyOrch)._isWorktreeHealthy(env.worktreePath)).toBe(false);
  });
});
