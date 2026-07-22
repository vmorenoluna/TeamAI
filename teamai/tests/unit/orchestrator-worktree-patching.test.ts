/**
 * Tests for worktree git-env helpers — _patchWorktreeGitFile,
 * _restoreWorktreeGitFileToHostPaths, _worktreeGitEnv — and their
 * integration with _execGit and _commitArtifactsToWorktree.
 *
 * Design principle: No OS assumptions are hardcoded. The container
 * workspace path comes from docker inspect at runtime; the host project
 * root is the actual value passed to the orchestrator. Tests verify
 * idempotency, correct path forms per execution context (host vs.
 * container), and that git operations bypass the .git pointer file
 * via GIT_DIR / GIT_WORK_TREE env vars.
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
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), error: vi.fn(), warn: mockWarn,
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
import { getToolPath } from '../../src/lib/tool-checker';
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

  // Create the worktree metadata dir so _worktreeGitEnv can detect the linked worktree.
  const worktreeMetaDir = join(root, '.git', 'worktrees', worktreeName);
  mkdirSync(worktreeMetaDir, { recursive: true });

  const clean = () => {
    onHandlers.clear();
    vi.clearAllMocks();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  };

  return { root, worktreePath, worktreeName, worktreeMetaDir, clean };
}

function makeOrch(root: string): any {
  const orch = getOrchestrator(root);
  (orch as any).pipelines.clear();
  (orch as any).activeTasks.clear();
  return orch;
}

/** Extract -e KEY=VALUE flags from a docker exec call's argument array. */
function extractDockerEnvVars(dockerArgs: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (let i = 0; i < dockerArgs.length; i++) {
    if (dockerArgs[i] === '-e' && i + 1 < dockerArgs.length) {
      const eq = dockerArgs[i + 1].indexOf('=');
      if (eq > 0) {
        env[dockerArgs[i + 1].slice(0, eq)] = dockerArgs[i + 1].slice(eq + 1);
      }
      i++;
    }
  }
  return env;
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
    expect(() => (orch as AnyOrch)._ctx.restoreWorktreeGitFileToHostPaths(env.worktreePath)).not.toThrow();
  });

  it('returns early when .git file does not start with "gitdir:"', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    writeFileSync(join(env.worktreePath, '.git'), 'not a gitdir file\n');
    (orch as AnyOrch)._ctx.restoreWorktreeGitFileToHostPaths(env.worktreePath);
    // File should be unchanged
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe('not a gitdir file\n');
  });

  it('returns early when gitdir path has no /worktrees/ segment', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    writeFileSync(join(env.worktreePath, '.git'), 'gitdir: /some/random/path\n');
    (orch as AnyOrch)._ctx.restoreWorktreeGitFileToHostPaths(env.worktreePath);
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe('gitdir: /some/random/path\n');
  });

  it('is a no-op when gitdir is already a host-style path', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const hostRoot = env.root.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${hostGitdir}\n`);
    writeFileSync(join(env.worktreeMetaDir, 'gitdir'), `${hostRoot}/.worktrees/my-feature/.git\n`);

    (orch as AnyOrch)._ctx.restoreWorktreeGitFileToHostPaths(env.worktreePath);

    // File should be unchanged — already correct
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe(`gitdir: ${hostGitdir}\n`);
  });

  it('rewrites a container-style gitdir back to host-style paths', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerGitdir = `/workspaces/project/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${containerGitdir}\n`);
    writeFileSync(join(env.worktreeMetaDir, 'gitdir'), `/workspaces/project/.worktrees/my-feature/.git\n`);

    (orch as AnyOrch)._ctx.restoreWorktreeGitFileToHostPaths(env.worktreePath);

    const hostRoot = env.root.replace(/\\/g, '/');
    const expectedGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);

    const expectedBackRef = `${env.worktreePath.replace(/\\/g, '/')}/.git`;
    expect(readFileSync(join(env.worktreeMetaDir, 'gitdir'), 'utf-8').trim()).toBe(expectedBackRef);
  });

  it('rewrites a Windows-style gitdir (backslashes) to forward-slash host path', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const windowsGitdir = `C:\\\\Users\\\\test\\\\project\\.git\\worktrees\\${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${windowsGitdir}\n`);

    (orch as AnyOrch)._ctx.restoreWorktreeGitFileToHostPaths(env.worktreePath);

    const hostRoot = env.root.replace(/\\/g, '/');
    const expectedGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);
  });

  it('handles missing back-reference file gracefully (does not throw)', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerGitdir = `/workspaces/project/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${containerGitdir}\n`);

    // Remove the meta dir so back-reference does not exist
    rmSync(env.worktreeMetaDir, { recursive: true, force: true });

    expect(() => (orch as AnyOrch)._ctx.restoreWorktreeGitFileToHostPaths(env.worktreePath)).not.toThrow();

    const hostRoot = env.root.replace(/\\/g, '/');
    const expectedGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);
  });

  // ── commondir tests ──

  it('rewrites commondir to ../.. when it contains an absolute host path', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerGitdir = `/workspaces/project/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${containerGitdir}\n`);
    writeFileSync(join(env.worktreeMetaDir, 'gitdir'), `/workspaces/project/.worktrees/my-feature/.git\n`);
    writeFileSync(join(env.worktreeMetaDir, 'commondir'), '/workspaces/project/.git\n');

    (orch as AnyOrch)._ctx.restoreWorktreeGitFileToHostPaths(env.worktreePath);

    const commondirContent = readFileSync(join(env.worktreeMetaDir, 'commondir'), 'utf-8').trim();
    expect(commondirContent).toBe('../..');
  });

  it('is a no-op when commondir is already ../..', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const hostRoot = env.root.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${hostGitdir}\n`);
    writeFileSync(join(env.worktreeMetaDir, 'commondir'), '../..\n');

    (orch as AnyOrch)._ctx.restoreWorktreeGitFileToHostPaths(env.worktreePath);

    // Should still be ../.. — unchanged
    const commondirContent = readFileSync(join(env.worktreeMetaDir, 'commondir'), 'utf-8').trim();
    expect(commondirContent).toBe('../..');
  });

  it('handles missing commondir file gracefully (does not throw)', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerGitdir = `/workspaces/project/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${containerGitdir}\n`);

    // No commondir file — should not throw
    expect(() => (orch as AnyOrch)._ctx.restoreWorktreeGitFileToHostPaths(env.worktreePath)).not.toThrow();
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
    vi.mocked(hostToContainerPath).mockImplementation((p: string) => p);
  });

  afterEach(() => {
    if (env) env.clean();
  });

  it('returns early (no-op) when the .git file does not exist', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    expect(() =>
      (orch as AnyOrch)._ctx.patchWorktreeGitFile(env.worktreePath, '/workspaces/project')
    ).not.toThrow();
  });

  it('returns early when .git file does not start with "gitdir:"', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    writeFileSync(join(env.worktreePath, '.git'), 'regular git repo\n');
    (orch as AnyOrch)._ctx.patchWorktreeGitFile(env.worktreePath, '/workspaces/project');
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe('regular git repo\n');
  });

  it('returns early when gitdir path has no /worktrees/ segment', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    writeFileSync(join(env.worktreePath, '.git'), 'gitdir: /some/random/path\n');
    (orch as AnyOrch)._ctx.patchWorktreeGitFile(env.worktreePath, '/workspaces/project');
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe('gitdir: /some/random/path\n');
  });

  it('is a no-op when gitdir is already the correct container path', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWorkspace = '/workspaces/project';
    const correctGitdir = `${containerWorkspace}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${correctGitdir}\n`);
    writeFileSync(join(env.worktreeMetaDir, 'gitdir'), `${containerWorkspace}/.worktrees/my-feature/.git\n`);

    (orch as AnyOrch)._ctx.patchWorktreeGitFile(env.worktreePath, containerWorkspace);

    // File should be unchanged — already correct
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe(`gitdir: ${correctGitdir}\n`);
  });

  it('rewrites a host-style gitdir to a container-style path', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWorkspace = '/workspaces/project';

    const hostRoot = env.root.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${hostGitdir}\n`);
    writeFileSync(join(env.worktreeMetaDir, 'gitdir'), `${env.worktreePath.replace(/\\/g, '/')}/.git\n`);

    vi.mocked(hostToContainerPath).mockReturnValue(`${containerWorkspace}/.worktrees/my-feature`);

    (orch as AnyOrch)._ctx.patchWorktreeGitFile(env.worktreePath, containerWorkspace);

    const expectedGitdir = `${containerWorkspace}/.git/worktrees/${env.worktreeName}`;
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${expectedGitdir}`);

    expect(readFileSync(join(env.worktreeMetaDir, 'gitdir'), 'utf-8').trim()).toBe(
      `${containerWorkspace}/.worktrees/my-feature/.git`
    );
  });

  it('handles Windows-style host gitdir (with backslashes) by normalising to forward slashes', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWorkspace = '/workspaces/project';

    const windowsGitdir = `C:\\\\Users\\\\test\\\\project\\.git\\worktrees\\${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${windowsGitdir}\n`);

    vi.mocked(hostToContainerPath).mockReturnValue(`${containerWorkspace}/.worktrees/my-feature`);

    (orch as AnyOrch)._ctx.patchWorktreeGitFile(env.worktreePath, containerWorkspace);

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

    rmSync(env.worktreeMetaDir, { recursive: true, force: true });

    expect(() =>
      (orch as AnyOrch)._ctx.patchWorktreeGitFile(env.worktreePath, containerWorkspace)
    ).not.toThrow();

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
    writeFileSync(join(env.worktreeMetaDir, 'gitdir'), 'old content\n');

    const htcpSpy = vi.mocked(hostToContainerPath);
    htcpSpy.mockReturnValue('/workspaces/project/.worktrees/my-feature');

    (orch as AnyOrch)._ctx.patchWorktreeGitFile(env.worktreePath, containerWorkspace);

    expect(htcpSpy).toHaveBeenCalledWith(
      env.worktreePath,
      env.root,
      containerWorkspace
    );
  });

  // ── commondir tests ──

  it('rewrites commondir to ../.. when it contains a Windows absolute path', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWorkspace = '/workspaces/project';

    const hostRoot = env.root.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${hostGitdir}\n`);
    writeFileSync(join(env.worktreeMetaDir, 'commondir'), `${hostRoot}/.git\n`);

    vi.mocked(hostToContainerPath).mockReturnValue(`${containerWorkspace}/.worktrees/my-feature`);

    (orch as AnyOrch)._ctx.patchWorktreeGitFile(env.worktreePath, containerWorkspace);

    const commondirContent = readFileSync(join(env.worktreeMetaDir, 'commondir'), 'utf-8').trim();
    expect(commondirContent).toBe('../..');
  });

  it('is a no-op when commondir is already ../..', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWorkspace = '/workspaces/project';
    const correctGitdir = `${containerWorkspace}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${correctGitdir}\n`);
    writeFileSync(join(env.worktreeMetaDir, 'commondir'), '../..\n');

    (orch as AnyOrch)._ctx.patchWorktreeGitFile(env.worktreePath, containerWorkspace);

    // Should still be ../.. — unchanged
    const commondirContent = readFileSync(join(env.worktreeMetaDir, 'commondir'), 'utf-8').trim();
    expect(commondirContent).toBe('../..');
  });

  it('handles missing commondir file gracefully (does not throw)', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWorkspace = '/workspaces/project';

    const hostRoot = env.root.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${hostGitdir}\n`);

    // No commondir file — should not throw
    expect(() =>
      (orch as AnyOrch)._ctx.patchWorktreeGitFile(env.worktreePath, containerWorkspace)
    ).not.toThrow();
  });
});

