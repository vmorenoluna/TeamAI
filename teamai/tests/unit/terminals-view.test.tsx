// @vitest-environment happy-dom

/**
 * Unit tests for TerminalsView component.
 *
 * Tests terminal listing, provider selection, model selection, dialog controls,
 * session creation/closure, and error states.
 *
 * Uses vi.resetModules() between tests to reset the component's module-level
 * inflightFetches cache, ensuring each test starts with a clean state.
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
const mockGetAvailableModels = vi.hoisted(() => vi.fn());
const mockGetProvidersConfig = vi.hoisted(() => vi.fn());
const mockStartTransition = vi.hoisted(() =>
  vi.fn((cb: () => void) => {
    try { const r = cb() as unknown; if (r instanceof Promise) r.catch(() => {}); } catch { /* suppress */ }
  })
);

vi.mock('@/app/actions/terminals', () => ({
  createTerminalSession: (...a: unknown[]) => mockCreateTerminalSession(...a),
  closeTerminalSession: (...a: unknown[]) => mockCloseTerminalSession(...a),
}));

vi.mock('@/app/actions/providers', () => ({
  getAvailableModels: (...a: unknown[]) => mockGetAvailableModels(...a),
  getProvidersConfig: (...a: unknown[]) => mockGetProvidersConfig(...a),
}));

