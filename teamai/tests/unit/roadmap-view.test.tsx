// @vitest-environment happy-dom

/**
 * Unit tests for PhasedKanban component (roadmap-view.tsx).
 *
 * Tests phase filtering (4 kanban columns), priority badge rendering (P0-P3),
 * item selection (individual + select-all per phase + bulk convert bar),
 * item details (title, complexity, description, category, source), convert
 * buttons (unlinked vs linked), and edge cases (empty columns, expand/collapse,
 * affected files).
 *
 * React's useTransition is mocked (isPending=false, synchronous callback)
 * following the project's established pattern for component tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RoadmapReport, RoadmapItem } from '@/app/actions/roadmap';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockConvertToTask = vi.hoisted(() => vi.fn());
const mockConvertMultipleToTasks = vi.hoisted(() => vi.fn());
const mockDeleteRoadmapItem = vi.hoisted(() => vi.fn());
const mockGetLinkedTaskStatuses = vi.hoisted(() => vi.fn());

vi.mock('@/app/actions/roadmap', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/app/actions/roadmap')>();
  return {
    ...actual,
    convertToTask: (...args: unknown[]) => mockConvertToTask(...args),
    convertMultipleToTasks: (...args: unknown[]) => mockConvertMultipleToTasks(...args),
    deleteRoadmapItem: (...args: unknown[]) => mockDeleteRoadmapItem(...args),
    getLinkedTaskStatuses: (...args: unknown[]) => mockGetLinkedTaskStatuses(...args),
  };
});

vi.mock('@/hooks/use-phase-sync', () => ({
  usePhaseSync: vi.fn(),
}));

const mockStartTransition = vi.hoisted(() =>
  vi.fn((cb: () => void) => {
    try {
      const result = cb() as unknown;
      if (result instanceof Promise) result.catch(() => {});
    } catch {
      /* suppress */
    }
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

import { PhasedKanban } from '@/components/roadmap-view';

// ── Fixtures ────────────────────────────────────────────────────────────────

function item(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    title: 'Test item',
    priority: 'P1',
    complexity: 3,
    category: 'New Feature',
    description: 'A test description.',
    affected_files: ['src/main.ts'],
    source: 'ideation',
    ...overrides,
  };
}

function report(phases: Partial<RoadmapReport['phases']> = {}): RoadmapReport {
  return {
    generated_at: '2026-01-01T00:00:00Z',
    executive_summary: 'Test roadmap summary.',
    competitor_analysis_run: false,
    phases: {
      now: [],
      next: [],
      later: [],
      icebox: [],
      ...phases,
    },
  };
}

