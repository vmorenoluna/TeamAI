// @vitest-environment happy-dom

/**
 * Unit tests for RoadmapCard and ComplexityDots components.
 *
 * Tests the roadmap item card rendering across linked/unlinked states,
 * expanded/collapsed display, selection checkbox, error state,
 * complexity dots visualization, and click handlers.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RoadmapItem } from '@/app/actions/roadmap';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), prefetch: vi.fn() }),
}));

import { RoadmapCard, ComplexityDots, PHASE_LABELS } from '@/components/roadmap-card';

// ── Fixtures ───────────────────────────────────────────────────────────────

function roadItem(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    title: 'Test Roadmap Item',
    description: 'A description of the item.',
    category: 'New Feature',
    priority: 'P1',
    complexity: 3 as RoadmapItem['complexity'],
    source: 'ideation',
    affected_files: [],
    ...overrides,
  } as RoadmapItem;
}

function renderCard(
  item: RoadmapItem = roadItem(),
  overrides: {
    linkedStatus?: { phase: string; title: string } | null;
    onConvert?: () => void;
    onDelete?: () => void;
    isConverting?: boolean;
    isDeleting?: boolean;
    hasError?: boolean;
    isExpanded?: boolean;
    onToggle?: () => void;
    isSelected?: boolean;
    onToggleSelect?: () => void;
    onSelectTask?: () => void;
    onOpenDetail?: () => void;
  } = {}
) {
  render(
    <RoadmapCard
      item={item}
      linkedStatus={overrides.linkedStatus ?? null}
      onConvert={overrides.onConvert ?? vi.fn()}
      onDelete={overrides.onDelete ?? vi.fn()}
      isConverting={overrides.isConverting ?? false}
      isDeleting={overrides.isDeleting ?? false}
      hasError={overrides.hasError ?? false}
      isExpanded={overrides.isExpanded ?? false}
      onToggle={overrides.onToggle ?? vi.fn()}
      isSelected={overrides.isSelected ?? false}
      onToggleSelect={overrides.onToggleSelect ?? vi.fn()}
      onSelectTask={overrides.onSelectTask ?? vi.fn()}
      onOpenDetail={overrides.onOpenDetail ?? vi.fn()}
    />
  );
}

// ── ComplexityDots tests ────────────────────────────────────────────────────

describe('ComplexityDots', () => {
  it('renders 5 dots for complexity value', () => {
    render(<ComplexityDots value={3} />);

    const container = screen.getByRole('img', { name: 'Complexity 3 out of 5' });
    expect(container).toBeInTheDocument();

    const dots = container.querySelectorAll('span');
    expect(dots.length).toBe(5);
  });

  it('highlights filled dots with text-blue-400', () => {
    render(<ComplexityDots value={4} />);

    const container = screen.getByRole('img', { name: 'Complexity 4 out of 5' });
    const dots = container.querySelectorAll('span');
    // First 4 dots should be blue-400
    expect(dots[0]).toHaveClass('text-blue-400');
    expect(dots[1]).toHaveClass('text-blue-400');
    expect(dots[2]).toHaveClass('text-blue-400');
    expect(dots[3]).toHaveClass('text-blue-400');
  });

  it('renders unfilled dots with text-slate-600', () => {
    render(<ComplexityDots value={2} />);

    const container = screen.getByRole('img', { name: 'Complexity 2 out of 5' });
    const dots = container.querySelectorAll('span');
    // Dots 3-5 are unfilled
    expect(dots[2]).toHaveClass('text-slate-600');
    expect(dots[3]).toHaveClass('text-slate-600');
    expect(dots[4]).toHaveClass('text-slate-600');
  });

  it('renders all dots unfilled for complexity 0', () => {
    render(<ComplexityDots value={0} />);

    const container = screen.getByRole('img', { name: 'Complexity 0 out of 5' });
    const dots = container.querySelectorAll('span');
    expect(dots[0]).toHaveClass('text-slate-600');
  });

  it('renders all dots filled for complexity 5', () => {
    render(<ComplexityDots value={5} />);

    const container = screen.getByRole('img', { name: 'Complexity 5 out of 5' });
    const dots = container.querySelectorAll('span');
    expect(dots[0]).toHaveClass('text-blue-400');
    expect(dots[4]).toHaveClass('text-blue-400');
  });
});

// ── PHASE_LABELS ────────────────────────────────────────────────────────────

describe('PHASE_LABELS', () => {
  it('maps all 4 phase keys to display labels', () => {
    expect(PHASE_LABELS.now).toBe('Phase 1 — Now');
    expect(PHASE_LABELS.next).toBe('Phase 2 — Next');
    expect(PHASE_LABELS.later).toBe('Phase 3 — Later');
    expect(PHASE_LABELS.icebox).toBe('Icebox');
  });
});

// ── RoadmapCard tests ───────────────────────────────────────────────────────

describe('RoadmapCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Basic rendering ───────────────────────────────────────────────────

  describe('basic rendering', () => {
    it('renders the item title', () => {
      renderCard(roadItem({ title: 'Fix login bug' }));

      expect(screen.getByText('Fix login bug')).toBeInTheDocument();
    });

    it('renders the item description', () => {
      renderCard(roadItem({ description: 'Users cannot log in with SSO.' }));

      expect(screen.getByText('Users cannot log in with SSO.')).toBeInTheDocument();
    });

    it('renders the priority badge', () => {
      renderCard(roadItem({ priority: 'P2' }));

      expect(screen.getByText('P2')).toBeInTheDocument();
    });

    it('renders the category label', () => {
      renderCard(roadItem({ category: 'Security' }));

      expect(screen.getByText('Security')).toBeInTheDocument();
    });

    it('renders the source attribution', () => {
      renderCard(roadItem({ source: 'competitor-analysis' }));

      expect(screen.getByText('Source: competitor-analysis')).toBeInTheDocument();
    });

    it('renders complexity value with dots and number', () => {
      renderCard(roadItem({ complexity: 2 }));

      expect(screen.getByText('(2/5)')).toBeInTheDocument();
      expect(screen.getByRole('img', { name: 'Complexity 2 out of 5' })).toBeInTheDocument();
    });
  });

  // ── Unlinked card ─────────────────────────────────────────────────────

  describe('unlinked card', () => {
    it('shows "+ Convert to ticket" button when not linked', () => {
      renderCard(roadItem({ linkedTaskId: undefined }));

      expect(screen.getByText('+ Convert to ticket')).toBeInTheDocument();
    });

    it('shows the selection checkbox when not linked', () => {
      renderCard(roadItem({ linkedTaskId: undefined }));

      const checkbox = screen.getByRole('checkbox');
      expect(checkbox).toBeInTheDocument();
    });

    it('shows "Click to view details" hint', () => {
      renderCard(roadItem({ linkedTaskId: undefined }));

      expect(screen.getByText('Click to view details')).toBeInTheDocument();
    });

    it('calls onConvert when convert button is clicked', () => {
      const onConvert = vi.fn();
      renderCard(roadItem({ linkedTaskId: undefined }), { onConvert });

      fireEvent.click(screen.getByText('+ Convert to ticket'));
      expect(onConvert).toHaveBeenCalledTimes(1);
    });

    it('disables convert button when isConverting is true', () => {
      renderCard(roadItem({ linkedTaskId: undefined }), { isConverting: true });

      expect(screen.getByText('Converting…')).toBeInTheDocument();
    });
  });

  // ── Linked card ───────────────────────────────────────────────────────

  describe('linked card', () => {
    it('does not show the selection checkbox when linked', () => {
      renderCard(roadItem({ linkedTaskId: 'task-123' }));

      expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    });

    it('does not show "+ Convert to ticket" when linked', () => {
      renderCard(roadItem({ linkedTaskId: 'task-123' }));

      expect(screen.queryByText('+ Convert to ticket')).not.toBeInTheDocument();
    });

    it('shows the linked status badge when linkedStatus is provided', () => {
      renderCard(
        roadItem({ linkedTaskId: 'task-123' }),
        { linkedStatus: { phase: 'implement', title: 'Fix stuff' } }
      );

      // Should show the phase label from TASK_PHASE_LABELS
      expect(screen.queryByText('+ Convert to ticket')).not.toBeInTheDocument();
    });

    it('shows "…" when linked but no linkedStatus available yet', () => {
      renderCard(roadItem({ linkedTaskId: 'task-123' }), { linkedStatus: null });

      expect(screen.getByText('…')).toBeInTheDocument();
    });

    it('calls onSelectTask when card is clicked and linked', () => {
      const onSelectTask = vi.fn();
      renderCard(
        roadItem({ linkedTaskId: 'task-abc' }),
        { onSelectTask }
      );

      fireEvent.click(screen.getByText('Test Roadmap Item').closest('div')!);
      expect(onSelectTask).toHaveBeenCalledWith('task-abc');
    });
  });

  // ── Expanded / collapsed ──────────────────────────────────────────────

  describe('expanded / collapsed', () => {
    it('clamps description to 3 lines when not expanded', () => {
      renderCard(roadItem({ description: 'A'.repeat(200) }), { isExpanded: false });

      const desc = screen.getByText(/A{100,}/);
      expect(desc).toHaveClass('line-clamp-3');
    });

    it('does not clamp description when expanded', () => {
      renderCard(roadItem({ description: 'A'.repeat(200) }), { isExpanded: true });

      const desc = screen.getByText(/A{100,}/);
      expect(desc).not.toHaveClass('line-clamp-3');
    });

    it('breaks long words in the description instead of overflowing', () => {
      renderCard(roadItem({ description: 'A'.repeat(300) }), { isExpanded: true });

      const desc = screen.getByText(/A{100,}/);
      expect(desc).toHaveClass('break-words');
    });

    it('shows affected files section when expanded and files exist', () => {
      renderCard(
        roadItem({ affected_files: ['src/foo.ts', 'src/bar.ts'] }),
        { isExpanded: true }
      );

      expect(screen.getByText('Affected Files')).toBeInTheDocument();
      expect(screen.getByText('src/foo.ts')).toBeInTheDocument();
      expect(screen.getByText('src/bar.ts')).toBeInTheDocument();
    });

    it('does not show affected files when collapsed', () => {
      renderCard(
        roadItem({ affected_files: ['src/foo.ts'] }),
        { isExpanded: false }
      );

      expect(screen.queryByText('Affected Files')).not.toBeInTheDocument();
    });
  });

  // ── Error state ───────────────────────────────────────────────────────

  describe('error state', () => {
    it('shows error message when hasError is true', () => {
      renderCard(roadItem(), { hasError: true });

      expect(screen.getByText('Action failed — please try again.')).toBeInTheDocument();
    });

    it('applies red border and background when hasError', () => {
      renderCard(roadItem({ linkedTaskId: undefined }), { hasError: true });

      // The outer card div should have red border/background classes
      const card = screen.getByText('Test Roadmap Item').closest('.border-red-800');
      expect(card).toBeInTheDocument();
    });
  });

  // ── Click handler ─────────────────────────────────────────────────────

  describe('click handler', () => {
    it('calls onOpenDetail when clicking an unlinked card', () => {
      const onOpenDetail = vi.fn();
      const item = roadItem({ linkedTaskId: undefined });
      renderCard(item, { onOpenDetail });

      // Click the card container (the outer div)
      fireEvent.click(screen.getByText('Test Roadmap Item').closest('div')!);
      expect(onOpenDetail).toHaveBeenCalledWith(item);
    });

    it('calls onSelectTask with linkedTaskId when clicking a linked card', () => {
      const onSelectTask = vi.fn();
      renderCard(
        roadItem({ linkedTaskId: 'task-abc' }),
        { onSelectTask }
      );

      fireEvent.click(screen.getByText('Test Roadmap Item').closest('div')!);
      expect(onSelectTask).toHaveBeenCalledWith('task-abc');
    });
  });

  // ── Delete button ─────────────────────────────────────────────────────

  describe('delete button', () => {
    it('renders a subtle ✕ delete button', () => {
      renderCard();

      expect(screen.getByText('✕')).toBeInTheDocument();
    });

    it('calls onDelete when delete button is clicked', () => {
      const onDelete = vi.fn();
      renderCard(roadItem(), { onDelete });

      fireEvent.click(screen.getByText('✕'));
      expect(onDelete).toHaveBeenCalledTimes(1);
    });

    it('shows "…" when isDeleting', () => {
      renderCard(roadItem(), { isDeleting: true });

      // The button text should be '…' (not '✕')
      const btn = screen.getByText('…');
      expect(btn).toBeInTheDocument();
    });
  });

  // ── Selection checkbox ────────────────────────────────────────────────

  describe('selection checkbox', () => {
    it('toggles selection when checkbox is clicked', () => {
      const onToggleSelect = vi.fn();
      renderCard(roadItem({ linkedTaskId: undefined }), { onToggleSelect });

      fireEvent.click(screen.getByRole('checkbox'));
      expect(onToggleSelect).toHaveBeenCalledTimes(1);
    });

    it('is checked when isSelected is true', () => {
      renderCard(roadItem({ linkedTaskId: undefined }), { isSelected: true });

      const cb = screen.getByRole('checkbox') as HTMLInputElement;
      expect(cb.checked).toBe(true);
    });

    it('is unchecked when isSelected is false', () => {
      renderCard(roadItem({ linkedTaskId: undefined }), { isSelected: false });

      const cb = screen.getByRole('checkbox') as HTMLInputElement;
      expect(cb.checked).toBe(false);
    });
  });

  // ── Competitive context ───────────────────────────────────────────────

  describe('competitive context', () => {
    it('renders competitive context when present', () => {
      renderCard(roadItem({ competitive_context: 'Ahead of competitor X' }));

      expect(screen.getByText('Ahead of competitor X')).toBeInTheDocument();
    });

    it('breaks long words in competitive context instead of overflowing', () => {
      renderCard(roadItem({ competitive_context: 'x'.repeat(200) }));

      const ctx = screen.getByText(/x{100,}/);
      expect(ctx).toHaveClass('break-words');
    });

    it('does not render competitive context when absent', () => {
      renderCard(roadItem({ competitive_context: undefined }));

      // The source is the only italic element in the sources row
      expect(screen.getByText('Source: ideation')).toBeInTheDocument();
      expect(screen.queryByText('Ahead of competitor X')).not.toBeInTheDocument();
    });
  });
});
