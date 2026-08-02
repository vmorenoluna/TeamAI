import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock is hoisted by Vitest — factory must use inline vi.fn(), not top-level variables
vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

import { findInterruptedTasks, findOrphanedWorktrees, restoreContainerPatchedWorktrees, startupCleanup, autoClearExpiredRateLimits, reconcileTaskArtifacts, autoResumeInterruptedTasks, sweepStalledTasks } from '../../src/lib/recovery';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { join } from 'path';

// Mock orchestrator module for autoResumeInterruptedTasks and sweepStalledTasks tests
const mockOrchResumeTask = vi.fn();
const mockGetOrchestrator = vi.fn();
const mockIsTaskActive = vi.fn();
const mockSweepResumeTask = vi.fn();
const mockTriggerEarlyWakeup = vi.fn<[string, string], boolean>(() => false);
const mockGetAllSessions = vi.fn();
const mockGetStalledSessions = vi.fn<[number?, number?], { id: string; taskId: string; role: string; toolInFlight?: boolean }[]>(() => []);
const mockKillSession = vi.fn();

vi.mock('../../src/lib/orchestrator', () => ({
  getOrchestrator: (...args: unknown[]) => mockGetOrchestrator(...args),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    getAllSessions: (...args: unknown[]) => mockGetAllSessions(...args as []),
    getStalledSessions: (idleTimeoutMs: number, toolTimeoutMs: number) => mockGetStalledSessions(idleTimeoutMs, toolTimeoutMs),
    killSession: (sessionId: string) => mockKillSession(sessionId),
  },
}));

// Mock container-manager so getWorktreeBase doesn't try to probe Docker.
vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: () => ({ enabled: false, explicit: false }),
  readContainerRemoteUser: () => 'node',
  containerManager: {
    ensureContainer: vi.fn(),
    getRunningContainer: () => null,
  },
  hostToContainerPath: (p: string) => p,
  dockerAvailable: () => false,
  _resetDockerAvailableCache: vi.fn(),
}));

const mockRestoreWorktreeGitFileToHostPaths = vi.fn();
vi.mock('../../src/lib/orchestrator/worktree-utils', () => ({
  restoreWorktreeGitFileToHostPaths: (...args: unknown[]) => mockRestoreWorktreeGitFileToHostPaths(...args),
}));

// Helper: readdirSync and statSync have overloaded signatures that make
// mockImplementation require a type assertion. These wrappers contain the
// narrow `as any` casts so each test doesn't need to repeat them.
 
const mockReaddir = (impl: (path: unknown) => string[]) => {
  (vi.mocked(readdirSync) as any).mockImplementation(impl);
};

const mockStatSync = (impl: () => { isDirectory: () => boolean }) => {
  (vi.mocked(statSync) as any).mockImplementation(impl);
};
 

describe('findInterruptedTasks', () => {
  it('returns empty array when no projects file exists', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    expect(findInterruptedTasks()).toEqual([]);
  });

  it('returns empty array when projects file is empty array', () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p) === join('/mock/home', '.teamai', 'projects.json'));
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json')) return '[]';
      return '';
    });

    expect(findInterruptedTasks()).toEqual([]);
  });

  it('skips projects without .teamai directory', () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p) === join('/mock/home', '.teamai', 'projects.json'));
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: '/test' }]);
      return '';
    });

    expect(findInterruptedTasks()).toEqual([]);
  });

  it('finds tasks in in-progress phases', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'my-task', 'task.json');
    const sessionMap = join(teamaiDir, 'my-task', 'session_map.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      if (path === sessionMap) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 'task-123', title: 'My Task', phase: 'implement' });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['my-task'];
      return [];
    });

    const result = findInterruptedTasks();
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      taskId: 'task-123',
      title: 'My Task',
      phase: 'implement',
      projectPath,
      projectName: 'test',
      isPaused: false,
    });
  });

  it('ignores tasks in non-in-progress phases', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'done-task', 'task.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 'done-1', title: 'Done', phase: 'done' });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['done-task'];
      return [];
    });

    expect(findInterruptedTasks()).toEqual([]);
  });

  it('skips malformed task.json', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'bad-task', 'task.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile) return 'not-json';
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['bad-task'];
      return [];
    });

    expect(findInterruptedTasks()).toEqual([]);
  });

  it('handles multiple projects', () => {
    const projA = '/proj/a';
    const projB = '/proj/b';
    const teamaiA = join(projA, '.teamai');
    const taskFileA = join(teamaiA, 't1', 'task.json');
    const sessionMapA = join(teamaiA, 't1', 'session_map.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiA) return true;
      if (path === join(projB, '.teamai')) return true;
      if (path === taskFileA) return true;
      if (path === sessionMapA) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'A', path: projA }, { name: 'B', path: projB }]);
      if (path === taskFileA)
        return JSON.stringify({ id: 'a-1', title: 'Task A', phase: 'spec' });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiA) return ['t1'];
      if (String(p) === join(projB, '.teamai')) return ['t2'];
      return [];
    });

    const result = findInterruptedTasks();
    expect(result).toHaveLength(1);
    expect(result[0].projectName).toBe('A');
  });

  // Coverage: lines 44-45 — readdirSync throws for a project's teamaiDir
  it('skips project when readdirSync throws for teamaiDir', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      return '';
    });
    // readdirSync throws for teamaiDir — catch at lines 44-45 continues to next project
    mockReaddir(() => {
      throw new Error('cannot read directory');
    });

    expect(findInterruptedTasks()).toEqual([]);
  });
});