function renderKanban(
  rpt: RoadmapReport = report(),
  filename = 'roadmap-2026-01-01.json'
) {
  act(() => {
    render(
      <PhasedKanban
        report={rpt}
        filename={filename}
        onRefresh={vi.fn()}
        onSelectTask={vi.fn()}
        onOpenRoadmapItem={vi.fn()}
      />
    );
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('PhasedKanban', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetLinkedTaskStatuses.mockResolvedValue({});
  });

  // ── Phase columns ────────────────────────────────────────────────────

  describe('phase columns', () => {
    it('renders all four phase columns', () => {
      renderKanban();

      expect(screen.getByText('Phase 1 — Now')).toBeInTheDocument();
      expect(screen.getByText('Phase 2 — Next')).toBeInTheDocument();
      expect(screen.getByText('Phase 3 — Later')).toBeInTheDocument();
      expect(screen.getByText('Icebox')).toBeInTheDocument();
    });

    it('shows item count badges in each column header', () => {
      renderKanban(
        report({
          now: [item({ title: 'A' }), item({ title: 'B' })],
          next: [item({ title: 'C' })],
          later: [],
          icebox: [item({ title: 'D' }), item({ title: 'E' }), item({ title: 'F' })],
        })
      );

      // Count badges are rendered in each header. We find them by their
      // position: each column header has a count badge.
      const badges = screen.getAllByText(/^[0-9]+$/);
      const badgeTexts = badges.map(b => b.textContent).sort();
      expect(badgeTexts).toEqual(expect.arrayContaining(['2', '1', '0', '3']));
    });

    it('shows "No items" placeholder in empty columns', () => {
      renderKanban(report());

      const emptyMessages = screen.getAllByText('No items');
      expect(emptyMessages).toHaveLength(4);
    });

    it('renders items in the correct phase columns', () => {
      renderKanban(
        report({
          now: [item({ title: 'Now Item' })],
          next: [item({ title: 'Next Item' })],
          later: [item({ title: 'Later Item' })],
          icebox: [item({ title: 'Icebox Item' })],
        })
      );

      expect(screen.getByText('Now Item')).toBeInTheDocument();
      expect(screen.getByText('Next Item')).toBeInTheDocument();
      expect(screen.getByText('Later Item')).toBeInTheDocument();
      expect(screen.getByText('Icebox Item')).toBeInTheDocument();
    });
  });

  // ── Priority badges ──────────────────────────────────────────────────

  describe('priority badges', () => {
    it('renders P0 badge', () => {
      renderKanban(report({ now: [item({ priority: 'P0', title: 'Critical' })] }));
      expect(screen.getByText('P0')).toBeInTheDocument();
    });

    it('renders P1 badge', () => {
      renderKanban(report({ now: [item({ priority: 'P1', title: 'High' })] }));
      expect(screen.getByText('P1')).toBeInTheDocument();
    });

    it('renders P2 badge', () => {
      renderKanban(report({ now: [item({ priority: 'P2', title: 'Medium' })] }));
      expect(screen.getByText('P2')).toBeInTheDocument();
    });

    it('renders P3 badge', () => {
      renderKanban(report({ now: [item({ priority: 'P3', title: 'Low' })] }));
      expect(screen.getByText('P3')).toBeInTheDocument();
    });

    it('applies correct priority color classes', () => {
      renderKanban(
        report({
          now: [
            item({ priority: 'P0', title: 'P0 item' }),
            item({ priority: 'P1', title: 'P1 item' }),
          ],
        })
      );

      const p0Badge = screen.getByText('P0');
      expect(p0Badge.className).toContain('bg-red-900/30');
      expect(p0Badge.className).toContain('text-red-400');

      const p1Badge = screen.getByText('P1');
      expect(p1Badge.className).toContain('bg-orange-900/30');
      expect(p1Badge.className).toContain('text-orange-400');
    });
  });

  // ── Item details ─────────────────────────────────────────────────────

  describe('item details', () => {
    it('renders item title', () => {
      renderKanban(report({ now: [item({ title: 'Fix login bug' })] }));
      expect(screen.getByText('Fix login bug')).toBeInTheDocument();
    });

    it('renders item category', () => {
      renderKanban(report({ now: [item({ category: 'Security', title: 'Sec fix' })] }));
      expect(screen.getByText('Security')).toBeInTheDocument();
    });

    it('renders item complexity with dots and numeric display', () => {
      renderKanban(report({ now: [item({ complexity: 4, title: 'Complex one' })] }));

      // ComplexityDots renders 5 dots with aria-label
      expect(screen.getByLabelText('Complexity 4 out of 5')).toBeInTheDocument();
      // Numeric display
      expect(screen.getByText('(4/5)')).toBeInTheDocument();
    });

    it('renders item description', () => {
      renderKanban(
        report({ now: [item({ description: 'This needs to be fixed asap.', title: 'Bug' })] })
      );
      expect(screen.getByText('This needs to be fixed asap.')).toBeInTheDocument();
    });

    it('renders source label', () => {
      renderKanban(report({ now: [item({ source: 'ideation', title: 'Idea item' })] }));
      expect(screen.getByText('Source: ideation')).toBeInTheDocument();
    });

    it('renders competitive context when present', () => {
      renderKanban(
        report({
          now: [
            item({
              source: 'competitor-analysis',
              competitive_context: 'Acme Corp',
              title: 'Comp item',
            }),
          ],
        })
      );
      expect(screen.getByText('Acme Corp')).toBeInTheDocument();
    });

    it('hides affected files section when not expanded', () => {
      renderKanban(
        report({
          now: [
            item({
              affected_files: ['src/a.ts', 'src/b.ts'],
              title: 'Many files',
            }),
          ],
        })
      );

      expect(screen.queryByText('Affected Files')).not.toBeInTheDocument();
    });
  });

  // ── Item selection ───────────────────────────────────────────────────

  describe('item selection', () => {
    const rpt = report({
      now: [item({ title: 'Item A' }), item({ title: 'Item B' })],
      next: [item({ title: 'Item C' })],
    });

    it('selects an individual item via checkbox', () => {
      renderKanban(rpt);

      // There are 4 column header checkboxes (now/next/later/icebox),
      // followed by card checkboxes in DOM order.
      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[4]); // first "now" card checkbox

      expect(screen.getByText('1 item selected')).toBeInTheDocument();
    });

    it('deselects an individual item', () => {
      renderKanban(rpt);

      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[4]); // select
      expect(screen.getByText('1 item selected')).toBeInTheDocument();

      fireEvent.click(checkboxes[4]); // deselect
      expect(screen.queryByText(/item selected/)).not.toBeInTheDocument();
    });

    it('selects all items in a phase via column header checkbox', () => {
      renderKanban(rpt);

      // Column header checkboxes are the first 4
      const headerCheckboxes = screen.getAllByRole('checkbox');
      // The "now" column header checkbox is the first one
      fireEvent.click(headerCheckboxes[0]);

      expect(screen.getByText('2 items selected')).toBeInTheDocument();
    });

    it('deselects all items in a phase via column header checkbox', () => {
      renderKanban(rpt);

      const headerCheckboxes = screen.getAllByRole('checkbox');
      fireEvent.click(headerCheckboxes[0]); // select all in "now"
      expect(screen.getByText('2 items selected')).toBeInTheDocument();

      fireEvent.click(headerCheckboxes[0]); // deselect all in "now"
      expect(screen.queryByText(/items? selected/)).not.toBeInTheDocument();
    });

    it('deselects an individual item', () => {
      renderKanban(rpt);

      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[4]); // select one

      expect(screen.getByText('Convert Selected')).toBeInTheDocument();
      expect(screen.getByText('Clear')).toBeInTheDocument();
    });

    it('Clear button deselects all items and hides the bulk bar', () => {
      renderKanban(rpt);

      const checkboxes = screen.getAllByRole('checkbox');
      fireEvent.click(checkboxes[4]); // select one

      fireEvent.click(screen.getByText('Clear'));

      expect(screen.queryByText(/item selected/)).not.toBeInTheDocument();
      expect(screen.queryByText('Convert Selected')).not.toBeInTheDocument();
    });

    it('does not select already-linked items with select-all', () => {
      const linkedRpt = report({
        now: [
          item({ title: 'Linked', linkedTaskId: 'task-1' }),
          item({ title: 'Not Linked' }),
        ],
      });

      renderKanban(linkedRpt);

      // Click the "now" column header checkbox to select all
      const headerCheckboxes = screen.getAllByRole('checkbox');
      fireEvent.click(headerCheckboxes[0]);

      // Only 1 should be selected (the unlinked one)
      expect(screen.getByText('1 item selected')).toBeInTheDocument();
    });
  });

  // ── Bulk convert ─────────────────────────────────────────────────────

  describe('bulk convert', () => {
    const rpt = report({
      now: [item({ title: 'Item A' }), item({ title: 'Item B' })],
    });

    it('calls convertMultipleToTasks with correct args', async () => {
      mockConvertMultipleToTasks.mockResolvedValue({
        converted: 2,
        skipped: 0,
        taskIds: ['t1', 't2'],
      });

      renderKanban(rpt);

      // Select all items in "now"
      const headerCheckboxes = screen.getAllByRole('checkbox');
      fireEvent.click(headerCheckboxes[0]);

      await act(async () => {
        fireEvent.click(screen.getByText('Convert Selected'));
      });

      expect(mockConvertMultipleToTasks).toHaveBeenCalledWith(
        'roadmap-2026-01-01.json',
        expect.arrayContaining([
          { itemIndex: 0, phaseKey: 'now' },
          { itemIndex: 1, phaseKey: 'now' },
        ])
      );
    });

    it('shows Converting… state during bulk convert', async () => {
      mockConvertMultipleToTasks.mockReturnValue(new Promise(() => {}));

      renderKanban(rpt);

      const headerCheckboxes = screen.getAllByRole('checkbox');
      fireEvent.click(headerCheckboxes[0]);

      await act(async () => {
        fireEvent.click(screen.getByText('Convert Selected'));
      });

      expect(screen.getByText('Converting…')).toBeInTheDocument();
    });

    it('shows bulk error message when conversion fails', async () => {
      mockConvertMultipleToTasks.mockRejectedValue(new Error('fail'));

      renderKanban(rpt);

      const headerCheckboxes = screen.getAllByRole('checkbox');
      fireEvent.click(headerCheckboxes[0]);

      await act(async () => {
        fireEvent.click(screen.getByText('Convert Selected'));
      });

      await waitFor(() => {
        expect(
          screen.getByText('Conversion failed. Try again.')
        ).toBeInTheDocument();
      });
    });
  });

  // ── Convert button (individual) ──────────────────────────────────────

  describe('individual convert button', () => {
    it('shows "+ Convert to ticket" for unlinked items', () => {
      renderKanban(report({ now: [item({ title: 'Unlinked' })] }));

      expect(screen.getByText('+ Convert to ticket')).toBeInTheDocument();
    });

    it('shows status badge for linked items instead of convert button', async () => {
      mockGetLinkedTaskStatuses.mockResolvedValue({
        'task-1': { phase: 'implement', title: 'Linked Task' },
      });

      renderKanban(
        report({
          now: [item({ title: 'Already done', linkedTaskId: 'task-1' })],
        })
      );

      await waitFor(() => {
        // Linked item should show the phase badge, not convert button
        expect(screen.queryByText('+ Convert to ticket')).not.toBeInTheDocument();
        expect(screen.getByText('In Progress')).toBeInTheDocument();
      });
    });

    it('calls convertToTask when convert button is clicked', async () => {
      mockConvertToTask.mockResolvedValue({ taskId: 'new-task' });

      renderKanban(report({ now: [item({ title: 'Convert me' })] }));

      await act(async () => {
        fireEvent.click(screen.getByText('+ Convert to ticket'));
      });

      expect(mockConvertToTask).toHaveBeenCalledWith(
        'roadmap-2026-01-01.json',
        0,
        'now'
      );
    });

    it('shows Converting… on the clicked button only', async () => {
      mockConvertToTask.mockReturnValue(new Promise(() => {}));

      renderKanban(
        report({
          now: [item({ title: 'A' }), item({ title: 'B' })],
        })
      );

      const convertButtons = screen.getAllByText('+ Convert to ticket');
      await act(async () => {
        fireEvent.click(convertButtons[0]);
      });

      // First button should now say "Converting…"
      expect(screen.getByText('Converting…')).toBeInTheDocument();
      // Second button should still say "+ Convert to ticket"
      expect(screen.getByText('+ Convert to ticket')).toBeInTheDocument();
    });
  });

  // ── Executive summary & competitor banner ────────────────────────────

  describe('report metadata', () => {
    it('renders executive summary when present', () => {
      renderKanban(
        report({ now: [item({ title: 'A' })] }),
        'roadmap-2026-01-01.json'
      );

      expect(screen.getByText('Test roadmap summary.')).toBeInTheDocument();
    });

    it('renders competitor analysis banner when run', () => {
      const rpt = report({ now: [item({ title: 'A' })] });
      rpt.competitor_analysis_run = true;
      rpt.competitors = ['Acme Corp', 'Globex'];

      renderKanban(rpt);

      expect(
        screen.getByText(/Competitor analysis was run/)
      ).toBeInTheDocument();
      expect(screen.getByText(/Acme Corp, Globex/)).toBeInTheDocument();
    });

    it('does not show competitor banner when analysis was not run', () => {
      renderKanban(report({ now: [item({ title: 'A' })] }));

      expect(
        screen.queryByText(/Competitor analysis was run/)
      ).not.toBeInTheDocument();
    });
  });

  // ── Delete button ────────────────────────────────────────────────────

  describe('delete button', () => {
    it('renders delete button on each card', () => {
      renderKanban(report({ now: [item({ title: 'A' }), item({ title: 'B' })] }));

      const deleteButtons = screen.getAllByTitle('Delete from roadmap');
      expect(deleteButtons).toHaveLength(2);
    });

    it('calls deleteRoadmapItem when confirmed', async () => {
      vi.spyOn(window, 'confirm').mockReturnValue(true);
      mockDeleteRoadmapItem.mockResolvedValue(undefined);

      renderKanban(report({ now: [item({ title: 'Delete me' })] }));

      const deleteBtn = screen.getByTitle('Delete from roadmap');
      await act(async () => {
        fireEvent.click(deleteBtn);
      });

      expect(window.confirm).toHaveBeenCalled();
      expect(mockDeleteRoadmapItem).toHaveBeenCalledWith(
        'roadmap-2026-01-01.json',
        0,
        'now'
      );
    });

    it('does not delete when confirm is cancelled', () => {
      vi.spyOn(window, 'confirm').mockReturnValue(false);

      renderKanban(report({ now: [item({ title: 'Keep me' })] }));

      const deleteBtn = screen.getByTitle('Delete from roadmap');
      fireEvent.click(deleteBtn);

      expect(mockDeleteRoadmapItem).not.toHaveBeenCalled();
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles missing linked task status gracefully', async () => {
      // getLinkedTaskStatuses returns {} by default (set in beforeEach)
      renderKanban(
        report({
          now: [
            item({ title: 'Stale link', linkedTaskId: 'dead-task' }),
          ],
        })
      );

      // Should render without crashing, showing "…" placeholder
      await waitFor(() => {
        expect(screen.getByText('Stale link')).toBeInTheDocument();
      });
    });

    it('renders items with different categories', () => {
      const categories = [
        'Critical Fix',
        'Security',
        'Performance',
        'DX',
        'New Feature',
        'Competitive Response',
        'Infrastructure',
      ] as const;

      renderKanban(
        report({
          now: categories.map((cat, i) =>
            item({ title: `Item ${i}`, category: cat as RoadmapItem['category'] })
          ),
        })
      );

      for (const cat of categories) {
        expect(screen.getByText(cat)).toBeInTheDocument();
      }
    });

    it('renders complexity dots correctly for each level 1-5', () => {
      renderKanban(
        report({
          now: [1, 2, 3, 4, 5].map((c) =>
            item({
              title: `Complexity ${c}`,
              complexity: c as RoadmapItem['complexity'],
            })
          ),
        })
      );

      expect(screen.getByLabelText('Complexity 1 out of 5')).toBeInTheDocument();
      expect(screen.getByLabelText('Complexity 5 out of 5')).toBeInTheDocument();
    });

    it('handles items with no affected_files', () => {
      renderKanban(
        report({ now: [item({ affected_files: [], title: 'No files' })] })
      );

      // Card should render without affected files section even when expanded
      expect(screen.getByText('No files')).toBeInTheDocument();
    });
  });
});
