// @vitest-environment happy-dom

/**
 * Unit tests for TerminalsView component.
 *
 * Tests terminal listing, role selection, dialog controls,
 * session creation/closure, and edge cases.
 *
 * Uses vi.resetModules() between tests to reset the component's module-level
 * state, ensuring each test starts with a clean state.
 *
 * React's useTransition is mocked (isPending=false, synchronous callback).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { RoleDefinition } from '@/app/actions/roles';

// ── Hoisted mocks (survive vi.resetModules) ─────────────────────────────────

const mockCreateTerminalSession = vi.hoisted(() => vi.fn());
const mockCloseTerminalSession = vi.hoisted(() => vi.fn());
const mockStartTransition = vi.hoisted(() =>
  vi.fn((cb: () => void) => {
    try { const r = cb() as unknown; if (r instanceof Promise) r.catch(() => {}); } catch { /* suppress */ }
  })
);

vi.mock('@/app/actions/terminals', () => ({
  createTerminalSession: (...a: unknown[]) => mockCreateTerminalSession(...a),
  closeTerminalSession: (...a: unknown[]) => mockCloseTerminalSession(...a),
}));

vi.mock('@/components/terminal-panel', () => ({
  TerminalPanel: ({ sessionId, role, model, onClose }: { sessionId: string; role: string; model: string; onClose: () => void }) => (
    <div data-testid="terminal-panel" data-session-id={sessionId} data-role={role} data-model={model}>
      <button data-testid="close-terminal" onClick={onClose}>Close</button>
    </div>
  ),
}));

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next/link', () => ({
  default: ({ href, children, className }: { href: string; children: React.ReactNode; className?: string }) => (
    <a href={href} className={className}>{children}</a>
  ),
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return { ...actual, useTransition: () => [false, mockStartTransition] };
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeRoles(): RoleDefinition[] {
  return [
    { filename: 'analyst.md', name: 'Analyst', content: '# Role: Analyst' },
    { filename: 'coder.md', name: 'Coder', content: '# Role: Coder' },
    { filename: 'qa-reviewer.md', name: 'QA Reviewer', content: '# Role: QA Reviewer' },
  ];
}

