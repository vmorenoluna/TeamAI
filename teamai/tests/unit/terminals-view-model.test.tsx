// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TerminalsView } from '@/components/terminals-view';
import type { RoleDefinition } from '@/app/actions/roles';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockCreateTerminalSession = vi.fn().mockResolvedValue({ sessionId: 'session-1', role: 'analyst.md', model: 'claude-sonnet-4-6' });
const mockCloseTerminalSession = vi.fn();

vi.mock('@/app/actions/terminals', () => ({
  createTerminalSession: (...args: unknown[]) => mockCreateTerminalSession(...args),
  closeTerminalSession: (...args: unknown[]) => mockCloseTerminalSession(...args),
}));

// ── Fixtures ───────────────────────────────────────────────────────────

const MOCK_ROLES: RoleDefinition[] = [
  { filename: 'analyst.md', name: 'Analyst', content: '# Role: Analyst\n\nAnalyze requirements.' },
  { filename: 'planner.md', name: 'Planner', content: '# Role: Planner\n\nPlan implementation.' },
  { filename: 'coder.md', name: 'Coder', content: '# Role: Coder\n\nWrite code.' },
];

// ── Tests ──────────────────────────────────────────────────────────────

describe('TerminalsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Dialog open/close ───────────────────────────────────────────────

  it('opens the New Terminal dialog when + New Terminal is clicked', async () => {
    act(() => {
      render(<TerminalsView roles={MOCK_ROLES} />);
    });

    const newBtn = screen.getByText('+ New Terminal');
    await act(async () => {
      fireEvent.click(newBtn);
    });

    expect(screen.getByText('New Terminal')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('closes the dialog when Cancel is clicked', async () => {
    act(() => {
      render(<TerminalsView roles={MOCK_ROLES} />);
    });

    // Open dialog
    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });
    expect(screen.getByText('New Terminal')).toBeInTheDocument();

    // Close with Cancel
    await act(async () => {
      fireEvent.click(screen.getByText('Cancel'));
    });
    expect(screen.queryByText('New Terminal')).not.toBeInTheDocument();
  });

  // ── Role select ─────────────────────────────────────────────────────

  it('renders role options from the provided roles', async () => {
    act(() => {
      render(<TerminalsView roles={MOCK_ROLES} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });

    const roleSelect = document.querySelector('select') as HTMLSelectElement;
    expect(roleSelect).toBeTruthy();
    const options = Array.from(roleSelect.options).map(o => o.textContent);
    expect(options).toContain('Analyst');
    expect(options).toContain('Planner');
    expect(options).toContain('Coder');
  });

  // ── Open button ─────────────────────────────────────────────────────

  it('has Open button enabled when a role is auto-selected', async () => {
    act(() => {
      render(<TerminalsView roles={MOCK_ROLES} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });

    const openBtn = screen.getByText('Open');
    expect(openBtn).toBeEnabled();
  });

  // ── Terminal creation ───────────────────────────────────────────────

  it('creates a terminal session with the selected role', async () => {
    mockCreateTerminalSession.mockResolvedValue({ sessionId: 'session-1', role: 'analyst.md', model: 'claude-sonnet-4-6' });
    act(() => {
      render(<TerminalsView roles={MOCK_ROLES} />);
    });

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Open'));
    });

    expect(mockCreateTerminalSession).toHaveBeenCalledWith('analyst.md');
  });
});
