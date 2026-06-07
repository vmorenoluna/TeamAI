// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WorkflowView } from '@/components/workflow-view';
import type { WorkflowTask } from '@/app/actions/workflow';

const NOW = new Date('2025-06-07T12:00:00.000Z').getTime();

function makeTask(overrides: Partial<WorkflowTask['task']> = {}): WorkflowTask['task'] {
  return {
    id: 'task-1',
    title: 'Add dark mode toggle',
    description: 'Implement a dark mode toggle in settings',
    phase: 'implement',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeWorkflowTask(overrides: Partial<Omit<WorkflowTask, 'task'>> & { task?: Partial<WorkflowTask['task']> } = {}): WorkflowTask {
  const { task: taskOverrides, ...rest } = overrides;
  return {
    task: makeTask(taskOverrides),
    qaBounces: 0,
    enteredPhaseAt: null,
    ...rest,
  };
}

describe('WorkflowView', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── Pipeline phases ───────────────────────────────────────────────────

  it('renders all pipeline phase labels', () => {
    render(<WorkflowView workflowTasks={[]} />);

    expect(screen.getByText('Spec')).toBeInTheDocument();
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('Implement')).toBeInTheDocument();
    expect(screen.getByText('QA Review')).toBeInTheDocument();
    expect(screen.getByText('Awaiting Review')).toBeInTheDocument();
    expect(screen.getByText('Merge')).toBeInTheDocument();
    expect(screen.getByText('Create PR')).toBeInTheDocument();
    expect(screen.getByText('PR Open')).toBeInTheDocument();
  });

  // ── Header ────────────────────────────────────────────────────────────

  it('renders the header and subtitle', () => {
    render(<WorkflowView workflowTasks={[]} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Workflow');
    expect(screen.getByText(/Active tickets flowing through the pipeline/)).toBeInTheDocument();
  });

  // ── Empty state ───────────────────────────────────────────────────────

  it('shows empty state when no tasks', () => {
    render(<WorkflowView workflowTasks={[]} />);

    expect(screen.getByText('No active tickets — start a task from the Board to see it here.')).toBeInTheDocument();
  });

  // ── Task rendering ────────────────────────────────────────────────────

  it('shows task under correct phase', () => {
    const wt = makeWorkflowTask({
      task: { id: 'task-1', title: 'Fix login bug', phase: 'qa-review' },
    });

    render(<WorkflowView workflowTasks={[wt]} />);

    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
    // QA Review phase should show task count
    expect(screen.getByText('1')).toBeInTheDocument();
  });

  it('shows multiple tasks under different phases', () => {
    const tasks: WorkflowTask[] = [
      makeWorkflowTask({ task: { id: 't1', title: 'Spec task', phase: 'spec' } }),
      makeWorkflowTask({ task: { id: 't2', title: 'Plan task', phase: 'plan' } }),
      makeWorkflowTask({ task: { id: 't3', title: 'Impl task', phase: 'implement' } }),
    ];

    render(<WorkflowView workflowTasks={tasks} />);

    expect(screen.getByText('Spec task')).toBeInTheDocument();
    expect(screen.getByText('Plan task')).toBeInTheDocument();
    expect(screen.getByText('Impl task')).toBeInTheDocument();
  });

  it('groups multiple tasks under same phase', () => {
    const tasks: WorkflowTask[] = [
      makeWorkflowTask({ task: { id: 't1', title: 'Task A', phase: 'qa-review' } }),
      makeWorkflowTask({ task: { id: 't2', title: 'Task B', phase: 'qa-review' } }),
    ];

    render(<WorkflowView workflowTasks={tasks} />);

    expect(screen.getByText('Task A')).toBeInTheDocument();
    expect(screen.getByText('Task B')).toBeInTheDocument();
    // Phase count badge should show 2
    const badges = screen.getAllByText('2');
    expect(badges.length).toBeGreaterThan(0);
  });

  // ── QA bounce indicator ───────────────────────────────────────────────

  it('shows QA bounce count when task has been bounced', () => {
    const wt = makeWorkflowTask({
      task: { id: 'task-1', title: 'Bug fix', phase: 'implement' },
      qaBounces: 2,
    });

    render(<WorkflowView workflowTasks={[wt]} />);

    expect(screen.getByText('Bug fix')).toBeInTheDocument();
    expect(screen.getByText('2x QA')).toBeInTheDocument();
  });

  it('does not show QA bounce when zero', () => {
    const wt = makeWorkflowTask({
      task: { id: 'task-1', title: 'Clean task', phase: 'implement' },
      qaBounces: 0,
    });

    render(<WorkflowView workflowTasks={[wt]} />);

    expect(screen.getByText('Clean task')).toBeInTheDocument();
    expect(screen.queryByText(/x QA/)).not.toBeInTheDocument();
  });

  it('shows QA bounce for singular (1x QA)', () => {
    const wt = makeWorkflowTask({
      task: { id: 'task-1', title: 'One bounce', phase: 'implement' },
      qaBounces: 1,
    });

    render(<WorkflowView workflowTasks={[wt]} />);

    expect(screen.getByText('1x QA')).toBeInTheDocument();
  });

  // ── Time in phase ─────────────────────────────────────────────────────

  it('shows time in phase when enteredPhaseAt is provided', () => {
    const recent = new Date(NOW - 5 * 60000).toISOString(); // 5 minutes ago (frozen time)
    const wt = makeWorkflowTask({
      task: { id: 'task-1', title: 'Recent task', phase: 'spec' },
      enteredPhaseAt: recent,
    });

    render(<WorkflowView workflowTasks={[wt]} />);

    expect(screen.getByText('Recent task')).toBeInTheDocument();
    expect(screen.getByText('5m')).toBeInTheDocument();
  });

  it('shows "just now" for very recent phase entry', () => {
    const justNow = new Date(NOW - 30_000).toISOString(); // 30 seconds ago (frozen time)
    const wt = makeWorkflowTask({
      task: { id: 'task-1', title: 'Just started', phase: 'plan' },
      enteredPhaseAt: justNow,
    });

    render(<WorkflowView workflowTasks={[wt]} />);

    expect(screen.getByText('just now')).toBeInTheDocument();
  });

  it('shows hours when time is more than 60 minutes', () => {
    const hoursAgo = new Date(NOW - 3 * 3600_000).toISOString(); // 3 hours ago (frozen time)
    const wt = makeWorkflowTask({
      task: { id: 'task-1', title: 'Old task', phase: 'awaiting-review' },
      enteredPhaseAt: hoursAgo,
    });

    render(<WorkflowView workflowTasks={[wt]} />);

    expect(screen.getByText('3h')).toBeInTheDocument();
  });

  it('shows days when time is more than 24 hours', () => {
    const daysAgo = new Date(NOW - 3 * 86400_000).toISOString(); // 3 days ago (frozen time)
    const wt = makeWorkflowTask({
      task: { id: 'task-1', title: 'Stale task', phase: 'pr-open' },
      enteredPhaseAt: daysAgo,
    });

    render(<WorkflowView workflowTasks={[wt]} />);

    expect(screen.getByText('3d')).toBeInTheDocument();
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  it('handles task with unknown phase gracefully (does not crash)', () => {
    const wt = makeWorkflowTask({
      task: { id: 'task-1', title: 'Weird phase', phase: 'some-unknown-phase' },
    });

    // Should not throw
    expect(() => render(<WorkflowView workflowTasks={[wt]} />)).not.toThrow();
  });

  it('handles tasks with both QA bounce and time in phase', () => {
    const recent = new Date(NOW - 10 * 60000).toISOString();
    const wt = makeWorkflowTask({
      task: { id: 'task-1', title: 'Combo task', phase: 'implement' },
      qaBounces: 3,
      enteredPhaseAt: recent,
    });

    render(<WorkflowView workflowTasks={[wt]} />);

    expect(screen.getByText('Combo task')).toBeInTheDocument();
    expect(screen.getByText('3x QA')).toBeInTheDocument();
    expect(screen.getByText('10m')).toBeInTheDocument();
  });
});
