// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TerminalsView } from '@/components/terminals-view';
import { TerminalSessionsProvider } from '@/components/terminal-sessions-provider';
import type { RoleDefinition } from '@/app/actions/roles';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockCreateTerminalSession = vi.fn().mockResolvedValue({ sessionId: 'session-1', role: 'analyst.md', model: 'claude-sonnet-4-6' });
const mockCloseTerminalSession = vi.fn();

vi.mock('@/app/actions/terminals', () => ({
  createTerminalSession: (...args: unknown[]) => mockCreateTerminalSession(...args),
  closeTerminalSession: (...args: unknown[]) => mockCloseTerminalSession(...args),
}));

// ── Fixtures ───────────────────────────────────────────────────────────

vi.mock('@/components/terminal-panel', () => ({
  TerminalPanel: ({ sessionId, role, model }: { sessionId: string; role: string; model: string }) => (
    <div data-component="terminal-panel" data-session-id={sessionId} data-role={role} data-model={model} />
  ),
}));

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
      render(
        <TerminalSessionsProvider initialTerminals={[]}>
          <TerminalsView roles={MOCK_ROLES} />
        </TerminalSessionsProvider>,
      );
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
      render(
        <TerminalSessionsProvider initialTerminals={[]}>
          <TerminalsView roles={MOCK_ROLES} />
        </TerminalSessionsProvider>,
      );
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
      render(
        <TerminalSessionsProvider initialTerminals={[]}>
          <TerminalsView roles={MOCK_ROLES} />
        </TerminalSessionsProvider>,
      );
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
      render(
        <TerminalSessionsProvider initialTerminals={[]}>
          <TerminalsView roles={MOCK_ROLES} />
        </TerminalSessionsProvider>,
      );
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
      render(
        <TerminalSessionsProvider initialTerminals={[]}>
          <TerminalsView roles={MOCK_ROLES} />
        </TerminalSessionsProvider>,
      );
    });

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Open'));
    });

    expect(mockCreateTerminalSession).toHaveBeenCalledWith('analyst.md');
  });

  it('keeps terminal sessions when the terminals view is unmounted and remounted', async () => {
    mockCreateTerminalSession.mockResolvedValue({ sessionId: 'session-persisted', role: 'analyst.md', model: 'claude-sonnet-4-6' });
    function Route({ showTerminals }: { showTerminals: boolean }) {
      return showTerminals ? <TerminalsView roles={MOCK_ROLES} /> : <div>Kanban page</div>;
    }

    const { rerender } = render(
      <TerminalSessionsProvider initialTerminals={[]}>
        <Route showTerminals />
      </TerminalSessionsProvider>,
    );

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });
    await act(async () => {
      fireEvent.click(screen.getByText('Open'));
    });

    await act(async () => {
      rerender(
        <TerminalSessionsProvider initialTerminals={[]}>
          <Route showTerminals={false} />
        </TerminalSessionsProvider>,
      );
    });
    expect(screen.getByText('Kanban page')).toBeInTheDocument();

    await act(async () => {
      rerender(
        <TerminalSessionsProvider initialTerminals={[]}>
          <Route showTerminals />
        </TerminalSessionsProvider>,
      );
    });

    expect(screen.getByTestId('terminal-panel')).toHaveAttribute('data-session-id', 'session-persisted');
    expect(mockCreateTerminalSession).toHaveBeenCalledTimes(1);
  });
});
