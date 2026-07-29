// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { WorkflowView } from '@/components/workflow-view';
import type { WorkflowTask } from '@/app/actions/workflow';

vi.mock('@/hooks/use-phase-sync', () => ({
  usePhaseSync: vi.fn(),
}));

vi.mock('@/components/task-panel', () => ({
  TaskPanel: ({ taskId, onClose }: { taskId: string; onClose: () => void }) => (
    <div data-component="task-panel" data-taskid={taskId}>
      <button data-component="task-panel-close" onClick={onClose}>Close</button>
    </div>
  ),
}));

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
    isActive: false,
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

  // ── Phase nodes ────────────────────────────────────────────────────────

  it('renders all pipeline phase node labels', () => {
    render(<WorkflowView projectPath="/test" workflowTasks={[
      makeWorkflowTask({ task: { id: 't', title: 'T', phase: 'backlog' } }),
    ]} />);

    expect(screen.getByText('Backlog')).toBeInTheDocument();
    expect(screen.getByText('Spec')).toBeInTheDocument();
    expect(screen.getByText('Plan')).toBeInTheDocument();
    expect(screen.getByText('Implement')).toBeInTheDocument();
    expect(screen.getByText('QA Review')).toBeInTheDocument();
    expect(screen.getByText('Awaiting Review')).toBeInTheDocument();
    expect(screen.getByText('Merge')).toBeInTheDocument();
    expect(screen.getByText('Create PR')).toBeInTheDocument();
    expect(screen.getByText('PR Open')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();
  });

  // ── Header ────────────────────────────────────────────────────────────

  it('renders the header and subtitle', () => {
    render(<WorkflowView projectPath="/test" workflowTasks={[
      makeWorkflowTask({ task: { id: 't', title: 'T', phase: 'backlog' } }),
    ]} />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Workflow');
    expect(screen.getByText(/Pipeline state diagram/)).toBeInTheDocument();
  });

  // ── Empty state ───────────────────────────────────────────────────────

  it('shows empty state when no tasks', () => {
    render(<WorkflowView projectPath="/test" workflowTasks={[]} />);

    expect(screen.getByText('No tickets yet — create one from the Board.')).toBeInTheDocument();
  });

  // ── Ticket count badges ───────────────────────────────────────────────

  it('shows ticket count badge on phase nodes with tasks', () => {
    const tasks: WorkflowTask[] = [
      makeWorkflowTask({ task: { id: 't1', title: 'Task A', phase: 'qa-review' } }),
      makeWorkflowTask({ task: { id: 't2', title: 'Task B', phase: 'qa-review' } }),
    ];

    render(<WorkflowView projectPath="/test" workflowTasks={tasks} />);

    const badges = screen.getAllByText('2');
    expect(badges.length).toBeGreaterThan(0);
  });

  // ── Hover reveals tickets ─────────────────────────────────────────────

  it('shows tickets in a popover when hovering a phase node', async () => {
    const tasks: WorkflowTask[] = [
      makeWorkflowTask({ task: { id: 't1', title: 'Fix login bug', phase: 'qa-review' } }),
    ];

    render(<WorkflowView projectPath="/test" workflowTasks={tasks} />);

    const qaNode = screen.getByText('QA Review');
    fireEvent.mouseEnter(qaNode);
    await act(() => { vi.advanceTimersByTime(180); });

    expect(screen.getByText('Fix login bug')).toBeInTheDocument();
  });

  it('shows header subtitle with hover instructions', () => {
    render(<WorkflowView projectPath="/test" workflowTasks={[
      makeWorkflowTask({ task: { id: 't', title: 'T', phase: 'backlog' } }),
    ]} />);

    expect(screen.getByText(/hover over a phase to see its tickets/)).toBeInTheDocument();
  });

  it('shows "no tickets" message when hovering an empty phase', async () => {
    render(<WorkflowView projectPath="/test" workflowTasks={[
      makeWorkflowTask({ task: { id: 't', title: 'T', phase: 'backlog' } }),
    ]} />);

    const specNode = screen.getByText('Spec');
    fireEvent.mouseEnter(specNode);
    await act(() => { vi.advanceTimersByTime(180); });

    expect(screen.getByText('No tickets currently in this phase.')).toBeInTheDocument();
  });

  // ── Click to open task detail ─────────────────────────────────────────

  it('opens task detail modal when clicking a ticket in the hover panel', async () => {
    const tasks: WorkflowTask[] = [
      makeWorkflowTask({ task: { id: 'task-1', title: 'Click me', phase: 'implement' } }),
    ];

    render(<WorkflowView projectPath="/test" workflowTasks={tasks} />);

    fireEvent.mouseEnter(screen.getByText('Implement'));
    await act(() => { vi.advanceTimersByTime(180); });
    fireEvent.click(screen.getByText('Click me'));

    expect(screen.getByTestId('task-panel')).toBeInTheDocument();
    expect(screen.getByTestId('task-panel').getAttribute('data-taskid')).toBe('task-1');
  });

  it('closes modal when clicking close button', async () => {
    const tasks: WorkflowTask[] = [
      makeWorkflowTask({ task: { id: 'task-1', title: 'Click me', phase: 'implement' } }),
    ];

    render(<WorkflowView projectPath="/test" workflowTasks={tasks} />);

    fireEvent.mouseEnter(screen.getByText('Implement'));
    await act(() => { vi.advanceTimersByTime(180); });
    fireEvent.click(screen.getByText('Click me'));
    expect(screen.getByTestId('task-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('task-panel-close'));
    expect(screen.queryByTestId('task-panel')).not.toBeInTheDocument();
  });

  it('closes modal when pressing Escape', async () => {
    const tasks: WorkflowTask[] = [
      makeWorkflowTask({ task: { id: 'task-1', title: 'Click me', phase: 'implement' } }),
    ];

    render(<WorkflowView projectPath="/test" workflowTasks={tasks} />);

    fireEvent.mouseEnter(screen.getByText('Implement'));
    await act(() => { vi.advanceTimersByTime(180); });
    fireEvent.click(screen.getByText('Click me'));
    expect(screen.getByTestId('task-panel')).toBeInTheDocument();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByTestId('task-panel')).not.toBeInTheDocument();
  });

  // ── QA bounce indicator ───────────────────────────────────────────────

  it('shows QA bounce count on tickets', async () => {
    const tasks: WorkflowTask[] = [
      makeWorkflowTask({
        task: { id: 'task-1', title: 'Bug fix', phase: 'implement' },
        qaBounces: 2,
      }),
    ];

    render(<WorkflowView projectPath="/test" workflowTasks={tasks} />);

    fireEvent.mouseEnter(screen.getByText('Implement'));
    await act(() => { vi.advanceTimersByTime(180); });

    expect(screen.getByText('Bug fix')).toBeInTheDocument();
    expect(screen.getByText('2x QA')).toBeInTheDocument();
  });

  it('does not show QA bounce when zero', async () => {
    const tasks: WorkflowTask[] = [
      makeWorkflowTask({
        task: { id: 'task-1', title: 'Clean task', phase: 'implement' },
        qaBounces: 0,
      }),
    ];

    render(<WorkflowView projectPath="/test" workflowTasks={tasks} />);

    fireEvent.mouseEnter(screen.getByText('Implement'));
    await act(() => { vi.advanceTimersByTime(180); });

    expect(screen.getByText('Clean task')).toBeInTheDocument();
    expect(screen.queryByText(/x QA/)).not.toBeInTheDocument();
  });

  // ── Time in phase ─────────────────────────────────────────────────────

  it('shows time in phase on tickets', async () => {
    const recent = new Date(NOW - 5 * 60000).toISOString();
    const tasks: WorkflowTask[] = [
      makeWorkflowTask({
        task: { id: 'task-1', title: 'Recent task', phase: 'spec' },
        enteredPhaseAt: recent,
      }),
    ];

    render(<WorkflowView projectPath="/test" workflowTasks={tasks} />);

    fireEvent.mouseEnter(screen.getByText('Spec'));
    await act(() => { vi.advanceTimersByTime(180); });

    expect(screen.getByText('Recent task')).toBeInTheDocument();
    expect(screen.getByText('5m')).toBeInTheDocument();
  });

  // ── Other (catch-all) ─────────────────────────────────────────────────

  it('renders Other node for unrecognized phases', () => {
    const tasks: WorkflowTask[] = [
      makeWorkflowTask({ task: { id: 'task-1', title: 'Weird phase', phase: 'some-unknown-phase' } }),
    ];

    render(<WorkflowView projectPath="/test" workflowTasks={tasks} />);

    expect(screen.getByText('Other')).toBeInTheDocument();
  });

  it('shows tickets when hovering Other node', async () => {
    const tasks: WorkflowTask[] = [
      makeWorkflowTask({ task: { id: 'task-1', title: 'Mystery', phase: 'some-unknown-phase' } }),
    ];

    render(<WorkflowView projectPath="/test" workflowTasks={tasks} />);

    fireEvent.mouseEnter(screen.getByText('Other'));
    await act(() => { vi.advanceTimersByTime(180); });

    expect(screen.getByText('Mystery')).toBeInTheDocument();
  });

  // ── Active session pulse glow ─────────────────────────────────────────

  it('adds pulse glow class to phase node with active tasks', () => {
    const tasks: WorkflowTask[] = [
      makeWorkflowTask({
        task: { id: 'task-1', title: 'Running task', phase: 'implement' },
        isActive: true,
      }),
    ];

    render(<WorkflowView projectPath="/test" workflowTasks={tasks} />);

    // The Implement phase node should have the pulse glow class
    const implNode = screen.getByText('Implement');
    const parent = implNode.closest('[class*="animate-pulse-glow"]');
    expect(parent).toBeTruthy();
  });

  it('does not add pulse glow to phase node without active tasks', () => {
    const tasks: WorkflowTask[] = [
      makeWorkflowTask({
        task: { id: 'task-1', title: 'Idle task', phase: 'implement' },
        isActive: false,
      }),
    ];

    render(<WorkflowView projectPath="/test" workflowTasks={tasks} />);

    const implNode = screen.getByText('Implement');
    const parent = implNode.closest('[class*="animate-pulse-glow"]');
    expect(parent).toBeNull();
  });
});
