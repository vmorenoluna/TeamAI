// @vitest-environment happy-dom

/** Unit tests for the RoleRefinementCard inline card: idle/analyzing/suggested/
 *  no-gap states, the mode/phase gates, and the apply/dismiss action wiring. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { Task } from '@/lib/task-store';
import type { RoleRefinementSuggestion } from '@/lib/role-refinement';

const { mockAnalyze, mockApply, mockApplyRetry, mockDismiss } = vi.hoisted(() => ({
  mockAnalyze: vi.fn(),
  mockApply: vi.fn(),
  mockApplyRetry: vi.fn(),
  mockDismiss: vi.fn(),
}));

vi.mock('@/app/actions/role-refinement', () => ({
  analyzeFailedTask: (...args: unknown[]) => mockAnalyze(...args),
  applyRefinementAction: (...args: unknown[]) => mockApply(...args),
  applyAndRetryRefinementAction: (...args: unknown[]) => mockApplyRetry(...args),
  dismissRefinementAction: (...args: unknown[]) => mockDismiss(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

// Mock startTransition so async callbacks resolve synchronously.
const mockStartTransition = vi.hoisted(() =>
  vi.fn((cb: () => void | Promise<void>) => {
    try {
      const result = cb() as unknown;
      if (result instanceof Promise) result.catch(() => { /* best-effort */ });
    } catch { /* suppress */ }
  })
);

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useTransition: () => [false, mockStartTransition] };
});

import { RoleRefinementCard } from '@/components/role-refinement-card';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't-1',
    title: 'Broken migration',
    description: '',
    phase: 'failed',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as Task;
}

function makeSuggestion(overrides: Partial<RoleRefinementSuggestion> = {}): RoleRefinementSuggestion {
  return {
    id: 's-1',
    createdAt: '2026-08-01T00:00:00.000Z',
    updatedAt: '2026-08-01T00:00:00.000Z',
    status: 'suggested',
    trigger: 'manual',
    sourceTaskIds: ['t-1'],
    signature: 'sha256:x',
    isRolePromptGap: true,
    contractGap: false,
    contractFile: null,
    rootCause: 'Planner never mentions force-add',
    confidence: 'high',
    diagnosis: 'Add the rule.',
    edits: [{ roleFile: 'planner.md', mode: 'append', rationale: 'evidence commit', proposedContent: 'Use git add -f.', riskClass: 'additive' }],
    appliedAt: null,
    appliedBy: null,
    backups: [],
    ...overrides,
  };
}

function renderCard(task: Task, suggestion: RoleRefinementSuggestion | null, mode: 'off' | 'manual' = 'manual') {
  return render(
    <RoleRefinementCard
      task={task}
      suggestion={suggestion}
      roleFiles={{ 'planner.md': '# Role: Planner\n\nold body\n' }}
      mode={mode}
    />,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAnalyze.mockResolvedValue({ success: true });
  mockApply.mockResolvedValue({ success: true });
  mockApplyRetry.mockResolvedValue({ success: true });
  mockDismiss.mockResolvedValue({ success: true });
  // CopyButton relies on the clipboard API — stub it in happy-dom.
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('RoleRefinementCard', () => {
  it('renders nothing when mode is off', () => {
    const { container } = renderCard(makeTask(), null, 'off');
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the task is not failed', () => {
    const { container } = renderCard(makeTask({ phase: 'implement' }), null);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders the idle prompt + analyze button on a failed task', () => {
    renderCard(makeTask(), null);
    expect(screen.getByText(/Keeps failing the same way\?/)).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: /Analyze failure/i });
    fireEvent.click(btn);
    expect(mockAnalyze).toHaveBeenCalledWith('t-1');
  });

  it('shows the analyzing spinner while analysis is in flight', () => {
    renderCard(makeTask({ refinementStatus: 'analyzing' }), null);
    expect(screen.getByText(/Reading QA reports and agent logs/)).toBeInTheDocument();
  });

  it('renders the no-gap card with the diagnosis and no apply button', () => {
    const suggestion = makeSuggestion({
      status: 'no-gap',
      isRolePromptGap: false,
      edits: [],
      diagnosis: 'The spec lacks thresholds — not a role gap.',
    });
    renderCard(makeTask({ refinementStatus: 'no-gap' }), suggestion);
    expect(screen.getByText('Not a role-prompt gap')).toBeInTheDocument();
    expect(screen.getByText('The spec lacks thresholds — not a role gap.')).toBeInTheDocument();
    expect(screen.queryByText('Apply')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Dismiss'));
    expect(mockDismiss).toHaveBeenCalledWith('s-1');
  });

  it('renders the suggested card with diff, apply, and apply & retry', async () => {
    const { container } = renderCard(makeTask({ refinementStatus: 'suggested' }), makeSuggestion());
    expect(screen.getByText('Suggested role-prompt refinement')).toBeInTheDocument();
    expect(screen.getByText('high')).toBeInTheDocument();
    expect(screen.getByText(/Planner never mentions force-add/)).toBeInTheDocument();
    // Diff body — the marker and line render in separate nodes; assert textContent.
    const diff = container.querySelector('[data-component="unified-diff"]');
    expect(diff?.textContent).toContain('+');
    expect(diff?.textContent).toContain('Use git add -f.');

    fireEvent.click(screen.getByRole('button', { name: /^Apply$/ }));
    await vi.waitFor(() => expect(mockApply).toHaveBeenCalledWith('s-1', undefined));
    fireEvent.click(screen.getByRole('button', { name: /Apply & Retry/ }));
    await vi.waitFor(() => expect(mockApplyRetry).toHaveBeenCalledWith('s-1', undefined));
  });

  it('collapses the card for applied/dismissed/superseded records', () => {
    for (const status of ['applied', 'dismissed', 'superseded'] as const) {
      const { container } = renderCard(makeTask(), makeSuggestion({ status }));
      expect(container).toBeEmptyDOMElement();
    }
  });

  it('switches the diff to an editable textarea via Edit', () => {
    const { container } = renderCard(makeTask({ refinementStatus: 'suggested' }), makeSuggestion());
    fireEvent.click(screen.getByText('Edit'));
    const textarea = container.querySelector('textarea[data-component="role-refinement-edit-planner.md"]');
    expect(textarea).not.toBeNull();
  });
});
