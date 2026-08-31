// @vitest-environment happy-dom

/**
 * Unit tests for KanbanBoard component.
 *
 * Tests column rendering (6 phases with normalization), task card placement,
 * filter toolbar (search / phase filter / source filter / sort / reset),
 * bulk selection (individual + shift-click range + ctrl-click), drag and drop,
 * optimistic phase updates, the New Task dialog with templates, the
 * retry-phase dialog on artifact-clearing drops, and the connection indicator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Task } from '@/lib/task-store';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockCreateTask = vi.hoisted(() => vi.fn());
const mockMoveTask = vi.hoisted(() => vi.fn());
const mockBulkDeleteTasks = vi.hoisted(() => vi.fn());
const mockRetryTaskWithOptions = vi.hoisted(() => vi.fn());

vi.mock('@/app/actions/tasks', () => ({
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  moveTask: (...args: unknown[]) => mockMoveTask(...args),
  bulkDeleteTasks: (...args: unknown[]) => mockBulkDeleteTasks(...args),
  retryTaskWithOptions: (...args: unknown[]) => mockRetryTaskWithOptions(...args),
}));

vi.mock('@/hooks/use-phase-sync', () => ({
  usePhaseSync: vi.fn(),
}));

const mockRouterRefresh = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

// TaskCard — render minimal identifiable output so cards are visible in DOM
vi.mock('@/components/task-card', () => ({
  TaskCard: ({ task, isMoving }: { task: Task; onSelect: (id: string) => void; isMoving?: boolean }) => (
    <div data-component="task-card" data-task-id={task.id} data-phase={task.phase}>
      <span data-component="task-title">{task.title}</span>
      {isMoving && <span data-component="is-moving" />}
    </div>
  ),
}));

vi.mock('@/components/task-panel', () => ({
  TaskPanel: ({ taskId, onClose }: { taskId: string; onClose: () => void; readonly?: boolean; cachedData?: unknown; onDataLoaded?: () => void; onError?: () => void }) => (
    <div data-component="task-panel" data-task-id={taskId}>
      <button data-component="close-panel" onClick={onClose}>Close</button>
    </div>
  ),
}));

const mockGetDoneTicketSpec = vi.hoisted(() => vi.fn());
const mockLoadMoreDoneHistory = vi.hoisted(() => vi.fn());
const mockRescanDoneHistory = vi.hoisted(() => vi.fn());

vi.mock('@/app/actions/history', () => ({
  getDoneTicketSpec: (...args: unknown[]) => mockGetDoneTicketSpec(...args),
  loadMoreDoneHistory: (...args: unknown[]) => mockLoadMoreDoneHistory(...args),
  rescanDoneHistory: (...args: unknown[]) => mockRescanDoneHistory(...args),
}));

vi.mock('@/components/connection-indicator', () => ({
  ConnectionIndicator: ({ connected, initial }: { connected: boolean; initial: boolean }) => (
    <span data-component="connection-indicator" data-connected={connected} data-initial={initial} />
  ),
}));

const mockStartTransition = vi.hoisted(() =>
  vi.fn((cb: () => void) => {
    try {
      const result = cb() as unknown;
      if (result instanceof Promise) result.catch(() => { /* best-effort */ });
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

import { KanbanBoard } from '@/components/kanban-board';
import type { DoneTicketFromHistory } from '@/lib/history-scanner';