describe('findOrphanedWorktrees', () => {
  it('returns empty when no projects', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(findOrphanedWorktrees()).toEqual([]);
  });

  it('skips projects without worktrees directory', () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p) === join('/mock/home', '.teamai', 'projects.json'));
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: '/test' }]);
      return '';
    });

    expect(findOrphanedWorktrees()).toEqual([]);
  });

  it('finds worktree with no matching task', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '..', 'worktrees');
    const wtPath = join(wtDir, 'orphan-123');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === wtDir) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === wtDir) return ['orphan-123'];
      if (String(p) === join(projectPath, '.teamai')) return ['other'];
      return [];
    });
    mockStatSync(() => ({ isDirectory: () => true }));

    const result = findOrphanedWorktrees();
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(wtPath);
  });

  it('finds worktree whose task is no longer active', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '..', 'worktrees');
    const wtPath = join(wtDir, 'done-slug');
    const taskFile = join(projectPath, '.teamai', 'done-slug', 'task.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === wtDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 'done-456', title: 'Done', phase: 'done' });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === wtDir) return ['done-slug'];
      if (String(p) === join(projectPath, '.teamai')) return ['done-slug'];
      return [];
    });
    mockStatSync(() => ({ isDirectory: () => true }));

    const result = findOrphanedWorktrees();
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(wtPath);
  });

  it('skips non-directory entries in worktrees', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '..', 'worktrees');

    vi.mocked(existsSync).mockImplementation((p) =>
      String(p) === join('/mock/home', '.teamai', 'projects.json') || String(p) === wtDir);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === wtDir) return ['some-slug'];
      return [];
    });
    mockStatSync(() => ({ isDirectory: () => false }));

    expect(findOrphanedWorktrees()).toEqual([]);
  });

  it('ignores worktree entries without task- prefix', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '..', 'worktrees');

    vi.mocked(existsSync).mockImplementation((p) =>
      String(p) === join('/mock/home', '.teamai', 'projects.json') || String(p) === wtDir);
    vi.mocked(readFileSync).mockImplementation(() => '[]');
    mockReaddir((p) => {
      if (String(p) === wtDir) return ['not-a-task'];
      return [];
    });
    mockStatSync(() => ({ isDirectory: () => true }));

    expect(findOrphanedWorktrees()).toEqual([]);
  });

  it('keeps worktree when task is still in progress', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '..', 'worktrees');
    const taskFile = join(projectPath, '.teamai', 'active', 'task.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === wtDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 'active-789', title: 'Active', phase: 'implement' });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === wtDir) return ['active'];
      if (String(p) === join(projectPath, '.teamai')) return ['active'];
      return [];
    });
    mockStatSync(() => ({ isDirectory: () => true }));

    expect(findOrphanedWorktrees()).toEqual([]);
  });

  // Coverage: lines 86-87 — readdirSync throws for worktreesDir
  it('skips project when readdirSync throws for worktreesDir', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '..', 'worktrees');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === wtDir) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      return '';
    });
    // readdirSync throws for worktreesDir — catch at lines 86-87 continues to next project
    mockReaddir(() => {
      throw new Error('cannot read worktrees');
    });

    expect(findOrphanedWorktrees()).toEqual([]);
  });
});

// ── restoreContainerPatchedWorktrees ────────────────────────────────────
//
// A worktree's .git file (and its host-side back-reference) is
// deliberately rewritten to container-style paths (patchWorktreeGitFile)
// while a coder session runs inside a devcontainer. The only place that
// reverses this today is the artifact-commit success path — any
// interruption before that (a killed session, a crashed container, or the
// TeamAI server process itself being terminated) leaves the worktree
// stuck container-shaped. This is the startup-time repair for that: safe
// regardless of *why* the previous run ended, since there's no in-memory
// state to reason about after a restart.

