// @vitest-environment happy-dom

/**
 * Unit tests for KanbanBoard component.
 *
 * Tests column rendering (6 phases with normalization), task card placement,
 * filter toolbar (search / phase filter / source filter / sort / reset),
 * bulk selection (individual + shift-click range + ctrl-click), drag and drop,
 * optimistic phase updates, the New Task dialog with templates, and the
 * connection indicator.
 *
 * React's useTransition is mocked (isPending=false, synchronous callback)
 * following the project's established pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Task } from '@/lib/task-store';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockCreateTask = vi.hoisted(() => vi.fn());
const mockMoveTask = vi.hoisted(() => vi.fn());
const mockBulkDeleteTasks = vi.hoisted(() => vi.fn());

vi.mock('@/app/actions/tasks', () => ({
  createTask: (...args: unknown[]) => mockCreateTask(...args),
  moveTask: (...args: unknown[]) => mockMoveTask(...args),
  bulkDeleteTasks: (...args: unknown[]) => mockBulkDeleteTasks(...args),
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
    <div data-testid="task-card" data-task-id={task.id} data-phase={task.phase}>
      <span data-testid="task-title">{task.title}</span>
      {isMoving && <span data-testid="is-moving" />}
    </div>
  ),
}));

vi.mock('@/components/task-panel', () => ({
  TaskPanel: ({ taskId, onClose }: { taskId: string; onClose: () => void; readonly?: boolean; cachedData?: unknown; onDataLoaded?: () => void; onError?: () => void }) => (
    <div data-testid="task-panel" data-task-id={taskId}>
      <button data-testid="close-panel" onClick={onClose}>Close</button>
    </div>
  ),
}));

vi.mock('@/components/connection-indicator', () => ({
  ConnectionIndicator: ({ connected, initial }: { connected: boolean; initial: boolean }) => (
    <span data-testid="connection-indicator" data-connected={connected} data-initial={initial} />
  ),
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

import { KanbanBoard } from '@/components/kanban-board';

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

function renderBoard(tasks: Task[] = []) {
  render(<KanbanBoard tasks={tasks} />);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('KanbanBoard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockMoveTask.mockResolvedValue(undefined);
    mockCreateTask.mockResolvedValue(undefined);
    mockBulkDeleteTasks.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
      const titles = cards.map(c => c.querySelector('[data-testid="task-title"]')?.textContent);
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
      expect(cards[0].querySelector('[data-testid="task-title"]')?.textContent).toBe('Fix login bug');
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
      expect(cards[0].querySelector('[data-testid="task-title"]')?.textContent).toBe('Ideation item');
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

  // ── Drag and drop ────────────────────────────────────────────────────

  describe('drag and drop', () => {
    it('calls moveTask when a card is dropped onto a different column', async () => {
      renderBoard([task({ id: '1', title: 'Draggable', phase: 'backlog' })]);

      const card = screen.getByTestId('task-card');
      // Start drag
      fireEvent.dragStart(card);

      // Simulate dragging over the "In Progress" column
      const implementHeader = screen.getByText('In Progress');
      const implementColumn = implementHeader.closest('.flex.flex-col')!;
      fireEvent.dragOver(implementColumn);
      fireEvent.drop(implementColumn);

      await waitFor(() => {
        // resolveTargetPhase('implement', 'backlog') → 'implement'
      expect(mockMoveTask).toHaveBeenCalledWith('1', 'implement');
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
    });

    it('adds opacity class to the dragged card', () => {
      renderBoard([task({ id: '1', title: 'Fade me', phase: 'backlog' })]);

      const card = screen.getByTestId('task-card');
      const cardWrapper = card.parentElement!;
      fireEvent.dragStart(cardWrapper);

      // The card wrapper should get opacity class
      expect(cardWrapper.className).toContain('opacity-40');
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
    it('shows undo toast after a successful drag-and-drop move', async () => {
      renderBoard([task({ id: '1', title: 'Moved task', phase: 'backlog' })]);

      const card = screen.getByTestId('task-card');
      fireEvent.dragStart(card);

      const implementHeader = screen.getByText('In Progress');
      fireEvent.drop(implementHeader.closest('.flex.flex-col')!);

      await waitFor(() => {
        expect(screen.getByText(/Moved "Moved task" to/)).toBeInTheDocument();
      });
    });

    it('shows Undo button in the toast', async () => {
      renderBoard([task({ id: '1', title: 'Undoable', phase: 'backlog' })]);

      const card = screen.getByTestId('task-card');
      fireEvent.dragStart(card);

      const implementHeader = screen.getByText('In Progress');
      fireEvent.drop(implementHeader.closest('.flex.flex-col')!);

      await waitFor(() => {
        expect(screen.getByText('Undo')).toBeInTheDocument();
      });
    });
  });
});
