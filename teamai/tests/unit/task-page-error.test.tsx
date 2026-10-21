// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TaskNotFoundError } from '@/lib/orchestrator/errors';

const mockGetTaskFull = vi.fn();
const mockGetActiveProject = vi.fn();
const mockNotFound = vi.fn(() => {
  throw new Error('NEXT_NOT_FOUND');
});

vi.mock('next/navigation', () => ({
  notFound: () => mockNotFound(),
}));

vi.mock('@/app/actions/tasks', () => ({
  getTaskFull: (...args: unknown[]) => mockGetTaskFull(...args),
}));

vi.mock('@/app/actions/projects', () => ({
  getActiveProject: () => mockGetActiveProject(),
}));

vi.mock('@/components/task-detail', () => ({
  TaskDetail: () => null,
}));

import ErrorBoundary from '@/app/error';
import TaskPage from '@/app/task/[id]/page';

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  mockGetActiveProject.mockResolvedValue({ path: '/p' });
});

describe('TaskPage error handling', () => {
  it('rejects with the original error and does not call notFound for a generic error', async () => {
    const boom = new Error('disk read failed');
    mockGetTaskFull.mockRejectedValue(boom);

    await expect(TaskPage({ params: Promise.resolve({ id: 't1' }) })).rejects.toBe(boom);
    expect(mockNotFound).not.toHaveBeenCalled();
  });

  it('calls notFound for TaskNotFoundError', async () => {
    mockGetTaskFull.mockRejectedValue(new TaskNotFoundError('t1'));

    await expect(TaskPage({ params: Promise.resolve({ id: 't1' }) })).rejects.toThrow('NEXT_NOT_FOUND');
    expect(mockNotFound).toHaveBeenCalledTimes(1);
  });
});

describe('root error boundary', () => {
  it('renders message and digest, and Reload calls unstable_retry once', () => {
    const error = Object.assign(new Error('boom'), { digest: 'abc' });
    const retry = vi.fn();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});

    render(<ErrorBoundary error={error} unstable_retry={retry} />);

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('Could not load this page');
    expect(alert).toHaveTextContent('boom');
    expect(alert).toHaveTextContent('abc');

    fireEvent.click(screen.getByRole('button', { name: 'Reload' }));
    expect(retry).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