vi.mock('@/components/terminal-panel', () => ({
  TerminalPanel: ({ sessionId, role, onClose }: { sessionId: string; role: string; onClose: () => void }) => (
    <div data-testid="terminal-panel" data-session-id={sessionId} data-role={role}>
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

function sampleModels(): string[] {
  return ['claude-sonnet-4-6', 'claude-opus-4-5', 'claude-haiku-4-1'];
}

function getSelect(index: number): HTMLSelectElement {
  return document.querySelectorAll('select')[index] as HTMLSelectElement;
}

/** Renders TerminalsView with fresh module imports (resets inflightFetches cache) */
async function renderView(roles?: RoleDefinition[]) {
  const mod = await import('@/components/terminals-view');
  render(<mod.TerminalsView roles={roles ?? makeRoles()} />);
  // Flush pending async effects
  await act(async () => { await new Promise(r => setTimeout(r, 100)); });
}

/** Open dialog and wait for 3 selects (model loaded) */
async function openDialogAndWait() {
  fireEvent.click(screen.getByTestId('new-terminal-btn'));
  await waitFor(() => {
    expect(document.querySelectorAll('select').length).toBe(3);
  }, { timeout: 5000 });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('TerminalsView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableModels.mockResolvedValue({ models: sampleModels() });
    mockGetProvidersConfig.mockResolvedValue({ default: { model: 'claude-sonnet-4-6', provider: 'anthropic' }, roles: {} });
    mockCreateTerminalSession.mockResolvedValue('sess-1');
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
      expect(getSelect(0).options).toHaveLength(3);
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

  // ── Provider ─────────────────────────────────────────────────────────

  describe('provider', () => {
    it('renders 6 providers, defaults to anthropic', async () => {
      mockGetProvidersConfig.mockResolvedValue({ default: { model: '', provider: '' }, roles: {} });
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      const ps = getSelect(1);
      expect(ps.options).toHaveLength(6);
      expect(ps.value).toBe('anthropic');
    });

    it('switching provider triggers fetch', async () => {
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await openDialogAndWait();
      mockGetAvailableModels.mockClear();

      fireEvent.change(getSelect(1), { target: { value: 'gemini' } });
      await waitFor(() => {
        expect(mockGetAvailableModels).toHaveBeenCalledWith('gemini', false);
      });
    });
  });

  // ── Model loading ────────────────────────────────────────────────────

  describe('model loading', () => {
    it('shows spinner while fetching', async () => {
      mockGetAvailableModels.mockReturnValue(new Promise(() => {}));
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      expect(screen.getByText('Loading models…')).toBeInTheDocument();
    });

    it('renders model select with options when loaded', async () => {
      await renderView();
      await openDialogAndWait();
      const ms = getSelect(2);
      const vals = Array.from(ms.options).map(o => o.value);
      expect(vals).toEqual(expect.arrayContaining(['claude-sonnet-4-6', 'claude-opus-4-5', 'claude-haiku-4-1']));
      const last = ms.options[ms.options.length - 1];
      expect(last.value).toBe('__custom__');
    });
  });

  // ── Model selection ──────────────────────────────────────────────────

  describe('model selection', () => {
    it('selects a model from dropdown', async () => {
      await renderView();
      await openDialogAndWait();
      const ms = getSelect(2);
      fireEvent.change(ms, { target: { value: 'claude-opus-4-5' } });
      expect(ms.value).toBe('claude-opus-4-5');
    });
  });

  // ── Custom model ─────────────────────────────────────────────────────

  describe('custom model', () => {
    it('shows input after selecting Custom…', async () => {
      await renderView();
      await openDialogAndWait();
      fireEvent.change(getSelect(2), { target: { value: '__custom__' } });
      expect(screen.getByPlaceholderText('Type a model name…')).toBeInTheDocument();
    });

    it('Enter key on custom input sets value', async () => {
      await renderView();
      await openDialogAndWait();
      fireEvent.change(getSelect(2), { target: { value: '__custom__' } });
      const inp = screen.getByPlaceholderText('Type a model name…');
      fireEvent.change(inp, { target: { value: 'my-model-v2' } });
      fireEvent.keyDown(inp, { key: 'Enter' });
      await waitFor(() => expect(screen.getByDisplayValue('my-model-v2')).toBeInTheDocument());
    });

    it('blur on custom input sets value', async () => {
      await renderView();
      await openDialogAndWait();
      fireEvent.change(getSelect(2), { target: { value: '__custom__' } });
      const inp = screen.getByPlaceholderText('Type a model name…');
      fireEvent.change(inp, { target: { value: 'blur-model' } });
      fireEvent.blur(inp);
      expect(screen.getByDisplayValue('blur-model')).toBeInTheDocument();
    });
  });

  // ── Refresh ──────────────────────────────────────────────────────────

  describe('refresh', () => {
    it('refresh button calls getAvailableModels(true)', async () => {
      await renderView();
      await openDialogAndWait();
      mockGetAvailableModels.mockClear();
      fireEvent.click(screen.getByTitle('Refresh anthropic models'));
      await waitFor(() => {
        expect(mockGetAvailableModels).toHaveBeenCalledWith('anthropic', true);
      });
    });
  });

  // ── Error states ─────────────────────────────────────────────────────

  describe('error states', () => {
    it('free text input when no models', async () => {
      mockGetAvailableModels.mockResolvedValue({ models: [] });
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await waitFor(() => {
        expect(screen.getByPlaceholderText('Type a model name…')).toBeInTheDocument();
      }, { timeout: 3000 });
    });

    it('error in placeholder when fetch fails', async () => {
      mockGetAvailableModels.mockResolvedValue({ models: [], error: 'API key not set' });
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await waitFor(() => {
        expect(screen.getByPlaceholderText('API key not set — type a model name')).toBeInTheDocument();
      }, { timeout: 3000 });
    });

    it('fallback input when fetch throws', async () => {
      // Suppress vitest unhandled-rejection by pre-catching the rejection
      const err = new Error('Network failure');
      const rej = Promise.reject(err); rej.catch(() => {});
      mockGetAvailableModels.mockRejectedValue(err);
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await waitFor(() => {
        expect(screen.getByPlaceholderText(/Failed to fetch models/)).toBeInTheDocument();
      }, { timeout: 3000 });
    });
  });

  // ── Terminal CRUD ────────────────────────────────────────────────────

  describe('terminal operations', () => {
    it('creates with role + model', async () => {
      mockCreateTerminalSession.mockResolvedValue('sess-xyz');
      await renderView();
      await openDialogAndWait();
      fireEvent.change(getSelect(2), { target: { value: 'claude-opus-4-5' } });
      await act(async () => { fireEvent.click(screen.getByText('Open')); });
      expect(mockCreateTerminalSession).toHaveBeenCalledWith('analyst.md', 'claude-opus-4-5');
    });

    it('creates with custom model', async () => {
      await renderView();
      await openDialogAndWait();
      fireEvent.change(getSelect(2), { target: { value: '__custom__' } });
      fireEvent.change(screen.getByPlaceholderText('Type a model name…'), { target: { value: 'gpt-5-turbo' } });
      fireEvent.blur(screen.getByPlaceholderText('Type a model name…'));
      await act(async () => { fireEvent.click(screen.getByText('Open')); });
      expect(mockCreateTerminalSession).toHaveBeenCalledWith('analyst.md', 'gpt-5-turbo');
    });

    it('creates without model', async () => {
      mockCreateTerminalSession.mockResolvedValue('sess-no-model');
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await act(async () => { fireEvent.click(screen.getByText('Open')); });
      expect(mockCreateTerminalSession).toHaveBeenCalledWith('analyst.md', undefined);
    });

    it('closes dialog after creation', async () => {
      mockCreateTerminalSession.mockResolvedValue('sess-1');
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await act(async () => { fireEvent.click(screen.getByText('Open')); });
      await waitFor(() => expect(screen.queryByText('New Terminal')).not.toBeInTheDocument());
    });

    it('adds panel to grid', async () => {
      mockCreateTerminalSession.mockResolvedValue('sess-abc');
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await act(async () => { fireEvent.click(screen.getByText('Open')); });
      await waitFor(() => {
        const panels = screen.getAllByTestId('terminal-panel');
        expect(panels).toHaveLength(1);
        expect(panels[0].getAttribute('data-session-id')).toBe('sess-abc');
      });
    });

    it('passes role to TerminalPanel', async () => {
      mockCreateTerminalSession.mockResolvedValue('sess-role');
      await renderView();
      fireEvent.click(screen.getByTestId('new-terminal-btn'));
      await act(async () => { fireEvent.click(screen.getByText('Open')); });
      await waitFor(() => {
        expect(screen.getByTestId('terminal-panel').getAttribute('data-role')).toBe('analyst.md');
      });
    });
  });

  // ── Terminal closing ─────────────────────────────────────────────────

  describe('terminal closing', () => {
    it('removes from grid and calls closeTerminalSession', async () => {
      mockCreateTerminalSession.mockResolvedValue('sess-close');
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
      mockCreateTerminalSession.mockResolvedValue('sess-ignore');
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
      mockCreateTerminalSession.mockImplementation(() => Promise.resolve(`sess-${++c}`));
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

  // ── Edge cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles getProvidersConfig rejection', async () => {
      mockGetProvidersConfig.mockRejectedValue(new Error('No project'));
      await renderView();
      expect(screen.getByText('Terminals')).toBeInTheDocument();
    });
  });
});