describe('_worktreeGitEnv', () => {
  let env: ReturnType<typeof setupTestEnv>;

  beforeEach(() => {
    vi.resetAllMocks();
    onHandlers.clear();
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });
    vi.mocked(containerManager.getRunningContainer).mockReturnValue(null);
    vi.mocked(hostToContainerPath).mockImplementation((p: string) => p);
  });

  afterEach(() => {
    if (env) env.clean();
  });

  it('returns {} when the worktree metadata dir does not exist (non-worktree cwd)', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    // projectRoot itself has no worktrees/<basename> — returns empty
    const result = (orch as AnyOrch)._ctx.worktreeGitEnv(env.root);
    expect(result).toEqual({});
  });

  it('returns {} for an arbitrary directory not under .git/worktrees', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    const unknownDir = join(env.root, '.worktrees', 'nonexistent');
    const result = (orch as AnyOrch)._ctx.worktreeGitEnv(unknownDir);
    expect(result).toEqual({});
  });

  it('returns host-path GIT_DIR and GIT_WORK_TREE when containerWs is omitted', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    const result = (orch as AnyOrch)._ctx.worktreeGitEnv(env.worktreePath);

    const hostRoot = env.root.replace(/\\/g, '/');
    expect(result.GIT_DIR).toBe(`${hostRoot}/.git/worktrees/${env.worktreeName}`);
    expect(result.GIT_WORK_TREE).toBe(env.worktreePath.replace(/\\/g, '/'));
  });

  it('uses forward slashes in host paths (Windows normalisation)', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    const result = (orch as AnyOrch)._ctx.worktreeGitEnv(env.worktreePath);

    // Both values must use forward slashes only
    expect(result.GIT_DIR).not.toContain('\\');
    expect(result.GIT_WORK_TREE).not.toContain('\\');
  });

  it('returns container-path GIT_DIR and GIT_WORK_TREE when containerWs is provided', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWs = '/workspaces/project';
    const containerWorktreePath = `${containerWs}/.worktrees/${env.worktreeName}`;
    vi.mocked(hostToContainerPath).mockReturnValue(containerWorktreePath);

    const result = (orch as AnyOrch)._ctx.worktreeGitEnv(env.worktreePath, containerWs);

    expect(result.GIT_DIR).toBe(`${containerWs}/.git/worktrees/${env.worktreeName}`);
    expect(result.GIT_WORK_TREE).toBe(containerWorktreePath);
  });

  it('calls hostToContainerPath for GIT_WORK_TREE in container context', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);
    const containerWs = '/workspaces/project';
    vi.mocked(hostToContainerPath).mockReturnValue(`${containerWs}/.worktrees/my-feature`);

    (orch as AnyOrch)._ctx.worktreeGitEnv(env.worktreePath, containerWs);

    expect(vi.mocked(hostToContainerPath)).toHaveBeenCalledWith(
      env.worktreePath,
      env.root,
      containerWs,
    );
  });

  it('works for Linux host paths (no backslashes, forward slashes preserved)', () => {
    // Simulate a Linux host root — tmpdir on Linux uses /tmp/...
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    const result = (orch as AnyOrch)._ctx.worktreeGitEnv(env.worktreePath);

    // On any OS, the result must use forward slashes and include the worktree name
    expect(result.GIT_DIR).toContain(`/worktrees/${env.worktreeName}`);
    expect(result.GIT_WORK_TREE).toContain(env.worktreeName);
  });
});

