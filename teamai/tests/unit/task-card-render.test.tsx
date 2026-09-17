// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TaskCard } from '@/components/task-card';
import type { Task } from '@/lib/task-store';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockRouterRefresh = vi.fn();
const mockRouterPush = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: mockRouterRefresh,
    push: mockRouterPush,
    prefetch: vi.fn(),
  }),
}));

vi.mock('@/app/actions/tasks', () => ({
  checkTaskWorktree: vi.fn().mockResolvedValue({ exists: false, path: null }),
  deleteTaskWorktree: vi.fn(),
  retryTask: vi.fn(),
  stopTask: vi.fn(),
  pauseTask: vi.fn(),
  resumeTask: vi.fn(),
  playTask: vi.fn(),
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

// ── Tests ──────────────────────────────────────────────────────────────

describe('TaskCard PR link indicator (render)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders a clickable PR link when prUrl is set', () => {
    const task = makeTask({ prUrl: 'https://github.com/owner/repo/pull/42' });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    const link = screen.getByTestId('pr-link-indicator');
    expect(link).toBeInTheDocument();
    expect(link.tagName).toBe('A');
    expect(link).toHaveAttribute('href', 'https://github.com/owner/repo/pull/42');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(link).toHaveAttribute('title', 'Open PR: https://github.com/owner/repo/pull/42');
    expect(link).toHaveTextContent('PR');
  });

  it('does not render a PR link when prUrl is undefined or absent', () => {
    const task = makeTask();
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    expect(screen.queryByTestId('pr-link-indicator')).not.toBeInTheDocument();
  });

  it('renders the PR link alongside other metadata (relative time)', () => {
    const task = makeTask({ prUrl: 'https://github.com/owner/repo/pull/1' });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    // Both the relative time and the PR link should be visible
    const link = screen.getByTestId('pr-link-indicator');
    expect(link).toBeInTheDocument();

    // The task card itself should still be rendered
    expect(screen.getByTestId('task-card')).toBeInTheDocument();
    expect(screen.getByText('Test Task')).toBeInTheDocument();
  });

  it('includes an external-link SVG icon in the PR link', () => {
    const task = makeTask({ prUrl: 'https://github.com/owner/repo/pull/42' });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    const link = screen.getByTestId('pr-link-indicator');
    // The link should contain an SVG element (the external link icon)
    const svg = link.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });
});

// ── Auto-processed border rendering ───────────────────────────────────

describe('TaskCard auto-processed border', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies amber border when autoProcessed is true and autoReviewed is false', () => {
    const task = makeTask({
      phase: 'done',
      autoProcessed: true,
      autoReviewed: false,
    });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    const card = screen.getByTestId('task-card');
    expect(card.className).toContain('border-amber-500/50');
  });

  it('does NOT apply amber border when autoReviewed is true (even if autoProcessed)', () => {
    const task = makeTask({
      phase: 'done',
      autoProcessed: true,
      autoReviewed: true,
    });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    const card = screen.getByTestId('task-card');
    expect(card.className).not.toContain('border-amber-500/50');
  });

  it('does NOT apply amber border to normal tasks (neither autoProcessed nor autoReviewed)', () => {
    const task = makeTask({
      phase: 'done',
    });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    const card = screen.getByTestId('task-card');
    expect(card.className).not.toContain('border-amber-500/50');
  });

  it('does NOT apply amber border when autoReviewed is true but autoProcessed is false', () => {
    // Degenerate case — should not happen in practice but the logic must handle it
    const task = makeTask({
      phase: 'done',
      autoProcessed: false,
      autoReviewed: true,
    });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    const card = screen.getByTestId('task-card');
    expect(card.className).not.toContain('border-amber-500/50');
  });

  it('applies amber border regardless of phase (border check has no phase guard)', () => {
    // The border uses `autoProcessed && !autoReviewed` without a phase check.
    // The "Auto" badge has a phase guard, but the border intentionally does not.
    const task = makeTask({
      phase: 'spec',  // not 'done'
      autoProcessed: true,
      autoReviewed: false,
    });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    const card = screen.getByTestId('task-card');
    expect(card.className).toContain('border-amber-500/50');
  });

  it('does NOT apply amber border when isMoving is true (moving state overrides)', () => {
    const task = makeTask({
      phase: 'done',
      autoProcessed: true,
      autoReviewed: false,
    });
    render(<TaskCard task={task} onSelect={vi.fn()} isMoving />);

    const card = screen.getByTestId('task-card');
    // Moving border class should be present instead
    expect(card.className).toContain('border-[#2563eb]/60');
    expect(card.className).not.toContain('border-amber-500/50');
  });
});

// ── Auto badge rendering ──────────────────────────────────────────────

describe('TaskCard Auto badge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the "Auto" badge when autoProcessed, !autoReviewed, and phase is done', () => {
    const task = makeTask({
      phase: 'done',
      autoProcessed: true,
      autoReviewed: false,
    });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    expect(screen.getByText('Auto')).toBeInTheDocument();
  });

  it('hides the "Auto" badge when autoReviewed is true', () => {
    const task = makeTask({
      phase: 'done',
      autoProcessed: true,
      autoReviewed: true,
    });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    expect(screen.queryByText('Auto')).not.toBeInTheDocument();
  });

  it('hides the "Auto" badge when phase is not done (even if autoProcessed and !autoReviewed)', () => {
    const task = makeTask({
      phase: 'spec',
      autoProcessed: true,
      autoReviewed: false,
    });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    expect(screen.queryByText('Auto')).not.toBeInTheDocument();
  });
});

// ── Needs-attention badge ─────────────────────────────────────────────

describe('TaskCard needs-attention badge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows "Needs attention" when phase is awaiting-review with a reason (failure park)', () => {
    const task = makeTask({
      phase: 'awaiting-review',
      awaitingReviewReason: 'Spec phase produced no spec.md — the analyst session ended without writing a spec.',
    });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    const badge = screen.getByTestId('needs-attention-badge');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', task.awaitingReviewReason);
    expect(screen.getByText(/Needs attention/)).toBeInTheDocument();
  });

  it('hides the badge when awaiting-review has no reason (genuine QA pass)', () => {
    const task = makeTask({ phase: 'awaiting-review' });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    expect(screen.queryByTestId('needs-attention-badge')).not.toBeInTheDocument();
  });

  it('hides the badge when a reason is present but phase is not awaiting-review', () => {
    // A stale reason should never surface outside the phase it belongs to —
    // updatePhase() clears it on any other transition, but the card itself
    // also gates on phase defensively.
    const task = makeTask({
      phase: 'implement',
      awaitingReviewReason: 'Spec phase produced no spec.md.',
    });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    expect(screen.queryByTestId('needs-attention-badge')).not.toBeInTheDocument();
  });

  it('suppresses the in-progress spinner when the needs-attention badge is shown', () => {
    const task = makeTask({
      phase: 'awaiting-review',
      awaitingReviewReason: 'Spec phase produced no spec.md.',
    });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    expect(screen.getByTestId('needs-attention-badge')).toBeInTheDocument();
    expect(screen.queryByTestId('spinner-icon')).not.toBeInTheDocument();
  });
});
