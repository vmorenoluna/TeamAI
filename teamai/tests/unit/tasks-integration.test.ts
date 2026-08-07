/**
 * Integration tests for server action functions (getTaskArtifacts, getTaskFull).
 * Covers git diff (detectDefaultBranch), humanFeedback from human_feedback.md,
 * and edge cases for header stripping, whitespace trimming, and null returns.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted mocks ──

const { mockExecFileSync } = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
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
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  log: vi.fn(), warn: vi.fn(),
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

describe('getTaskFull — includes humanFeedback from human_feedback.md', () => {
  let taskId: string;

  beforeEach(() => {
    vi.clearAllMocks();

    mockProjectPath = TEST_DIR;
    mkdirSync(join(TEST_DIR, '.teamai', 'feedback-task-slug'), { recursive: true });
    taskId = 'task-feedback-test';

    const task = {
      id: taskId,
      title: 'Test Feedback Task',
      description: 'test task for human feedback',
      phase: 'qa-review',
      // no branch — skip git diff to keep test focused
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(TEST_DIR, '.teamai', 'feedback-task-slug', 'task.json'),
      JSON.stringify(task, null, 2),
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  it('returns stripped humanFeedback when human_feedback.md exists', async () => {
    // Write the human_feedback.md file in the task's directory
    writeFileSync(
      join(TEST_DIR, '.teamai', 'feedback-task-slug', 'human_feedback.md'),
      '# Human Review Feedback\n\nFix the header alignment on mobile\n',
    );

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull(taskId);

    expect(result.humanFeedback).toBe('Fix the header alignment on mobile');
  });

  it('returns humanFeedback=null when human_feedback.md does not exist', async () => {
    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull(taskId);

    expect(result.humanFeedback).toBeNull();
  });

  it('returns null when the file contains only the header (no actual feedback)', async () => {
    writeFileSync(
      join(TEST_DIR, '.teamai', 'feedback-task-slug', 'human_feedback.md'),
      '# Human Review Feedback\n\n',
    );

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull(taskId);

    expect(result.humanFeedback).toBeNull();
  });

  it('returns null when the file is whitespace-only after stripping header', async () => {
    writeFileSync(
      join(TEST_DIR, '.teamai', 'feedback-task-slug', 'human_feedback.md'),
      '# Human Review Feedback\n\n   \n',
    );

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull(taskId);

    expect(result.humanFeedback).toBeNull();
  });

  it('trims extra whitespace from around the feedback content', async () => {
    writeFileSync(
      join(TEST_DIR, '.teamai', 'feedback-task-slug', 'human_feedback.md'),
      '# Human Review Feedback\n\n  Fix the button color  \n\n',
    );

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull(taskId);

    expect(result.humanFeedback).toBe('Fix the button color');
  });
});

describe('getTaskArtifacts — includes humanFeedback from human_feedback.md', () => {
  let taskId: string;

  beforeEach(() => {
    vi.clearAllMocks();

    mockProjectPath = TEST_DIR;
    mkdirSync(join(TEST_DIR, '.teamai', 'artifacts-feedback-slug'), { recursive: true });
    taskId = 'task-artifacts-feedback-test';

    const task = {
      id: taskId,
      title: 'Test Artifacts Feedback Task',
      description: 'test task for human feedback in getTaskArtifacts',
      phase: 'qa-review',
      // no branch — skip git diff to keep test focused
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(TEST_DIR, '.teamai', 'artifacts-feedback-slug', 'task.json'),
      JSON.stringify(task, null, 2),
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  it('returns stripped humanFeedback when human_feedback.md exists', async () => {
    writeFileSync(
      join(TEST_DIR, '.teamai', 'artifacts-feedback-slug', 'human_feedback.md'),
      '# Human Review Feedback\n\nFix the header alignment on mobile\n',
    );

    const { getTaskArtifacts } = await import('@/app/actions/tasks');
    const result = await getTaskArtifacts(taskId);

    expect(result.humanFeedback).toBe('Fix the header alignment on mobile');
  });

  it('returns humanFeedback=null when human_feedback.md does not exist', async () => {
    const { getTaskArtifacts } = await import('@/app/actions/tasks');
    const result = await getTaskArtifacts(taskId);

    expect(result.humanFeedback).toBeNull();
  });

  it('returns null when the file contains only the header (no actual feedback)', async () => {
    writeFileSync(
      join(TEST_DIR, '.teamai', 'artifacts-feedback-slug', 'human_feedback.md'),
      '# Human Review Feedback\n\n',
    );

    const { getTaskArtifacts } = await import('@/app/actions/tasks');
    const result = await getTaskArtifacts(taskId);

    expect(result.humanFeedback).toBeNull();
  });

  it('returns null when the file is whitespace-only after stripping header', async () => {
    writeFileSync(
      join(TEST_DIR, '.teamai', 'artifacts-feedback-slug', 'human_feedback.md'),
      '# Human Review Feedback\n\n   \n',
    );

    const { getTaskArtifacts } = await import('@/app/actions/tasks');
    const result = await getTaskArtifacts(taskId);

    expect(result.humanFeedback).toBeNull();
  });

  it('trims extra whitespace from around the feedback content', async () => {
    writeFileSync(
      join(TEST_DIR, '.teamai', 'artifacts-feedback-slug', 'human_feedback.md'),
      '# Human Review Feedback\n\n  Fix the button color  \n\n',
    );

    const { getTaskArtifacts } = await import('@/app/actions/tasks');
    const result = await getTaskArtifacts(taskId);

    expect(result.humanFeedback).toBe('Fix the button color');
  });
});

describe('getTaskFull — returns specPath', () => {
  let taskId: string;

  beforeEach(() => {
    vi.clearAllMocks();

    mockProjectPath = TEST_DIR;
    mkdirSync(join(TEST_DIR, '.teamai', 'specpath-task-slug'), { recursive: true });
    taskId = 'task-specpath-test';

    const task = {
      id: taskId,
      title: 'Test SpecPath Task',
      description: 'test task for specPath in getTaskFull',
      phase: 'spec',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(TEST_DIR, '.teamai', 'specpath-task-slug', 'task.json'),
      JSON.stringify(task, null, 2),
    );
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  it('returns specPath pointing to spec.md in the task dir', async () => {
    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull(taskId);

    expect(result.specPath).toContain('.teamai');
    expect(result.specPath).toContain('specpath-task-slug');
    expect(result.specPath).toContain('spec.md');
  });
});