describe('_execGit — GIT_DIR/GIT_WORK_TREE injection', () => {
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

    it('passes GIT_DIR and GIT_WORK_TREE as -e flags to docker exec for worktree operations', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);
      mockExecFileSync.mockReturnValue('');

      (orch as AnyOrch)._execGit(['rebase', 'origin/master'], env.worktreePath);

      const dockerPath = getToolPath('docker');
      const dockerCall = mockExecFileSync.mock.calls.find((c: unknown[]) => c[0] === dockerPath);
      expect(dockerCall).toBeDefined();
      const envVars = extractDockerEnvVars(dockerCall![1] as string[]);
      expect(envVars['GIT_DIR']).toBe(`/workspaces/project/.git/worktrees/${env.worktreeName}`);
      expect(envVars['GIT_WORK_TREE']).toBeDefined();
    });

    it('does not modify the .git file — git resolves via env vars only', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);
      const hostRoot = env.root.replace(/\\/g, '/');
      const originalContent = `gitdir: ${hostRoot}/.git/worktrees/${env.worktreeName}\n`;
      writeFileSync(join(env.worktreePath, '.git'), originalContent);
      mockExecFileSync.mockReturnValue('');

      (orch as AnyOrch)._execGit(['status'], env.worktreePath);

      // .git file must be completely unchanged
      expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe(originalContent);
    });

    it('docker exec error propagates to caller without touching the .git file', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);
      const hostRoot = env.root.replace(/\\/g, '/');
      const originalContent = `gitdir: ${hostRoot}/.git/worktrees/${env.worktreeName}\n`;
      writeFileSync(join(env.worktreePath, '.git'), originalContent);

      const dockerPath = getToolPath('docker');
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === dockerPath) throw new Error('rebase conflict');
        return '';
      });

      expect(() => (orch as AnyOrch)._execGit(['rebase', 'origin/master'], env.worktreePath))
        .toThrow('rebase conflict');

      // .git file must still be unchanged after the error
      expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe(originalContent);
    });

    it('does not call docker exec for worktree subcommands (routes to host git)', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);
      mockExecFileSync.mockReturnValue('');

      (orch as AnyOrch)._execGit(['worktree', 'add', env.worktreePath], env.root);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'add']),
        expect.any(Object),
      );
      const dockerCalls = mockExecFileSync.mock.calls.filter((c: unknown[]) => c[0] === 'docker');
      expect(dockerCalls.length).toBe(0);
    });

    it('does not inject GIT_DIR for worktree subcommands on host git', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);
      mockExecFileSync.mockReturnValue('');

      // worktree commands fall through to host git — should not have GIT_DIR
      (orch as AnyOrch)._execGit(['worktree', 'remove', env.worktreePath], env.root);

      const gitCall = mockExecFileSync.mock.calls.find((c: unknown[]) => c[0] === 'git');
      expect(gitCall).toBeDefined();
      const opts = gitCall![2] as { env?: Record<string, string> };
      expect(opts.env?.GIT_DIR).toBeUndefined();
    });

    it('maps absolute project-root-prefixed args to container paths', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);

      const mapSpy = vi.mocked(hostToContainerPath);
      mockExecFileSync.mockReturnValue('');

      const absoluteFilePath = join(env.root, 'src', 'main.ts');
      (orch as AnyOrch)._execGit(['add', absoluteFilePath], env.worktreePath);

      expect(mapSpy).toHaveBeenCalledWith(
        absoluteFilePath,
        env.root,
        '/workspaces/project',
      );
    });

    it('uses readContainerRemoteUser for the docker exec -u flag', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);
      vi.mocked(readContainerRemoteUser).mockReturnValue('customuser');
      mockExecFileSync.mockReturnValue('');

      (orch as AnyOrch)._execGit(['status'], env.worktreePath);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        getToolPath('docker'),
        expect.arrayContaining(['-u', 'customuser']),
      );
    });

    it('passes no env flags when hostCwd is not a linked worktree (non-worktree docker exec)', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);
      mockExecFileSync.mockReturnValue('');

      // env.root has no matching .git/worktrees/<basename> entry
      // (the tmp dir name isn't a registered worktree)
      (orch as AnyOrch)._execGit(['fetch', 'origin'], env.root);

      const dockerCall = mockExecFileSync.mock.calls.find((c: unknown[]) => c[0] === 'docker');
      if (dockerCall) {
        const envVars = extractDockerEnvVars(dockerCall![1] as string[]);
        expect(envVars['GIT_DIR']).toBeUndefined();
      }
      // If no docker call was made (host fallback), that is also acceptable
    });
  });

  describe('host git fallback path', () => {
    it('injects GIT_DIR and GIT_WORK_TREE env vars for linked-worktree operations', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);
      mockExecFileSync.mockReturnValue('');

      (orch as AnyOrch)._execGit(['status'], env.worktreePath);

      const gitCall = mockExecFileSync.mock.calls.find((c: unknown[]) => c[0] === 'git');
      expect(gitCall).toBeDefined();
      const opts = gitCall![2] as { cwd: string; env?: Record<string, string> };
      expect(opts.env?.GIT_DIR).toContain(`/worktrees/${env.worktreeName}`);
      expect(opts.env?.GIT_WORK_TREE).toBeDefined();
    });

    it('does not modify the .git file — env vars bypass file lookup', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);
      // Write a container-style gitdir — should NOT be changed by host git path
      const containerContent = 'gitdir: /workspaces/project/.git/worktrees/my-feature\n';
      writeFileSync(join(env.worktreePath, '.git'), containerContent);
      mockExecFileSync.mockReturnValue('');

      (orch as AnyOrch)._execGit(['status'], env.worktreePath);

      // .git file unchanged
      expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toBe(containerContent);
    });

    it('falls back to host git when container enabled but container not running, with GIT_DIR injected', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);

      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(containerManager.getRunningContainer).mockReturnValue(null);

      mockExecFileSync.mockReturnValue('');

      (orch as AnyOrch)._execGit(['status'], env.worktreePath);

      const gitCall = mockExecFileSync.mock.calls.find((c: unknown[]) => c[0] === 'git');
      expect(gitCall).toBeDefined();
      const opts = gitCall![2] as { cwd: string; env?: Record<string, string> };
      expect(opts.env?.GIT_DIR).toContain(`/worktrees/${env.worktreeName}`);
    });

    it('calls host git without env override when cwd is not a linked worktree', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);
      mockExecFileSync.mockReturnValue('');

      // env.root is the main project root — no worktree metadata for it
      (orch as AnyOrch)._execGit(['fetch', 'origin'], env.root);

      const gitCall = mockExecFileSync.mock.calls.find((c: unknown[]) => c[0] === 'git');
      expect(gitCall).toBeDefined();
      const opts = gitCall![2] as { cwd: string; env?: Record<string, string> };
      // env should be absent (no GIT_DIR override for the main repo)
      expect(opts.env?.GIT_DIR).toBeUndefined();
    });

    it('does not throw when cwd has no .git file (non-worktree directory like projectRoot)', () => {
      env = setupTestEnv();
      const orch = makeOrch(env.root);

      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(containerManager.getRunningContainer).mockReturnValue({
        containerId: 'cont-test',
        remoteWorkspaceFolder: '/workspaces/project',
      } as any);

      mockExecFileSync.mockReturnValue('');

      expect(() =>
        (orch as AnyOrch)._execGit(['status'], env.root)
      ).not.toThrow();
    });
  });
});

