/**
 * Unit tests for recovery server actions.
 *
 * Tests cover getInterruptedTasks() filtering of actively-running tasks from
 * the interrupted tasks list — tasks that have an active orchestrator pipeline
 * are not "interrupted" and should not appear in the recovery banner.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InterruptedTask } from '@/lib/recovery';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockFindInterrupted = vi.fn();
const mockIsTaskActive = vi.fn();
const mockGetOrchestrator = vi.fn();

vi.mock('@/lib/recovery', () => ({
  findInterruptedTasks: () => mockFindInterrupted(),
}));

vi.mock('@/lib/orchestrator', () => ({
  getOrchestrator: (projectPath: string) => mockGetOrchestrator(projectPath),
}));

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a mock InterruptedTask for test data. */
function interruptedTask(overrides: Partial<InterruptedTask> = {}): InterruptedTask {
  return {
    taskId: 'task-1',
    title: 'Test Task',
    phase: 'spec',
    projectPath: '/test/project',
    projectName: 'Test Project',
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('getInterruptedTasks', () => {
  let getInterruptedTasks: () => Promise<InterruptedTask[]>;

  beforeEach(async () => {
    vi.clearAllMocks();

    // Default: no interrupted tasks, no active tasks
    mockFindInterrupted.mockReturnValue([]);
    mockIsTaskActive.mockReturnValue(false);
    mockGetOrchestrator.mockReturnValue({ isTaskActive: mockIsTaskActive });

    // Dynamic import so mocks are applied before the module loads
    const mod = await import('@/app/actions/recovery');
    getInterruptedTasks = mod.getInterruptedTasks;
  });

  describe('when no interrupted tasks exist', () => {
    it('returns an empty array', async () => {
      mockFindInterrupted.mockReturnValue([]);

      const result = await getInterruptedTasks();

      expect(result).toEqual([]);
      expect(mockGetOrchestrator).not.toHaveBeenCalled();
    });
  });

  describe('when all interrupted tasks are genuinely interrupted', () => {
    it('returns all tasks when none are active', async () => {
      const tasks = [
        interruptedTask({ taskId: 'task-a', phase: 'spec' }),
        interruptedTask({ taskId: 'task-b', phase: 'implement' }),
      ];
      mockFindInterrupted.mockReturnValue(tasks);
      mockIsTaskActive.mockReturnValue(false);

      const result = await getInterruptedTasks();

      expect(result).toHaveLength(2);
      expect(result[0].taskId).toBe('task-a');
      expect(result[1].taskId).toBe('task-b');
      expect(mockIsTaskActive).toHaveBeenCalledTimes(2);
    });
  });

  describe('when some tasks are actively running', () => {
    it('filters out tasks that have an active orchestrator pipeline', async () => {
      const tasks = [
        interruptedTask({ taskId: 'active-task', phase: 'spec' }),
        interruptedTask({ taskId: 'orphaned-task', phase: 'implement' }),
      ];
      mockFindInterrupted.mockReturnValue(tasks);

      // First task is actively running — should be filtered out
      mockIsTaskActive.mockImplementation((taskId: string) => taskId === 'active-task');

      const result = await getInterruptedTasks();

      expect(result).toHaveLength(1);
      expect(result[0].taskId).toBe('orphaned-task');
    });

    it('returns empty array when all tasks are actively running', async () => {
      const tasks = [
        interruptedTask({ taskId: 'task-a', phase: 'spec' }),
        interruptedTask({ taskId: 'task-b', phase: 'plan' }),
      ];
      mockFindInterrupted.mockReturnValue(tasks);
      mockIsTaskActive.mockReturnValue(true);

      const result = await getInterruptedTasks();

      expect(result).toEqual([]);
    });
  });

  describe('when a task is rate-limited (paused, not active)', () => {
    it('includes rate-limited tasks (they are not actively running)', async () => {
      const tasks = [
        interruptedTask({ taskId: 'rate-limited', phase: 'implement' }),
      ];
      mockFindInterrupted.mockReturnValue(tasks);
      // When isTaskActive returns false (e.g., orchestrator instance was lost
      // after a crash or restart), the task should appear as interrupted.
      mockIsTaskActive.mockReturnValue(false);

      const result = await getInterruptedTasks();

      expect(result).toHaveLength(1);
      expect(result[0].taskId).toBe('rate-limited');
    });
  });

  describe('handles orchestrator access failures gracefully', () => {
    it('includes tasks when getOrchestrator throws', async () => {
      const tasks = [
        interruptedTask({ taskId: 'task-a', phase: 'spec' }),
      ];
      mockFindInterrupted.mockReturnValue(tasks);
      mockGetOrchestrator.mockImplementation(() => {
        throw new Error('Cannot create orchestrator');
      });

      const result = await getInterruptedTasks();

      // Err on the side of showing the banner — include the task
      expect(result).toHaveLength(1);
      expect(result[0].taskId).toBe('task-a');
    });
  });

  describe('tasks across multiple projects', () => {
    it('queries the correct orchestrator for each task', async () => {
      const tasks = [
        interruptedTask({ taskId: 'task-a', projectPath: '/proj/a', projectName: 'Project A' }),
        interruptedTask({ taskId: 'task-b', projectPath: '/proj/b', projectName: 'Project B' }),
      ];
      mockFindInterrupted.mockReturnValue(tasks);

      // Only task-b is active
      mockIsTaskActive.mockImplementation((taskId: string) => taskId === 'task-b');

      const result = await getInterruptedTasks();

      expect(result).toHaveLength(1);
      expect(result[0].taskId).toBe('task-a');

      // Each task's project path should be used to get the right orchestrator
      expect(mockGetOrchestrator).toHaveBeenCalledWith('/proj/a');
      expect(mockGetOrchestrator).toHaveBeenCalledWith('/proj/b');
    });
  });

  describe('various in-progress phases', () => {
    it.each(['spec', 'plan', 'implement', 'qa-review', 'merge', 'create-pr'] as const)(
      'filters active tasks in the "%s" phase',
      async (phase) => {
        const tasks = [
          interruptedTask({ taskId: 'active', phase }),
          interruptedTask({ taskId: 'orphaned', phase }),
        ];
        mockFindInterrupted.mockReturnValue(tasks);
        mockIsTaskActive.mockImplementation((taskId: string) => taskId === 'active');

        const result = await getInterruptedTasks();

        expect(result).toHaveLength(1);
        expect(result[0].taskId).toBe('orphaned');
      },
    );
  });
});
