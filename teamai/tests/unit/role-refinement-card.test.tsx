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
    model: 'claude-sonnet-4-6',
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

function renderCard(task: Task, suggestion: RoleRefinementSuggestion | null, mode: 'off' | 'manual' = 'manual', suggestions?: RoleRefinementSuggestion[]) {
  return render(
    <RoleRefinementCard
      task={task}
      suggestion={suggestion}
      suggestions={suggestions}
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

  it('keeps the spinner once the analyzing record lands (SSE refresh case)', () => {
    // analyzeFailure writes the record synchronously with status 'analyzing',
    // so a refresh delivers the record while the session is still running —
    // the card must not blank out for the rest of the analysis.
    const suggestion = makeSuggestion({ status: 'analyzing' });
    renderCard(makeTask({ refinementStatus: 'analyzing' }), suggestion);
    expect(screen.getByText(/Reading QA reports and agent logs/)).toBeInTheDocument();
    expect(screen.queryByText('Suggested role-prompt refinement')).not.toBeInTheDocument();
  });

  it('shows the suggested card over a stale analyzing task flag', () => {
    // Transient staleness: the record already resolved to 'suggested' but the
    // task prop still says 'analyzing' — the terminal card must win.
    renderCard(makeTask({ refinementStatus: 'analyzing' }), makeSuggestion());
    expect(screen.getByText('Suggested role-prompt refinement')).toBeInTheDocument();
    expect(screen.queryByText(/Reading QA reports and agent logs/)).not.toBeInTheDocument();
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

  // Regression: an 'append' edit's proposedContent is only the new block, not
  // the resulting file. Diffing it directly against the full current file
  // (instead of the merged result applyRefinement — role-refinement.ts —
  // actually writes) showed the whole existing role file as removed, making
  // an additive suggestion look destructive.
  it('diffs an append-mode edit against the merged result, not the raw snippet, so nothing existing looks removed', () => {
    const { container } = renderCard(makeTask({ refinementStatus: 'suggested' }), makeSuggestion());
    const diff = container.querySelector('[data-component="unified-diff"]');
    // The existing "# Role: Planner" / "old body" content must never appear
    // inside a removed (red) row — it's unchanged, not deleted. Only the new
    // block is added.
    const redRows = Array.from(diff?.querySelectorAll('.bg-red-950\\/20') ?? []);
    const redText = redRows.map(r => r.textContent).join('\n');
    expect(redText).not.toContain('Role: Planner');
    expect(redText).not.toContain('old body');
    expect(diff?.textContent).toContain('old body');
    expect(diff?.textContent).toContain('Use git add -f.');
  });

  it('diffs a replace-mode edit against the full proposedContent unchanged (no merge)', () => {
    const replaceSuggestion = makeSuggestion({
      edits: [{ roleFile: 'planner.md', mode: 'replace', rationale: 'full rewrite', proposedContent: '# Role: Planner\n\nnew body\n', riskClass: 'modifying' }],
    });
    const { container } = renderCard(makeTask({ refinementStatus: 'suggested' }), replaceSuggestion);
    const diff = container.querySelector('[data-component="unified-diff"]');
    // "old body" is genuinely gone under a real replace — that removal is
    // correct and expected, unlike the append case above.
    expect(diff?.querySelector('.bg-red-950\\/20')).not.toBeNull();
    expect(diff?.textContent).toContain('old body');
    expect(diff?.textContent).toContain('new body');
  });

  it('keeps the analyze button and applied outcome visible', () => {
    renderCard(makeTask(), makeSuggestion({ status: 'applied' }));
    expect(screen.getByRole('button', { name: /Analyze failure/i })).toBeInTheDocument();
    expect(screen.getByText('Role-prompt refinement applied.')).toBeInTheDocument();
  });

  it('renders multiple non-dismissed outcomes and omits dismissed history', () => {
    const first = makeSuggestion({ id: 's-1', status: 'no-gap', isRolePromptGap: false, edits: [], diagnosis: 'First outcome' });
    const second = makeSuggestion({ id: 's-2', status: 'suggested', rootCause: 'Second outcome' });
    const dismissed = makeSuggestion({ id: 's-3', status: 'dismissed', rootCause: 'Hidden outcome' });
    renderCard(makeTask(), second, 'manual', [first, second, dismissed]);
    expect(screen.getByText('First outcome')).toBeInTheDocument();
    expect(screen.getByText('Second outcome')).toBeInTheDocument();
    expect(screen.queryByText('Hidden outcome')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Analyze failure/i })).toBeInTheDocument();
  });

  it('switches the diff to an editable textarea via Edit', () => {
    const { container } = renderCard(makeTask({ refinementStatus: 'suggested' }), makeSuggestion());
    fireEvent.click(screen.getByText('Edit'));
    const textarea = container.querySelector('textarea[data-component="role-refinement-edit-planner.md"]');
    expect(textarea).not.toBeNull();
  });

  it('shows the retry-loop escalation banner while retaining the analyze button', () => {
    renderCard(makeTask({ refinementEscalated: true }), null);
    expect(screen.getByText(/A role refinement was applied but the task failed the same way/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Analyze failure/i })).toBeInTheDocument();
  });

  it('does not show the escalation banner for a clean task', () => {
    renderCard(makeTask(), null);
    expect(screen.queryByText(/human review needed/)).not.toBeInTheDocument();
  });
});
