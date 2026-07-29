// @vitest-environment happy-dom
/**
 * Unit tests for TaskDetail mutation handlers (regression: silent failures).
 *
 * Mirrors the kanban-board pattern: Server Action raw-throws must surface
 * a role="alert" error banner instead of being silently swallowed by
 * useServerMutation's empty catch. Each handler tested covers one code
 * branch that previously did nothing on failure.
 *
 * React's useTransition / useServerMutation are NOT mocked — the existing
 * task-card-mutations.test.tsx pattern uses `await act(async () => ...)`
 * which flushes React state updates through both microtask resolution and
 * the catch-block re-throw.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TaskDetail } from '@/components/task-detail';
import type { Task } from '@/lib/task-store';

// ── Hoisted mocks ────────────────────────────────────────────────────────

const mockRouterPush = vi.fn();
const mockRouterRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: mockRouterPush,
    refresh: mockRouterRefresh,
    prefetch: vi.fn(),
  }),
}));

const mockAddDependency = vi.fn();
const mockRemoveDependency = vi.fn();
const mockAddBlock = vi.fn();
const mockRemoveBlock = vi.fn();
const mockDeleteTask = vi.fn();
const mockRetryTask = vi.fn();
const mockRestartCurrentPhase = vi.fn();

vi.mock('@/app/actions/tasks', () => ({
  addDependency: (...args: unknown[]) => mockAddDependency(...args),
  removeDependency: (...args: unknown[]) => mockRemoveDependency(...args),
  addBlock: (...args: unknown[]) => mockAddBlock(...args),
  removeBlock: (...args: unknown[]) => mockRemoveBlock(...args),
  deleteTask: (...args: unknown[]) => mockDeleteTask(...args),
  retryTask: (...args: unknown[]) => mockRetryTask(...args),
  restartCurrentPhase: (...args: unknown[]) => mockRestartCurrentPhase(...args),
}));

const mockMarkAutoReviewed = vi.fn();

vi.mock('@/app/actions/auto-mode', () => ({
  markAutoReviewed: (...args: unknown[]) => mockMarkAutoReviewed(...args),
}));

// Render siblings minimally — focus is on parent handler behavior, not on
// sub-component internals. PhaseSyncer uses WebSocket so MUST be mocked;
// AgentPanel/ReviewPanel/SpecDiffView are optional safety mocks.
vi.mock('@/components/agent-panel', () => ({
  AgentPanel: () => <div data-component="agent-panel" />,
}));

vi.mock('@/components/review-panel', () => ({
  ReviewPanel: () => <div data-component="review-panel" />,
}));

vi.mock('@/components/phase-syncer', () => ({
  PhaseSyncer: () => null,
}));

// ── Fixtures ────────────────────────────────────────────────────────────

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test Task',
    description: 'A test task',
    phase: 'implement',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

const originalConfirm = window.confirm;

// ── Tests ───────────────────────────────────────────────────────────────

describe('TaskDetail mutation handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.confirm = vi.fn().mockReturnValue(true);
    // Successful defaults — individual tests override per-case.
    mockAddDependency.mockResolvedValue(undefined);
    mockRemoveDependency.mockResolvedValue(undefined);
    mockAddBlock.mockResolvedValue(undefined);
    mockRemoveBlock.mockResolvedValue(undefined);
    mockDeleteTask.mockResolvedValue({ success: true });
    mockRetryTask.mockResolvedValue({ success: true });
    mockRestartCurrentPhase.mockResolvedValue({ success: true });
    mockMarkAutoReviewed.mockResolvedValue(undefined);
  });

  afterEach(() => {
    window.confirm = originalConfirm;
  });

  function renderDetail(task: Task, extraTasks: Task[] = []) {
    return render(
      <TaskDetail
        task={task}
        allTasks={[task, ...extraTasks]}
        dependencies={[]}
        dependents={[]}
        spec={null}
        plan={null}
        qaReport={null}
        diff={null}
        subtaskTerminals={[]}
        qaLog={null}
        specLog={null}
        planLog={null}
        mergeLog={null}
        sessionMap={{}}
      />,
    );
  }

  // ── Raw-throw path (regression) ────────────────────────────────────
  // Each handler below wraps its Server Action in try/catch. The catch
  // re-throws AFTER setting error state, so useServerMutation skips
  // router.refresh() on failure. Without that wrapper, a raw throw was
  // silently caught by useServerMutation's empty catch — error banner
  // didn't appear, button click appeared to "do nothing". These tests
  // lock in the post-fix contract for the four most-affected handlers.

  describe('raw-throw path (regression)', () => {
    it('handleRestart: role=alert banner surfaces when restartCurrentPhase throws', async () => {
      mockRestartCurrentPhase.mockRejectedValue(new Error('restart raw throw: pipeline mismatch'));

      renderDetail(makeTask({ id: 'r-1', phase: 'implement', title: 'Restart me' }));

      await act(async () => {
        fireEvent.click(screen.getByTestId('restart-phase-button'));
      });

      expect(window.confirm).toHaveBeenCalled();
      expect(mockRestartCurrentPhase).toHaveBeenCalledWith('r-1');
      await waitFor(() => {
        const banner = screen.getByRole('alert');
        expect(banner).toHaveTextContent('Failed to restart task: restart raw throw: pipeline mismatch');
      });
      // re-throw → useServerMutation skips refresh
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('handleMarkReviewed: role=alert banner surfaces when markAutoReviewed throws', async () => {
      mockMarkAutoReviewed.mockRejectedValue(new Error('markReviewed raw throw: db timeout'));

      renderDetail(
        makeTask({
          id: 'mr-1',
          phase: 'done',
          autoProcessed: true,
          autoReviewed: false,
          title: 'Auto merged',
        }),
      );

      await act(async () => {
        // Mark Reviewed button label is "✓ Mark Reviewed" (with leading
        // check-mark) — use a regex substring match since exact getByText
        // would miss the ✓ prefix.
        fireEvent.click(screen.getByText(/Mark Reviewed/));
      });

      expect(window.confirm).toHaveBeenCalled();
      expect(mockMarkAutoReviewed).toHaveBeenCalledWith('mr-1');
      await waitFor(() => {
        const banner = screen.getByRole('alert');
        expect(banner).toHaveTextContent('Failed to mark task as reviewed: markReviewed raw throw: db timeout');
      });
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('handleInlineRetry: role=alert banner surfaces when retryTask throws', async () => {
      mockRetryTask.mockRejectedValue(new Error('inline retry raw throw: bad pipeline state'));

      renderDetail(
        makeTask({
          id: 'retry-1',
          phase: 'failed',
          completionSummary: 'QA exceeded max attempts while validating',
          title: 'Failed task',
        }),
      );

      await act(async () => {
        fireEvent.click(screen.getByTestId('detail-retry-button'));
      });

      expect(mockRetryTask).toHaveBeenCalledWith('retry-1');
      await waitFor(() => {
        const banner = screen.getByRole('alert');
        expect(banner).toHaveTextContent('Failed to retry task: inline retry raw throw: bad pipeline state');
      });
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('handleDelete: role=alert banner surfaces when deleteTask throws (and router.push is skipped)', async () => {
      mockDeleteTask.mockRejectedValue(new Error('delete raw throw: file locked'));

      renderDetail(makeTask({ id: 'del-1', title: 'Will be deleted' }));

      await act(async () => {
        fireEvent.click(screen.getByTitle('Delete task'));
      });

      expect(window.confirm).toHaveBeenCalled();
      expect(mockDeleteTask).toHaveBeenCalledWith('del-1');
      await waitFor(() => {
        const banner = screen.getByRole('alert');
        // handleDelete's catch now prefixes with "Failed to delete task:" to
        // match handleRestart / handleMarkReviewed / handleInlineRetry.
        expect(banner).toHaveTextContent('Failed to delete task: delete raw throw: file locked');
      });
      // Critical: handleDelete does `if (onClose) onClose() else router.push('/')`
      // AFTER `await deleteTask(...)`. The catch block fires BEFORE that
      // branch, so router.push must NOT be invoked on failure.
      expect(mockRouterPush).not.toHaveBeenCalled();
    });
  });
});
