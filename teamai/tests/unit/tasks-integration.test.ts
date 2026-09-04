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

describe('getTaskFull — role-refinement suggestion staleness', () => {
  // A suggestion's signature snapshots the FAIL criteria that triggered it.
  // If the task later fails again for a different reason, that suggestion
  // (most commonly a 'no-gap' verdict) describes a failure that no longer
  // exists — RoleRefinementCard only offers the idle "Analyze failure"
  // prompt when no suggestion is present, so a stale one left in place
  // would hide it behind an unrelated old diagnosis forever.
  let taskId: string;
  let taskDir: string;

  function makeSuggestion(overrides: Partial<{ signature: string; status: string }> = {}) {
    return {
      id: 'sug-1',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: overrides.status ?? 'no-gap',
      trigger: 'manual',
      model: null,
      sourceTaskIds: [taskId],
      signature: overrides.signature ?? 'sha256:old-signature',
      isRolePromptGap: false,
      contractGap: false,
      contractFile: null,
      rootCause: 'old diagnosis',
      confidence: 'high',
      diagnosis: 'This was not a role-prompt gap.',
      edits: [],
      appliedAt: null,
      appliedBy: null,
      backups: [],
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();

    mockProjectPath = TEST_DIR;
    taskId = 'task-refinement-staleness-test';
    taskDir = join(TEST_DIR, '.teamai', 'refinement-staleness-slug');
    mkdirSync(taskDir, { recursive: true });

    const task = {
      id: taskId,
      title: 'Test Refinement Staleness Task',
      description: 'test task for stale refinement suggestions',
      phase: 'failed',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      refinementSuggestionId: 'sug-1',
      refinementStatus: 'no-gap',
    };
    writeFileSync(join(taskDir, 'task.json'), JSON.stringify(task, null, 2));
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  it('drops a suggestion whose signature no longer matches the current qa_report.json', async () => {
    writeFileSync(join(taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      criteria: [{ name: 'AC-T1', status: 'FAIL' }],
    }));
    const refinementsDir = join(TEST_DIR, '.teamai', 'role-refinements');
    mkdirSync(refinementsDir, { recursive: true });
    writeFileSync(join(refinementsDir, 'sug-1.json'), JSON.stringify(makeSuggestion()));

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull(taskId);

    expect(result.refinementSuggestion).toBeNull();
  });

  it('keeps a suggestion whose signature still matches the current qa_report.json', async () => {
    writeFileSync(join(taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      criteria: [{ name: 'AC-T1', status: 'FAIL' }],
    }));
    const { buildFailureSignature } = await import('@/lib/role-refinement');
    const currentSignature = buildFailureSignature(taskDir, taskId);
    const refinementsDir = join(TEST_DIR, '.teamai', 'role-refinements');
    mkdirSync(refinementsDir, { recursive: true });
    writeFileSync(join(refinementsDir, 'sug-1.json'), JSON.stringify(makeSuggestion({ signature: currentSignature })));

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull(taskId);

    expect(result.refinementSuggestion?.id).toBe('sug-1');
  });

  it('drops a suggestion with no signature at all (legacy record)', async () => {
    const refinementsDir = join(TEST_DIR, '.teamai', 'role-refinements');
    mkdirSync(refinementsDir, { recursive: true });
    const legacy = makeSuggestion({ signature: '' });
    writeFileSync(join(refinementsDir, 'sug-1.json'), JSON.stringify(legacy));

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull(taskId);

    expect(result.refinementSuggestion).toBeNull();
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

  // ── specVersions: live spec merges as v{maxSnapshot+1} ─────────────
  //
  // Under the rename-at-revision scheme the on-disk layout is: spec_v{1..N}.md
  // are archived versions and spec.md is the CURRENT version (N+1) — except
  // before the first revision, where spec.md alone IS v1 and no snapshot
  // exists. getTaskFull must present both shapes as one consistent map so the
  // Spec tab's version chips and compare dropdowns (built purely from
  // specVersions keys) show every viewable version.
  function seedVersionTask(slug: string, id: string): void {
    mkdirSync(join(TEST_DIR, '.teamai', slug), { recursive: true });
    const task = {
      id,
      title: 'Versioned Task',
      description: 'test task for specVersions in getTaskFull',
      phase: 'implement',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(join(TEST_DIR, '.teamai', slug, 'task.json'), JSON.stringify(task, null, 2));
  }

  it('merges an unversioned live spec as v1 (no snapshots on disk)', async () => {
    seedVersionTask('versions-fresh-slug', 'task-versions-fresh');
    writeFileSync(join(TEST_DIR, '.teamai', 'versions-fresh-slug', 'spec.md'), '# Only version');

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull('task-versions-fresh');

    expect(result.specVersions).toEqual({ v1: '# Only version' });
    expect(result.spec).toBe('# Only version');
  });

  it('merges the live spec as v{maxSnapshot+1} when snapshots exist', async () => {
    seedVersionTask('versions-rev1-slug', 'task-versions-rev1');
    const dir = join(TEST_DIR, '.teamai', 'versions-rev1-slug');
    writeFileSync(join(dir, 'spec_v1.md'), '# Original spec');
    writeFileSync(join(dir, 'spec.md'), '# Revised spec\n\nNew formula.');

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull('task-versions-rev1');

    // v1 = archive, v2 = live revised spec — exactly two viewable versions.
    expect(result.specVersions).toEqual({ v1: '# Original spec', v2: '# Revised spec\n\nNew formula.' });
  });

  it('does not double-count a legacy spec_v1.md that is byte-identical to the live spec', async () => {
    seedVersionTask('versions-legacy-slug', 'task-versions-legacy');
    const dir = join(TEST_DIR, '.teamai', 'versions-legacy-slug');
    // Old copy-scheme dir: spec_v1.md was a byte-copy of the initial spec.
    writeFileSync(join(dir, 'spec_v1.md'), '# Same content\n');
    writeFileSync(join(dir, 'spec.md'), '# Same content\n');

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull('task-versions-legacy');

    // The identical highest snapshot collapses into the live entry — one
    // version, not two.
    expect(result.specVersions).toEqual({ v1: '# Same content\n' });
  });

  it('maps a multi-revision legacy dir to v1..vN without duplicate keys', async () => {
    seedVersionTask('versions-multi-slug', 'task-versions-multi');
    const dir = join(TEST_DIR, '.teamai', 'versions-multi-slug');
    // Old copy-scheme dir after two revisions: v1 = initial, v2 = first
    // revision (byte-identical to the current live spec.md).
    writeFileSync(join(dir, 'spec_v1.md'), '# v1 content');
    writeFileSync(join(dir, 'spec_v2.md'), '# v2 content');
    writeFileSync(join(dir, 'spec.md'), '# v2 content');

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull('task-versions-multi');

    expect(result.specVersions).toEqual({ v1: '# v1 content', v2: '# v2 content' });
  });

  it('returns snapshots only when the live spec.md is absent (mid-revision window)', async () => {
    seedVersionTask('versions-inflight-slug', 'task-versions-inflight');
    const dir = join(TEST_DIR, '.teamai', 'versions-inflight-slug');
    // beginSpecRevision renamed spec.md away; the analyst has not written
    // the revised spec yet.
    writeFileSync(join(dir, 'spec_v1.md'), '# Pre-revision spec');

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull('task-versions-inflight');

    expect(result.specVersions).toEqual({ v1: '# Pre-revision spec' });
    expect(result.spec).toBeNull();
  });

  // routeHumanFeedback's "Request Changes → Analyst" path has no cap on
  // pipeline.specRevision (unlike autoReviseSpec's QA-driven cap of 3), so
  // a human can push a task past spec_v4.md. Before this fix, getTaskFull's
  // spec-version loop was hardcoded to [1, 2, 3, 4] and silently dropped
  // v5+ from the Spec tab — this asserts the full history stays visible.
  it('surfaces a 5th+ archived version instead of silently dropping it', async () => {
    seedVersionTask('versions-deep-slug', 'task-versions-deep');
    const dir = join(TEST_DIR, '.teamai', 'versions-deep-slug');
    for (let v = 1; v <= 5; v++) {
      writeFileSync(join(dir, `spec_v${v}.md`), `# v${v} content`);
    }
    writeFileSync(join(dir, 'spec.md'), '# v6 content (live)');

    const { getTaskFull } = await import('@/app/actions/tasks');
    const result = await getTaskFull('task-versions-deep');

    expect(result.specVersions).toEqual({
      v1: '# v1 content',
      v2: '# v2 content',
      v3: '# v3 content',
      v4: '# v4 content',
      v5: '# v5 content',
      v6: '# v6 content (live)',
    });
  });
});
