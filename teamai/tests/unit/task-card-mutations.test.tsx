// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TaskCard } from '@/components/task-card';
import type { Task } from '@/lib/task-store';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockRouterRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: mockRouterRefresh,
    push: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

const mockRetryTask = vi.fn();
const mockStopTask = vi.fn();
const mockPlayTask = vi.fn();
const mockDeleteWorktree = vi.fn();
const mockCheckWorktree = vi.fn().mockResolvedValue({ exists: false, path: null });

vi.mock('@/app/actions/tasks', () => ({
  retryTask: (...args: unknown[]) => mockRetryTask(...args),
  stopTask: (...args: unknown[]) => mockStopTask(...args),
  playTask: (...args: unknown[]) => mockPlayTask(...args),
  deleteTaskWorktree: (...args: unknown[]) => mockDeleteWorktree(...args),
  checkTaskWorktree: (...args: unknown[]) => mockCheckWorktree(...args),
}));

// ── Fixtures ───────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test Task',
    description: 'A test task',
    phase: 'done',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Helpers ────────────────────────────────────────────────────────────

const originalConfirm = window.confirm;
const originalAlert = window.alert;

// ── Tests ──────────────────────────────────────────────────────────────

describe('TaskCard mutation handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.confirm = vi.fn().mockReturnValue(true);
    window.alert = vi.fn();
    mockRetryTask.mockResolvedValue({ success: true, error: '' });
    mockStopTask.mockResolvedValue({ success: true, error: '' });
    mockPlayTask.mockResolvedValue({ success: true, error: '' });
    mockDeleteWorktree.mockResolvedValue({ success: true, error: '' });
    mockCheckWorktree.mockResolvedValue({ exists: false, path: null });
  });

  afterEach(() => {
    window.confirm = originalConfirm;
    window.alert = originalAlert;
  });

  // ── handleRetry ──────────────────────────────────────────────────────

  describe('handleRetry (retry button)', () => {
    function renderFailedTask() {
      return render(
        <TaskCard task={makeTask({ id: 'failed-1', phase: 'failed', title: 'Failed Task' })} onSelect={vi.fn()} />,
      );
    }

    it('calls retryTask and refreshes router on success', async () => {
      mockRetryTask.mockResolvedValue({ success: true, error: '' });
      renderFailedTask();

      await act(async () => {
        fireEvent.click(screen.getByTestId('retry-button'));
      });

      expect(mockRetryTask).toHaveBeenCalledWith('failed-1');
      expect(mockRouterRefresh).toHaveBeenCalled();
      expect(window.alert).not.toHaveBeenCalled();
    });

    it('shows alert and skips router refresh on failure', async () => {
      mockRetryTask.mockResolvedValue({ success: false, error: 'API rate limited' });
      renderFailedTask();

      await act(async () => {
        fireEvent.click(screen.getByTestId('retry-button'));
      });

      expect(mockRetryTask).toHaveBeenCalledWith('failed-1');
      expect(window.alert).toHaveBeenCalledWith('Failed to retry task: API rate limited');
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('disables retry button and shows spinner while pending', async () => {
      // Never-resolving promise keeps the action pending
      mockRetryTask.mockImplementation(() => new Promise(() => {}));
      renderFailedTask();

      await act(async () => {
        fireEvent.click(screen.getByTestId('retry-button'));
      });

      const btn = screen.getByTestId('retry-button');
      expect(btn).toBeDisabled();
      // Should show a spinner icon (the animate-spin div)
      expect(btn.querySelector('.animate-spin')).toBeInTheDocument();
    });

    it('stops click event propagation', async () => {
      mockRetryTask.mockResolvedValue({ success: true, error: '' });
      const onSelect = vi.fn();
      render(<TaskCard task={makeTask({ id: 'failed-2', phase: 'failed' })} onSelect={onSelect} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('retry-button'));
      });

      // The card's onSelect should NOT have been called
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  // ── handleStop ───────────────────────────────────────────────────────

  describe('handleStop (stop button)', () => {
    function renderActiveTask() {
      return render(
        <TaskCard task={makeTask({ id: 'active-1', phase: 'implement', title: 'Active Task' })} onSelect={vi.fn()} />,
      );
    }

    it('calls stopTask and refreshes router on success', async () => {
      mockStopTask.mockResolvedValue({ success: true, error: '' });
      renderActiveTask();

      const stopBtn = screen.getByText('Stop');
      await act(async () => {
        fireEvent.click(stopBtn);
      });

      expect(mockStopTask).toHaveBeenCalledWith('active-1');
      expect(mockRouterRefresh).toHaveBeenCalled();
      expect(window.alert).not.toHaveBeenCalled();
    });

    it('shows alert and skips router refresh on failure', async () => {
      mockStopTask.mockResolvedValue({ success: false, error: 'Task locked' });
      renderActiveTask();

      await act(async () => {
        fireEvent.click(screen.getByText('Stop'));
      });

      expect(window.alert).toHaveBeenCalledWith('Failed to stop task: Task locked');
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('disables stop button and shows spinner while pending', async () => {
      mockStopTask.mockImplementation(() => new Promise(() => {}));
      renderActiveTask();

      await act(async () => {
        fireEvent.click(screen.getByText('Stop'));
      });

      const stopBtn = screen.getByText('Stop');
      expect(stopBtn).toBeDisabled();
    });
  });

  // ── handlePlay ───────────────────────────────────────────────────────

  describe('handlePlay (play button)', () => {
    function renderBacklogTask() {
      return render(
        <TaskCard task={makeTask({ id: 'backlog-1', phase: 'backlog', title: 'Backlog Task' })} onSelect={vi.fn()} />,
      );
    }

    it('calls playTask and refreshes router on success', async () => {
      mockPlayTask.mockResolvedValue({ success: true, error: '' });
      renderBacklogTask();

      await act(async () => {
        fireEvent.click(screen.getByText('Start'));
      });

      expect(mockPlayTask).toHaveBeenCalledWith('backlog-1');
      expect(mockRouterRefresh).toHaveBeenCalled();
      expect(window.alert).not.toHaveBeenCalled();
    });

    it('shows alert and skips router refresh on failure', async () => {
      mockPlayTask.mockResolvedValue({ success: false, error: 'No spec template' });
      renderBacklogTask();

      await act(async () => {
        fireEvent.click(screen.getByText('Start'));
      });

      expect(window.alert).toHaveBeenCalledWith('Failed to start task: No spec template');
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('disables play button and shows spinner while pending', async () => {
      mockPlayTask.mockImplementation(() => new Promise(() => {}));
      renderBacklogTask();

      await act(async () => {
        fireEvent.click(screen.getByText('Start'));
      });

      const startBtn = screen.getByText('Start');
      expect(startBtn).toBeDisabled();
    });
  });

  // ── handleDeleteWorktree ─────────────────────────────────────────────

  describe('handleDeleteWorktree', () => {
    function renderWithWorktree() {
      // Set up checkTaskWorktree to return an existing worktree
      mockCheckWorktree.mockResolvedValue({ exists: true, path: '/tmp/worktrees/task-1' });
      return render(
        <TaskCard
          task={makeTask({ id: 'wt-1', title: 'Worktree Task', branch: 'feature/test' })}
          onSelect={vi.fn()}
        />,
      );
    }

    it('shows worktree delete button when worktree exists', async () => {
      renderWithWorktree();

      // Wait for the checkTaskWorktree effect to resolve
      await waitFor(() => {
        expect(screen.getByTitle(/Delete worktree/)).toBeInTheDocument();
      });
    });

    it('calls deleteTaskWorktree and refreshes router on success', async () => {
      renderWithWorktree();

      await waitFor(() => {
        expect(screen.getByTitle(/Delete worktree/)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByTitle(/Delete worktree/));
      });

      expect(window.confirm).toHaveBeenCalled();
      expect(mockDeleteWorktree).toHaveBeenCalledWith('wt-1');
      expect(mockRouterRefresh).toHaveBeenCalled();
      expect(window.alert).not.toHaveBeenCalled();
    });

    it('shows alert and skips router refresh on failure', async () => {
      mockDeleteWorktree.mockResolvedValue({ success: false, error: 'Worktree locked' });
      renderWithWorktree();

      await waitFor(() => {
        expect(screen.getByTitle(/Delete worktree/)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByTitle(/Delete worktree/));
      });

      expect(window.alert).toHaveBeenCalledWith('Failed to delete worktree: Worktree locked');
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('does not proceed when confirm is cancelled', async () => {
      window.confirm = vi.fn().mockReturnValue(false);
      renderWithWorktree();

      await waitFor(() => {
        expect(screen.getByTitle(/Delete worktree/)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByTitle(/Delete worktree/));
      });

      expect(mockDeleteWorktree).not.toHaveBeenCalled();
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('shows loading indicator while deleting', async () => {
      mockDeleteWorktree.mockImplementation(() => new Promise(() => {}));
      renderWithWorktree();

      await waitFor(() => {
        expect(screen.getByTitle(/Delete worktree/)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByTitle(/Delete worktree/));
      });

      // The button should show ⌛ (the loading state set via wtDeleting)
      const btn = screen.getByTitle(/Delete worktree/);
      expect(btn).toBeDisabled();
      expect(btn.textContent).toContain('⌛');
    });
  });

  // ── Worktree status re-check on phase change ────────────────────────

  describe('worktree status re-check', () => {
    it('re-checks worktree when task.phase changes', async () => {
      mockCheckWorktree.mockResolvedValue({ exists: true, path: '/tmp/wt/feature' });

      const { rerender } = render(
        <TaskCard
          task={makeTask({ id: 'wt-1', phase: 'implement', branch: 'feature/test' })}
          onSelect={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(mockCheckWorktree).toHaveBeenCalledWith('wt-1');
      });

      const callCountBefore = mockCheckWorktree.mock.calls.length;

      // Re-render with a different phase — should trigger re-check
      rerender(
        <TaskCard
          task={makeTask({ id: 'wt-1', phase: 'done', branch: 'feature/test' })}
          onSelect={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(mockCheckWorktree.mock.calls.length).toBeGreaterThan(callCountBefore);
      });
    });

    it('resets worktree status when branch becomes undefined', async () => {
      mockCheckWorktree.mockResolvedValue({ exists: true, path: '/tmp/wt/feature' });

      const { rerender } = render(
        <TaskCard
          task={makeTask({ id: 'wt-1', phase: 'implement', branch: 'feature/test' })}
          onSelect={vi.fn()}
        />
      );

      await waitFor(() => {
        expect(screen.getByTitle(/Delete worktree/)).toBeInTheDocument();
      });

      // Re-render with branch undefined (e.g., worktree deleted externally)
      rerender(
        <TaskCard
          task={makeTask({ id: 'wt-1', phase: 'done', branch: undefined })}
          onSelect={vi.fn()}
        />
      );

      // The worktree delete button should no longer be visible
      await waitFor(() => {
        expect(screen.queryByTitle(/Delete worktree/)).not.toBeInTheDocument();
      });
    });
  });

  // ── Button visibility by phase ───────────────────────────────────────

  describe('button visibility', () => {
    it('shows retry button and failure indicator only for failed tasks', () => {
      render(<TaskCard task={makeTask({ id: 'f1', phase: 'failed' })} onSelect={vi.fn()} />);
      expect(screen.getByTestId('retry-button')).toBeInTheDocument();
      expect(screen.getByTestId('failure-indicator')).toBeInTheDocument();
    });

    it('hides retry button for non-failed tasks', () => {
      render(<TaskCard task={makeTask({ id: 't1', phase: 'done' })} onSelect={vi.fn()} />);
      expect(screen.queryByTestId('retry-button')).not.toBeInTheDocument();
    });

    it('shows play (Start) button only for backlog tasks', () => {
      render(<TaskCard task={makeTask({ id: 'b1', phase: 'backlog' })} onSelect={vi.fn()} />);
      expect(screen.getByText('Start')).toBeInTheDocument();
    });

    it('hides play button for non-backlog tasks', () => {
      render(<TaskCard task={makeTask({ id: 't1', phase: 'spec' })} onSelect={vi.fn()} />);
      expect(screen.queryByText('Start')).not.toBeInTheDocument();
    });

    it('shows stop button for active phases (not backlog, failed, done)', () => {
      render(<TaskCard task={makeTask({ id: 'a1', phase: 'implement' })} onSelect={vi.fn()} />);
      expect(screen.getByText('Stop')).toBeInTheDocument();
    });

    it('hides stop button for backlog, failed, and done phases', () => {
      for (const phase of ['backlog', 'failed', 'done']) {
        const { unmount } = render(<TaskCard task={makeTask({ id: 't', phase })} onSelect={vi.fn()} />);
        expect(screen.queryByText('Stop')).not.toBeInTheDocument();
        unmount();
      }
    });
  });

  // ── Raw-throw path (regression) ──────────────────────────────────────
  // The existing !result.success tests above cover the failed-action
  // surface ({success:false, error:'...'} → throw new Error(...)). These
  // tests cover the OTHER branch through the same catch: the Server Action
  // itself throws an Error (e.g., upstream transport/network failure).
  // Both branches converge at the unified catch and must produce an alert
  // — the audit-flagged regression was that the raw throw path was
  // silently swallowed by useServerMutation's empty catch.

  describe('raw-throw path (regression)', () => {
    it('handleRetry: alerts when retryTask raw-throws', async () => {
      mockRetryTask.mockRejectedValue(new Error('network dropped'));

      render(<TaskCard task={makeTask({ id: 'failed-r', phase: 'failed' })} onSelect={vi.fn()} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('retry-button'));
      });

      expect(mockRetryTask).toHaveBeenCalledWith('failed-r');
      expect(window.alert).toHaveBeenCalledWith('Failed to retry task: network dropped');
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('handleStop: alerts when stopTask raw-throws', async () => {
      mockStopTask.mockRejectedValue(new Error('session killed'));

      render(<TaskCard task={makeTask({ id: 'active-r', phase: 'implement' })} onSelect={vi.fn()} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Stop'));
      });

      expect(mockStopTask).toHaveBeenCalledWith('active-r');
      expect(window.alert).toHaveBeenCalledWith('Failed to stop task: session killed');
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('handlePlay: alerts when playTask raw-throws', async () => {
      mockPlayTask.mockRejectedValue(new Error('config missing'));

      render(<TaskCard task={makeTask({ id: 'backlog-r', phase: 'backlog' })} onSelect={vi.fn()} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Start'));
      });

      expect(mockPlayTask).toHaveBeenCalledWith('backlog-r');
      expect(window.alert).toHaveBeenCalledWith('Failed to start task: config missing');
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('handleDeleteWorktree: alerts when deleteTaskWorktree raw-throws', async () => {
      mockDeleteWorktree.mockRejectedValue(new Error('git worktree lock'));
      mockCheckWorktree.mockResolvedValue({ exists: true, path: '/tmp/wt/task-r' });

      render(
        <TaskCard
          task={makeTask({ id: 'wt-r', branch: 'feature/test' })}
          onSelect={vi.fn()}
        />,
      );

      await waitFor(() => {
        expect(screen.getByTitle(/Delete worktree/)).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByTitle(/Delete worktree/));
      });

      expect(window.confirm).toHaveBeenCalled();
      expect(mockDeleteWorktree).toHaveBeenCalledWith('wt-r');
      expect(window.alert).toHaveBeenCalledWith('Failed to delete worktree: git worktree lock');
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });
  });
});
