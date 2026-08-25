// @vitest-environment happy-dom

/** Unit tests for the RoleRefinementSettings panel: mode control, pending
 *  suggestions list, no-gap findings, applied history, and revert wiring. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RoleRefinementConfig, RoleRefinementSuggestion } from '@/lib/role-refinement';

const { mockSetConfig, mockApply, mockDismiss, mockRevert } = vi.hoisted(() => ({
  mockSetConfig: vi.fn(),
  mockApply: vi.fn(),
  mockDismiss: vi.fn(),
  mockRevert: vi.fn(),
}));

vi.mock('@/app/actions/role-refinement', () => ({
  setRoleRefinementConfigAction: (...args: unknown[]) => mockSetConfig(...args),
  applyRefinementAction: (...args: unknown[]) => mockApply(...args),
  dismissRefinementAction: (...args: unknown[]) => mockDismiss(...args),
  revertRefinementAction: (...args: unknown[]) => mockRevert(...args),
}));

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}));

vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: React.ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

// Synchronous useTransition (project pattern).
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

import { RoleRefinementSettings } from '@/components/role-refinement-settings';

const CONFIG: RoleRefinementConfig = {
  mode: 'manual',
  autoApply: false,
  maxAutoAnalysesPerDay: 5,
  recurrenceThreshold: 2,
};

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
    rootCause: 'Planner omits force-add',
    confidence: 'high',
    diagnosis: 'Add the rule.',
    edits: [{ roleFile: 'planner.md', mode: 'append', rationale: 'evidence', proposedContent: 'Use git add -f.', riskClass: 'additive' }],
    appliedAt: null,
    appliedBy: null,
    backups: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockSetConfig.mockResolvedValue(undefined);
  mockApply.mockResolvedValue({ success: true });
  mockDismiss.mockResolvedValue({ success: true });
  mockRevert.mockResolvedValue({ success: true });
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: vi.fn().mockResolvedValue(undefined) },
    configurable: true,
  });
});

describe('RoleRefinementSettings', () => {
  it('switches mode via the Off/Manual segments', () => {
    render(<RoleRefinementSettings config={CONFIG} suggestions={[]} tasks={{}} />);
    fireEvent.click(screen.getByTestId('role-refinement-mode-off'));
    expect(mockSetConfig).toHaveBeenCalledWith({ ...CONFIG, mode: 'off' });
  });

  it('lists pending suggestions with task title, root cause, and apply/dismiss', async () => {
    const suggestion = makeSuggestion();
    render(
      <RoleRefinementSettings
        config={CONFIG}
        suggestions={[suggestion]}
        tasks={{ 't-1': 'Broken migration' }}
      />,
    );
    expect(screen.getByText('Broken migration')).toBeInTheDocument();
    expect(screen.getByText(/Planner omits force-add/)).toBeInTheDocument();
    expect(screen.getByText(/planner\.md \(append\)/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Apply'));
    await vi.waitFor(() => expect(mockApply).toHaveBeenCalledWith('s-1'));
    fireEvent.click(screen.getByText('Dismiss'));
    await vi.waitFor(() => expect(mockDismiss).toHaveBeenCalledWith('s-1'));
  });

  it('labels contract-gap findings with the affected defaults file and no Apply', () => {
    const suggestion = makeSuggestion({
      status: 'no-gap',
      isRolePromptGap: false,
      contractGap: true,
      contractFile: 'implement.md',
      edits: [],
    });
    render(
      <RoleRefinementSettings
        config={CONFIG}
        suggestions={[suggestion]}
        tasks={{ 't-1': 'Broken migration' }}
      />,
    );
    expect(screen.getByText(/contract gap — defaults\/commands\/implement\.md/)).toBeInTheDocument();
    expect(screen.queryByText('Apply')).not.toBeInTheDocument();
  });

  it('shows applied history with a working Revert button', async () => {
    const applied = makeSuggestion({ status: 'applied', appliedAt: '2026-08-02T00:00:00.000Z', backups: [{ roleFile: 'planner.md', backupPath: '/tmp/x.md' }] });
    render(<RoleRefinementSettings config={CONFIG} suggestions={[applied]} tasks={{ 't-1': 'Broken migration' }} />);
    expect(screen.getByText(/applied/)).toBeInTheDocument();
    fireEvent.click(screen.getByText('↺ Revert'));
    await vi.waitFor(() => expect(mockRevert).toHaveBeenCalledWith('s-1'));
  });

  it('renders empty states', () => {
    render(<RoleRefinementSettings config={CONFIG} suggestions={[]} tasks={{}} />);
    expect(screen.getByText('No pending suggestions.')).toBeInTheDocument();
    expect(screen.getByText('Nothing applied yet.')).toBeInTheDocument();
  });
});