describe('restoreContainerPatchedWorktrees', () => {
  beforeEach(() => {
    mockRestoreWorktreeGitFileToHostPaths.mockClear();
  });

  it('returns 0 when no projects exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(restoreContainerPatchedWorktrees()).toBe(0);
    expect(mockRestoreWorktreeGitFileToHostPaths).not.toHaveBeenCalled();
  });

  it('restores a worktree whose .git file points to an unresolvable (container-style) gitdir', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '..', 'worktrees');
    const wtPath = join(wtDir, 'stuck-slug');
    const gitFile = join(wtPath, '.git');
    const containerGitdir = '/workspaces/formell/.git/worktrees/stuck-slug';

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === wtDir) return true;
      if (path === gitFile) return true;
      if (path === containerGitdir) return false; // unresolvable from the host
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === gitFile) return `gitdir: ${containerGitdir}\n`;
      return '';
    });
    mockReaddir((p) => (String(p) === wtDir ? ['stuck-slug'] : []));
    mockStatSync(() => ({ isDirectory: () => true }));

    const count = restoreContainerPatchedWorktrees();

    expect(count).toBe(1);
    expect(mockRestoreWorktreeGitFileToHostPaths).toHaveBeenCalledWith(wtPath, projectPath);
  });

  it('does not touch a worktree whose .git file already resolves on the host', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '..', 'worktrees');
    const wtPath = join(wtDir, 'healthy-slug');
    const gitFile = join(wtPath, '.git');
    const hostGitdir = join(projectPath, '.git', 'worktrees', 'healthy-slug');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === wtDir) return true;
      if (path === gitFile) return true;
      if (path === hostGitdir) return true; // already host-resolvable
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === gitFile) return `gitdir: ${hostGitdir}\n`;
      return '';
    });
    mockReaddir((p) => (String(p) === wtDir ? ['healthy-slug'] : []));
    mockStatSync(() => ({ isDirectory: () => true }));

    const count = restoreContainerPatchedWorktrees();

    expect(count).toBe(0);
    expect(mockRestoreWorktreeGitFileToHostPaths).not.toHaveBeenCalled();
  });

  it('skips a worktree directory with no .git file', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '..', 'worktrees');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === wtDir) return true;
      return false; // .git file (and everything else) absent
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      return '';
    });
    mockReaddir((p) => (String(p) === wtDir ? ['no-git-slug'] : []));
    mockStatSync(() => ({ isDirectory: () => true }));

    expect(restoreContainerPatchedWorktrees()).toBe(0);
    expect(mockRestoreWorktreeGitFileToHostPaths).not.toHaveBeenCalled();
  });

  it('does not crash and continues past a project whose worktrees dir cannot be read', () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      return true; // worktreesDir "exists" but reading it will throw
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: '/test/project' }]);
      return '';
    });
    mockReaddir(() => { throw new Error('cannot read worktrees'); });

    expect(restoreContainerPatchedWorktrees()).toBe(0);
    expect(mockRestoreWorktreeGitFileToHostPaths).not.toHaveBeenCalled();
  });
});

describe('startupCleanup', () => {
  it('returns unified report', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const report = startupCleanup(3);
    expect(report).toEqual({
      interruptedTasks: [],
      staleSessions: 3,
      orphanedWorktrees: [],
      autoClearedRateLimits: 0,
      artifactInconsistencies: [],
      restoredWorktrees: 0,
    });
  });
});

// ── reconcileTaskArtifacts (#9) ───────────────────────────────────

describe('reconcileTaskArtifacts', () => {
  it('returns empty when no projects exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(reconcileTaskArtifacts()).toEqual([]);
  });

  it('returns empty when no tasks are in phases that require artifacts', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'backlog-task', 'task.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (String(p) === taskFile)
        return JSON.stringify({ id: 'backlog-1', title: 'Backlog Task', phase: 'backlog' });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['backlog-task'];
      return [];
    });

    expect(reconcileTaskArtifacts()).toEqual([]);
  });

  it('detects missing spec.md for plan phase task', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'plan-task', 'task.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      // spec.md does NOT exist
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (String(p) === taskFile)
        return JSON.stringify({ id: 'plan-1', title: 'Plan Task', phase: 'plan' });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['plan-task'];
      return [];
    });

    const result = reconcileTaskArtifacts();
    expect(result).toHaveLength(1);
    expect(result[0].taskId).toBe('plan-1');
    expect(result[0].phase).toBe('plan');
    expect(result[0].issue).toContain('spec.md');
  });

  it('detects missing plan.json for implement phase task', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'impl-task', 'task.json');
    const specFile = join(teamaiDir, 'impl-task', 'spec.md');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      if (path === specFile) return true; // spec.md exists
      // plan.json does NOT exist
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (String(p) === taskFile)
        return JSON.stringify({ id: 'impl-1', title: 'Implement Task', phase: 'implement' });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['impl-task'];
      return [];
    });

    const result = reconcileTaskArtifacts();
    expect(result).toHaveLength(1);
    expect(result[0].issue).toContain('plan.json');
  });

  it('reports no issues when all artifacts present', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'good-task', 'task.json');
    const specFile = join(teamaiDir, 'good-task', 'spec.md');
    const planFile = join(teamaiDir, 'good-task', 'plan.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      if (path === specFile) return true;
      if (path === planFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (String(p) === taskFile)
        return JSON.stringify({ id: 'good-1', title: 'Good Task', phase: 'implement' });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['good-task'];
      return [];
    });

    expect(reconcileTaskArtifacts()).toEqual([]);
  });

  it('detects multiple missing artifacts for create-pr phase', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'pr-task', 'task.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false; // Neither spec.md nor plan.json exists
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (String(p) === taskFile)
        return JSON.stringify({ id: 'pr-1', title: 'PR Task', phase: 'create-pr' });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['pr-task'];
      return [];
    });

    const result = reconcileTaskArtifacts();
    // create-pr requires both spec.md and plan.json
    expect(result).toHaveLength(2);
  });
});

// ── autoClearExpiredRateLimits ──────────────────────────────────────

