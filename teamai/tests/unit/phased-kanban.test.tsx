// @vitest-environment happy-dom

/**
 * Unit tests for PhasedKanban component.
 *
 * Tests the phased kanban view: column rendering, empty states, bulk selection,
 * convert/delete flows, linked status fetching, and pagination-aware item display.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RoadmapReport, RoadmapItem } from '@/app/actions/roadmap';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockConvertToTask = vi.fn();
const mockDeleteRoadmapItem = vi.fn();
const mockConvertMultipleToTasks = vi.fn();
const mockGetLinkedTaskStatuses = vi.fn();

vi.mock('@/app/actions/roadmap', () => ({
  convertToTask: ((...args: unknown[]) => mockConvertToTask(...args)) as typeof import('@/app/actions/roadmap').convertToTask,
  deleteRoadmapItem: ((...args: unknown[]) => mockDeleteRoadmapItem(...args)) as typeof import('@/app/actions/roadmap').deleteRoadmapItem,
  convertMultipleToTasks: ((...args: unknown[]) => mockConvertMultipleToTasks(...args)) as typeof import('@/app/actions/roadmap').convertMultipleToTasks,
  getLinkedTaskStatuses: ((...args: unknown[]) => mockGetLinkedTaskStatuses(...args)) as typeof import('@/app/actions/roadmap').getLinkedTaskStatuses,
}));

vi.mock('@/hooks/use-phase-sync', () => ({
  usePhaseSync: vi.fn(),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

// ── Imports ─────────────────────────────────────────────────────────────────

import { PhasedKanban } from '@/components/phased-kanban';

// ── Fixtures ───────────────────────────────────────────────────────────────

function roadItem(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    title: 'Test Item',
    description: 'A test item description.',
    category: 'New Feature',
    priority: 'P1',
    complexity: 3 as RoadmapItem['complexity'],
    source: 'ideation',
    affected_files: [],
    ...overrides,
  } as RoadmapItem;
}

function makeReport(overrides: Partial<RoadmapReport> = {}): RoadmapReport {
  return {
    generated_at: '2025-01-01T00:00:00Z',
    executive_summary: '',
    competitor_analysis_run: false,
    phases: {
      now: [roadItem({ title: 'Now item 1' }), roadItem({ title: 'Now item 2' })],
      next: [roadItem({ title: 'Next item 1' })],
      later: [],
      icebox: [roadItem({ title: 'Icebox item 1' })],
    },
    ...overrides,
  };
}

function renderComponent(
  report: RoadmapReport = makeReport(),
  overrides: {
    filename?: string;
    projectPath?: string;
    onRefresh?: () => void;
    onSelectTask?: () => void;
    onOpenRoadmapItem?: () => void;
  } = {}
) {
  render(
    <PhasedKanban
      report={report}
      filename={overrides.filename ?? 'roadmap-2025-01-01.json'}
      projectPath={overrides.projectPath ?? '/test'}
      onRefresh={overrides.onRefresh ?? vi.fn()}
      onSelectTask={overrides.onSelectTask ?? vi.fn()}
      onOpenRoadmapItem={overrides.onOpenRoadmapItem ?? vi.fn()}
    />
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PhasedKanban', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLinkedTaskStatuses.mockResolvedValue({});
    // Suppress window.confirm
    vi.spyOn(window, 'confirm').mockReturnValue(true);
  });

  // ── Column rendering ──────────────────────────────────────────────────

  describe('column rendering', () => {
    it('renders all 4 phase columns', () => {
      renderComponent();

      expect(screen.getByText('Phase 1 — Now')).toBeInTheDocument();
      expect(screen.getByText('Phase 2 — Next')).toBeInTheDocument();
      expect(screen.getByText('Phase 3 — Later')).toBeInTheDocument();
      expect(screen.getByText('Icebox')).toBeInTheDocument();
    });

    it('shows item count badges in each column', () => {
      renderComponent();

      // Now: 2 items, Next: 1, Later: 0, Icebox: 1
      const badges = screen.getAllByText(/^[0-2]$/);
      expect(badges.length).toBeGreaterThanOrEqual(4);

      // Phase Now has 2 items
      expect(badges[0].textContent).toBe('2');
    });

    it('shows item titles in each column', () => {
      renderComponent();

      expect(screen.getByText('Now item 1')).toBeInTheDocument();
      expect(screen.getByText('Now item 2')).toBeInTheDocument();
      expect(screen.getByText('Next item 1')).toBeInTheDocument();
      expect(screen.getByText('Icebox item 1')).toBeInTheDocument();
    });

    it('shows "No items" for empty columns', () => {
      renderComponent();

      expect(screen.getByText('No items')).toBeInTheDocument();
    });
  });

  // ── Executive summary ─────────────────────────────────────────────────

  describe('executive summary', () => {
    it('renders executive summary when present', () => {
      renderComponent(
        makeReport({ executive_summary: 'This roadmap outlines Q2 goals.' })
      );

      expect(
        screen.getByText('This roadmap outlines Q2 goals.')
      ).toBeInTheDocument();
    });

    it('does not render executive summary when absent', () => {
      renderComponent(makeReport({ executive_summary: undefined }));

      expect(
        screen.queryByText('This roadmap outlines Q2 goals.')
      ).not.toBeInTheDocument();
    });
  });

  // ── Competitor analysis banner ────────────────────────────────────────

  describe('competitor analysis banner', () => {
    it('shows competitor analysis notice when run', () => {
      renderComponent(
        makeReport({
          competitor_analysis_run: true,
          competitors: ['Stripe', 'Paddle'],
        })
      );

      expect(
        screen.getByText(/Competitor analysis was run/)
      ).toBeInTheDocument();
      expect(screen.getByText(/Competitors: Stripe, Paddle/)).toBeInTheDocument();
    });

    it('does not show competitor notice when not run', () => {
      renderComponent(
        makeReport({ competitor_analysis_run: false })
      );

      expect(
        screen.queryByText(/Competitor analysis was run/)
      ).not.toBeInTheDocument();
    });
  });

  // ── Bulk selection ────────────────────────────────────────────────────

  describe('bulk selection', () => {
    it('shows bulk actions bar when items are selected', () => {
      renderComponent();

      // Click checkbox on first unlinked item in "now"
      const checkboxes = screen.getAllByRole('checkbox');
      // First 4 are column-level checkboxes, then item checkboxes
      fireEvent.click(checkboxes[4]); // first item checkbox (Now item 1)

      expect(screen.getByText('Convert Selected')).toBeInTheDocument();
      expect(screen.getByText('Clear')).toBeInTheDocument();
    });

    it('toggles select-all in a phase via the column header checkbox', () => {
      renderComponent();

      // Click the column header checkbox for "Phase 1 — Now" (first checkbox)
      const columnCheckbox = screen.getAllByRole('checkbox')[0];
      fireEvent.click(columnCheckbox);

      expect(screen.getByText('2 items selected')).toBeInTheDocument();
    });
  });

  // ── Convert flow ──────────────────────────────────────────────────────

  describe('convert flow', () => {
    it('calls convertToTask when "+ Convert to ticket" is clicked', async () => {
      mockConvertToTask.mockResolvedValue(undefined);
      const onRefresh = vi.fn();
      renderComponent(makeReport(), { onRefresh });

      // Click the "+ Convert to ticket" on the first unlinked card
      const convertBtns = screen.getAllByText('+ Convert to ticket');
      fireEvent.click(convertBtns[0]);

      await waitFor(() => {
        expect(mockConvertToTask).toHaveBeenCalled();
      });
    });

    it('shows "Converting…" while conversion is in progress', () => {
      renderComponent();

      const convertBtns = screen.getAllByText('+ Convert to ticket');
      fireEvent.click(convertBtns[0]);

      expect(screen.getByText('Converting…')).toBeInTheDocument();
    });
  });

  // ── Delete flow ───────────────────────────────────────────────────────

  describe('delete flow', () => {
    it('shows "…" while deletion is in progress', () => {
      mockDeleteRoadmapItem.mockReturnValue(new Promise(() => {}));
      renderComponent();

      // Click the ✕ delete button on first card
      const deleteBtns = screen.getAllByText('✕');
      fireEvent.click(deleteBtns[0]);

      expect(screen.getByText('…')).toBeInTheDocument();
    });
  });

  // ── Linked status fetching ────────────────────────────────────────────

  describe('linked status fetching', () => {
    it('fetches linked task statuses on mount when linked items exist', () => {
      const report = makeReport();
      report.phases.now[0] = roadItem({
        ...report.phases.now[0],
        linkedTaskId: 'task-linked',
      });

      renderComponent(report);

      expect(mockGetLinkedTaskStatuses).toHaveBeenCalledWith(['task-linked']);
    });

    it('does not fetch statuses when no linked items exist', () => {
      renderComponent(makeReport());

      // No items have linkedTaskId, so should not call
      expect(mockGetLinkedTaskStatuses).not.toHaveBeenCalled();
    });
  });

  // ── Empty report ──────────────────────────────────────────────────────

  describe('empty report', () => {
    it('renders all columns with 0 items each', () => {
      renderComponent(
        makeReport({
          phases: { now: [], next: [], later: [], icebox: [] },
        })
      );

      // All four columns should show "No items"
      const noItems = screen.getAllByText('No items');
      expect(noItems.length).toBe(4);
    });
  });
});
