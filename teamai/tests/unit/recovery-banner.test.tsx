// @vitest-environment happy-dom

/**
 * Unit tests for RecoveryBanner component.
 *
 * Tests rendering behavior based on interrupted tasks data:
 * - Returns null (renders nothing) when tasks array is empty
 * - Renders banner with task count when tasks are present
 * - Renders Resume buttons for each interrupted task with title and phase
 * - Handles single vs multiple tasks (pluralization)
 * - Calls resumeTask server action and refreshes router on click
 * - Handles pending state (buttons disabled during transition)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { InterruptedTask } from '@/lib/recovery';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockResumeTask = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const mockRouterRefresh = vi.hoisted(() => vi.fn());

vi.mock('@/app/actions/recovery', () => ({
  resumeTask: (...args: unknown[]) => mockResumeTask(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

const mockStartTransition = vi.hoisted(() =>
  vi.fn((cb: () => void) => {
    try {
      const result = cb() as unknown;
      if (result instanceof Promise) result.catch(() => {});
    } catch { /* suppress */ }
  })
);

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useTransition: () => [false, mockStartTransition],
  };
});

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { RecoveryBanner } from '@/components/recovery-banner';

// ── Fixtures ───────────────────────────────────────────────────────────────

function interruptedTask(overrides: Partial<InterruptedTask> = {}): InterruptedTask {
  return {
    taskId: 'task-1',
    title: 'Test Task',
    phase: 'implement',
    projectPath: '/test/project',
    projectName: 'test-proj',
    ...overrides,
  };
}