describe('autoClearExpiredRateLimits', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  it('returns 0 when no projects exist', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(autoClearExpiredRateLimits()).toBe(0);
  });

  it('returns 0 when no tasks have rateLimitedUntil', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'my-task', 'task.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (String(p) === taskFile)
        return JSON.stringify({ id: 't1', title: 'Task', phase: 'implement' });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['my-task'];
      return [];
    });

    expect(autoClearExpiredRateLimits()).toBe(0);
  });

  it('clears expired rateLimitedUntil and returns count', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'my-task', 'task.json');
    const pastDate = new Date(Date.now() - 3600_000).toISOString(); // 1 hour ago

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (String(p) === taskFile)
        return JSON.stringify({ id: 't1', title: 'Task', phase: 'implement', rateLimitedUntil: pastDate });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['my-task'];
      return [];
    });

    const result = autoClearExpiredRateLimits();
    expect(result).toBe(1);

    // writeFileSync should have been called to clear the field
    const writeCall = vi.mocked(writeFileSync).mock.calls[0];
    expect(writeCall).toBeDefined();
    expect(String(writeCall[0])).toBe(taskFile);
    const written = JSON.parse(String(writeCall[1]));
    expect(written.rateLimitedUntil).toBeUndefined();
  });

  it('does not clear future rateLimitedUntil', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'my-task', 'task.json');
    const futureDate = new Date(Date.now() + 3600_000).toISOString(); // 1 hour from now

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (String(p) === taskFile)
        return JSON.stringify({ id: 't1', title: 'Task', phase: 'implement', rateLimitedUntil: futureDate });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['my-task'];
      return [];
    });

    // Future rate limit should NOT be cleared
    expect(autoClearExpiredRateLimits()).toBe(0);
    expect(vi.mocked(writeFileSync)).not.toHaveBeenCalled();
  });

  it('skips malformed task.json gracefully', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'bad-task', 'task.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (String(p) === taskFile) return '{{{bad-json';
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['bad-task'];
      return [];
    });

    expect(autoClearExpiredRateLimits()).toBe(0);
  });

  // Coverage: line 157 — continue when project has no .teamai directory
  it('skips project with no .teamai directory', () => {
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: '/test' }]);
      return '';
    });

    // .teamai dir does NOT exist → continue to next project
    expect(autoClearExpiredRateLimits()).toBe(0);
  });

  // Coverage: lines 163-164 — readdirSync throws for teamaiDir in autoClearExpiredRateLimits
  it('skips project when readdirSync throws for teamaiDir', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      return '';
    });
    // readdirSync throws for teamaiDir — the catch at lines 163-164 continues
    mockReaddir(() => {
      throw new Error('cannot read directory');
    });

    expect(autoClearExpiredRateLimits()).toBe(0);
  });
});


// ── Edge-case coverage: catch blocks ──

describe('_loadProjects (via findInterruptedTasks)', () => {
  it('returns empty when projects.json contains invalid JSON', () => {
    vi.mocked(existsSync).mockImplementation((p) =>
      String(p) === join('/mock/home', '.teamai', 'projects.json'));
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json')) return '{{{bad-json';
      return '';
    });

    expect(findInterruptedTasks()).toEqual([]);
  });
});

describe('findOrphanedWorktrees — catch blocks', () => {
  it('reports worktree as orphaned when readdirSync throws for teamai dir', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '..', 'worktrees');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === wtDir) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      return '';
    });
    // First call (wtDir) returns entries, second call (teamaiDir) throws
    let callCount = 0;
    mockReaddir((p) => {
      if (String(p) === wtDir && callCount++ === 0) return ['orphan-slug'];
      throw new Error('readdirSync failed');
    });
    mockStatSync(() => ({ isDirectory: () => true }));

    // When readdirSync for teamaiDir throws, the knownSlugs set is empty,
    // so the worktree IS reported as orphaned.
    const result = findOrphanedWorktrees();
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(join(wtDir, 'orphan-slug'));
  });

  // Coverage: lines 96-97 — statSync throws for a worktree entry
  it('skips entry when statSync throws', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '..', 'worktrees');

    vi.mocked(existsSync).mockImplementation((p) =>
      String(p) === join('/mock/home', '.teamai', 'projects.json') || String(p) === wtDir);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === wtDir) return ['some-slug'];
      return [];
    });
    // statSync throws — the catch at lines 96-97 continues to next entry
    mockStatSync(() => {
      throw new Error('statSync failed');
    });

    expect(findOrphanedWorktrees()).toEqual([]);
  });

  // Coverage: lines 121-122 — malformed JSON in inner task lookup
  it('reports worktree as orphaned when matching task.json is malformed', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '..', 'worktrees');
    const wtPath = join(wtDir, 'bad');
    const taskFile = join(projectPath, '.teamai', 'bad', 'task.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === wtDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      // task.json is malformed JSON — the catch skips it
      if (path === taskFile) return 'not-valid-json{{{';
      return '';
    });
    // wtDir has the worktree, teamaiDir has 'bad' directory
    mockReaddir((p) => {
      if (String(p) === wtDir) return ['bad'];
      if (String(p) === join(projectPath, '.teamai')) return ['bad'];
      return [];
    });
    mockStatSync(() => ({ isDirectory: () => true }));

    // The catch skips the malformed JSON, task stays out of knownSlugs,
    // so the worktree is reported as orphaned
    const result = findOrphanedWorktrees();
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(wtPath);
  });
});

// ── autoResumeInterruptedTasks ──────────────────────────────────────