/** Renders TerminalsView with fresh module imports */
async function renderView(roles?: RoleDefinition[]) {
  const mod = await import('@/components/terminals-view');
  render(<mod.TerminalsView roles={roles ?? makeRoles()} />);
  await act(async () => { await new Promise(r => setTimeout(r, 100)); });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('TerminalsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCreateTerminalSession.mockResolvedValue({ sessionId: 'sess-1', role: 'analyst.md', model: 'claude-sonnet-4-6' });
    mockCloseTerminalSession.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  // ── Initial render ───────────────────────────────────────────────────

  describe('initial render', () => {
    it('renders header, subtitle, and + New Terminal button', async () => {
      await renderView();
      expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Terminals');
      expect(screen.getByText('Interactive Claude sessions pre-loaded with a role persona.')).toBeInTheDocument();
      expect(screen.getByTestId('new-terminal-btn')).toHaveTextContent('+ New Terminal');
    });

    it('shows empty state when no terminals exist', async () => {
      await renderView();
      expect(screen.getByText('Click "+ New Terminal" to open an interactive Claude session.')).toBeInTheDocument();
    });
  });

  // ── Dialog ───────────────────────────────────────────────────────────

  describe('dialog', () => {
    it('opens on + New Terminal click and shows Role, Cancel, Open', async () => {
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      expect(screen.getByText('New Terminal')).toBeInTheDocument();
      expect(screen.getByText('Role')).toBeInTheDocument();
      expect(screen.getByText('Cancel')).toBeInTheDocument();
      expect(screen.getByText('Open')).toBeInTheDocument();
    });

    it('closes on Cancel', async () => {
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      fireEvent.click(screen.getByText('Cancel'));
      expect(screen.queryByText('New Terminal')).not.toBeInTheDocument();
    });

    it('closes on backdrop click', async () => {
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      fireEvent.click(screen.getByTestId('dialog-backdrop'));
      expect(screen.queryByText('New Terminal')).not.toBeInTheDocument();
    });
  });

  // ── Role selection ───────────────────────────────────────────────────

  describe('role', () => {
    it('shows all roles from props', async () => {
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      const roleSelect = document.querySelector('select') as HTMLSelectElement;
      expect(roleSelect.options).toHaveLength(3);
      expect(screen.getByText('Analyst')).toBeInTheDocument();
      expect(screen.getByText('Coder')).toBeInTheDocument();
      expect(screen.getByText('QA Reviewer')).toBeInTheDocument();
    });

    it('disables Open button when no roles', async () => {
      await renderView([]);
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      expect((screen.getByText('Open') as HTMLButtonElement).disabled).toBe(true);
    });
  });

  // ── Terminal CRUD ────────────────────────────────────────────────────

  describe('terminal operations', () => {
    it('creates a terminal session with the selected role', async () => {
      mockCreateTerminalSession.mockResolvedValue({ sessionId: 'sess-xyz', role: 'analyst.md', model: 'claude-opus-4-8' });
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await act(async () => { fireEvent.click(screen.getByText('Open')); });
      expect(mockCreateTerminalSession).toHaveBeenCalledWith('analyst.md');
    });

    it('closes dialog after creation', async () => {
      mockCreateTerminalSession.mockResolvedValue({ sessionId: 'sess-1', role: 'analyst.md', model: 'claude-sonnet-4-6' });
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await act(async () => { fireEvent.click(screen.getByText('Open')); });
      await waitFor(() => expect(screen.queryByText('New Terminal')).not.toBeInTheDocument());
    });

    it('adds panel to grid', async () => {
      mockCreateTerminalSession.mockResolvedValue({ sessionId: 'sess-abc', role: 'analyst.md', model: 'claude-sonnet-4-6' });
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await act(async () => { fireEvent.click(screen.getByText('Open')); });
      await waitFor(() => {
        const panels = screen.getAllByTestId('terminal-panel');
        expect(panels).toHaveLength(1);
        expect(panels[0].getAttribute('data-session-id')).toBe('sess-abc');
      });
    });

    it('passes role and model to TerminalPanel', async () => {
      mockCreateTerminalSession.mockResolvedValue({ sessionId: 'sess-role', role: 'coder.md', model: 'claude-opus-4-8' });
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await act(async () => { fireEvent.click(screen.getByText('Open')); });
      await waitFor(() => {
        expect(screen.getByTestId('terminal-panel').getAttribute('data-role')).toBe('coder.md');
        expect(screen.getByTestId('terminal-panel').getAttribute('data-model')).toBe('claude-opus-4-8');
      });
    });
  });

  // ── Terminal closing ─────────────────────────────────────────────────

  describe('terminal closing', () => {
    it('removes from grid and calls closeTerminalSession', async () => {
      mockCreateTerminalSession.mockResolvedValue({ sessionId: 'sess-close', role: 'analyst.md', model: 'claude-sonnet-4-6' });
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await act(async () => { fireEvent.click(screen.getByText('Open')); });
      await waitFor(() => expect(screen.getByTestId('terminal-panel')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('close-terminal'));
      expect(mockCloseTerminalSession).toHaveBeenCalledWith('sess-close');
      await waitFor(() => expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument());
    });

    it('handles closeTerminalSession rejection', async () => {
      mockCloseTerminalSession.mockRejectedValue(new Error('Already closed'));
      mockCreateTerminalSession.mockResolvedValue({ sessionId: 'sess-ignore', role: 'analyst.md', model: 'claude-sonnet-4-6' });
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await act(async () => { fireEvent.click(screen.getByText('Open')); });
      await waitFor(() => expect(screen.getByTestId('terminal-panel')).toBeInTheDocument());
      fireEvent.click(screen.getByTestId('close-terminal'));
      await waitFor(() => expect(screen.queryByTestId('terminal-panel')).not.toBeInTheDocument());
    });
  });

  // ── Multiple terminals ───────────────────────────────────────────────

  describe('multiple terminals', () => {
    it('can create two and close one', async () => {
      let c = 0;
      mockCreateTerminalSession.mockImplementation(() => Promise.resolve({ sessionId: `sess-${++c}`, role: 'analyst.md', model: 'claude-sonnet-4-6' }));
      await renderView();

      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await act(async () => { fireEvent.click(screen.getByText('Open')); });
      await waitFor(() => expect(screen.getAllByTestId('terminal-panel')).toHaveLength(1));

      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await act(async () => { fireEvent.click(screen.getByText('Open')); });
      await waitFor(() => expect(screen.getAllByTestId('terminal-panel')).toHaveLength(2));

      fireEvent.click(screen.getAllByTestId('close-terminal')[0]);
      await waitFor(() => expect(screen.getAllByTestId('terminal-panel')).toHaveLength(1));
    });
  });
});
