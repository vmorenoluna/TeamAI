/**
 * Tests that getTaskArtifacts and getTaskFull use detectDefaultBranch
 * to dynamically determine the base branch for git diff, rather than
 * hardcoding 'main'.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ──

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFileSync: mockExecFileSync,
  spawn: vi.fn(),
  ChildProcess: class MockCP {},
}));

let mockProjectPath = '/test/project';

// Mock next/headers cookies() to return the real test project path
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: vi.fn((name: string) => {
      if (name === 'activeProject') return { value: mockProjectPath };
      return undefined;
    }),
    set: vi.fn(),
    delete: vi.fn(),
  })),
}));

// Mock next/cache revalidatePath
vi.mock('next/cache', () => ({
  revalidatePath: vi.fn(),
}));

// Mock process-manager (imported via orchestrator)
vi.mock('@/lib/process-manager', () => ({
  processManager: {
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    emit: vi.fn(),
    sendMessage: vi.fn(),
    killSession: vi.fn(),
    createSession: vi.fn(),
  },
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  warn: vi.fn(),
  error: vi.fn(),
}));

// ── Real imports ──

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(process.cwd(), '.teamai-test-diff-' + Math.random().toString(36).slice(2, 10));

// ── Tests ──

describe('getTaskArtifacts — git diff uses detectDefaultBranch', () => {
  let taskId: string;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up a real .teamai test directory
    mockProjectPath = TEST_DIR;
    mkdirSync(join(TEST_DIR, '.teamai', 'test-task-slug'), { recursive: true });
    taskId = 'task-diff-test';

    const task = {
      id: taskId,
      title: 'Test Diff Task',
      description: 'test task for diff',
      phase: 'qa-review',
      branch: 'feat/test-task-slug',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(TEST_DIR, '.teamai', 'test-task-slug', 'task.json'),
      JSON.stringify(task, null, 2),
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  it('uses detectDefaultBranch result (main) in git diff args', async () => {
    // detectDefaultBranch calls: git symbolic-ref refs/remotes/origin/HEAD
    // Then getTaskArtifacts calls: git diff {base}...{branch}
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
      if (args && args[0] === 'diff') return 'diff output here\n';
      return '';
    });

    // Update mock cookies to return /test/project → point to our test dir
    const { getTaskArtifacts } = await import('@/app/actions/tasks');
    const result = await getTaskArtifacts(taskId);

    // The diff arg should be 'main...feat/test-task-slug' (from detectDefaultBranch)
    const diffCalls = mockExecFileSync.mock.calls.filter(
      (call: any[]) => call[1] && call[1][0] === 'diff',
    );
    expect(diffCalls).toHaveLength(1);
    expect(diffCalls[0][1][1]).toBe('main...feat/test-task-slug');

    expect(result.diff).toBe('diff output here\n');
  });

  it('uses detectDefaultBranch result (master) in git diff args', async () => {
    // detectDefaultBranch returns master
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'symbolic-ref') return 'refs/remotes/origin/master\n';
      if (args && args[0] === 'diff') return 'master-branch diff\n';
      return '';
    });

    const { getTaskArtifacts } = await import('@/app/actions/tasks');
    const result = await getTaskArtifacts(taskId);

    // The diff arg should use 'master', not 'main'
    const diffCalls = mockExecFileSync.mock.calls.filter(
      (call: any[]) => call[1] && call[1][0] === 'diff',
    );
    expect(diffCalls).toHaveLength(1);
    expect(diffCalls[0][1][1]).toBe('master...feat/test-task-slug');

    expect(result.diff).toBe('master-branch diff\n');
  });

  it('returns diff=null when git diff command fails', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
      throw new Error('git diff failed');
    });

    const { getTaskArtifacts } = await import('@/app/actions/tasks');
    const result = await getTaskArtifacts(taskId);

    // Should gracefully return null
    expect(result.diff).toBeNull();
  });

  it('returns diff=null when detectDefaultBranch itself fails (fallback chain exercised)', async () => {
    // detectDefaultBranch falls back to 'main' on failure
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'symbolic-ref') throw new Error('no upstream');
      if (args && args[0] === 'diff') throw new Error('diff also failed');
      return '';
    });

    const { getTaskArtifacts } = await import('@/app/actions/tasks');
    const result = await getTaskArtifacts(taskId);

    expect(result.diff).toBeNull();

    // Verify the fallback chain ran: detectDefaultBranch swallowed the error,
    // returned 'main', and the diff was attempted with that fallback value
    const diffCalls = mockExecFileSync.mock.calls.filter(
      (call: any[]) => call[1] && call[1][0] === 'diff',
    );
    expect(diffCalls).toHaveLength(1);
    expect(diffCalls[0][1][1]).toBe('main...feat/test-task-slug');
  });

  it('returns diff=null when task has no branch', async () => {
    // Rewrite task.json to have no branch
    const task = {
      id: taskId,
      title: 'Test Diff Task',
      description: 'test task for diff',
      phase: 'backlog',
      // no branch field
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(TEST_DIR, '.teamai', 'test-task-slug', 'task.json'),
      JSON.stringify(task, null, 2),
    );

    const { getTaskArtifacts } = await import('@/app/actions/tasks');
    const result = await getTaskArtifacts(taskId);

    // No branch → diff should be null, and no git diff call should be made
    expect(result.diff).toBeNull();
    const diffCalls = mockExecFileSync.mock.calls.filter(
      (call: any[]) => call[1] && call[1][0] === 'diff',
    );
    expect(diffCalls).toHaveLength(0);
  });
});

describe('getTaskFull — git diff uses detectDefaultBranch', () => {
  let taskId: string;

  beforeEach(() => {
    vi.clearAllMocks();

    // Set up a real .teamai test directory
    mockProjectPath = TEST_DIR;
    mkdirSync(join(TEST_DIR, '.teamai', 'full-task-slug'), { recursive: true });
    taskId = 'task-full-test';

    const task = {
      id: taskId,
      title: 'Test Full Task',
      description: 'full task test',
      phase: 'implement',
      branch: 'feat/full-task-slug',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(TEST_DIR, '.teamai', 'full-task-slug', 'task.json'),
      JSON.stringify(task, null, 2),
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  it('uses detectDefaultBranch result in git diff args', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
      if (args && args[0] === 'diff') return 'full diff output\n';
      return '';
    });

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull(taskId);

    const diffCalls = mockExecFileSync.mock.calls.filter(
      (call: any[]) => call[1] && call[1][0] === 'diff',
    );
    expect(diffCalls).toHaveLength(1);
    expect(diffCalls[0][1][1]).toBe('main...feat/full-task-slug');

    expect(result.diff).toBe('full diff output\n');
  });

  it('detects master branch and uses it in git diff', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'symbolic-ref') return 'refs/remotes/origin/master\n';
      if (args && args[0] === 'diff') return 'master diff\n';
      return '';
    });

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull(taskId);

    const diffCalls = mockExecFileSync.mock.calls.filter(
      (call: any[]) => call[1] && call[1][0] === 'diff',
    );
    expect(diffCalls[0][1][1]).toBe('master...feat/full-task-slug');
    expect(result.diff).toBe('master diff\n');
  });

  it('returns diff=null when git diff command fails', async () => {
    mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
      if (args && args[0] === 'symbolic-ref') return 'refs/remotes/origin/main\n';
      throw new Error('git diff failed');
    });

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull(taskId);

    expect(result.diff).toBeNull();
  });
});
