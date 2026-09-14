// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { DoneHistoryCard } from '@/components/done-history';
import type { DoneTicketFromHistory } from '@/lib/history-scanner';

const mockMarkAutoReviewed = vi.fn().mockResolvedValue(undefined);

vi.mock('@/app/actions/auto-mode', () => ({
  markAutoReviewed: (...args: unknown[]) => mockMarkAutoReviewed(...args),
}));

vi.mock('@/hooks/use-server-mutation', () => ({
  useServerMutation: () => ({
    run: (action: () => Promise<unknown>) => void action(),
    isPending: false,
  }),
}));

function makeTicket(overrides: Partial<DoneTicketFromHistory> = {}): DoneTicketFromHistory {
  return {
    title: 'Completed task',
    summary: 'Implemented the feature.',
    slug: 'completed-task',
    taskId: 'task-1',
    completedAt: new Date(),
    source: 'commit',
    ...overrides,
  };
}

describe('DoneHistoryCard auto-review state', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows the highlight, Auto badge, and Mark Reviewed button for an unreviewed auto completion', () => {
    render(<DoneHistoryCard ticket={makeTicket({ autoProcessed: true, autoReviewed: false })} onSelect={vi.fn()} />);

    expect(screen.getByTestId('done-history-card').className).toContain('border-amber-500/50');
    expect(screen.getByText('Auto')).toBeInTheDocument();
    expect(screen.getByText('✓ Mark Reviewed')).toBeInTheDocument();
  });

  it('acknowledges a deleted-task history card by task ID without opening it', () => {
    const onSelect = vi.fn();
    render(<DoneHistoryCard ticket={makeTicket({ autoProcessed: true, autoReviewed: false })} onSelect={onSelect} />);

    fireEvent.click(screen.getByText('✓ Mark Reviewed'));

    expect(mockMarkAutoReviewed).toHaveBeenCalledWith('task-1');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('hides the auto highlight and button after the history record is reviewed', () => {
    render(<DoneHistoryCard ticket={makeTicket({ autoProcessed: true, autoReviewed: true })} onSelect={vi.fn()} />);

    expect(screen.getByTestId('done-history-card').className).not.toContain('border-amber-500/50');
    expect(screen.queryByText('Auto')).not.toBeInTheDocument();
    expect(screen.queryByText('✓ Mark Reviewed')).not.toBeInTheDocument();
  });
});
