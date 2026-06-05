// @vitest-environment happy-dom

/**
 * Unit tests for RecoveryBanner component.
 *
 * Tests rendering behavior based on interrupted tasks data:
 * - Returns null (renders nothing) when tasks array is empty
 * - Renders banner with task count when tasks are present
 * - Shows single task title in the banner text
 * - Handles single vs multiple tasks (pluralization)
 * - Dismisses when X button is clicked
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { InterruptedTask } from '@/lib/recovery';

// ── Imports ─────────────────────────────────────────────────────────────────

import { RecoveryBanner, resetRecoveryBannerDismissed } from '@/components/recovery-banner';

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
    resetRecoveryBannerDismissed();
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
      const message = screen.getByText(/1 interrupted task/);
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
      expect(screen.getByText(/3 interrupted tasks/)).toBeInTheDocument();
    });

    it('shows auto-resume message', () => {
      renderBanner([interruptedTask()]);

      expect(screen.getByText(/auto-resumed on server startup/)).toBeInTheDocument();
    });
  });

  // ── Single task title ────────────────────────────────────────────────

  describe('single task title', () => {
    it('shows the task title when only one interrupted task exists', () => {
      renderBanner([interruptedTask({ taskId: 't1', title: 'Fix login', phase: 'spec' })]);

      expect(screen.getByText(/Fix login/)).toBeInTheDocument();
    });

    it('does not show task titles when multiple tasks exist', () => {
      renderBanner([
        interruptedTask({ taskId: 't1', title: 'Task 1' }),
        interruptedTask({ taskId: 't2', title: 'Task 2' }),
      ]);

      // Multiple tasks: no individual titles shown
      expect(screen.queryByText(/Task 1/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Task 2/)).not.toBeInTheDocument();
    });
  });

  // ── Dismiss behavior ─────────────────────────────────────────────────

  describe('dismiss behavior', () => {
    it('renders a dismiss X button', () => {
      renderBanner([interruptedTask()]);

      const dismissButton = screen.getByTitle('Dismiss');
      expect(dismissButton).toBeInTheDocument();
      expect(dismissButton).toHaveTextContent('×');
    });

    it('hides the banner when X button is clicked', () => {
      renderBanner([interruptedTask()]);

      const dismissButton = screen.getByTitle('Dismiss');
      fireEvent.click(dismissButton);

      // Banner should disappear
      expect(screen.queryByText(/interrupted/)).not.toBeInTheDocument();
    });

    it('stays hidden on re-render — dismissal persists across mounts until server restart', () => {
      const { rerender } = render(<RecoveryBanner tasks={[interruptedTask({ taskId: 't1', title: 'Task 1' })]} />);

      // Dismiss
      fireEvent.click(screen.getByTitle('Dismiss'));
      expect(screen.queryByText(/interrupted/)).not.toBeInTheDocument();

      // Rerender with different tasks — banner stays hidden (dismissal persists)
      rerender(<RecoveryBanner tasks={[interruptedTask({ taskId: 't2', title: 'Task 2' })]} />);
      expect(screen.queryByText(/interrupted/)).not.toBeInTheDocument();
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('renders correctly with max-length title for a single task', () => {
      renderBanner([
        interruptedTask({
          taskId: 'max',
          title: 'Implement comprehensive multi-factor authentication system with biometric support',
          phase: 'qa-review',
        }),
      ]);

      expect(screen.getByText(/Implement comprehensive multi-factor authentication system with biometric support/)).toBeInTheDocument();
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

      // Banner should appear with dismiss button
      expect(screen.getByText(/1 interrupted task/)).toBeInTheDocument();
      expect(screen.getByText(/New Task/)).toBeInTheDocument();
      expect(screen.getByTitle('Dismiss')).toBeInTheDocument();
    });
  });
});