function renderBanner(tasks: InterruptedTask[] = []) {
  render(<RecoveryBanner tasks={tasks} />);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('RecoveryBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResumeTask.mockResolvedValue(undefined);
  });

  // ── Show/hide behavior ───────────────────────────────────────────────

  describe('show/hide behavior', () => {
    it('returns null (renders nothing) when tasks array is empty', () => {
      renderBanner([]);

      // No banner elements should be in the document
      expect(screen.queryByText(/interrupted/)).not.toBeInTheDocument();
    });

    it('renders banner when tasks are present', () => {
      renderBanner([interruptedTask()]);

      // Banner should be visible with task count
      expect(screen.getByText(/1 interrupted task/)).toBeInTheDocument();
    });

    it('shows correct count for a single task', () => {
      renderBanner([interruptedTask({ taskId: 'only', title: 'Single Task' })]);

      // Singular form: "1 interrupted task" (no "s")
      const message = screen.getByText('1 interrupted task detected from previous session');
      expect(message).toBeInTheDocument();
      expect(message.textContent).not.toContain('tasks');
    });

    it('shows correct count and pluralization for multiple tasks', () => {
      renderBanner([
        interruptedTask({ taskId: 't1', title: 'Task 1' }),
        interruptedTask({ taskId: 't2', title: 'Task 2' }),
        interruptedTask({ taskId: 't3', title: 'Task 3' }),
      ]);

      // Plural form: "3 interrupted tasks" (with "s")
      expect(screen.getByText('3 interrupted tasks detected from previous session')).toBeInTheDocument();
    });
  });

  // ── Resume buttons ────────────────────────────────────────────────────

  describe('resume buttons', () => {
    it('renders a Resume button for each interrupted task', () => {
      renderBanner([
        interruptedTask({ taskId: 't1', title: 'Fix login', phase: 'spec' }),
        interruptedTask({ taskId: 't2', title: 'Add dark mode', phase: 'implement' }),
      ]);

      expect(screen.getByRole('button', { name: 'Resume: Fix login (spec)' })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Resume: Add dark mode (implement)' })).toBeInTheDocument();
    });

    it('renders a single Resume button when one task is present', () => {
      renderBanner([interruptedTask({ taskId: 'only', title: 'One Task', phase: 'plan' })]);

      const button = screen.getByRole('button', { name: 'Resume: One Task (plan)' });
      expect(button).toBeInTheDocument();
    });

    it('displays the correct task title and phase on each button', () => {
      renderBanner([interruptedTask({ taskId: 't1', title: 'QA task', phase: 'qa-review' })]);

      const button = screen.getByRole('button');
      expect(button).toHaveTextContent('Resume: QA task (qa-review)');
    });
  });

  // ── Click behavior ────────────────────────────────────────────────────

  describe('click behavior', () => {
    it('calls resumeTask server action with the correct task on click', () => {
      const task = interruptedTask({ taskId: 'task-abc', title: 'Clicked Task', phase: 'implement' });
      renderBanner([task]);

      fireEvent.click(screen.getByRole('button'));

      expect(mockResumeTask).toHaveBeenCalledTimes(1);
      expect(mockResumeTask).toHaveBeenCalledWith(task);
    });

    it('calls router.refresh after resumeTask completes', async () => {
      const task = interruptedTask();
      renderBanner([task]);

      fireEvent.click(screen.getByRole('button'));

      expect(mockStartTransition).toHaveBeenCalledTimes(1);
      expect(mockResumeTask).toHaveBeenCalledTimes(1);
      // router.refresh is called after await resumeTask resolves inside startTransition
      // — wait for the microtask to flush
      await waitFor(() => {
        expect(mockRouterRefresh).toHaveBeenCalled();
      });
    });

    it('calls resumeTask for each button independently', () => {
      const taskA = interruptedTask({ taskId: 'a', title: 'Task A', phase: 'spec' });
      const taskB = interruptedTask({ taskId: 'b', title: 'Task B', phase: 'plan' });
      renderBanner([taskA, taskB]);

      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(2);

      fireEvent.click(buttons[0]);
      expect(mockResumeTask).toHaveBeenCalledWith(taskA);

      fireEvent.click(buttons[1]);
      expect(mockResumeTask).toHaveBeenCalledWith(taskB);

      expect(mockResumeTask).toHaveBeenCalledTimes(2);
    });
  });

  // ── Pending state ────────────────────────────────────────────────────

  describe('pending state', () => {
    it('disables resume buttons when a transition is pending (isPending=true)', async () => {
      // Temporarily re-mock useTransition to return [true, ...]
      const react = await import('react');
      const useTransitionSpy = vi.spyOn(react, 'useTransition');
      useTransitionSpy.mockReturnValue([true, mockStartTransition] as unknown as [boolean, () => void]);

      renderBanner([interruptedTask({ taskId: 't1', title: 'Loading Task', phase: 'spec' })]);

      const button = screen.getByRole('button', { name: 'Resume: Loading Task (spec)' });
      expect(button).toBeDisabled();
      expect(button.className).toContain('disabled:opacity-50');

      useTransitionSpy.mockRestore();
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('renders correctly with max-length title and phase names', () => {
      renderBanner([
        interruptedTask({
          taskId: 'max',
          title: 'Implement comprehensive multi-factor authentication system with biometric support',
          phase: 'qa-review',
        }),
      ]);

      const button = screen.getByRole('button');
      expect(button).toHaveTextContent('Resume: Implement comprehensive multi-factor authentication system with biometric support (qa-review)');
    });

    it('handles all in-progress phases on buttons', () => {
      const phases: Array<InterruptedTask['phase']> = ['spec', 'plan', 'implement', 'qa-review', 'merge', 'create-pr'];
      const tasks = phases.map((phase, i) =>
        interruptedTask({ taskId: `p-${i}`, title: `Phase ${phase}`, phase })
      );

      renderBanner(tasks);

      const buttons = screen.getAllByRole('button');
      expect(buttons).toHaveLength(phases.length);

      for (let i = 0; i < phases.length; i++) {
        expect(buttons[i]).toHaveTextContent(`Resume: Phase ${phases[i]} (${phases[i]})`);
      }
    });

    it('does not render anything when tasks prop changes from populated to empty', () => {
      const tasks = [interruptedTask()];
      const { rerender } = render(<RecoveryBanner tasks={tasks} />);

      // Initially visible
      expect(screen.getByText(/interrupted/)).toBeInTheDocument();

      // Rerender with empty tasks
      rerender(<RecoveryBanner tasks={[]} />);

      // Banner should disappear
      expect(screen.queryByText(/interrupted/)).not.toBeInTheDocument();
    });

    it('renders correctly when tasks prop changes from empty to populated', () => {
      const { rerender } = render(<RecoveryBanner tasks={[]} />);

      // Initially nothing rendered
      expect(screen.queryByText(/interrupted/)).not.toBeInTheDocument();

      // Rerender with tasks
      rerender(<RecoveryBanner tasks={[interruptedTask({ title: 'New Task', phase: 'spec' })]} />);

      // Banner should appear
      expect(screen.getByText('1 interrupted task detected from previous session')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Resume: New Task (spec)' })).toBeInTheDocument();
    });
  });
});
