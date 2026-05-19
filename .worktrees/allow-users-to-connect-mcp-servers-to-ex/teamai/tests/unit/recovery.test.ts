import { describe, it, expect, vi } from 'vitest';

// vi.mock is hoisted by Vitest — factory must use inline vi.fn(), not top-level variables
vi.mock('os', () => ({
  homedir: vi.fn(() => '/mock/home'),
}));

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  statSync: vi.fn(),
}));

import { findInterruptedTasks, findOrphanedWorktrees, startupCleanup } from '../../src/lib/recovery';
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

// Helper: readdirSync and statSync have overloaded signatures that make
// mockImplementation require a type assertion. These wrappers contain the
// narrow `as any` casts so each test doesn't need to repeat them.
/* eslint-disable @typescript-eslint/no-explicit-any */
const mockReaddir = (impl: (path: unknown) => string[]) => {
  (vi.mocked(readdirSync) as any).mockImplementation(impl);
};

const mockStatSync = (impl: () => { isDirectory: () => boolean }) => {
  (vi.mocked(statSync) as any).mockImplementation(impl);
};
/* eslint-enable @typescript-eslint/no-explicit-any */

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

    vi.mocked(existsSync).mockImplementation((p) => {
      const path = String(p);
      if (path === join('/mock/home', '.teamai', 'projects.json')) return true;
      if (path === teamaiA) return true;
      if (path === join(projB, '.teamai')) return true;
      if (path === taskFileA) return true;
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
    const wtDir = join(projectPath, '.teamai', 'worktrees');
    const wtPath = join(wtDir, 'task-orphan-123');

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
      if (String(p) === wtDir) return ['task-orphan-123'];
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
    const wtDir = join(projectPath, '.teamai', 'worktrees');
    const wtPath = join(wtDir, 'task-done-456');
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
      if (String(p) === wtDir) return ['task-done-456'];
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
    const wtDir = join(projectPath, '.teamai', 'worktrees');

    vi.mocked(existsSync).mockImplementation((p) =>
      String(p) === join('/mock/home', '.teamai', 'projects.json') || String(p) === wtDir);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === wtDir) return ['task-123'];
      return [];
    });
    mockStatSync(() => ({ isDirectory: () => false }));

    expect(findOrphanedWorktrees()).toEqual([]);
  });

  it('ignores worktree entries without task- prefix', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '.teamai', 'worktrees');

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
    const wtDir = join(projectPath, '.teamai', 'worktrees');
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
      if (String(p) === wtDir) return ['task-active-789'];
      if (String(p) === join(projectPath, '.teamai')) return ['active'];
      return [];
    });
    mockStatSync(() => ({ isDirectory: () => true }));

    expect(findOrphanedWorktrees()).toEqual([]);
  });

  // Coverage: lines 86-87 — readdirSync throws for worktreesDir
  it('skips project when readdirSync throws for worktreesDir', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '.teamai', 'worktrees');

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

describe('startupCleanup', () => {
  it('returns unified report', () => {
    vi.mocked(existsSync).mockReturnValue(false);

    const report = startupCleanup(3);
    expect(report).toEqual({
      interruptedTasks: [],
      staleSessions: 3,
      orphanedWorktrees: [],
    });
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
    const wtDir = join(projectPath, '.teamai', 'worktrees');

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
      if (String(p) === wtDir && callCount++ === 0) return ['task-123'];
      throw new Error('readdirSync failed');
    });
    mockStatSync(() => ({ isDirectory: () => true }));

    // When readdirSync for teamaiDir throws, taskFound stays false,
    // so the worktree IS reported as orphaned. This is correct behavior.
    const result = findOrphanedWorktrees();
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(join(wtDir, 'task-123'));
  });

  // Coverage: lines 96-97 — statSync throws for a worktree entry
  it('skips entry when statSync throws', () => {
    const projectPath = '/test/project';
    const wtDir = join(projectPath, '.teamai', 'worktrees');

    vi.mocked(existsSync).mockImplementation((p) =>
      String(p) === join('/mock/home', '.teamai', 'projects.json') || String(p) === wtDir);
    vi.mocked(readFileSync).mockImplementation((p) => {
      if (String(p) === join('/mock/home', '.teamai', 'projects.json'))
        return JSON.stringify([{ name: 'test', path: projectPath }]);
      return '';
    });
    mockReaddir((p) => {
      if (String(p) === wtDir) return ['task-123'];
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
    const wtDir = join(projectPath, '.teamai', 'worktrees');
    const wtPath = join(wtDir, 'task-bad-json');
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
      // task.json is malformed JSON — the inner catch at 121-122 skips it
      if (path === taskFile) return 'not-valid-json{{{';
      return '';
    });
    // wtDir has the worktree, teamaiDir has 'bad' directory
    mockReaddir((p) => {
      if (String(p) === wtDir) return ['task-bad-json'];
      if (String(p) === join(projectPath, '.teamai')) return ['bad'];
      return [];
    });
    mockStatSync(() => ({ isDirectory: () => true }));

    // The inner catch skips the malformed JSON, taskFound stays false,
    // so the worktree is reported as orphaned
    const result = findOrphanedWorktrees();
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe(wtPath);
  });
});
