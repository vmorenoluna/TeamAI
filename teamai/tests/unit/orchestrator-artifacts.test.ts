/**
 * Tests for _commitArtifactsToWorktree.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Hoisted mocks ──

const onHandlers = vi.hoisted(() =>
  new Map<string, Array<(...args: unknown[]) => void>>()
);

const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), error: vi.fn(), warn: vi.fn(),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    createSession: vi.fn(),
    sendMessage: vi.fn(),
    killSession: vi.fn(),
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

import { Orchestrator, getOrchestrator } from '../../src/lib/orchestrator';
import { readContainerConfig, containerManager, hostToContainerPath, dockerAvailable, _resetDockerAvailableCache, readContainerRemoteUser } from '../../src/lib/container-manager';

type AnyOrch = any;

// ── Helpers ──

function setupTestProject(): { root: string; taskId: string; taskDir: string; slug: string; clean: () => void } {
  const root = join(tmpdir(), `teamai-artifacts-${randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });

  mkdirSync(join(root, '.teamai'), { recursive: true });

  const taskId = randomUUID();
  const taskDir = join(root, '.teamai', taskId);
  mkdirSync(taskDir, { recursive: true });

  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    title: 'Test Task',
    description: 'A test task',
    phase: 'spec',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  const slug = randomUUID().slice(0, 8);

  const clean = () => {
    onHandlers.clear();
    vi.clearAllMocks();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  };

  return { root, taskId, taskDir, slug, clean };
}

function makeOrch(root: string): Orchestrator {
  const orch = getOrchestrator(root);
  const a = orch as unknown as AnyOrch;
  a.pipelines.clear();
  a.activeTasks.clear();
  return orch;
}

function makePipeline(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: 'task-id',
    description: 'test',
    phase: 'spec',
    specPath: '/test/spec',
    worktreePath: '/test/wt',
    branch: 'feat/test',
    qaAttempt: 0,
    maxQaAttempts: 3,
    ...overrides,
  };
}

// ── Tests ──

describe('_commitArtifactsToWorktree', () => {
  let testData: ReturnType<typeof setupTestProject>;

  beforeEach(() => {
    vi.resetAllMocks();
    onHandlers.clear();
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });
    vi.mocked(hostToContainerPath).mockImplementation((p: string) => p);
    vi.mocked(containerManager.getRunningContainer).mockReturnValue(null);
    vi.mocked(readContainerRemoteUser).mockReturnValue('node');
    vi.mocked(dockerAvailable).mockReturnValue(true);
    vi.mocked(_resetDockerAvailableCache).mockReturnValue(undefined);
  });

  afterEach(() => {
    if (testData) testData.clean();
    vi.resetModules();
  });

  // ── Successful commit ─────────────────────────────────────────────

  it('copies artifacts, commits them, and logs success', () => {
    testData = setupTestProject();
    const orch = makeOrch(testData.root);

    // Set up artifact files in the specPath
    writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature spec');
    writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({ subtasks: [{ id: 1, title: 'Task' }] }));
    writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({ overall: 'PASS' }));
    writeFileSync(join(testData.taskDir, 'output.log'), 'terminal output');  // excluded
    writeFileSync(join(testData.taskDir, '.pipeline_state.json'), '{}');     // excluded
    writeFileSync(join(testData.taskDir, 'events.jsonl'), JSON.stringify({ phase: 'plan' }));
    writeFileSync(join(testData.taskDir, 'completion_summary.md'), '# Summary');

    const worktreePath = join(testData.root, 'worktree-test');
    mkdirSync(worktreePath, { recursive: true });

    const pipeline = makePipeline({
      taskId: testData.taskId,
      description: testData.slug,
      specPath: testData.taskDir,
      worktreePath,
    });

    mockExecFileSync.mockReturnValue('');

    (orch as unknown as AnyOrch)._ctx.commitArtifactsToWorktree(pipeline);

    // Verify target directory was created
    const targetDir = join(worktreePath, '.teamai', basename(pipeline.specPath as string));
    expect(existsSync(targetDir)).toBe(true);

    // Excluded files should NOT be copied
    expect(existsSync(join(targetDir, 'output.log'))).toBe(false);
    expect(existsSync(join(targetDir, '.pipeline_state.json'))).toBe(false);

    // Included files SHOULD be copied (6 files: spec, plan, qa_report, events,
    // completion_summary, plus task.json from setupTestProject)
    expect(existsSync(join(targetDir, 'spec.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'plan.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'qa_report.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(targetDir, 'completion_summary.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'task.json'))).toBe(true);

    // Committed task.json should have phase: "done" — by the time the branch
    // is merged and pulled into main, the task IS done, so the committed copy
    // should reflect the final state and not create a stale kanban entry.
    const committedTask = JSON.parse(readFileSync(join(targetDir, 'task.json'), 'utf-8'));
    expect(committedTask.phase).toBe('done');
    expect(committedTask.updatedAt).toBeTruthy();

    // _execGit should have been called with git add -f .teamai/<slug>
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['add', '-f', expect.stringContaining('.teamai/')]),
      expect.objectContaining({ cwd: worktreePath }),
    );
    // And git commit
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['commit', '-m', expect.stringContaining('TeamAI pipeline artifacts')]),
      expect.objectContaining({ cwd: worktreePath }),
    );

    // Log file should contain the phase header and success message
    const logContent = readFileSync(join(testData.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('ARTIFACTS');
    expect(logContent).toContain('Committed 6 artifact file');
  });

  // ── Empty source directory ────────────────────────────────────────

  it('returns early when source directory has no artifacts (only excluded files)', () => {
    testData = setupTestProject();
    const orch = makeOrch(testData.root);

    try { unlinkSync(join(testData.taskDir, 'task.json')); } catch {}

    // Only put excluded files in the source dir
    writeFileSync(join(testData.taskDir, 'output.log'), 'terminal output');
    writeFileSync(join(testData.taskDir, '.pipeline_state.json'), '{}');

    const worktreePath = join(testData.root, 'worktree-empty');
    mkdirSync(worktreePath, { recursive: true });

    const pipeline = makePipeline({
      taskId: testData.taskId,
      description: testData.slug,
      specPath: testData.taskDir,
      worktreePath,
    });

    (orch as unknown as AnyOrch)._ctx.commitArtifactsToWorktree(pipeline);

    // Should NOT have called git at all
    const gitCalls = mockExecFileSync.mock.calls.filter(
      (c: unknown[]) => c[0] === 'git'
    );
    expect(gitCalls.length).toBe(0);

    // Log should indicate no artifacts
    const logContent = readFileSync(join(testData.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('No artifacts to commit');
  });

  it('does not crash when the specPath directory does not exist (logToOutput swallows ENOENT)', () => {
    testData = setupTestProject();
    const orch = makeOrch(testData.root);

    const worktreePath = join(testData.root, 'worktree-nonexistent-src');
    mkdirSync(worktreePath, { recursive: true });

    const pipeline = makePipeline({
      taskId: testData.taskId,
      description: testData.slug,
      specPath: join(testData.taskDir, 'nonexistent-subdir'),
      worktreePath,
    });

    // logToOutput wraps appendFileSync with try/catch so missing
    // directories don't crash the pipeline — the function should
    // complete without throwing.
    expect(() => (orch as unknown as AnyOrch)._ctx.commitArtifactsToWorktree(pipeline)).not.toThrow();
  });

  // ── Gitignore-blocked ─────────────────────────────────────────────

  it('logs warning and returns when artifacts are gitignored', () => {
    testData = setupTestProject();
    const orch = makeOrch(testData.root);

    writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
    writeFileSync(join(testData.taskDir, 'plan.json'), '{}');

    const worktreePath = join(testData.root, 'worktree-gitignore');
    mkdirSync(worktreePath, { recursive: true });

    const pipeline = makePipeline({
      taskId: testData.taskId,
      description: testData.slug,
      specPath: testData.taskDir,
      worktreePath,
    });

    // git add succeeds, git commit fails with "nothing added to commit"
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (Array.isArray(args) && args.includes('commit')) {
        throw new Error('nothing added to commit but untracked files present');
      }
      return '';
    });

    // Should NOT throw
    expect(() => (orch as unknown as AnyOrch)._ctx.commitArtifactsToWorktree(pipeline)).not.toThrow();

    // Log should contain the gitignore warning
    const logContent = readFileSync(join(testData.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('appears to be gitignored');

    // Files should still have been copied
    const targetDir = join(worktreePath, '.teamai', basename(pipeline.specPath as string));
    expect(existsSync(join(targetDir, 'spec.md'))).toBe(true);
  });

  // ── Already-committed ─────────────────────────────────────────────

  it('logs and returns (no-op) when artifacts are already committed', () => {
    testData = setupTestProject();
    const orch = makeOrch(testData.root);

    writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
    writeFileSync(join(testData.taskDir, 'plan.json'), '{}');

    const worktreePath = join(testData.root, 'worktree-already');
    mkdirSync(worktreePath, { recursive: true });

    const pipeline = makePipeline({
      taskId: testData.taskId,
      description: testData.slug,
      specPath: testData.taskDir,
      worktreePath,
    });

    // git add succeeds, git commit fails with "nothing to commit, working tree clean"
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (Array.isArray(args) && args.includes('commit')) {
        throw new Error('nothing to commit, working tree clean');
      }
      return '';
    });

    // Should NOT throw
    expect(() => (orch as unknown as AnyOrch)._ctx.commitArtifactsToWorktree(pipeline)).not.toThrow();

    // Log should indicate already committed
    const logContent = readFileSync(join(testData.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('Already committed');
  });

  // ── Git add failure ───────────────────────────────────────────────

  it('throws when git add fails', () => {
    testData = setupTestProject();
    const orch = makeOrch(testData.root);

    writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
    writeFileSync(join(testData.taskDir, 'plan.json'), '{}');

    const worktreePath = join(testData.root, 'worktree-add-fail');
    mkdirSync(worktreePath, { recursive: true });

    const pipeline = makePipeline({
      taskId: testData.taskId,
      description: testData.slug,
      specPath: testData.taskDir,
      worktreePath,
    });

    // git add throws a real error
    mockExecFileSync.mockImplementation(() => {
      throw new Error('fatal: not a git repository');
    });

    expect(() => (orch as unknown as AnyOrch)._ctx.commitArtifactsToWorktree(pipeline)).toThrow(
      'not a git repository'
    );
  });

  // ── Git commit unexpected error ────────────────────────────────────

  it('throws when git commit fails with an unexpected error', () => {
    testData = setupTestProject();
    const orch = makeOrch(testData.root);

    writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
    writeFileSync(join(testData.taskDir, 'plan.json'), '{}');

    const worktreePath = join(testData.root, 'worktree-commit-fail');
    mkdirSync(worktreePath, { recursive: true });

    const pipeline = makePipeline({
      taskId: testData.taskId,
      description: testData.slug,
      specPath: testData.taskDir,
      worktreePath,
    });

    // git add succeeds, git commit fails with an unexpected error
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (Array.isArray(args) && args.includes('commit')) {
        throw new Error('fatal: unable to create commit');
      }
      return '';
    });

    expect(() => (orch as unknown as AnyOrch)._ctx.commitArtifactsToWorktree(pipeline)).toThrow(
      'unable to create commit'
    );
  });

  // ── Nested subdirectory support (Bug 2 fix) ─────────────────────────

  it('recursively copies files from nested subdirectories, excluding ARTIFACT_EXCLUDE at every depth', () => {
    testData = setupTestProject();
    const orch = makeOrch(testData.root);

    // Create a nested directory structure in the source
    const nestedDir = join(testData.taskDir, 'reports');
    mkdirSync(nestedDir, { recursive: true });
    const deepDir = join(nestedDir, 'subreports');
    mkdirSync(deepDir, { recursive: true });

    writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
    writeFileSync(join(testData.taskDir, 'plan.json'), '{}');
    writeFileSync(join(nestedDir, 'qa-results.md'), '# QA Results');
    writeFileSync(join(nestedDir, 'output.log'), 'should be excluded');  // excluded even nested
    writeFileSync(join(deepDir, 'detailed-report.md'), '# Detailed');
    writeFileSync(join(deepDir, '.pipeline_state.json'), '{}');  // excluded even deep

    const worktreePath = join(testData.root, 'worktree-nested');
    mkdirSync(worktreePath, { recursive: true });

    const pipeline = makePipeline({
      taskId: testData.taskId,
      description: testData.slug,
      specPath: testData.taskDir,
      worktreePath,
    });

    mockExecFileSync.mockReturnValue('');

    (orch as unknown as AnyOrch)._ctx.commitArtifactsToWorktree(pipeline);

    const targetDir = join(worktreePath, '.teamai', basename(pipeline.specPath as string));

    // Top-level files copied
    expect(existsSync(join(targetDir, 'spec.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'plan.json'))).toBe(true);

    // Nested directory and files copied
    expect(existsSync(join(targetDir, 'reports'))).toBe(true);
    expect(existsSync(join(targetDir, 'reports', 'qa-results.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'reports', 'subreports', 'detailed-report.md'))).toBe(true);

    // Excluded files at every depth
    expect(existsSync(join(targetDir, 'reports', 'output.log'))).toBe(false);
    expect(existsSync(join(targetDir, 'reports', 'subreports', '.pipeline_state.json'))).toBe(false);

    // Log file should count 4 copied files (spec, plan, qa-results, detailed-report)
    const logContent = readFileSync(join(testData.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('Committed 5 artifact file');  // 4 + task.json
  });

  it('handles empty subdirectories gracefully (copies only files)', () => {
    testData = setupTestProject();
    const orch = makeOrch(testData.root);

    const emptyDir = join(testData.taskDir, 'empty-reports');
    mkdirSync(emptyDir, { recursive: true });
    writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');

    const worktreePath = join(testData.root, 'worktree-empty-subdir');
    mkdirSync(worktreePath, { recursive: true });

    const pipeline = makePipeline({
      taskId: testData.taskId,
      description: testData.slug,
      specPath: testData.taskDir,
      worktreePath,
    });

    mockExecFileSync.mockReturnValue('');

    (orch as unknown as AnyOrch)._ctx.commitArtifactsToWorktree(pipeline);

    const targetDir = join(worktreePath, '.teamai', basename(pipeline.specPath as string));

    // Top-level file still copied
    expect(existsSync(join(targetDir, 'spec.md'))).toBe(true);
    // Empty directory created but no files inside
    expect(existsSync(join(targetDir, 'empty-reports'))).toBe(true);

    const logContent = readFileSync(join(testData.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('Committed 2 artifact file');  // spec + task.json
  });

  it('recursively copies 3+ levels deep, excluding ARTIFACT_EXCLUDE files at every depth', () => {
    testData = setupTestProject();
    const orch = makeOrch(testData.root);

    // Build a 3-level directory tree with excluded files mixed in at each level.
    //
    // taskDir/                         ← level 0
    //   spec.md                        ← included
    //   output.log                     ← EXCLUDED (ARTIFACT_EXCLUDE at depth 0)
    //   benchmarks/                    ← level 1
    //     results.json                 ← included
    //     .pipeline_state.json         ← EXCLUDED (ARTIFACT_EXCLUDE at depth 1)
    //     raw/                         ← level 2
    //       dataset.csv                ← included
    //       output.log                 ← EXCLUDED (ARTIFACT_EXCLUDE at depth 2)
    //       archive/                   ← level 3
    //         summary.md               ← included
    //         .pipeline_state.json     ← EXCLUDED (ARTIFACT_EXCLUDE at depth 3)

    const l1 = join(testData.taskDir, 'benchmarks');
    const l2 = join(l1, 'raw');
    const l3 = join(l2, 'archive');
    mkdirSync(l1, { recursive: true });
    mkdirSync(l2, { recursive: true });
    mkdirSync(l3, { recursive: true });

    // Level 0
    writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
    writeFileSync(join(testData.taskDir, 'output.log'), 'excluded at L0');

    // Level 1
    writeFileSync(join(l1, 'results.json'), '{}');
    writeFileSync(join(l1, '.pipeline_state.json'), 'excluded at L1');

    // Level 2
    writeFileSync(join(l2, 'dataset.csv'), 'col1,col2');
    writeFileSync(join(l2, 'output.log'), 'excluded at L2');

    // Level 3
    writeFileSync(join(l3, 'summary.md'), '# Deep Summary');
    writeFileSync(join(l3, '.pipeline_state.json'), 'excluded at L3');

    const worktreePath = join(testData.root, 'worktree-deep');
    mkdirSync(worktreePath, { recursive: true });

    const pipeline = makePipeline({
      taskId: testData.taskId,
      description: testData.slug,
      specPath: testData.taskDir,
      worktreePath,
    });

    mockExecFileSync.mockReturnValue('');

    (orch as unknown as AnyOrch)._ctx.commitArtifactsToWorktree(pipeline);

    const targetDir = join(worktreePath, '.teamai', basename(pipeline.specPath as string));

    // ── Level 0 assertions ──
    expect(existsSync(join(targetDir, 'spec.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'output.log'))).toBe(false);

    // ── Level 1 assertions ──
    expect(existsSync(join(targetDir, 'benchmarks'))).toBe(true);
    expect(existsSync(join(targetDir, 'benchmarks', 'results.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'benchmarks', '.pipeline_state.json'))).toBe(false);

    // ── Level 2 assertions ──
    expect(existsSync(join(targetDir, 'benchmarks', 'raw'))).toBe(true);
    expect(existsSync(join(targetDir, 'benchmarks', 'raw', 'dataset.csv'))).toBe(true);
    expect(existsSync(join(targetDir, 'benchmarks', 'raw', 'output.log'))).toBe(false);

    // ── Level 3 assertions ──
    expect(existsSync(join(targetDir, 'benchmarks', 'raw', 'archive'))).toBe(true);
    expect(existsSync(join(targetDir, 'benchmarks', 'raw', 'archive', 'summary.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'benchmarks', 'raw', 'archive', '.pipeline_state.json'))).toBe(false);

    // 4 included files (spec, results, dataset, summary) + task.json = 5
    const logContent = readFileSync(join(testData.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('Committed 5 artifact file');
  });

  // ── Per-phase / per-subtask log exclusion ────────────────────

  it('excludes output-*.log variants (per-phase and per-subtask session logs)', () => {
    testData = setupTestProject();
    const orch = makeOrch(testData.root);

    // Set up artifact files including per-phase and per-subtask log files
    writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
    writeFileSync(join(testData.taskDir, 'plan.json'), '{}');
    // These should ALL be excluded — raw session logs
    writeFileSync(join(testData.taskDir, 'output.log'), 'raw terminal output');
    writeFileSync(join(testData.taskDir, 'output-spec.log'), 'spec session log');
    writeFileSync(join(testData.taskDir, 'output-plan.log'), 'plan session log');
    writeFileSync(join(testData.taskDir, 'output-qa.log'), 'qa session log');
    writeFileSync(join(testData.taskDir, 'output-merge.log'), 'merge session log');
    writeFileSync(join(testData.taskDir, 'output-st1.log'), 'subtask 1 log');
    writeFileSync(join(testData.taskDir, 'output-st7.log'), 'subtask 7 log');
    writeFileSync(join(testData.taskDir, 'output-st9999.log'), 'subtask 9999 log');
    writeFileSync(join(testData.taskDir, '.pipeline_state.json'), '{}');

    const worktreePath = join(testData.root, 'worktree-log-variants');
    mkdirSync(worktreePath, { recursive: true });

    const pipeline = makePipeline({
      taskId: testData.taskId,
      description: testData.slug,
      specPath: testData.taskDir,
      worktreePath,
    });

    mockExecFileSync.mockReturnValue('');

    (orch as unknown as AnyOrch)._ctx.commitArtifactsToWorktree(pipeline);

    const targetDir = join(worktreePath, '.teamai', basename(pipeline.specPath as string));

    // ALL output log variants should be excluded
    expect(existsSync(join(targetDir, 'output.log'))).toBe(false);
    expect(existsSync(join(targetDir, 'output-spec.log'))).toBe(false);
    expect(existsSync(join(targetDir, 'output-plan.log'))).toBe(false);
    expect(existsSync(join(targetDir, 'output-qa.log'))).toBe(false);
    expect(existsSync(join(targetDir, 'output-merge.log'))).toBe(false);
    expect(existsSync(join(targetDir, 'output-st1.log'))).toBe(false);
    expect(existsSync(join(targetDir, 'output-st7.log'))).toBe(false);
    expect(existsSync(join(targetDir, 'output-st9999.log'))).toBe(false);
    expect(existsSync(join(targetDir, '.pipeline_state.json'))).toBe(false);

    // Included files should still be copied
    expect(existsSync(join(targetDir, 'spec.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'plan.json'))).toBe(true);

    // Log should report 3 files committed (spec, plan, task.json)
    const logContent = readFileSync(join(testData.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('Committed 3 artifact file');
  });

  // ── Full artifact set (spec revisions, snapshots, etc.) ────────────

  it('excludes output.log and .pipeline_state.json but includes spec revisions, qa report versions, and snapshots', () => {
    testData = setupTestProject();
    const orch = makeOrch(testData.root);

    // Set up a full artifact directory with all the story-telling files
    writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
    writeFileSync(join(testData.taskDir, 'spec_v1.md'), '# Spec v1');
    writeFileSync(join(testData.taskDir, 'spec_v2.md'), '# Spec v2');
    writeFileSync(join(testData.taskDir, 'plan.json'), '{}');
    writeFileSync(join(testData.taskDir, 'qa_report.json'), '{}');
    writeFileSync(join(testData.taskDir, 'qa_report_v1.json'), '{}');
    writeFileSync(join(testData.taskDir, 'qa_report_v2.json'), '{}');
    writeFileSync(join(testData.taskDir, 'qa_report_v3.json'), '{}');
    writeFileSync(join(testData.taskDir, 'qa_report_before_bounce.json'), '{}');
    writeFileSync(join(testData.taskDir, 'qa_report_before_failed.json'), '{}');
    writeFileSync(join(testData.taskDir, 'qa_feedback.md'), '# Feedback');
    writeFileSync(join(testData.taskDir, 'human_feedback.md'), '# Human feedback');
    writeFileSync(join(testData.taskDir, 'human_feedback_before_bounce.md'), '# HF snapshot');
    writeFileSync(join(testData.taskDir, 'spec_revision_feedback.md'), '# Revision feedback');
    writeFileSync(join(testData.taskDir, 'completion_summary.md'), '# Summary');
    writeFileSync(join(testData.taskDir, 'events.jsonl'), '{}');
    writeFileSync(join(testData.taskDir, 'task.json'), '{}');
    // These should be excluded
    writeFileSync(join(testData.taskDir, 'output.log'), 'output');
    writeFileSync(join(testData.taskDir, '.pipeline_state.json'), 'state');

    const worktreePath = join(testData.root, 'worktree-full');
    mkdirSync(worktreePath, { recursive: true });

    const pipeline = makePipeline({
      taskId: testData.taskId,
      description: testData.slug,
      specPath: testData.taskDir,
      worktreePath,
    });

    mockExecFileSync.mockReturnValue('');

    (orch as unknown as AnyOrch)._ctx.commitArtifactsToWorktree(pipeline);

    const targetDir = join(worktreePath, '.teamai', basename(pipeline.specPath as string));

    // Excluded — should NOT be present
    expect(existsSync(join(targetDir, 'output.log'))).toBe(false);
    expect(existsSync(join(targetDir, '.pipeline_state.json'))).toBe(false);

    // Included story files — should ALL be present
    expect(existsSync(join(targetDir, 'spec.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'spec_v1.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'spec_v2.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'plan.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'qa_report.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'qa_report_v1.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'qa_report_v2.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'qa_report_v3.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'qa_report_before_bounce.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'qa_report_before_failed.json'))).toBe(true);
    expect(existsSync(join(targetDir, 'qa_feedback.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'human_feedback.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'human_feedback_before_bounce.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'spec_revision_feedback.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'completion_summary.md'))).toBe(true);
    expect(existsSync(join(targetDir, 'events.jsonl'))).toBe(true);
    expect(existsSync(join(targetDir, 'task.json'))).toBe(true);

    // Committed task.json should have phase: "done"
    const committedTask = JSON.parse(readFileSync(join(targetDir, 'task.json'), 'utf-8'));
    expect(committedTask.phase).toBe('done');
    expect(committedTask.updatedAt).toBeTruthy();

    // Log should report 17 files committed (19 total - 2 excluded)
    const logContent = readFileSync(join(testData.taskDir, 'output.log'), 'utf-8');
    expect(logContent).toContain('Committed 17 artifact file');
  });
});
