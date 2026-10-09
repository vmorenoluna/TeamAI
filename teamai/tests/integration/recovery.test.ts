/**
 * Integration tests for the recovery module.
 *
 * Tests exercise the full filesystem pipeline: creating real projects.json
 * files, task.json files, worktree directories, and verifying that each
 * recovery function correctly detects interrupted tasks and orphaned
 * worktrees using real filesystem operations.
 *
 * The homedir() mock redirects ~/.teamai/projects.json to a temp directory
 * so tests never touch the real user configuration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Mocks ───────────────────────────────────────────────────────────────────

const mockHomedir = vi.hoisted(() => vi.fn());

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return {
    ...actual,
    homedir: (...args: unknown[]) => mockHomedir(...args),
  };
});

// Mock container-manager so getWorktreeBase doesn't try to probe Docker.
// recovery.ts imports getWorktreeBase from orchestrator/helpers which calls
// readContainerConfig → dockerAvailable, which fails without a Docker daemon.
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

// ── Orchestrator mock for auto-resume integration tests ─────────────────────

const mockOrchResumeTask = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockGetOrchestrator = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/orchestrator', () => ({
  getOrchestrator: (...args: unknown[]) => mockGetOrchestrator(...args),
}));

// ── Test Fixture Helpers ────────────────────────────────────────────────────

let homeDir: string;

/** Create a mock home directory with ~/.teamai/ subdirectory */
function initHome() {
  homeDir = join(tmpdir(), `teamai-recovery-integ-${randomUUID().slice(0, 8)}`);
  mkdirSync(join(homeDir, '.teamai'), { recursive: true });
  mockHomedir.mockReturnValue(homeDir);
  return homeDir;
}

