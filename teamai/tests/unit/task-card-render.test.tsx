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

  it('handles GitLab MR URLs correctly', () => {
    const task = makeTask({ prUrl: 'https://gitlab.com/group/project/-/merge_requests/99' });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    const link = screen.getByTestId('pr-link-indicator');
    expect(link).toHaveAttribute('href', 'https://gitlab.com/group/project/-/merge_requests/99');
    expect(link).toHaveAttribute('target', '_blank');
  });

  it('handles Bitbucket PR URLs correctly', () => {
    const task = makeTask({ prUrl: 'https://bitbucket.org/team/repo/pull-requests/7' });
    render(<TaskCard task={task} onSelect={vi.fn()} />);

    const link = screen.getByTestId('pr-link-indicator');
    expect(link).toHaveAttribute('href', 'https://bitbucket.org/team/repo/pull-requests/7');
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