describe('_commitArtifactsToWorktree — GIT_DIR bypass', () => {
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

  function makePipeline(taskDir: string, worktreePath: string) {
    return {
      taskId: 'test-task',
      description: 'my-feature',
      phase: 'merge',
      specPath: taskDir,
      worktreePath,
      branch: 'feat/my-feature',
      qaAttempt: 0,
      maxQaAttempts: 3,
    };
  }

  it('injects GIT_DIR and GIT_WORK_TREE for git add and commit', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    const taskDir = join(env.root, '.teamai', randomUUID().slice(0, 8));
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'spec.md'), '# Spec');
    writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
      id: 'test-task', title: 'T', description: 'my-feature',
      phase: 'merge', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));

    mockExecFileSync.mockReturnValue('');

    (orch as AnyOrch)._ctx.commitArtifactsToWorktree(makePipeline(taskDir, env.worktreePath));

    const gitCalls = mockExecFileSync.mock.calls.filter((c: unknown[]) => c[0] === 'git');
    expect(gitCalls.length).toBeGreaterThanOrEqual(2);

    for (const call of gitCalls) {
      const opts = call[2] as { env?: Record<string, string> };
      expect(opts.env?.GIT_DIR).toContain(`/worktrees/${env.worktreeName}`);
      expect(opts.env?.GIT_WORK_TREE).toBeDefined();
    }
  });

  it('works even when .git file contains container-style paths', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    // Simulate state left by _patchWorktreeGitFile (before agent session)
    writeFileSync(
      join(env.worktreePath, '.git'),
      `gitdir: /workspaces/project/.git/worktrees/${env.worktreeName}\n`,
    );

    const taskDir = join(env.root, '.teamai', randomUUID().slice(0, 8));
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'spec.md'), '# Spec');
    writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
      id: 'test-task', title: 'T', description: 'my-feature',
      phase: 'merge', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));

    mockExecFileSync.mockReturnValue('');

    // Should not throw even with stale container paths in .git
    expect(() =>
      (orch as AnyOrch)._ctx.commitArtifactsToWorktree(makePipeline(taskDir, env.worktreePath))
    ).not.toThrow();

    // git add must use GIT_DIR (bypasses the stale .git file)
    const addCall = mockExecFileSync.mock.calls.find(
      (c: unknown[]) => c[0] === 'git' && (c[1] as string[]).includes('add')
    );
    expect(addCall).toBeDefined();
    const opts = addCall![2] as { env?: Record<string, string> };
    expect(opts.env?.GIT_DIR).toContain(`/worktrees/${env.worktreeName}`);
  });

  it('must use host git, NOT docker exec, even in container mode', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
    vi.mocked(containerManager.getRunningContainer).mockReturnValue({
      containerId: 'cont-test',
      remoteWorkspaceFolder: '/workspaces/project',
    } as any);

    const taskDir = join(env.root, '.teamai', randomUUID().slice(0, 8));
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'spec.md'), '# Spec');
    writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
      id: 'test-task', title: 'T', description: 'my-feature',
      phase: 'merge', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));

    mockExecFileSync.mockReturnValue('');

    (orch as AnyOrch)._ctx.commitArtifactsToWorktree(makePipeline(taskDir, env.worktreePath));

    // Must not have called docker exec
    const dockerCalls = mockExecFileSync.mock.calls.filter((c: unknown[]) => c[0] === 'docker');
    expect(dockerCalls.length).toBe(0);

    // Must have called host git
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['add', '-f', expect.stringContaining('.teamai/')]),
      expect.any(Object),
    );
  });

  it('best-effort restores .git file to host paths for external tooling', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    writeFileSync(
      join(env.worktreePath, '.git'),
      `gitdir: /workspaces/project/.git/worktrees/${env.worktreeName}\n`,
    );

    const taskDir = join(env.root, '.teamai', randomUUID().slice(0, 8));
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, 'spec.md'), '# Spec');
    writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
      id: 'test-task', title: 'T', description: 'my-feature',
      phase: 'merge', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }));

    mockExecFileSync.mockReturnValue('');

    (orch as AnyOrch)._ctx.commitArtifactsToWorktree(makePipeline(taskDir, env.worktreePath));

    // .git file should have been restored to host paths as a best-effort cleanup
    const hostRoot = env.root.replace(/\\/g, '/');
    const content = readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim();
    expect(content).toBe(`gitdir: ${hostRoot}/.git/worktrees/${env.worktreeName}`);
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

    const hostRoot = env.root.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${hostGitdir}\n`);

    vi.mocked(hostToContainerPath).mockReturnValue(`${containerWorkspace}/.worktrees/my-feature`);

    (orch as AnyOrch)._ctx.patchWorktreeGitFile(env.worktreePath, containerWorkspace);
    const afterFirst = readFileSync(join(env.worktreePath, '.git'), 'utf-8');
    expect(afterFirst).toContain(containerWorkspace);

    (orch as AnyOrch)._ctx.patchWorktreeGitFile(env.worktreePath, containerWorkspace);
    const afterSecond = readFileSync(join(env.worktreePath, '.git'), 'utf-8');
    expect(afterSecond).toBe(afterFirst);
  });

  it('repeated restore calls are safe: restoring already-host paths is a no-op', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    const hostRoot = env.root.replace(/\\/g, '/');
    const hostGitdir = `${hostRoot}/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${hostGitdir}\n`);
    writeFileSync(join(env.worktreeMetaDir, 'gitdir'), `${env.worktreePath.replace(/\\/g, '/')}/.git\n`);

    (orch as AnyOrch)._ctx.restoreWorktreeGitFileToHostPaths(env.worktreePath);
    const afterFirst = readFileSync(join(env.worktreePath, '.git'), 'utf-8');
    expect(afterFirst).toContain(hostGitdir);

    (orch as AnyOrch)._ctx.restoreWorktreeGitFileToHostPaths(env.worktreePath);
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

    const hostBackRef = `${env.worktreePath.replace(/\\/g, '/')}/.git`;
    writeFileSync(join(env.worktreeMetaDir, 'gitdir'), `${hostBackRef}\n`);
    // Create commondir with an absolute host path — both patch and restore
    // should converge it to ../.. (the universally-correct relative path).
    writeFileSync(join(env.worktreeMetaDir, 'commondir'), `${hostRoot}/.git\n`);

    const containerWorktreePath = `${containerWorkspace}/.worktrees/my-feature`;
    vi.mocked(hostToContainerPath).mockReturnValue(containerWorktreePath);

    (orch as AnyOrch)._ctx.patchWorktreeGitFile(env.worktreePath, containerWorkspace);
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8')).toContain(containerWorkspace);
    expect(readFileSync(join(env.worktreeMetaDir, 'gitdir'), 'utf-8').trim()).toBe(`${containerWorktreePath}/.git`);

    (orch as AnyOrch)._ctx.restoreWorktreeGitFileToHostPaths(env.worktreePath);
    expect(readFileSync(join(env.worktreePath, '.git'), 'utf-8').trim()).toBe(`gitdir: ${hostGitdir}`);
    expect(readFileSync(join(env.worktreeMetaDir, 'gitdir'), 'utf-8').trim()).toBe(hostBackRef);

    // commondir should stay ../.. through the entire round-trip
    const commondirContent = readFileSync(join(env.worktreeMetaDir, 'commondir'), 'utf-8').trim();
    expect(commondirContent).toBe('../..');
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

    const containerGitdir = `/workspaces/project/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${containerGitdir}\n`);

    // worktreeMetaDir already created by setupTestEnv
    expect((orch as AnyOrch)._ctx.isWorktreeHealthy(env.worktreePath)).toBe(true);
  });

  it('returns false when .git file has container path but host gitdir does not exist', () => {
    env = setupTestEnv();
    const orch = makeOrch(env.root);

    vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });

    const containerGitdir = `/workspaces/project/.git/worktrees/${env.worktreeName}`;
    writeFileSync(join(env.worktreePath, '.git'), `gitdir: ${containerGitdir}\n`);

    rmSync(env.worktreeMetaDir, { recursive: true, force: true });

    expect((orch as AnyOrch)._ctx.isWorktreeHealthy(env.worktreePath)).toBe(false);
  });
});