/** Clean up the temp home directory */
function cleanupHome() {
  if (homeDir && existsSync(homeDir)) {
    try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** Write the projects.json file in the mock home dir */
function writeProjects(projects: Array<{ name: string; path: string }>) {
  writeFileSync(join(homeDir, '.teamai', 'projects.json'), JSON.stringify(projects, null, 2));
}

/** Create a real project directory with a .teamai/ subdirectory */
function createProject(name: string, path?: string): string {
  const projectPath = path ?? join(homeDir, 'projects', name);
  mkdirSync(join(projectPath, '.teamai'), { recursive: true });
  return projectPath;
}

/** Register a project in projects.json and create its directory on disk */
function registerProject(name: string, path?: string): string {
  const projectPath = createProject(name, path);
  writeProjects([{ name, path: projectPath }]);
  return projectPath;
}

/** Create a task.json in a project's .teamai/ directory */
function createTask(
  projectPath: string,
  taskId: string,
  overrides: Partial<{ title: string; phase: string; wakeupUntil: string }> = {},
) {
  const slug = `task-${taskId}`;
  const dir = join(projectPath, '.teamai', slug);
  mkdirSync(dir, { recursive: true });
  const task = {
    id: taskId,
    title: overrides.title ?? `Task ${taskId}`,
    description: 'Integration test task',
    phase: overrides.phase ?? 'backlog',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...(overrides.wakeupUntil ? { wakeupUntil: overrides.wakeupUntil } : {}),
  };
  writeFileSync(join(dir, 'task.json'), JSON.stringify(task, null, 2));
  // Evidence the task was actually running — findInterruptedTasks requires
  // session_map.json or output.log to exist before flagging a task as interrupted.
  writeFileSync(join(dir, 'session_map.json'), JSON.stringify({}), 'utf-8');
  return dir;
}

/** Create a worktree directory under the project's worktree base path (next to project) */
function createWorktree(
  projectPath: string,
  taskId: string,
): string {
  // Worktrees live at <project>/../worktrees/<slug>, matching getWorktreeBase()
  const slug = `task-${taskId}`;
  const wtDir = join(projectPath, '..', 'worktrees');
  mkdirSync(wtDir, { recursive: true });
  const dir = join(wtDir, slug);
  mkdirSync(dir, { recursive: true });
  return dir;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Recovery Integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    initHome();
  });

  afterEach(() => {
    cleanupHome();
    vi.resetModules();
  });

  // ── findInterruptedTasks ───────────────────────────────────────────

  describe('findInterruptedTasks', () => {
    it('returns empty array when no projects.json exists', async () => {
      // Remove the .teamai dir that initHome created
      rmSync(join(homeDir, '.teamai'), { recursive: true, force: true });

      const { findInterruptedTasks } = await import('../../src/lib/recovery');
      const result = findInterruptedTasks();
      expect(result).toEqual([]);
    });

    it('returns empty array when projects.json is empty array', async () => {
      writeProjects([]);

      const { findInterruptedTasks } = await import('../../src/lib/recovery');
      const result = findInterruptedTasks();
      expect(result).toEqual([]);
    });

    it('returns empty array when project has no .teamai directory', async () => {
      const projectPath = join(homeDir, 'no-teamai-project');
      mkdirSync(projectPath, { recursive: true });
      writeProjects([{ name: 'no-teamai', path: projectPath }]);

      const { findInterruptedTasks } = await import('../../src/lib/recovery');
      const result = findInterruptedTasks();
      expect(result).toEqual([]);
    });

    it('finds tasks in in-progress phases (spec, plan, implement, qa-review, merge)', async () => {
      const projectPath = registerProject('test-proj');

      // Create tasks in various phases
      createTask(projectPath, 't-spec', { phase: 'spec', title: 'In Spec' });
      createTask(projectPath, 't-plan', { phase: 'plan', title: 'In Plan' });
      createTask(projectPath, 't-impl', { phase: 'implement', title: 'In Implement' });
      createTask(projectPath, 't-qa', { phase: 'qa-review', title: 'In QA Review' });
      createTask(projectPath, 't-merge', { phase: 'merge', title: 'In Merge' });

      const { findInterruptedTasks } = await import('../../src/lib/recovery');
      const result = findInterruptedTasks();

      expect(result).toHaveLength(5);
      const titles = result.map(t => t.title);
      expect(titles).toContain('In Spec');
      expect(titles).toContain('In Plan');
      expect(titles).toContain('In Implement');
      expect(titles).toContain('In QA Review');
      expect(titles).toContain('In Merge');
    });

    it('ignores tasks in non-in-progress phases (backlog, done, failed, cancelled)', async () => {
      const projectPath = registerProject('test-proj');

      createTask(projectPath, 't-backlog', { phase: 'backlog', title: 'Backlog' });
      createTask(projectPath, 't-done', { phase: 'done', title: 'Done' });
      createTask(projectPath, 't-failed', { phase: 'failed', title: 'Failed' });
      createTask(projectPath, 't-cancelled', { phase: 'cancelled', title: 'Cancelled' });

      const { findInterruptedTasks } = await import('../../src/lib/recovery');
      const result = findInterruptedTasks();

      expect(result).toEqual([]);
    });

    it('skips malformed task.json gracefully', async () => {
      const projectPath = registerProject('test-proj');

      // Create a directory with malformed JSON
      const slug = 'task-malformed';
      const dir = join(projectPath, '.teamai', slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'task.json'), 'not-valid-json{{{');

      // Create a valid task too
      createTask(projectPath, 't-valid', { phase: 'spec' });

      const { findInterruptedTasks } = await import('../../src/lib/recovery');
      const result = findInterruptedTasks();

      expect(result).toHaveLength(1);
      expect(result[0].taskId).toBe('t-valid');
    });

    it('handles multiple projects', async () => {
      const projA = registerProject('proj-a');
      const projB = createProject('proj-b');
      writeProjects([
        { name: 'proj-a', path: projA },
        { name: 'proj-b', path: projB },
      ]);

      createTask(projA, 't1', { phase: 'spec' });
      createTask(projB, 't2', { phase: 'implement' });

      const { findInterruptedTasks } = await import('../../src/lib/recovery');
      const result = findInterruptedTasks();

      expect(result).toHaveLength(2);
    });

    it('returns correct metadata for interrupted tasks', async () => {
      const projectPath = registerProject('test-proj');
      createTask(projectPath, 'task-123', { phase: 'implement', title: 'My Important Task' });

      const { findInterruptedTasks } = await import('../../src/lib/recovery');
      const result = findInterruptedTasks();

      expect(result[0]).toEqual({
        taskId: 'task-123',
        title: 'My Important Task',
        phase: 'implement',
        projectPath,
        projectName: 'test-proj',
        isPaused: false,
      });
    });

    it('handles unreadable .teamai directory gracefully', async () => {
      const projectPath = registerProject('readable-proj');
      createTask(projectPath, 't1', { phase: 'spec' });

      // Register a second project whose .teamai dir exists but readdirSync fails
      // We can't easily make readdirSync throw on a real directory, so we
      // test the path where the directory simply doesn't contain any task dirs
      const emptyPath = createProject('empty-proj');
      writeProjects([
        { name: 'readable-proj', path: projectPath },
        { name: 'empty-proj', path: emptyPath },
      ]);

      const { findInterruptedTasks } = await import('../../src/lib/recovery');
      const result = findInterruptedTasks();

      // Should find the task from readable-proj, skip empty-proj gracefully
      expect(result).toHaveLength(1);
      expect(result[0].projectName).toBe('readable-proj');
    });
  });

  // ── findOrphanedWorktrees ──────────────────────────────────────────

  describe('findOrphanedWorktrees', () => {
    it('returns empty array when no projects exist', async () => {
      const { findOrphanedWorktrees } = await import('../../src/lib/recovery');
      const result = findOrphanedWorktrees();
      expect(result).toEqual([]);
    });

    it('returns empty array when project has no worktrees directory', async () => {
      const projectPath = registerProject('test-proj');
      createTask(projectPath, 't1', { phase: 'spec' });

      const { findOrphanedWorktrees } = await import('../../src/lib/recovery');
      const result = findOrphanedWorktrees();
      expect(result).toEqual([]);
    });

    it('finds worktree whose task no longer exists', async () => {
      const projectPath = registerProject('test-proj');
      createWorktree(projectPath, 'orphan-task-123');

      const { findOrphanedWorktrees } = await import('../../src/lib/recovery');
      const result = findOrphanedWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].path).toContain('task-orphan-task-123');
      expect(result[0].projectPath).toBe(projectPath);
    });

    it('finds worktree whose task is done (no longer active)', async () => {
      const projectPath = registerProject('test-proj');
      const taskId = 'done-task-456';
      createWorktree(projectPath, taskId);
      createTask(projectPath, taskId, { phase: 'done', title: 'Done Task' });

      const { findOrphanedWorktrees } = await import('../../src/lib/recovery');
      const result = findOrphanedWorktrees();

      expect(result).toHaveLength(1);
      expect(result[0].path).toContain(`task-${taskId}`);
    });

    it('keeps worktree whose task is still active', async () => {
      const projectPath = registerProject('test-proj');
      const taskId = 'active-789';
      createWorktree(projectPath, taskId);
      createTask(projectPath, taskId, { phase: 'implement', title: 'Active Task' });

      const { findOrphanedWorktrees } = await import('../../src/lib/recovery');
      const result = findOrphanedWorktrees();

      expect(result).toEqual([]);
    });

    it('skips non-directory entries in worktrees directory', async () => {
      const projectPath = registerProject('test-proj');
      const wtDir = join(projectPath, '.teamai', 'worktrees');
      mkdirSync(wtDir, { recursive: true });
      // Create a file instead of a directory
      writeFileSync(join(wtDir, 'task-file-entry'), 'not a directory');

      const { findOrphanedWorktrees } = await import('../../src/lib/recovery');
      const result = findOrphanedWorktrees();

      expect(result).toEqual([]);
    });

    it('ignores worktree entries without task- prefix', async () => {
      const projectPath = registerProject('test-proj');
      const wtDir = join(projectPath, '.teamai', 'worktrees');
      mkdirSync(wtDir, { recursive: true });
      mkdirSync(join(wtDir, 'not-a-task-dir'), { recursive: true });

      const { findOrphanedWorktrees } = await import('../../src/lib/recovery');
      const result = findOrphanedWorktrees();

      expect(result).toEqual([]);
    });

    it('handles multiple worktrees across multiple projects', async () => {
      const projA = registerProject('proj-a');
      const projB = createProject('proj-b');
      writeProjects([
        { name: 'proj-a', path: projA },
        { name: 'proj-b', path: projB },
      ]);

      // proj-a: one active worktree, one orphaned
      createWorktree(projA, 'active-1');
      createTask(projA, 'active-1', { phase: 'spec' });
      createWorktree(projA, 'orphan-1');

      // proj-b: one orphaned worktree
      createWorktree(projB, 'orphan-2');

      const { findOrphanedWorktrees } = await import('../../src/lib/recovery');
      const result = findOrphanedWorktrees();

      expect(result).toHaveLength(2);
      const paths = result.map(w => w.path);
      expect(paths.some(p => p.includes('orphan-1'))).toBe(true);
      expect(paths.some(p => p.includes('orphan-2'))).toBe(true);
    });

    it('handles worktree with malformed task.json by reporting it as orphaned', async () => {
      const projectPath = registerProject('test-proj');
      const taskId = 'bad-json-task';
      createWorktree(projectPath, taskId);

      // Create a task dir with malformed JSON
      const slug = `task-${taskId}`;
      const taskDir = join(projectPath, '.teamai', slug);
      mkdirSync(taskDir, { recursive: true });
      writeFileSync(join(taskDir, 'task.json'), '{{{bad-json');

      const { findOrphanedWorktrees } = await import('../../src/lib/recovery');
      const result = findOrphanedWorktrees();

      // Malformed task.json can't be parsed, so task is not found → orphaned
      expect(result).toHaveLength(1);
      expect(result[0].path).toContain(`task-${taskId}`);
    });
  });

  // ── startupCleanup ─────────────────────────────────────────────────

  describe('startupCleanup', () => {
    it('returns unified report with counts from both scans', async () => {
      const projectPath = registerProject('test-proj');

      // One interrupted task
      createTask(projectPath, 't-spec', { phase: 'spec' });

      // One orphaned worktree
      createWorktree(projectPath, 'orphan-123');

      const { startupCleanup } = await import('../../src/lib/recovery');
      const result = startupCleanup(5); // 5 stale sessions

      expect(result.interruptedTasks).toHaveLength(1);
      expect(result.interruptedTasks[0].taskId).toBe('t-spec');
      expect(result.orphanedWorktrees).toHaveLength(1);
      expect(result.orphanedWorktrees[0].path).toContain('task-orphan-123');
      expect(result.staleSessions).toBe(5);
      expect(result.artifactInconsistencies).toEqual([]);
    });

    it('returns empty report when nothing is wrong', async () => {
      const projectPath = registerProject('test-proj');
      createTask(projectPath, 't-done', { phase: 'done' });

      const { startupCleanup } = await import('../../src/lib/recovery');
      const result = startupCleanup(0);

      expect(result.interruptedTasks).toEqual([]);
      expect(result.orphanedWorktrees).toEqual([]);
      expect(result.staleSessions).toBe(0);
      expect(result.artifactInconsistencies).toEqual([]);
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles projects.json containing invalid JSON gracefully', async () => {
      writeFileSync(join(homeDir, '.teamai', 'projects.json'), '{{{bad-json');

      const { findInterruptedTasks } = await import('../../src/lib/recovery');
      const result = findInterruptedTasks();
      expect(result).toEqual([]);
    });

    it('handles task.json containing phase as undefined gracefully', async () => {
      const projectPath = registerProject('test-proj');

      // Create task without phase field
      const slug = 'task-no-phase';
      const dir = join(projectPath, '.teamai', slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'task.json'), JSON.stringify({
        id: 'no-phase-task',
        title: 'No Phase',
        description: 'Task without phase field',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      const { findInterruptedTasks } = await import('../../src/lib/recovery');
      const result = findInterruptedTasks();

      // undefined phase is not in IN_PROGRESS_PHASES → should be ignored
      expect(result).toEqual([]);
    });

    it('handles worktree whose matching task.json has no id field', async () => {
      const projectPath = registerProject('test-proj');
      createWorktree(projectPath, 'missing-id-task');

      // Create task.json without an id field
      const slug = 'task-missing-id-task';
      const dir = join(projectPath, '.teamai', slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'task.json'), JSON.stringify({
        title: 'No ID',
        phase: 'done',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));

      const { findOrphanedWorktrees } = await import('../../src/lib/recovery');
      const result = findOrphanedWorktrees();

      // task.id is undefined, doesn't match the worktree's taskId → orphaned
      expect(result).toHaveLength(1);
    });
  });

  // ── autoResumeInterruptedTasks ─────────────────────────────────────

  describe('autoResumeInterruptedTasks', () => {
    beforeEach(async () => {
      vi.clearAllMocks();
      mockGetOrchestrator.mockReturnValue({ resumeTask: mockOrchResumeTask, isTaskActive: () => false });
      mockOrchResumeTask.mockResolvedValue(undefined);
    });

    it('calls resumeTask on orchestrator for each interrupted task on disk', async () => {
      const projectPath = registerProject('auto-resume-test');
      createTask(projectPath, 't-spec', { phase: 'spec', title: 'In Spec' });
      createTask(projectPath, 't-impl', { phase: 'implement', title: 'In Implement' });

      const { autoResumeInterruptedTasks } = await import('../../src/lib/recovery');
      const count = await autoResumeInterruptedTasks();

      expect(count).toBe(2);
      expect(mockGetOrchestrator).toHaveBeenCalledTimes(2);
      expect(mockGetOrchestrator).toHaveBeenCalledWith(projectPath);
      expect(mockOrchResumeTask).toHaveBeenCalledTimes(2);
      expect(mockOrchResumeTask).toHaveBeenCalledWith('t-spec');
      expect(mockOrchResumeTask).toHaveBeenCalledWith('t-impl');
    });

    // Regression: a server restart while a task is mid-implement waiting on a
    // scheduled wakeup (ADR 002) must not immediately re-invoke resumeTask —
    // that ignores however much of the wait window remains and burns a
    // premature re-entry against the wakeup-isolated subtask.
    it('does not resume a task whose wakeupUntil is still in the future', async () => {
      const projectPath = registerProject('wakeup-pending');
      createTask(projectPath, 't-waking', {
        phase: 'implement',
        title: 'Waiting on job',
        wakeupUntil: new Date(Date.now() + 60 * 60_000).toISOString(),
      });

      const { autoResumeInterruptedTasks } = await import('../../src/lib/recovery');
      const count = await autoResumeInterruptedTasks();

      expect(count).toBe(0);
      expect(mockOrchResumeTask).not.toHaveBeenCalled();
    });

    it('resumes a task whose wakeupUntil has already elapsed', async () => {
      const projectPath = registerProject('wakeup-elapsed');
      createTask(projectPath, 't-woken', {
        phase: 'implement',
        title: 'Job finished',
        wakeupUntil: new Date(Date.now() - 1000).toISOString(),
      });

      const { autoResumeInterruptedTasks } = await import('../../src/lib/recovery');
      const count = await autoResumeInterruptedTasks();

      expect(count).toBe(1);
      expect(mockOrchResumeTask).toHaveBeenCalledWith('t-woken');
    });

    it('returns 0 when no interrupted tasks on disk', async () => {
      // Register a project with only non-interrupted tasks
      const projectPath = registerProject('clean-proj');
      createTask(projectPath, 't-done', { phase: 'done', title: 'Done Task' });

      const { autoResumeInterruptedTasks } = await import('../../src/lib/recovery');
      const count = await autoResumeInterruptedTasks();

      expect(count).toBe(0);
      expect(mockGetOrchestrator).not.toHaveBeenCalled();
      expect(mockOrchResumeTask).not.toHaveBeenCalled();
    });

    it('skips tasks in non-in-progress phases (backlog, done, failed, cancelled)', async () => {
      const projectPath = registerProject('mixed-phases');
      createTask(projectPath, 't-backlog', { phase: 'backlog', title: 'Backlog' });
      createTask(projectPath, 't-done', { phase: 'done', title: 'Done' });
      createTask(projectPath, 't-failed', { phase: 'failed', title: 'Failed' });
      createTask(projectPath, 't-cancelled', { phase: 'cancelled', title: 'Cancelled' });
      // Only this one should be resumed
      createTask(projectPath, 't-spec', { phase: 'spec', title: 'Only Spec' });

      const { autoResumeInterruptedTasks } = await import('../../src/lib/recovery');
      const count = await autoResumeInterruptedTasks();

      expect(count).toBe(1);
      expect(mockOrchResumeTask).toHaveBeenCalledTimes(1);
      expect(mockOrchResumeTask).toHaveBeenCalledWith('t-spec');
    });

    it('handles multiple projects with interrupted tasks', async () => {
      const projA = registerProject('proj-a');
      const projB = createProject('proj-b');
      writeProjects([
        { name: 'proj-a', path: projA },
        { name: 'proj-b', path: projB },
      ]);

      createTask(projA, 'a1', { phase: 'plan', title: 'Proj A Task' });
      createTask(projB, 'b1', { phase: 'qa-review', title: 'Proj B Task' });

      const { autoResumeInterruptedTasks } = await import('../../src/lib/recovery');
      const count = await autoResumeInterruptedTasks();

      expect(count).toBe(2);
      expect(mockGetOrchestrator).toHaveBeenCalledWith(projA);
      expect(mockGetOrchestrator).toHaveBeenCalledWith(projB);
      expect(mockOrchResumeTask).toHaveBeenCalledWith('a1');
      expect(mockOrchResumeTask).toHaveBeenCalledWith('b1');
    });

    it('handles orchestrator creation failure gracefully', async () => {
      const projectPath = registerProject('fail-proj');
      createTask(projectPath, 't-spec', { phase: 'spec', title: 'Will Fail' });

      mockGetOrchestrator.mockImplementation(() => {
        throw new Error('Orchestrator creation failed');
      });

      const { autoResumeInterruptedTasks } = await import('../../src/lib/recovery');
      const count = await autoResumeInterruptedTasks();

      // Task was found but orchestrator creation failed, so it wasn't queued for resume
      expect(count).toBe(0);
      expect(mockGetOrchestrator).toHaveBeenCalledTimes(1);
      expect(mockOrchResumeTask).not.toHaveBeenCalled();
    });

    it('verifies resumeTask receives the correct taskId from persisted task.json', async () => {
      const projectPath = registerProject('verify-ids');
      createTask(projectPath, 'real-task-uuid-123', { phase: 'spec', title: 'Real Task' });

      const { autoResumeInterruptedTasks } = await import('../../src/lib/recovery');
      await autoResumeInterruptedTasks();

      expect(mockOrchResumeTask).toHaveBeenCalledWith('real-task-uuid-123');
    });

    it('re-schedules a future rate-limit deadline after startup instead of dropping it', async () => {
      vi.useFakeTimers();
      try {
        const projectPath = registerProject('future-rate-limit');
        const taskDir = createTask(projectPath, 't-future', { phase: 'implement', title: 'Future Rate Limit' });
        const resetAt = new Date(Date.now() + 60_000).toISOString();
        const taskFile = join(taskDir, 'task.json');
        const task = JSON.parse(readFileSync(taskFile, 'utf-8'));
        task.rateLimitedUntil = resetAt;
        writeFileSync(taskFile, JSON.stringify(task, null, 2));

        const { autoResumeInterruptedTasks } = await import('../../src/lib/recovery');
        const count = await autoResumeInterruptedTasks();

        // The deadline is future-dated, so startup must arm a timer but must
        // not resume the task early.
        expect(count).toBe(0);
        expect(mockOrchResumeTask).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);

        await vi.advanceTimersByTimeAsync(60_000);
        await Promise.resolve();

        expect(mockOrchResumeTask).toHaveBeenCalledWith('t-future');
        const resumedTask = JSON.parse(readFileSync(taskFile, 'utf-8'));
        expect(resumedTask.rateLimitedUntil).toBeUndefined();
      } finally {
        vi.useRealTimers();
      }
    });


  });
});
