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

const mockRetryTaskWithOptions = vi.fn();
const mockStopTask = vi.fn();
const mockPauseTask = vi.fn();
const mockResumeTask = vi.fn();
const mockPlayTask = vi.fn();
const mockDeleteWorktree = vi.fn();
const mockCheckWorktree = vi.fn().mockResolvedValue({ exists: false, path: null });

vi.mock('@/app/actions/tasks', () => ({
  retryTaskWithOptions: (...args: unknown[]) => mockRetryTaskWithOptions(...args),
  stopTask: (...args: unknown[]) => mockStopTask(...args),
  pauseTask: (...args: unknown[]) => mockPauseTask(...args),
  resumeTask: (...args: unknown[]) => mockResumeTask(...args),
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
    mockRetryTaskWithOptions.mockResolvedValue({ success: true, error: '' });
    mockStopTask.mockResolvedValue({ success: true, error: '' });
    mockPauseTask.mockResolvedValue({ success: true, error: '' });
    mockResumeTask.mockResolvedValue({ success: true, error: '' });
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

    it('opens the retry-phase dialog when retry button is clicked', async () => {
      renderFailedTask();

      await act(async () => {
        fireEvent.click(screen.getByTestId('retry-button'));
      });

      // Dialog title is "Choose Resume Phase" since there are multiple options
      expect(screen.getByText('Choose Resume Phase')).toBeInTheDocument();
      // Dialog shows the task title in the subtitle
      expect(screen.getByText(/"Failed Task" — pick which phase to resume from/)).toBeInTheDocument();
      // Budget toggle should be present
      expect(screen.getByText('Reset QA-attempt budget')).toBeInTheDocument();
    });

    it('calls retryTaskWithOptions and refreshes router on dialog confirm', async () => {
      mockRetryTaskWithOptions.mockResolvedValue({ success: true, error: '' });
      renderFailedTask();

      await act(async () => {
        fireEvent.click(screen.getByTestId('retry-button'));
      });

      // Click the confirm button
      await act(async () => {
        fireEvent.click(screen.getByText('Resume'));
      });

      expect(mockRetryTaskWithOptions).toHaveBeenCalledWith('failed-1', 'implement', false);
      expect(mockRouterRefresh).toHaveBeenCalled();
      expect(window.alert).not.toHaveBeenCalled();
    });

    it('shows alert and skips router refresh on failure', async () => {
      mockRetryTaskWithOptions.mockResolvedValue({ success: false, error: 'API rate limited' });
      renderFailedTask();

      await act(async () => {
        fireEvent.click(screen.getByTestId('retry-button'));
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Resume'));
      });

      expect(window.alert).toHaveBeenCalledWith('Failed to retry task: API rate limited');
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('closes dialog when Cancel is clicked', async () => {
      renderFailedTask();

      await act(async () => {
        fireEvent.click(screen.getByTestId('retry-button'));
      });

      expect(screen.getByText('Choose Resume Phase')).toBeInTheDocument();

      await act(async () => {
        fireEvent.click(screen.getByText('Cancel'));
      });

      // Dialog should be gone and no server action should have been called
      expect(screen.queryByText('Choose Resume Phase')).not.toBeInTheDocument();
      expect(mockRetryTaskWithOptions).not.toHaveBeenCalled();
    });

    it('disables retry button and shows spinner while pending', async () => {
      // Never-resolving promise keeps the action pending
      mockRetryTaskWithOptions.mockImplementation(() => new Promise(() => {}));
      renderFailedTask();

      // Open dialog
      await act(async () => {
        fireEvent.click(screen.getByTestId('retry-button'));
      });

      // Confirm
      await act(async () => {
        fireEvent.click(screen.getByText('Resume'));
      });

      // The retry button should still be disabled after the dialog closes
      const btn = screen.getByTestId('retry-button');
      expect(btn).toBeDisabled();
      expect(btn.querySelector('.animate-spin')).toBeInTheDocument();
    });

    it('stops click event propagation', async () => {
      mockRetryTaskWithOptions.mockResolvedValue({ success: true, error: '' });
      const onSelect = vi.fn();
      render(<TaskCard task={makeTask({ id: 'failed-2', phase: 'failed' })} onSelect={onSelect} />);

      await act(async () => {
        fireEvent.click(screen.getByTestId('retry-button'));
      });

      // The card's onSelect should NOT have been called
      expect(onSelect).not.toHaveBeenCalled();
    });
  });

  // ── handlePause ──────────────────────────────────────────────────────

  describe('handlePause (pause button)', () => {
    function renderActiveTask() {
      return render(
        <TaskCard task={makeTask({ id: 'active-1', phase: 'implement', title: 'Active Task' })} onSelect={vi.fn()} />,
      );
    }

    it('calls pauseTask and refreshes router on success', async () => {
      mockPauseTask.mockResolvedValue({ success: true, error: '' });
      renderActiveTask();

      const pauseBtn = screen.getByText('Pause');
      await act(async () => {
        fireEvent.click(pauseBtn);
      });

      expect(mockPauseTask).toHaveBeenCalledWith('active-1');
      expect(mockRouterRefresh).toHaveBeenCalled();
      expect(window.alert).not.toHaveBeenCalled();
    });

    it('shows alert and skips router refresh on failure', async () => {
      mockPauseTask.mockResolvedValue({ success: false, error: 'Task locked' });
      renderActiveTask();

      await act(async () => {
        fireEvent.click(screen.getByText('Pause'));
      });

      expect(window.alert).toHaveBeenCalledWith('Failed to pause task: Task locked');
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('disables pause button and shows spinner while pending', async () => {
      mockPauseTask.mockImplementation(() => new Promise(() => {}));
      renderActiveTask();

      await act(async () => {
        fireEvent.click(screen.getByText('Pause'));
      });

      const pauseBtn = screen.getByText('Pause');
      expect(pauseBtn).toBeDisabled();
    });
  });

  // ── handleResume ─────────────────────────────────────────────────────

  describe('handleResume (resume button)', () => {
    function renderPausedTask() {
      return render(
        <TaskCard task={makeTask({ id: 'paused-1', phase: 'implement', title: 'Paused Task', isPaused: true })} onSelect={vi.fn()} />,
      );
    }

    it('calls resumeTask and refreshes router on success', async () => {
      mockResumeTask.mockResolvedValue({ success: true, error: '' });
      renderPausedTask();

      const resumeBtn = screen.getByText('Resume');
      await act(async () => {
        fireEvent.click(resumeBtn);
      });

      expect(mockResumeTask).toHaveBeenCalledWith('paused-1');
      expect(mockRouterRefresh).toHaveBeenCalled();
      expect(window.alert).not.toHaveBeenCalled();
    });

    it('shows alert and skips router refresh on failure', async () => {
      mockResumeTask.mockResolvedValue({ success: false, error: 'Session dead' });
      renderPausedTask();

      await act(async () => {
        fireEvent.click(screen.getByText('Resume'));
      });

      expect(window.alert).toHaveBeenCalledWith('Failed to resume task: Session dead');
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('disables resume button and shows spinner while pending', async () => {
      mockResumeTask.mockImplementation(() => new Promise(() => {}));
      renderPausedTask();

      await act(async () => {
        fireEvent.click(screen.getByText('Resume'));
      });

      const resumeBtn = screen.getByText('Resume');
      expect(resumeBtn).toBeDisabled();
    });

    it('shows paused badge on paused task', () => {
      renderPausedTask();
      expect(screen.getByText('⏸ Paused')).toBeInTheDocument();
    });

    it('does not show pause button when task is paused', () => {
      renderPausedTask();
      expect(screen.queryByText('Pause')).not.toBeInTheDocument();
    });
  });

  // ── handleStop (small ✕ button, still available) ─────────────────────

  describe('handleStop (small ✕ stop button)', () => {
    function renderActiveTask() {
      return render(
        <TaskCard task={makeTask({ id: 'active-1', phase: 'implement', title: 'Active Task' })} onSelect={vi.fn()} />,
      );
    }

    it('calls stopTask and refreshes router on success', async () => {
      mockStopTask.mockResolvedValue({ success: true, error: '' });
      renderActiveTask();

      const stopBtn = screen.getByTitle('Stop task — cancel, clean up artifacts, and move back to Backlog');
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
        fireEvent.click(screen.getByTitle('Stop task — cancel, clean up artifacts, and move back to Backlog'));
      });

      expect(window.alert).toHaveBeenCalledWith('Failed to stop task: Task locked');
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('stop button still visible on paused tasks', () => {
      render(
        <TaskCard task={makeTask({ id: 'p1', phase: 'implement', isPaused: true })} onSelect={vi.fn()} />,
      );
      expect(screen.getByTitle('Stop task — cancel, clean up artifacts, and move back to Backlog')).toBeInTheDocument();
    });
  });

  // ── Paused state rendering ────────────────────────────────────────────

  describe('paused state rendering', () => {
    it('shows paused badge with correct title on paused task', () => {
      render(
        <TaskCard task={makeTask({ id: 'p1', phase: 'implement', isPaused: true })} onSelect={vi.fn()} />,
      );
      const badge = screen.getByText('⏸ Paused');
      expect(badge).toBeInTheDocument();
      expect(badge.closest('[title]')?.getAttribute('title')).toBe('Task paused — click Resume to continue');
    });

    it('does not show paused badge on non-paused tasks', () => {
      render(<TaskCard task={makeTask({ id: 'a1', phase: 'implement' })} onSelect={vi.fn()} />);
      expect(screen.queryByText('⏸ Paused')).not.toBeInTheDocument();
    });

    it('does not show spinner on paused tasks', () => {
      render(<TaskCard task={makeTask({ id: 'p1', phase: 'implement', isPaused: true })} onSelect={vi.fn()} />);
      expect(screen.queryByTestId('spinner-icon')).not.toBeInTheDocument();
    });

    it('does not show hourglass on paused rate-limited tasks', () => {
      render(
        <TaskCard
          task={makeTask({ id: 'p1', phase: 'implement', isPaused: true, rateLimitedUntil: '2026-12-31T00:00:00Z' })}
          onSelect={vi.fn()}
        />,
      );
      expect(screen.queryByTestId('hourglass-icon')).not.toBeInTheDocument();
    });

    it('resume button not shown when task is not paused', () => {
      render(<TaskCard task={makeTask({ id: 'a1', phase: 'implement' })} onSelect={vi.fn()} />);
      expect(screen.queryByText('Resume')).not.toBeInTheDocument();
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

    it('shows pause button for active phases (not backlog, failed, done)', () => {
      render(<TaskCard task={makeTask({ id: 'a1', phase: 'implement' })} onSelect={vi.fn()} />);
      expect(screen.getByText('Pause')).toBeInTheDocument();
    });

    it('hides pause/resume buttons for backlog, failed, and done phases', () => {
      for (const phase of ['backlog', 'failed', 'done']) {
        const { unmount } = render(<TaskCard task={makeTask({ id: 't', phase })} onSelect={vi.fn()} />);
        expect(screen.queryByText('Pause')).not.toBeInTheDocument();
        expect(screen.queryByText('Resume')).not.toBeInTheDocument();
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
    it('handleRetry: alerts when retryTaskWithOptions raw-throws', async () => {
      mockRetryTaskWithOptions.mockRejectedValue(new Error('network dropped'));

      render(<TaskCard task={makeTask({ id: 'failed-r', phase: 'failed' })} onSelect={vi.fn()} />);

      // Open dialog
      await act(async () => {
        fireEvent.click(screen.getByTestId('retry-button'));
      });

      // Confirm
      await act(async () => {
        fireEvent.click(screen.getByText('Resume'));
      });

      expect(mockRetryTaskWithOptions).toHaveBeenCalledWith('failed-r', 'implement', false);
      expect(window.alert).toHaveBeenCalledWith('Failed to retry task: network dropped');
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('handlePause: alerts when pauseTask raw-throws', async () => {
      mockPauseTask.mockRejectedValue(new Error('session killed'));

      render(<TaskCard task={makeTask({ id: 'active-r', phase: 'implement' })} onSelect={vi.fn()} />);

      await act(async () => {
        fireEvent.click(screen.getByText('Pause'));
      });

      expect(mockPauseTask).toHaveBeenCalledWith('active-r');
      expect(window.alert).toHaveBeenCalledWith('Failed to pause task: session killed');
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