describe('autoResumeInterruptedTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Advance system time past the debounce window so each test starts
    // with a fresh 15-second window.  Without this the first test to call
    // autoResumeInterruptedTasks() would set _lastAutoResumeTime and every
    // subsequent test would be debounced into a no-op.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 20_000);
    mockGetOrchestrator.mockReturnValue({ resumeTask: mockOrchResumeTask });
    mockOrchResumeTask.mockResolvedValue(undefined);
  });

  it('resumes all interrupted tasks found by findInterruptedTasks', async () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFileA = join(teamaiDir, 'task-a', 'task.json');
    const taskFileB = join(teamaiDir, 'task-b', 'task.json');
    const sessionMapA = join(teamaiDir, 'task-a', 'session_map.json');
    const sessionMapB = join(teamaiDir, 'task-b', 'session_map.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFileA) return true;
      if (path === taskFileB) return true;
      if (path === sessionMapA) return true;
      if (path === sessionMapB) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFileA)
        return JSON.stringify({ id: 'task-a', title: 'Task A', phase: 'spec' });
      if (path === taskFileB)
        return JSON.stringify({ id: 'task-b', title: 'Task B', phase: 'implement' });
      return '';
    });
    (vi.mocked(readdirSync) as any).mockImplementation((p: string) => {
      if (String(p) === teamaiDir) return ['task-a', 'task-b'];
      return [];
    });

    const count = await autoResumeInterruptedTasks();

    expect(count).toBe(2);
    expect(mockGetOrchestrator).toHaveBeenCalledTimes(2);
    expect(mockGetOrchestrator).toHaveBeenCalledWith(projectPath);
    expect(mockOrchResumeTask).toHaveBeenCalledTimes(2);
    expect(mockOrchResumeTask).toHaveBeenCalledWith('task-a');
    expect(mockOrchResumeTask).toHaveBeenCalledWith('task-b');
  });

  it('returns 0 when no interrupted tasks exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const count = await autoResumeInterruptedTasks();

    expect(count).toBe(0);
    expect(mockGetOrchestrator).not.toHaveBeenCalled();
    expect(mockOrchResumeTask).not.toHaveBeenCalled();
  });

  it('returns 0 when debounced (called within 15s window)', async () => {
    // First call — don't set up any tasks, just verify debounce works
    vi.mocked(existsSync).mockReturnValue(false);
    await autoResumeInterruptedTasks(); // sets _lastAutoResumeTime

    // Second call within debounce window should return 0 without doing work
    mockGetOrchestrator.mockClear();
    const count = await autoResumeInterruptedTasks();

    expect(count).toBe(0);
    expect(mockGetOrchestrator).not.toHaveBeenCalled();
  });

  it('handles orchestrator creation failure gracefully', async () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'task-a', 'task.json');
    const sessionMap = join(teamaiDir, 'task-a', 'session_map.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      if (path === sessionMap) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 'task-a', title: 'Task A', phase: 'spec' });
      return '';
    });
    (vi.mocked(readdirSync) as any).mockImplementation((p: string) => {
      if (String(p) === teamaiDir) return ['task-a'];
      return [];
    });

    mockGetOrchestrator.mockImplementation(() => {
      throw new Error('Failed to create orchestrator');
    });

    const count = await autoResumeInterruptedTasks();

    // Task was found but orchestrator creation failed, so it wasn't queued for resume
    expect(count).toBe(0);
    expect(mockGetOrchestrator).toHaveBeenCalledTimes(1);
    expect(mockOrchResumeTask).not.toHaveBeenCalled();
  });

  it('handles resumeTask rejection gracefully (fire-and-forget)', async () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'task-a', 'task.json');
    const sessionMap = join(teamaiDir, 'task-a', 'session_map.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      if (path === sessionMap) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 'task-a', title: 'Task A', phase: 'spec' });
      return '';
    });
    (vi.mocked(readdirSync) as any).mockImplementation((p: string) => {
      if (String(p) === teamaiDir) return ['task-a'];
      return [];
    });

    // resumeTask rejects, but the .catch handler should swallow it
    mockOrchResumeTask.mockRejectedValueOnce(new Error('Session creation failed'));

    const count = await autoResumeInterruptedTasks();

    // Should still return count and not throw
    expect(count).toBe(1);
    expect(mockOrchResumeTask).toHaveBeenCalledWith('task-a');
  });

  it('skips tasks with future rateLimitedUntil', async () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'task-rl', 'task.json');
    const sessionMap = join(teamaiDir, 'task-rl', 'session_map.json');
    const futureDate = new Date(Date.now() + 3600_000).toISOString();
    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      if (path === sessionMap) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 'task-rl', title: 'Rate Limited', phase: 'implement', rateLimitedUntil: futureDate });
      return '';
    });
    (vi.mocked(readdirSync) as any).mockImplementation((p: string) => {
      if (String(p) === teamaiDir) return ['task-rl'];
      return [];
    });
    const count = await autoResumeInterruptedTasks();
    expect(count).toBe(0);
    expect(mockOrchResumeTask).not.toHaveBeenCalled();
  });    it('resumes tasks with expired rateLimitedUntil', async () => {
      const projectPath = '/test/project';
      const teamaiDir = join(projectPath, '.teamai');
      const taskFile = join(teamaiDir, 'task-expired', 'task.json');
      const sessionMap = join(teamaiDir, 'task-expired', 'session_map.json');
      const pastDate = new Date(Date.now() - 3600_000).toISOString();
      vi.mocked(existsSync).mockImplementation((p) => {
        const path = String(p);
        if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
        if (path === teamaiDir) return true;
        if (path === taskFile) return true;
        if (path === sessionMap) return true;
        return false;
      });
      vi.mocked(readFileSync).mockImplementation((p) => {
        const path = String(p);
        if (path === join('/mock/home', '.teamai', 'projects.json'))
          return JSON.stringify([{ name: 'test', path: projectPath }]);
        if (path === taskFile)
          return JSON.stringify({ id: 'task-expired', title: 'Expired RL', phase: 'implement', rateLimitedUntil: pastDate });
        return '';
      });
      (vi.mocked(readdirSync) as any).mockImplementation((p: string) => {
        if (String(p) === teamaiDir) return ['task-expired'];
        return [];
      });
      const count = await autoResumeInterruptedTasks();
      expect(count).toBe(1);
      expect(mockOrchResumeTask).toHaveBeenCalledWith('task-expired');
    });

    it('skips user-paused tasks (isPaused flag)', async () => {
      const projectPath = '/test/project';
      const teamaiDir = join(projectPath, '.teamai');
      const taskFile = join(teamaiDir, 'task-paused', 'task.json');
      const sessionMap = join(teamaiDir, 'task-paused', 'session_map.json');
      vi.mocked(existsSync).mockImplementation((p) => {
        const path = String(p);
        if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
        if (path === teamaiDir) return true;
        if (path === taskFile) return true;
        if (path === sessionMap) return true;
        return false;
      });
      vi.mocked(readFileSync).mockImplementation((p) => {
        const path = String(p);
        if (path === join('/mock/home', '.teamai', 'projects.json'))
          return JSON.stringify([{ name: 'test', path: projectPath }]);
        if (path === taskFile)
          return JSON.stringify({ id: 'task-paused', title: 'Paused Task', phase: 'implement', isPaused: true });
        return '';
      });
      (vi.mocked(readdirSync) as any).mockImplementation((p: string) => {
        if (String(p) === teamaiDir) return ['task-paused'];
        return [];
      });
      const count = await autoResumeInterruptedTasks();
      expect(count).toBe(0);
      expect(mockOrchResumeTask).not.toHaveBeenCalled();
    });
  });

