/**
 * Integration test for worktree commondir patching.
 *
 * Creates a real git repository and worktree via `git worktree add`, then
 * verifies that _patchWorktreeGitFile rewrites commondir to the relative
 * path ../.. and that git commands on the worktree resolve correctly.
 *
 * Design: uses real git commands (execFileSync not mocked for git) so that
 * we exercise the full git worktree lifecycle. Process-manager and
 * container-manager are mocked minimally — just enough to instantiate the
 * Orchestrator and call private methods.
 *
 * On Windows, git marks linked-worktree .git files as read-only, which
 * causes writeFileSync to fail with EPERM.  The createRepo helper removes
 * those attributes so the patch methods can write.  (In production this is
 * not an issue — container-mode worktrees live on a Linux filesystem, and
 * host-mode git bypasses the .git file entirely via GIT_DIR/GIT_WORK_TREE.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import path from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Hoisted mocks: must be declared before module imports ──

const { mockOn, mockOff, mockEmit, mockKillSession, mockCreateSession, mockSendMessage } = vi.hoisted(() => ({
  mockOn: vi.fn(),
  mockOff: vi.fn(),
  mockEmit: vi.fn(),
  mockKillSession: vi.fn(),
  mockCreateSession: vi.fn(),
  mockSendMessage: vi.fn(),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: (...args: any[]) => mockOn(...args),
    off: (...args: any[]) => mockOff(...args),
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
  containerSessionOpts: vi.fn(() => ({})),
}));

vi.mock('../../src/lib/logger', () => ({ warn: vi.fn() }));

// hostToContainerPath mock: translate host paths inside the repo to
// /workspaces/project equivalents — simulates runtime container-manager.
// The _root (projectRoot) parameter is ignored because the Orchestrator
// always passes this.projectRoot === repoPath in these tests.
const { mockHostToContainer } = vi.hoisted(() => ({
  mockHostToContainer: vi.fn(),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: {
    ensureContainer: vi.fn(),
    getRunningContainer: vi.fn(() => null),
  },
  hostToContainerPath: (...args: any[]) => mockHostToContainer(...args),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

// ── Import after mocks ──

import { getOrchestrator } from '../../src/lib/orchestrator';
import { patchCommondirToRelative } from '../../src/lib/orchestrator/worktree-utils';

type AnyOrch = any;

function gitAvailable(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

function createRepo(): { repoPath: string; worktreePath: string } {
  const repoPath = path.join(tmpdir(), `teamai-wt-int-${randomUUID().slice(0, 8)}`);
  mkdirSync(repoPath, { recursive: true });

  execFileSync('git', ['init', '-b', 'main'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['config', 'user.email', 'test@test.com'], { cwd: repoPath, stdio: 'pipe' });

  // Create an initial commit so we have a branch to branch from
  writeFileSync(path.join(repoPath, 'README.md'), '# Integration test repo\n');
  execFileSync('git', ['add', 'README.md'], { cwd: repoPath, stdio: 'pipe' });
  execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoPath, stdio: 'pipe' });

  // Create a real worktree inside the repo (mirrors production — Orchestrator
  // places worktrees under .worktrees/ within the project root).
  const wtDir = path.join(repoPath, '.worktrees');
  mkdirSync(wtDir, { recursive: true });
  const worktreePath = path.join(wtDir, `wt-${randomUUID().slice(0, 6)}`);
  const branchName = `feat/int-${randomUUID().slice(0, 6)}`;
  execFileSync('git', ['worktree', 'add', worktreePath, '-b', branchName], { cwd: repoPath, stdio: 'pipe' });

  return { repoPath, worktreePath };
}

function removeRepo(repoPath: string, worktreePath: string): void {
  try {
    execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: repoPath, stdio: 'pipe' });
  } catch { /* best-effort */ }

  if (existsSync(worktreePath)) {
    try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // Prune stale worktree metadata after removing the worktree directory
  try { execFileSync('git', ['worktree', 'prune'], { cwd: repoPath, stdio: 'pipe' }); } catch { /* best-effort */ }
  try { rmSync(repoPath, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ── Test suite (conditional on git being available) ──

const suite = gitAvailable() ? describe : describe.skip;

suite('worktree commondir patching — integration', () => {
  let repoPath: string;
  let worktreePath: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mockHostToContainer.mockImplementation((hostPath: string, _root: string, containerWs: string) => {
      return hostPath.replace(/\\/g, '/').replace(repoPath.replace(/\\/g, '/'), containerWs);
    });

    const repo = createRepo();
    repoPath = repo.repoPath;
    worktreePath = repo.worktreePath;
  });

  afterEach(() => {
    removeRepo(repoPath, worktreePath);
  });

  describe('_patchWorktreeGitFile', () => {
    it('rewrites commondir to ../.. (no-op if git already wrote a relative path)', () => {
      const orch = getOrchestrator(repoPath) as AnyOrch;
      const containerWorkspace = '/workspaces/project';

      const worktreeName = path.basename(worktreePath);
      const commondirPath = path.join(repoPath, '.git', 'worktrees', worktreeName, 'commondir');
      expect(existsSync(commondirPath)).toBe(true);

      orch._ctx.patchWorktreeGitFile(worktreePath, containerWorkspace);

      // After patching: commondir must be ../.. (regardless of what git wrote initially)
      const afterContent = readFileSync(commondirPath, 'utf-8').trim();
      expect(afterContent).toBe('../..');
    });

    it('rewrites .git file to use container-style gitdir path', () => {
      const orch = getOrchestrator(repoPath) as AnyOrch;
      const containerWorkspace = '/workspaces/project';

      orch._ctx.patchWorktreeGitFile(worktreePath, containerWorkspace);

      const worktreeName = path.basename(worktreePath);
      const gitFile = path.join(worktreePath, '.git');
      const gitFileContent = readFileSync(gitFile, 'utf-8').trim();
      expect(gitFileContent).toBe(`gitdir: /workspaces/project/.git/worktrees/${worktreeName}`);
    });

    it('rewrites the back-reference gitdir file to container path', () => {
      const orch = getOrchestrator(repoPath) as AnyOrch;
      const containerWorkspace = '/workspaces/project';

      orch._ctx.patchWorktreeGitFile(worktreePath, containerWorkspace);

      const worktreeName = path.basename(worktreePath);
      const gitdirPath = path.join(repoPath, '.git', 'worktrees', worktreeName, 'gitdir');
      const afterPatch = readFileSync(gitdirPath, 'utf-8').trim().replace(/\\/g, '/');
      expect(afterPatch).toContain('/workspaces/project');
    });

    it('is idempotent — calling twice produces the same result', () => {
      const orch = getOrchestrator(repoPath) as AnyOrch;
      const containerWorkspace = '/workspaces/project';

      orch._ctx.patchWorktreeGitFile(worktreePath, containerWorkspace);
      const afterFirst = readFileSync(path.join(worktreePath, '.git'), 'utf-8');

      orch._ctx.patchWorktreeGitFile(worktreePath, containerWorkspace);
      const afterSecond = readFileSync(path.join(worktreePath, '.git'), 'utf-8');

      expect(afterSecond).toBe(afterFirst);
    });

    it('git commands on the worktree resolve correctly when using GIT_DIR / GIT_WORK_TREE env vars', () => {
      const orch = getOrchestrator(repoPath) as AnyOrch;
      const containerWorkspace = '/workspaces/project';

      // Patch — this rewrites .git to a container path the host can't resolve
      orch._ctx.patchWorktreeGitFile(worktreePath, containerWorkspace);

      // After patching, the .git file points to a container path that doesn't
      // exist on the host. A bare git command should fail.
      // (Note: some git versions may walk parent directories to find a .git;
      // if so the env-var test below already proves correctness.)
      let bareGitFailed = false;
      try {
        execFileSync('git', ['rev-parse', '--git-dir'], { cwd: worktreePath, stdio: 'pipe' });
      } catch {
        bareGitFailed = true;
      }
      expect(bareGitFailed).toBe(true);

      // But with GIT_DIR / GIT_WORK_TREE set (same as _execGit does), git
      // bypasses the .git pointer file entirely and resolves the worktree:
      const worktreeName = path.basename(worktreePath);
      const gitDir = path.join(repoPath, '.git', 'worktrees', worktreeName).replace(/\\/g, '/');
      const gitWorkTree = worktreePath.replace(/\\/g, '/');

      const result = execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: worktreePath,
        env: { ...process.env, GIT_DIR: gitDir, GIT_WORK_TREE: gitWorkTree },
        encoding: 'utf-8',
        stdio: 'pipe',
      }).trim().replace(/\\/g, '/');

      // git rev-parse --git-dir returns the .git directory path
      // (normalise result to forward slashes for cross-OS comparison)
      expect(result).toBe(gitDir);
    });
  });

  describe('_restoreWorktreeGitFileToHostPaths', () => {
    it('restores .git file to host absolute paths after container patch', () => {
      const orch = getOrchestrator(repoPath) as AnyOrch;

      // Step 1: Patch to container paths
      const containerWorkspace = '/workspaces/project';
      orch._ctx.patchWorktreeGitFile(worktreePath, containerWorkspace);

      // Step 2: Restore to host paths
      orch._ctx.restoreWorktreeGitFileToHostPaths(worktreePath);

      // .git file should now contain a host-absolute gitdir path
      const gitFile = path.join(worktreePath, '.git');
      const gitFileContent = readFileSync(gitFile, 'utf-8').trim();
      expect(gitFileContent).toContain('gitdir:');
      expect(gitFileContent).not.toContain('/workspaces/project');

      // commondir should still be ../.. after the round-trip
      const worktreeName = path.basename(worktreePath);
      const commondirPath = path.join(repoPath, '.git', 'worktrees', worktreeName, 'commondir');
      const commondirContent = readFileSync(commondirPath, 'utf-8').trim();
      expect(commondirContent).toBe('../..');
    });

    it('restores the back-reference (gitdir file) to host paths after container patch', () => {
      const orch = getOrchestrator(repoPath) as AnyOrch;

      const containerWorkspace = '/workspaces/project';
      orch._ctx.patchWorktreeGitFile(worktreePath, containerWorkspace);

      // After patch, back-reference should be container-style
      const worktreeName = path.basename(worktreePath);
      const gitdirPath = path.join(repoPath, '.git', 'worktrees', worktreeName, 'gitdir');
      const afterPatch = readFileSync(gitdirPath, 'utf-8').trim().replace(/\\/g, '/');
      expect(afterPatch).toContain('/workspaces/project');

      // Restore
      orch._ctx.restoreWorktreeGitFileToHostPaths(worktreePath);

      // After restore, back-reference should NOT reference the container workspace
      const afterRestore = readFileSync(gitdirPath, 'utf-8').trim();
      expect(afterRestore).not.toContain('/workspaces/project');
    });

    it('git commands work directly on the worktree after restore (no env vars needed)', () => {
      const orch = getOrchestrator(repoPath) as AnyOrch;

      // Patch to container, then restore
      orch._ctx.patchWorktreeGitFile(worktreePath, '/workspaces/project');
      orch._ctx.restoreWorktreeGitFileToHostPaths(worktreePath);

      // After restore, plain git commands (without GIT_DIR/GIT_WORK_TREE) must work
      const result = execFileSync('git', ['rev-parse', '--git-dir'], {
        cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe',
      }).trim();

      // result is either absolute (host) or relative (.git/worktrees/<name>)
      expect(result.length).toBeGreaterThan(0);
      expect(() => {
        execFileSync('git', ['status'], { cwd: worktreePath, stdio: 'pipe' });
      }).not.toThrow();
    });
  });

  describe('_patchCommondirToRelative', () => {
    it('directly rewrites commondir to ../..', () => {
      const worktreeName = path.basename(worktreePath);

      // Call the helper directly
      patchCommondirToRelative(worktreeName, repoPath);

      const commondirPath = path.join(repoPath, '.git', 'worktrees', worktreeName, 'commondir');
      const content = readFileSync(commondirPath, 'utf-8').trim();
      expect(content).toBe('../..');
    });

    it('is a no-op when commondir is already ../..', () => {
      const worktreeName = path.basename(worktreePath);
      const commondirPath = path.join(repoPath, '.git', 'worktrees', worktreeName, 'commondir');

      // Pre-set the commondir to ../..
      writeFileSync(commondirPath, '../..\n');

      // Should not throw
      patchCommondirToRelative(worktreeName, repoPath);

      const content = readFileSync(commondirPath, 'utf-8').trim();
      expect(content).toBe('../..');
    });
  });
});