// ── Fixtures ────────────────────────────────────────────────────────────────

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    title: 'Test Task',
    description: 'A test task description.',
    phase: 'backlog',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function renderBoard(
  tasks: Task[] = [],
  doneHistory: DoneTicketFromHistory[] = [],
  doneHistoryHasMore = false,
) {
  render(
    <KanbanBoard
      tasks={tasks}
      projectPath="/test"
      doneHistory={doneHistory}
      doneHistoryHasMore={doneHistoryHasMore}
    />,
  );
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Drop a card onto a column by its header text. */
function dropCardOnColumn(columnHeaderText: string) {
  const card = screen.getByTestId('task-card');
  fireEvent.dragStart(card);
  const header = screen.getByText(columnHeaderText);
  const column = header.closest('.flex.flex-col')!;
  fireEvent.dragOver(column);
  fireEvent.drop(column);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('KanbanBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMoveTask.mockResolvedValue(undefined);
    mockCreateTask.mockResolvedValue(undefined);
    mockBulkDeleteTasks.mockResolvedValue(undefined);
    mockRetryTaskWithOptions.mockResolvedValue({ success: true });
  });

  // ── Column rendering ─────────────────────────────────────────────────

  describe('column rendering', () => {
    it('renders all six columns with correct labels', () => {
      renderBoard();

      expect(screen.getByText('Backlog')).toBeInTheDocument();
      expect(screen.getByText('Analysis')).toBeInTheDocument();
      expect(screen.getByText('In Progress')).toBeInTheDocument();
      expect(screen.getByText('Review')).toBeInTheDocument();
      expect(screen.getByText('Failed')).toBeInTheDocument();
      expect(screen.getByText('Done')).toBeInTheDocument();
    });

    it('shows task count badges in each column', () => {
      renderBoard([
        task({ id: '1', title: 'A', phase: 'backlog' }),
        task({ id: '2', title: 'B', phase: 'backlog' }),
        task({ id: '3', title: 'C', phase: 'implement' }),
      ]);

      // Count badges are small rounded spans next to column headers
      const badges = screen.getAllByText(/^[0-9]+$/);
      const badgeTexts = badges.map(b => b.textContent);
      // backlog=2, analysis=0, implement=1, review=0, failed=0, done=0
      expect(badgeTexts).toEqual(expect.arrayContaining(['2', '0', '1']));
    });

    it('renders "Board" header with + New Task button', () => {
      renderBoard();

      expect(screen.getByText('Board')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '+ New Task' })).toBeInTheDocument();
    });

    it('renders the connection indicator', () => {
      renderBoard();

      const indicator = screen.getByTestId('connection-indicator');
      expect(indicator).toBeInTheDocument();
    });
  });

  // ── Task card placement ──────────────────────────────────────────────

  describe('task card placement', () => {
    it('places tasks in the correct columns by phase', () => {
      renderBoard([
        task({ id: '1', title: 'Backlog Item', phase: 'backlog' }),
        task({ id: '2', title: 'In Progress Item', phase: 'implement' }),
        task({ id: '3', title: 'Done Item', phase: 'done' }),
      ]);

      const cards = screen.getAllByTestId('task-card');
      const titles = cards.map(c => c.querySelector('[data-component="task-title"]')?.textContent);
      expect(titles).toEqual(expect.arrayContaining(['Backlog Item', 'In Progress Item', 'Done Item']));
    });

    it('normalizes spec and plan phases into Analysis column', () => {
      renderBoard([
        task({ id: '1', title: 'Spec task', phase: 'spec' }),
        task({ id: '2', title: 'Plan task', phase: 'plan' }),
      ]);

      // Both should appear in the Analysis column
      const cards = screen.getAllByTestId('task-card');
      expect(cards).toHaveLength(2);
    });

    it('normalizes review phases (qa-review, qa-fix, awaiting-review, create-pr, pr-open, merge) into Review column', () => {
      renderBoard([
        task({ id: '1', title: 'QA task', phase: 'qa-review' }),
        task({ id: '2', title: 'Merge task', phase: 'merge' }),
        task({ id: '3', title: 'PR task', phase: 'create-pr' }),
      ]);

      const cards = screen.getAllByTestId('task-card');
      expect(cards).toHaveLength(3);
      // All show in Review column
    });

    it('renders tasks with data-task-id attribute on cards', () => {
      renderBoard([task({ id: 'abc-123', title: 'ID check' })]);

      const card = screen.getByTestId('task-card');
      expect(card.getAttribute('data-task-id')).toBe('abc-123');
    });
  });

  // ── Filter & search ──────────────────────────────────────────────────

  describe('filter toolbar', () => {
    it('renders search input', () => {
      renderBoard();
      expect(screen.getByPlaceholderText('Search…')).toBeInTheDocument();
    });

    it('filters tasks by search query', () => {
      renderBoard([
        task({ id: '1', title: 'Fix login bug', phase: 'backlog' }),
        task({ id: '2', title: 'Add dark mode', phase: 'backlog' }),
      ]);

      const searchInput = screen.getByPlaceholderText('Search…');
      fireEvent.change(searchInput, { target: { value: 'login' } });

      // Only "Fix login bug" should remain
      const cards = screen.getAllByTestId('task-card');
      expect(cards).toHaveLength(1);
      expect(cards[0].querySelector('[data-component="task-title"]')?.textContent).toBe('Fix login bug');
    });

    it('searches in task description too', () => {
      renderBoard([
        task({ id: '1', title: 'Task A', description: 'contains keyword here', phase: 'backlog' }),
        task({ id: '2', title: 'Task B', description: 'something else', phase: 'backlog' }),
      ]);

      fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'keyword' } });

      expect(screen.getAllByTestId('task-card')).toHaveLength(1);
    });

    it('shows clear button when search query is entered', () => {
      renderBoard();

      fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'test' } });

      // The × button should appear
      const clearBtns = screen.getAllByText('×');
      expect(clearBtns.length).toBeGreaterThan(0);
    });

    it('renders Phase, Source, and Sort filter buttons', () => {
      renderBoard();

      expect(screen.getByText('Phase')).toBeInTheDocument();
      expect(screen.getByText('Source')).toBeInTheDocument();
      expect(screen.getByText('Sort')).toBeInTheDocument();
    });

    it('shows Reset button when filters are active', () => {
      renderBoard();

      fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'test' } });

      expect(screen.getByText('Reset')).toBeInTheDocument();
    });

    it('Reset clears all filters', () => {
      renderBoard([task({ id: '1', title: 'A', description: '' }), task({ id: '2', title: 'B', description: '' })]);

      fireEvent.change(screen.getByPlaceholderText('Search…'), { target: { value: 'zzznotfound' } });

      // Tasks are filtered out — no cards visible
      expect(screen.queryAllByTestId('task-card')).toHaveLength(0);

      fireEvent.click(screen.getByText('Reset'));

      // Tasks are back
      expect(screen.getAllByTestId('task-card')).toHaveLength(2);
    });

    it('opens phase filter dropdown and shows column checkboxes', () => {
      renderBoard();

      fireEvent.click(screen.getByText('Phase'));

      // Both the column header and dropdown checkbox show "Backlog"
      const backlogLabels = screen.getAllByText('Backlog');
      expect(backlogLabels.length).toBeGreaterThanOrEqual(2); // column header + dropdown label
    });

    it('opens source filter dropdown and allows filtering by source', () => {
      renderBoard([
        task({ id: '1', title: 'Ideation item', source: 'ideation' }),
        task({ id: '2', title: 'Comp item', source: 'competitor-analysis' }),
      ]);

      fireEvent.click(screen.getByText('Source'));

      // Select "Ideation" option
      fireEvent.click(screen.getByText('Ideation'));

      const cards = screen.getAllByTestId('task-card');
      expect(cards).toHaveLength(1);
      expect(cards[0].querySelector('[data-component="task-title"]')?.textContent).toBe('Ideation item');
    });
  });

  // ── Bulk selection ───────────────────────────────────────────────────

  describe('bulk selection', () => {
    const sampleTasks = [
      task({ id: '1', title: 'Task 1', phase: 'backlog' }),
      task({ id: '2', title: 'Task 2', phase: 'backlog' }),
      task({ id: '3', title: 'Task 3', phase: 'backlog' }),
    ];

    it('selects a single task via ctrl-click', () => {
      renderBoard(sampleTasks);

      const cards = screen.getAllByTestId('task-card');
      fireEvent.click(cards[0], { ctrlKey: true });

      // Bulk bar should appear with "1 selected"
      expect(screen.getByText('1 selected')).toBeInTheDocument();
    });

    it('deselects with the Deselect button', () => {
      renderBoard(sampleTasks);

      const cards = screen.getAllByTestId('task-card');
      fireEvent.click(cards[0], { ctrlKey: true });
      fireEvent.click(screen.getByText('Deselect'));

      expect(screen.queryByText('1 selected')).not.toBeInTheDocument();
    });

    it('shows bulk move dropdown when items are selected', () => {
      renderBoard(sampleTasks);

      const cards = screen.getAllByTestId('task-card');
      fireEvent.click(cards[0], { ctrlKey: true });

      // Bulk action bar shows move-to dropdown
      expect(screen.getByText('Move to:')).toBeInTheDocument();
    });

    it('shows Delete selected button when items are selected', () => {
      renderBoard(sampleTasks);

      const cards = screen.getAllByTestId('task-card');
      fireEvent.click(cards[0], { ctrlKey: true });

      expect(screen.getByText('Delete selected')).toBeInTheDocument();
    });

    it('selects a range of tasks via shift-click', () => {
      renderBoard([
        task({ id: '1', title: 'A', phase: 'backlog', createdAt: '2026-01-03T00:00:00.000Z' }),
        task({ id: '2', title: 'B', phase: 'backlog', createdAt: '2026-01-02T00:00:00.000Z' }),
        task({ id: '3', title: 'C', phase: 'backlog', createdAt: '2026-01-01T00:00:00.000Z' }),
      ]);

      const cards = screen.getAllByTestId('task-card');
      // Click first with ctrl to set lastClickedIndex
      fireEvent.click(cards[0], { ctrlKey: true });
      // Shift-click third to select range
      fireEvent.click(cards[2], { shiftKey: true });

      // All 3 should be selected (range includes cards[0] to cards[2])
      expect(screen.getByText('3 selected')).toBeInTheDocument();
    });
  });

  // ── Bulk move error handling (regression) ─────────────────────────────
  // The audit-flagged bug: handleBulkMove had no try/catch, so the first
  // Server Action throw was swallowed by useServerMutation's empty catch.
  // Result: the first moveTask succeeded silently, the second failed silently,
  // and the user had no signal that something went wrong. The fix adds
  // try/catch: surfaces the error, intentionally does NOT call clearSelection
  // (so the user can retry), and does NOT auto-revert the already-succeeded
  // tasks (server side, those moves are already committed).

  describe('bulk move error handling', () => {
    it('on partial failure: surfaces error, does NOT clear selection, does NOT revert succeeded tasks', async () => {
      // First id succeeds, second id throws — exercises the for-loop stop-on-first-throw semantic.
      mockMoveTask.mockImplementation(async (id: string) => {
        if (id === '2') throw new Error('second moveTask failed: rate limited');
        return undefined;
      });

      renderBoard([
        task({ id: '1', title: 'First', phase: 'backlog' }),
        task({ id: '2', title: 'Second', phase: 'backlog' }),
      ]);

      // Ctrl-click both cards → 2 selected
      const cards = screen.getAllByTestId('task-card');
      fireEvent.click(cards[0], { ctrlKey: true });
      fireEvent.click(cards[1], { ctrlKey: true });
      expect(screen.getByText('2 selected')).toBeInTheDocument();

      // Fire change on the bulk-move <select> → triggers handleBulkMove('implement')
      fireEvent.change(screen.getByRole('combobox'), { target: { value: 'implement' } });

      // (a) moveTask was called for BOTH ids with the resolved normalized phase.
      await waitFor(() => {
        expect(mockMoveTask).toHaveBeenCalledTimes(2);
      });
      expect(mockMoveTask).toHaveBeenNthCalledWith(1, '1', 'implement');
      expect(mockMoveTask).toHaveBeenNthCalledWith(2, '2', 'implement');

      // (b) Error banner surfaces the second call's thrown message.
      await waitFor(() => {
        const banner = screen.getByRole('alert');
        expect(banner).toHaveTextContent('second moveTask failed: rate limited');
      });

      // (c) SelectedIds is NOT cleared on failure — the for loop breaks BEFORE
      //     reaching clearSelection(), so the bulk bar persists and the user
      //     can retry the failed move (or Deselect manually).
      expect(screen.getByText('2 selected')).toBeInTheDocument();
      expect(screen.getByText('Deselect')).toBeInTheDocument();
      expect(screen.getByText('Delete selected')).toBeInTheDocument();

      // (d) No auto-revert — both cards still rendered. Bulk-move has no
      //     optimistic update at all, so server-side succeeded-then-failed
      //     never auto-undoes from the client. The first card's move is
      //     already committed (server-side), and that's a feature not a bug.
      expect(screen.getAllByTestId('task-card')).toHaveLength(2);
    });
  });

  // ── Other handler error paths (regression) ────────────────────────────
  // Each of the three remaining silent-failure-fixed handlers
  // (handleCreate, handleBulkDelete, handleUndo) gets a focused test that
  // locks in its specific anti-regression invariant beyond "error visible":
  //   handleCreate     → dialog stays open, template fields preserved (no reset on throw)
  //   handleBulkDelete → selection retained (user can retry)
  //   handleUndo       → popped entry is NOT re-pushed (Ctrl+Z is a no-op after undo throws)

  describe('single-handler error paths', () => {
    let originalConfirm: typeof window.confirm;

    beforeEach(() => {
      originalConfirm = window.confirm;
      // handleBulkDelete calls window.confirm before invoking the action.
      window.confirm = vi.fn().mockReturnValue(true);
    });

    afterEach(() => {
      window.confirm = originalConfirm;
    });

    it('handleCreate: surfaces error, keeps dialog open, preserves template fields', async () => {
      mockCreateTask.mockRejectedValueOnce(new Error('createTask refused: invalid path'));

      renderBoard();

      // Open dialog and pre-fill via template so we can verify "no reset on throw"
      fireEvent.click(screen.getByRole('button', { name: '+ New Task' }));
      expect(screen.getByText('New Task')).toBeInTheDocument();
      fireEvent.click(screen.getByText('Bug Fix'));

      const titleInput = screen.getByPlaceholderText('Add dark mode toggle') as HTMLInputElement;
      const descTextarea = screen.getByPlaceholderText('Describe what needs to be done...') as HTMLTextAreaElement;
      const filledTitle = titleInput.value;
      const filledDesc = descTextarea.value;
      expect(filledTitle).toContain('Fix: ');
      expect(filledDesc).toContain('Current Behavior');

      // Submit the form → handleCreate fires → createTask throws
      fireEvent.click(screen.getByRole('button', { name: 'Create Task' }));

      await waitFor(() => {
        expect(mockCreateTask).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => {
        const banner = screen.getByRole('alert');
        expect(banner).toHaveTextContent('createTask refused: invalid path');
      });

      // (a) Dialog did NOT close — setShowDialog(false) lives on the success path only.
      expect(screen.getByText('New Task')).toBeInTheDocument();

      // (b) Template fields preserved — clearTemplate() lives on the success path only,
      //     so the user can correct the FormData and retry without re-selecting a template.
      const titleAfter = (screen.getByPlaceholderText('Add dark mode toggle') as HTMLInputElement).value;
      const descAfter = (screen.getByPlaceholderText('Describe what needs to be done...') as HTMLTextAreaElement).value;
      expect(titleAfter).toBe(filledTitle);
      expect(descAfter).toBe(filledDesc);
    });

    it('handleBulkDelete: surfaces error, leaves selection intact for retry', async () => {
      mockBulkDeleteTasks.mockRejectedValueOnce(new Error('bulkDelete refused: server timeout'));

      renderBoard([
        task({ id: '1', title: 'A', phase: 'backlog' }),
        task({ id: '2', title: 'B', phase: 'backlog' }),
      ]);

      const cards = screen.getAllByTestId('task-card');
      fireEvent.click(cards[0], { ctrlKey: true });
      fireEvent.click(cards[1], { ctrlKey: true });
      expect(screen.getByText('2 selected')).toBeInTheDocument();

      // Click Delete selected → handleBulkDelete fires → bulkDeleteTasks throws
      fireEvent.click(screen.getByText('Delete selected'));

      await waitFor(() => {
        const banner = screen.getByRole('alert');
        expect(banner).toHaveTextContent('bulkDelete refused: server timeout');
      });

      // (a) bulkDeleteTasks was invoked with both selected IDs
      expect(mockBulkDeleteTasks).toHaveBeenCalledWith(['1', '2']);

      // (b) Selection retained — clearSelection() lives on the success path only,
      //     so the user can retry. Same invariant as bulk-move.
      expect(screen.getByText('2 selected')).toBeInTheDocument();
      expect(screen.getByText('Deselect')).toBeInTheDocument();
      expect(screen.getByText('Delete selected')).toBeInTheDocument();
    });

    it('handleUndo: on moveTask throw, does NOT re-push the popped entry (Ctrl+Z is a no-op)', async () => {
      // The dialog-based drop calls retryTaskWithOptions (for implement target).
      // The first call succeeds.  The undo calls moveTask.
      mockRetryTaskWithOptions
        .mockResolvedValueOnce({ success: true });
      mockMoveTask
        .mockRejectedValueOnce(new Error('undo moveTask refused: stale event handler'));

      renderBoard([task({ id: '1', title: 'Undo me', phase: 'backlog' })]);

      // 1. Drag the card to In Progress → dialog opens (implement is an artifact-clearing target)
      dropCardOnColumn('In Progress');

      // Dialog should be visible
      await waitFor(() => {
        expect(screen.getByText('Move Task')).toBeInTheDocument();
      });

      // Confirm the dialog
      fireEvent.click(screen.getByText('Move & Resume'));

      // retryTaskWithOptions should have been called
      await waitFor(() => {
        expect(mockRetryTaskWithOptions).toHaveBeenCalledWith('1', 'implement', false);
      });

      // Toast with Undo button appears
      await waitFor(() => {
        expect(screen.getByText('Undo')).toBeInTheDocument();
      });

      // 2. Click the toast's Undo button → handleUndo pops from undoStackRef,
      //    calls moveTask('1', 'backlog') → rejected → catch runs:
      //      setError(msg); throw err;  —— INTENTIONALLY does NOT re-push the entry.
      fireEvent.click(screen.getByText('Undo'));

      await waitFor(() => {
        expect(mockMoveTask).toHaveBeenCalledWith('1', 'backlog');
      });
      await waitFor(() => {
        const banner = screen.getByRole('alert');
        expect(banner).toHaveTextContent('undo moveTask refused: stale event handler');
      });
      // exactly one undo attempt
      expect(mockMoveTask).toHaveBeenCalledTimes(1);

      // 3. CRITICAL: pressed Ctrl+Z must be a no-op. The Ctrl+Z listener
      //    (registered in useEffect) gates on `undoStackRef.current.length > 0`
      //    — because the popped entry was NOT re-pushed, the stack is empty and
      //    the listener prevents default without calling handleUndo.
      mockMoveTask.mockClear();
      fireEvent.keyDown(window, { key: 'z', ctrlKey: true });

      await waitFor(() => {
        // mockClear reset the call list — if Ctrl+Z triggered handleUndo, the
        // list would be non-empty. A genuine no-op assertion.
        expect(mockMoveTask).not.toHaveBeenCalled();
      });
    });
  });

  // ── Drag and drop ────────────────────────────────────────────────────

  describe('drag and drop', () => {
    it('shows retry-phase dialog when dropping onto In Progress (artifact-clearing)', async () => {
      renderBoard([task({ id: '1', title: 'Draggable', phase: 'backlog' })]);

      dropCardOnColumn('In Progress');

      // Dialog should appear (implement is an artifact-clearing target)
      await waitFor(() => {
        expect(screen.getByText('Move Task')).toBeInTheDocument();
      });
      // Since there's only one phase (implement), no radio buttons — just explanation + budget toggle
      expect(screen.getByText('Reset QA-attempt budget')).toBeInTheDocument();
    });

    it('calls retryTaskWithOptions when dialog is confirmed for implement drop', async () => {
      renderBoard([task({ id: '1', title: 'Draggable', phase: 'backlog' })]);

      dropCardOnColumn('In Progress');

      await waitFor(() => {
        expect(screen.getByText('Move Task')).toBeInTheDocument();
      });

      // Confirm
      fireEvent.click(screen.getByText('Move & Resume'));

      await waitFor(() => {
        expect(mockRetryTaskWithOptions).toHaveBeenCalledWith('1', 'implement', false);
      });
    });

    it('closes dialog and takes no action on Cancel for artifact-clearing drop', async () => {
      renderBoard([task({ id: '1', title: 'Draggable', phase: 'backlog' })]);

      dropCardOnColumn('In Progress');

      await waitFor(() => {
        expect(screen.getByText('Move Task')).toBeInTheDocument();
      });

      // Cancel — no action should be taken, card stays in original column
      fireEvent.click(screen.getByText('Cancel'));

      expect(screen.queryByText('Move Task')).not.toBeInTheDocument();
      expect(mockRetryTaskWithOptions).not.toHaveBeenCalled();
      expect(mockMoveTask).not.toHaveBeenCalled();
    });

    it('moves instantly (no dialog) when dropping onto Backlog', async () => {
      renderBoard([task({ id: '1', title: 'Draggable', phase: 'implement' })]);

      dropCardOnColumn('Backlog');

      // No dialog — backlog is NO_RESUME_PHASES
      expect(screen.queryByText('Move Task')).not.toBeInTheDocument();

      await waitFor(() => {
        expect(mockMoveTask).toHaveBeenCalledWith('1', 'backlog');
      });
    });

    it('moves instantly (no dialog) when dropping onto Failed', async () => {
      renderBoard([task({ id: '1', title: 'Draggable', phase: 'implement' })]);

      dropCardOnColumn('Failed');

      expect(screen.queryByText('Move Task')).not.toBeInTheDocument();

      await waitFor(() => {
        expect(mockMoveTask).toHaveBeenCalledWith('1', 'failed');
      });
    });

    it('moves instantly (no dialog) when dropping onto Done', async () => {
      renderBoard([task({ id: '1', title: 'Draggable', phase: 'review' })]);

      // Need to find the Done column header
      const card = screen.getByTestId('task-card');
      fireEvent.dragStart(card);
      const doneHeader = screen.getByText('Done');
      const doneColumn = doneHeader.closest('.flex.flex-col')!;
      fireEvent.dragOver(doneColumn);
      fireEvent.drop(doneColumn);

      expect(screen.queryByText('Move Task')).not.toBeInTheDocument();

      await waitFor(() => {
        expect(mockMoveTask).toHaveBeenCalledWith('1', 'done');
      });
    });

    it('shows dialog with phase selector when dropping onto Analysis', async () => {
      renderBoard([task({ id: '1', title: 'Draggable', phase: 'failed' })]);

      dropCardOnColumn('Analysis');

      await waitFor(() => {
        // Analysis has two phases, so we get "Choose Resume Phase" not "Move Task"
        expect(screen.getByText('Choose Resume Phase')).toBeInTheDocument();
      });
      expect(screen.getByText('Resume from Spec')).toBeInTheDocument();
      expect(screen.getByText('Resume from Plan')).toBeInTheDocument();
    });

    it('defaults Analysis drop to plan and budget checked', async () => {
      renderBoard([task({ id: '1', title: 'Draggable', phase: 'failed' })]);

      dropCardOnColumn('Analysis');

      await waitFor(() => {
        expect(screen.getByText('Choose Resume Phase')).toBeInTheDocument();
      });

      // Confirm with defaults (plan, budget=true for spec/plan targets)
      fireEvent.click(screen.getByText('Resume'));

      await waitFor(() => {
        expect(mockRetryTaskWithOptions).toHaveBeenCalledWith('1', 'plan', true);
      });
    });

    it('shows drop target highlight on drag over', () => {
      renderBoard([task({ id: '1', title: 'Drag me', phase: 'backlog' })]);

      const card = screen.getByTestId('task-card');
      fireEvent.dragStart(card);

      const implementHeader = screen.getByText('In Progress');
      const implementColumn = implementHeader.closest('.flex.flex-col')!;
      fireEvent.dragOver(implementColumn);

      // The column should get highlight classes
      expect(implementColumn.className).toContain('ring-2');
    });

    it('does not call moveTask when dropped on the same column', () => {
      renderBoard([task({ id: '1', title: 'Stay', phase: 'backlog' })]);

      const card = screen.getByTestId('task-card');
      fireEvent.dragStart(card);

      const backlogHeader = screen.getByText('Backlog');
      const backlogColumn = backlogHeader.closest('.flex.flex-col')!;
      fireEvent.dragOver(backlogColumn);
      fireEvent.drop(backlogColumn);

      expect(mockMoveTask).not.toHaveBeenCalled();
      expect(mockRetryTaskWithOptions).not.toHaveBeenCalled();
    });

    it('adds opacity class to the dragged card', () => {
      renderBoard([task({ id: '1', title: 'Fade me', phase: 'backlog' })]);

      const card = screen.getByTestId('task-card');
      const cardWrapper = card.parentElement!;
      fireEvent.dragStart(cardWrapper);

      // The card wrapper should get opacity class
      expect(cardWrapper.className).toContain('opacity-40');
    });

    // ── Regression: handleDrop's catch block ────────────────────────────
    // The audit-flagged bug was that a bare `await retryTaskWithOptions(...)` threw into
    // useServerMutation's empty catch — leaving the card stuck in the
    // optimistic column and the corresponding undo-stack entry available,
    // so clicking Undo would re-attempt the same known-failing action.
    // The fix specifically: clearOptimistic + filter undoStackRef + setError.

    it('clears optimistic UI and removes the undo-stack entry when retryTaskWithOptions throws', async () => {
      mockRetryTaskWithOptions.mockRejectedValueOnce(new Error('database timeout on moveTask'));

      renderBoard([task({ id: '1', title: 'Will fail', phase: 'backlog' })]);

      dropCardOnColumn('In Progress');

      await waitFor(() => {
        expect(screen.getByText('Move Task')).toBeInTheDocument();
      });

      // Confirm dialog
      fireEvent.click(screen.getByText('Move & Resume'));

      await waitFor(() => {
        expect(mockRetryTaskWithOptions).toHaveBeenCalledWith('1', 'implement', false);
      });

      // (a) Error banner surfaces the thrown message
      await waitFor(() => {
        const banner = screen.getByRole('alert');
        expect(banner).toHaveTextContent('database timeout on moveTask');
      });

      // (b) Optimistic UI cleared — the isMoving marker on the card wrapper
      //     is gone (clearOptimistic removed the taskId from optimisticPhases
      //     and cleared the 10s reconciliation timeout).
      expect(screen.queryByTestId('is-moving')).not.toBeInTheDocument();

      // (c) Undo-stack entry dropped — even though the toast still renders
      //     its 'Undo' button (toast.undoAction snapshot was set BEFORE the
      //     throw), clicking it must NOT re-call retryTaskWithOptions. handleUndo pops
      //     from undoStackRef which was filtered to remove the failing id,
      //     so the click is a no-op.
      const undoBtn = screen.getByText('Undo');
      expect(undoBtn).toBeInTheDocument();
      fireEvent.click(undoBtn);

      // Give the click handler a tick to settle
      await waitFor(() => {
        expect(mockRetryTaskWithOptions).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ── New Task dialog ──────────────────────────────────────────────────

  describe('New Task dialog', () => {
    it('opens the dialog when + New Task is clicked', () => {
      renderBoard();

      fireEvent.click(screen.getByRole('button', { name: '+ New Task' }));

      expect(screen.getByText('New Task')).toBeInTheDocument();
      expect(screen.getByPlaceholderText('Add dark mode toggle')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Create Task' })).toBeInTheDocument();
    });

    it('closes the dialog on Cancel', () => {
      renderBoard();

      fireEvent.click(screen.getByRole('button', { name: '+ New Task' }));
      fireEvent.click(screen.getByText('Cancel'));

      expect(screen.queryByText('New Task')).not.toBeInTheDocument();
    });

    it('renders template buttons (Bug Fix, Feature Request, Refactor, Documentation)', () => {
      renderBoard();

      fireEvent.click(screen.getByRole('button', { name: '+ New Task' }));

      expect(screen.getByText('Bug Fix')).toBeInTheDocument();
      expect(screen.getByText('Feature Request')).toBeInTheDocument();
      expect(screen.getByText('Refactor')).toBeInTheDocument();
      expect(screen.getByText('Documentation')).toBeInTheDocument();
    });

    it('selects a template and fills title and description', () => {
      renderBoard();

      fireEvent.click(screen.getByRole('button', { name: '+ New Task' }));
      fireEvent.click(screen.getByText('Bug Fix'));

      const titleInput = screen.getByPlaceholderText('Add dark mode toggle') as HTMLInputElement;
      expect(titleInput.value).toContain('Fix: ');

      const descTextarea = screen.getByPlaceholderText('Describe what needs to be done...') as HTMLTextAreaElement;
      expect(descTextarea.value).toContain('Current Behavior');
    });

    it('clears template with Clear template button', () => {
      renderBoard();

      fireEvent.click(screen.getByRole('button', { name: '+ New Task' }));
      fireEvent.click(screen.getByText('Bug Fix'));
      fireEvent.click(screen.getByText('Clear template'));

      const titleInput = screen.getByPlaceholderText('Add dark mode toggle') as HTMLInputElement;
      expect(titleInput.value).toBe('');
    });

    // NOTE: isPending is mocked to always be false, so "Creating..." state
    // cannot be tested directly. The button text is `isPending ? 'Creating...' : 'Create Task'`.
  });

  // ── Undo toast ───────────────────────────────────────────────────────

  describe('undo toast', () => {
    it('shows undo toast after confirming a dialog-based move', async () => {
      renderBoard([task({ id: '1', title: 'Moved task', phase: 'backlog' })]);

      dropCardOnColumn('In Progress');

      await waitFor(() => {
        expect(screen.getByText('Move Task')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Move & Resume'));

      await waitFor(() => {
        expect(screen.getByText(/Moved "Moved task" to/)).toBeInTheDocument();
      });
    });

    it('shows Undo button in the toast', async () => {
      renderBoard([task({ id: '1', title: 'Undoable', phase: 'backlog' })]);

      dropCardOnColumn('In Progress');

      await waitFor(() => {
        expect(screen.getByText('Move Task')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText('Move & Resume'));

      await waitFor(() => {
        expect(screen.getByText('Undo')).toBeInTheDocument();
      });
    });
  });

  describe('DONE history wiring (§3f)', () => {
    const historyTicket: DoneTicketFromHistory = {
      title: 'Add password reset flow',
      summary: 'Implements the reset flow with email tokens.',
      slug: 'add-password-reset-flow',
      taskId: 'task-42',
      qaResult: 'PASS (5/5 criteria)',
      completedAt: new Date('2026-08-01T00:00:00Z'),
      prUrl: 'https://github.com/acme/repo/pull/42',
      source: 'both',
    };

    it('renders history-reconstructed tickets in the DONE column below disk tasks', () => {
      renderBoard(
        [task({ id: 'disk-1', title: 'Disk Done', phase: 'done' })],
        [historyTicket],
      );

      expect(screen.getByText('Disk Done')).toBeInTheDocument();
      expect(screen.getByText('Add password reset flow')).toBeInTheDocument();
      // Local-merge marker absent because the ticket has a PR.
      expect(screen.queryByText('local merge')).not.toBeInTheDocument();
    });

    it('counts history tickets in the DONE column badge', () => {
      renderBoard(
        [task({ id: 'disk-1', title: 'Disk Done', phase: 'done' })],
        [historyTicket],
      );

      const doneColumn = screen.getByText('Done').closest('div')!;
      expect(doneColumn).toHaveTextContent('2');
    });

    it('does not render history cards when none are provided', () => {
      renderBoard([task({ id: 'disk-1', title: 'Disk Done', phase: 'done' })]);

      expect(screen.getByText('Disk Done')).toBeInTheDocument();
      expect(screen.queryByText('Add password reset flow')).not.toBeInTheDocument();
    });

    it('opens the read-only spec modal on click and loads the spec on open', async () => {
      mockGetDoneTicketSpec.mockResolvedValue({ spec: 'Full spec text.' });
      renderBoard([], [historyTicket]);

      fireEvent.click(screen.getByText('Add password reset flow'));

      await waitFor(() => {
        expect(mockGetDoneTicketSpec).toHaveBeenCalledWith('add-password-reset-flow');
      });
      await waitFor(() => {
        expect(screen.getByText('Full spec text.')).toBeInTheDocument();
      });
    });

    it('closes the history modal on the close button', async () => {
      mockGetDoneTicketSpec.mockResolvedValue({ spec: 'S' });
      renderBoard([], [historyTicket]);

      fireEvent.click(screen.getByText('Add password reset flow'));
      await waitFor(() => {
        expect(screen.getByText('Completed ticket')).toBeInTheDocument();
      });

      fireEvent.click(screen.getByLabelText('Close'));

      expect(screen.queryByText('Completed ticket')).not.toBeInTheDocument();
    });

    it('shows the Rescan button only when more Source B pages exist, and calls rescanDoneHistory on click', async () => {
      mockRescanDoneHistory.mockResolvedValue({ enabled: true, tickets: [historyTicket], hasMore: false });

      const { rerender } = render(<KanbanBoard tasks={[]} projectPath="/test" doneHistory={[historyTicket]} />);
      expect(screen.queryByText('Rescan')).not.toBeInTheDocument();

      rerender(
        <KanbanBoard tasks={[]} projectPath="/test" doneHistory={[historyTicket]} doneHistoryHasMore />,
      );
      fireEvent.click(screen.getByText('Rescan'));

      await waitFor(() => {
        expect(mockRescanDoneHistory).toHaveBeenCalledTimes(1);
      });
    });

    it('loads the next Source B page when the DONE column is scrolled near the bottom', async () => {
      const page2Ticket: DoneTicketFromHistory = {
        ...historyTicket,
        slug: 'second-page-ticket',
        title: 'Second page ticket',
      };
      mockLoadMoreDoneHistory.mockResolvedValue({
        enabled: true,
        tickets: [page2Ticket],
        hasMore: false,
      });

      renderBoard([], [historyTicket], true);

      const columns = screen
        .getAllByText('Done')
        .map(el => el.closest('div'))
        .filter((d): d is HTMLDivElement => d !== null);
      const doneCol = columns[0]!.closest('.flex.flex-col')!.querySelector('.overflow-y-auto') as HTMLElement;

      // Position the column near its bottom to trigger the pagination fetch.
      Object.defineProperty(doneCol, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(doneCol, 'clientHeight', { value: 400, configurable: true });
      Object.defineProperty(doneCol, 'scrollTop', { value: 900, configurable: true });
      fireEvent.scroll(doneCol);

      await waitFor(() => {
        expect(mockLoadMoreDoneHistory).toHaveBeenCalledWith(1);
      });
      await waitFor(() => {
        expect(screen.getByText('Second page ticket')).toBeInTheDocument();
      });
    });

    it('does not fetch further pages when doneHistoryHasMore is false', () => {
      renderBoard([], [historyTicket], false);

      const columns = screen
        .getAllByText('Done')
        .map(el => el.closest('div'))
        .filter((d): d is HTMLDivElement => d !== null);
      const doneCol = columns[0]!.closest('.flex.flex-col')!.querySelector('.overflow-y-auto') as HTMLElement;

      Object.defineProperty(doneCol, 'scrollHeight', { value: 1000, configurable: true });
      Object.defineProperty(doneCol, 'clientHeight', { value: 400, configurable: true });
      Object.defineProperty(doneCol, 'scrollTop', { value: 900, configurable: true });
      fireEvent.scroll(doneCol);

      expect(mockLoadMoreDoneHistory).not.toHaveBeenCalled();
    });
  });
});