// ── sweepStalledTasks ───────────────────────────────────────────────

describe('sweepStalledTasks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrchestrator.mockReturnValue({
      isTaskActive: mockIsTaskActive,
      resumeTask: mockSweepResumeTask,
      triggerEarlyWakeup: mockTriggerEarlyWakeup,
    });
    mockIsTaskActive.mockReturnValue(false);
    mockSweepResumeTask.mockResolvedValue(undefined);
    mockTriggerEarlyWakeup.mockReturnValue(false);
    mockGetAllSessions.mockReturnValue([]);
    mockGetStalledSessions.mockReturnValue([]);
    mockKillSession.mockClear();
  });

  it('returns 0 when no projects exist', async () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const count = await sweepStalledTasks();
    expect(count).toBe(0);
  });

  it('clears expired rate limit and resumes task', async () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'my-task', 'task.json');
    const pastDate = new Date(Date.now() - 3600_000).toISOString();

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 't1', title: 'Test', phase: 'implement', rateLimitedUntil: pastDate });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['my-task'];
      return [];
    });

    const count = await sweepStalledTasks();
    expect(count).toBe(1);

    const writeCall = vi.mocked(writeFileSync).mock.calls[0];
    expect(writeCall).toBeDefined();
    expect(String(writeCall[0])).toBe(taskFile);
    const written = JSON.parse(String(writeCall[1]));
    expect(written.rateLimitedUntil).toBeUndefined();

    expect(mockSweepResumeTask).toHaveBeenCalledWith('t1');
  });

  it('does not clear future rateLimitedUntil', async () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'my-task', 'task.json');
    const futureDate = new Date(Date.now() + 3600_000).toISOString();

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 't1', title: 'Test', phase: 'implement', rateLimitedUntil: futureDate });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['my-task'];
      return [];
    });

    const count = await sweepStalledTasks();
    expect(count).toBe(0);
    expect(mockSweepResumeTask).not.toHaveBeenCalled();
  });

  it('skips task when orchestrator has active pipeline (expired rate limit case)', async () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'my-task', 'task.json');
    const pastDate = new Date(Date.now() - 3600_000).toISOString();

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 't1', title: 'Test', phase: 'implement', rateLimitedUntil: pastDate });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['my-task'];
      return [];
    });

    mockIsTaskActive.mockReturnValue(true);

    const count = await sweepStalledTasks();
    expect(count).toBe(0);
    expect(mockSweepResumeTask).not.toHaveBeenCalled();
  });

  it('resumes stalled task when no activity for >30 minutes', async () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'my-task', 'task.json');
    const oldDate = new Date(Date.now() - 31 * 60_000).toISOString();

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 't1', title: 'Test', phase: 'implement', updatedAt: oldDate });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['my-task'];
      return [];
    });

    const count = await sweepStalledTasks();
    expect(count).toBe(1);
    expect(mockSweepResumeTask).toHaveBeenCalledWith('t1');
  });

  it('skips recently updated tasks (within 30 min)', async () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'my-task', 'task.json');
    const outputLog = join(teamaiDir, 'my-task', 'output.log');
    const recentDate = new Date(Date.now() - 5 * 60_000).toISOString();

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      if (path === outputLog) return true; // output.log exists — pipeline is running
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 't1', title: 'Test', phase: 'implement', updatedAt: recentDate });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['my-task'];
      return [];
    });
    // statSync for output.log returns recent mtime — pipeline is active
    mockStatSync(() => ({ isDirectory: () => false, mtimeMs: Date.now() - 60_000 } as any));

    const count = await sweepStalledTasks();
    expect(count).toBe(0);
    expect(mockSweepResumeTask).not.toHaveBeenCalled();
  });

  it('skips task with a running session even if time-stalled', async () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'my-task', 'task.json');
    const oldDate = new Date(Date.now() - 31 * 60_000).toISOString();

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 't1', title: 'Test', phase: 'implement', updatedAt: oldDate });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['my-task'];
      return [];
    });

    mockGetAllSessions.mockReturnValue([{ taskId: 't1', status: 'running' }]);

    const count = await sweepStalledTasks();
    expect(count).toBe(0);
    expect(mockSweepResumeTask).not.toHaveBeenCalled();
  });

  it('skips tasks in non-in-progress phases', async () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'my-task', 'task.json');

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 't1', title: 'Test', phase: 'done' });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['my-task'];
      return [];
    });

    const count = await sweepStalledTasks();
    expect(count).toBe(0);
    expect(mockSweepResumeTask).not.toHaveBeenCalled();
  });

  it('handles resumeTask rejection gracefully', async () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'my-task', 'task.json');
    const pastDate = new Date(Date.now() - 3600_000).toISOString();

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 't1', title: 'Test', phase: 'implement', rateLimitedUntil: pastDate });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['my-task'];
      return [];
    });

    mockSweepResumeTask.mockRejectedValue(new Error('Session creation failed'));

    const count = await sweepStalledTasks();
    expect(count).toBe(1);
    expect(mockSweepResumeTask).toHaveBeenCalledWith('t1');
  });

  it('kills sessions stalled >2min idle with no output', async () => {
    vi.mocked(existsSync).mockReturnValue(false); // prevent project scanning
    mockGetStalledSessions.mockReturnValue([
      { id: 'sess-abc', taskId: 't1', role: 'coder', toolInFlight: false },
    ]);

    const count = await sweepStalledTasks();
    // No project tasks were swept, so count stays 0 — session kills are side-effect only
    expect(count).toBe(0);
    expect(mockKillSession).toHaveBeenCalledWith('sess-abc');
  });

  it('kills sessions stalled >30min with a tool in flight', async () => {
    vi.mocked(existsSync).mockReturnValue(false);
    mockGetStalledSessions.mockReturnValue([
      { id: 'sess-xyz', taskId: 't1', role: 'coder', toolInFlight: true },
    ]);

    const count = await sweepStalledTasks();
    expect(count).toBe(0);
    expect(mockKillSession).toHaveBeenCalledWith('sess-xyz');
  });

  it('uses a 2-minute idle threshold and a 30-minute tool-in-flight threshold, not a single 2-minute threshold for everyone', async () => {
    // Regression: a flat 2-minute no-output threshold killed sessions
    // mid-investigation while a single slow-but-alive tool call (a cold sbt
    // compile/test, a slow HTTP call) was legitimately still running. Locks
    // in the two-tier thresholds so idle stalls stay tightly bounded while
    // genuine tool-running silence gets real headroom.
    vi.mocked(existsSync).mockReturnValue(false);
    mockGetStalledSessions.mockReturnValue([]);

    await sweepStalledTasks();

    expect(mockGetStalledSessions).toHaveBeenCalledWith(2 * 60_000, 30 * 60_000);
  });

  // ── Wakeup progress-log freshness check ──────────────────────────────
  //
  // A task mid-wakeup-wait for a detached background job (the sweep) whose
  // coder provided a progress_log_path gets checked here: if that log has
  // gone stale, end the wait early via triggerEarlyWakeup rather than
  // blindly waiting out the full wakeup_at window.

  describe('wakeup progress-log freshness', () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskDir = join(teamaiDir, 'my-task');
    const taskFile = join(taskDir, 'task.json');
    const statePath = join(taskDir, '.pipeline_state.json');
    const worktreePath = '/test/worktrees/my-task';
    const progressLogPath = join(worktreePath, 'sweep_progress.log');

    function setUpFiles(opts: {
      wakeupUntil: string | undefined;
      state?: Record<string, unknown>;
      progressLogExists?: boolean;
      progressLogMtimeMs?: number;
    }) {
      vi.mocked(existsSync).mockImplementation((p) => {
        const path = String(p);
        if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
        if (path === teamaiDir) return true;
        if (path === taskFile) return true;
        if (path === statePath) return opts.state !== undefined;
        if (path === progressLogPath) return opts.progressLogExists ?? false;
        return false;
      });
      vi.mocked(readFileSync).mockImplementation((p) => {
        const path = String(p);
        if (path === join('/mock/home', '.teamai', 'projects.json'))
          return JSON.stringify([{ name: 'test', path: projectPath }]);
        if (path === taskFile)
          return JSON.stringify({ id: 't1', title: 'Test', phase: 'implement', wakeupUntil: opts.wakeupUntil });
        if (path === statePath) return JSON.stringify(opts.state ?? {});
        return '';
      });
      vi.mocked(statSync).mockImplementation((p) => {
        if (String(p) === progressLogPath) {
          return { mtimeMs: opts.progressLogMtimeMs } as ReturnType<typeof statSync>;
        }
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      });
      mockReaddir((p) => (String(p) === teamaiDir ? ['my-task'] : []));
    }

    it('ends the wait early when the progress log has gone stale (>30min)', async () => {
      setUpFiles({
        wakeupUntil: new Date(Date.now() + 3600_000).toISOString(), // 1h still to go
        state: { wakeupProgressPath: 'sweep_progress.log', worktreePath },
        progressLogExists: true,
        progressLogMtimeMs: Date.now() - 40 * 60_000, // 40 min stale
      });
      mockTriggerEarlyWakeup.mockReturnValue(true);

      await sweepStalledTasks();

      expect(mockTriggerEarlyWakeup).toHaveBeenCalledTimes(1);
      const [taskId, reason] = mockTriggerEarlyWakeup.mock.calls[0];
      expect(taskId).toBe('t1');
      expect(reason).toContain('sweep_progress.log');
      expect(reason).toContain('40min');
    });

    it('does not trigger when the progress log is fresh', async () => {
      setUpFiles({
        wakeupUntil: new Date(Date.now() + 3600_000).toISOString(),
        state: { wakeupProgressPath: 'sweep_progress.log', worktreePath },
        progressLogExists: true,
        progressLogMtimeMs: Date.now() - 30_000, // 30s ago — fresh
      });

      await sweepStalledTasks();

      expect(mockTriggerEarlyWakeup).not.toHaveBeenCalled();
    });

    it('does not trigger on a 15-20min silent gap — within normal buffered-stdout range, not death', async () => {
      // Regression guard: a real task's background sweep piped short, frequent
      // progress lines to a file rather than a TTY. Block-buffered stdout meant
      // the file's mtime could legitimately sit still for 15-20+ minutes while
      // the job kept solving cells correctly. A 15-minute threshold treated
      // that as death three times in a row, burning every wakeup attempt and
      // failing the task even though the job was never dead (confirmed
      // independently: process alive, log still advancing, well after the
      // task had already been marked failed). The threshold must clear this
      // gap with real margin.
      setUpFiles({
        wakeupUntil: new Date(Date.now() + 3600_000).toISOString(),
        state: { wakeupProgressPath: 'sweep_progress.log', worktreePath },
        progressLogExists: true,
        progressLogMtimeMs: Date.now() - 20 * 60_000, // 20 min stale
      });

      await sweepStalledTasks();

      expect(mockTriggerEarlyWakeup).not.toHaveBeenCalled();
    });

    it('does not trigger when no wakeupProgressPath was provided (backward compatible)', async () => {
      setUpFiles({
        wakeupUntil: new Date(Date.now() + 3600_000).toISOString(),
        state: { worktreePath }, // no wakeupProgressPath
      });

      await sweepStalledTasks();

      expect(mockTriggerEarlyWakeup).not.toHaveBeenCalled();
    });

    it('does not treat a not-yet-created progress log as stale', async () => {
      setUpFiles({
        wakeupUntil: new Date(Date.now() + 3600_000).toISOString(),
        state: { wakeupProgressPath: 'sweep_progress.log', worktreePath },
        progressLogExists: false, // job hasn't written its first line yet
      });

      await sweepStalledTasks();

      expect(mockTriggerEarlyWakeup).not.toHaveBeenCalled();
    });

    it('does not run the freshness check for a task with no pending wakeup', async () => {
      setUpFiles({ wakeupUntil: undefined });

      await sweepStalledTasks();

      expect(mockTriggerEarlyWakeup).not.toHaveBeenCalled();
    });

    it('does not run the freshness check once wakeupUntil has already passed (natural timer about to fire)', async () => {
      setUpFiles({
        wakeupUntil: new Date(Date.now() - 1000).toISOString(), // already due
        state: { wakeupProgressPath: 'sweep_progress.log', worktreePath },
        progressLogExists: true,
        progressLogMtimeMs: Date.now() - 20 * 60_000,
      });

      await sweepStalledTasks();

      expect(mockTriggerEarlyWakeup).not.toHaveBeenCalled();
    });
  });

  it('skips user-paused task with expired rate limit (check 1)', async () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'my-task', 'task.json');
    const pastDate = new Date(Date.now() - 3600_000).toISOString();

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 't1', title: 'Paused RL', phase: 'implement', rateLimitedUntil: pastDate, isPaused: true });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['my-task'];
      return [];
    });

    const count = await sweepStalledTasks();
    expect(count).toBe(0);
    expect(mockSweepResumeTask).not.toHaveBeenCalled();
  });

  it('skips user-paused stalled task (check 2)', async () => {
    const projectPath = '/test/project';
    const teamaiDir = join(projectPath, '.teamai');
    const taskFile = join(teamaiDir, 'my-task', 'task.json');
    const oldDate = new Date(Date.now() - 31 * 60_000).toISOString();

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiDir) return true;
      if (path === taskFile) return true;
      return false;
    });
    vi.mocked(readFileSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      if (path === taskFile)
        return JSON.stringify({ id: 't1', title: 'Paused Stalled', phase: 'implement', updatedAt: oldDate, isPaused: true });
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === teamaiDir) return ['my-task'];
      return [];
    });

    const count = await sweepStalledTasks();
    expect(count).toBe(0);
    expect(mockSweepResumeTask).not.toHaveBeenCalled();
  });
});
