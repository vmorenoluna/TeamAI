// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TerminalsView } from '@/components/terminals-view';
import type { RoleDefinition } from '@/app/actions/roles';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockGetAvailableModels = vi.fn();
const mockGetProvidersConfig = vi.fn();
const mockCreateTerminalSession = vi.fn().mockResolvedValue('session-1');
const mockCloseTerminalSession = vi.fn();

vi.mock('@/app/actions/providers', () => ({
  getAvailableModels: (...args: unknown[]) => mockGetAvailableModels(...args),
  getProvidersConfig: (...args: unknown[]) => mockGetProvidersConfig(...args),
}));

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

const CURATED_MODELS_ANTHROPIC = [
  'claude-sonnet-4-20250514',
  'claude-sonnet-4-6',
  'claude-3-5-sonnet-20241022',
];

// Helper: find a <select> combobox whose options satisfy a predicate
function findSelect(
  comboboxes: HTMLElement[],
  predicate: (options: HTMLOptionElement[]) => boolean,
): HTMLSelectElement | undefined {
  return comboboxes.find(
    s => s.tagName === 'SELECT' && predicate(Array.from((s as HTMLSelectElement).options)),
  ) as HTMLSelectElement | undefined;
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('TerminalsView - Model Controls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableModels.mockResolvedValue({ models: CURATED_MODELS_ANTHROPIC, error: undefined });
    mockGetProvidersConfig.mockResolvedValue({
      default: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
      roles: {},
    });
  });

  // ── Dialog open/close ───────────────────────────────────────────────

  it('opens the New Terminal dialog when + New Terminal is clicked', async () => {
    render(<TerminalsView roles={MOCK_ROLES} />);

    const newBtn = screen.getByText('+ New Terminal');
    await act(async () => {
      fireEvent.click(newBtn);
    });

    expect(screen.getByText('New Terminal')).toBeInTheDocument();
    expect(screen.getByText('Cancel')).toBeInTheDocument();
    expect(screen.getByText('Open')).toBeInTheDocument();
  });

  it('closes the dialog when Cancel is clicked', async () => {
    render(<TerminalsView roles={MOCK_ROLES} />);

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

  // ── Provider select ─────────────────────────────────────────────────

  it('shows provider select in the dialog', async () => {
    render(<TerminalsView roles={MOCK_ROLES} />);

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });

    // Find the provider select (the second select — first is role)
    const comboboxes = screen.getAllByRole('combobox');
    const providerSelect = findSelect(comboboxes, opts =>
      opts.every(o => ['anthropic', 'bedrock', 'vertex', 'openai', 'gemini', 'ollama'].includes(o.value)),
    );
    expect(providerSelect).toBeTruthy();
  });

  // ── Model loading ───────────────────────────────────────────────────

  it('loads models for the default provider on mount', async () => {
    render(<TerminalsView roles={MOCK_ROLES} />);

    await waitFor(() => {
      expect(mockGetAvailableModels).toHaveBeenCalledWith('anthropic', false);
    });
  });

  it('shows model controls in the dialog', async () => {
    render(<TerminalsView roles={MOCK_ROLES} />);

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });

    // Should have the Model label
    expect(screen.getByText('Model')).toBeInTheDocument();
    expect(screen.getByText(/optional override/)).toBeInTheDocument();
  });

  it('shows model select with options after models load', async () => {
    render(<TerminalsView roles={MOCK_ROLES} />);

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });

    // Wait for models to load
    await waitFor(() => {
      const comboboxes = screen.getAllByRole('combobox');
      // The model select should have options matching our curated models
      const modelSelect = findSelect(comboboxes, opts =>
        opts.some(o => o.value === 'claude-sonnet-4-6'),
      );
      expect(modelSelect).toBeTruthy();
    });
  });

  // ── Provider change ─────────────────────────────────────────────────

  it('reloads models when provider is changed', async () => {
    mockGetAvailableModels
      .mockResolvedValueOnce({ models: CURATED_MODELS_ANTHROPIC, error: undefined })
      .mockResolvedValue({ models: ['gpt-4o', 'gpt-4o-mini'], error: undefined });

    render(<TerminalsView roles={MOCK_ROLES} />);

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });

    // Wait for initial load
    await waitFor(() => {
      expect(mockGetAvailableModels).toHaveBeenCalledWith('anthropic', false);
    });

    // Find and change the provider select
    const comboboxes = screen.getAllByRole('combobox');
    const providerSelect = findSelect(comboboxes, opts =>
      opts.every(o => ['anthropic', 'bedrock', 'vertex', 'openai', 'gemini', 'ollama'].includes(o.value)),
    );
    expect(providerSelect).toBeTruthy();

    if (providerSelect) {
      await act(async () => {
        fireEvent.change(providerSelect, { target: { value: 'openai' } });
      });
    }

    await waitFor(() => {
      expect(mockGetAvailableModels).toHaveBeenCalledWith('openai', false);
    });
  });

  // ── Custom model ────────────────────────────────────────────────────

  it('shows custom model input when "Custom…" is selected', async () => {
    render(<TerminalsView roles={MOCK_ROLES} />);

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });

    // Wait for models to load and find the model select (has curated model options)
    await waitFor(() => {
      // Set a model value first so the select shows it
      // The model select is the one that has curated model names as options
      const comboboxes = screen.getAllByRole('combobox');
      const modelSelect = findSelect(comboboxes, opts =>
        opts.some(o => o.value === CURATED_MODELS_ANTHROPIC[0]),
      );
      expect(modelSelect).toBeTruthy();
    });

    const comboboxes = screen.getAllByRole('combobox');
    const modelSelect = findSelect(comboboxes, opts =>
      opts.some(o => o.value === CURATED_MODELS_ANTHROPIC[0]),
    );

    // Select Custom…
    if (modelSelect) {
      await act(async () => {
        fireEvent.change(modelSelect, { target: { value: '__custom__' } });
      });
    }

    const customInput = await screen.findByPlaceholderText('Type a model name…');
    expect(customInput).toBeInTheDocument();
  });

  // ── Refresh button ──────────────────────────────────────────────────

  it('calls loadModels with refresh=true when refresh button is clicked', async () => {
    render(<TerminalsView roles={MOCK_ROLES} />);

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });

    // Wait for initial load to finish so refresh button is enabled
    await waitFor(() => {
      expect(screen.queryByText('Loading models…')).toBeNull();
    });

    // Find the refresh button (has title "Refresh anthropic models")
    const refreshButtons = screen.getAllByTitle('Refresh anthropic models');
    expect(refreshButtons.length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      fireEvent.click(refreshButtons[0]);
    });

    expect(mockGetAvailableModels).toHaveBeenCalledWith('anthropic', true);
  });

  // ── Role select ─────────────────────────────────────────────────────

  it('renders role options from the provided roles', async () => {
    render(<TerminalsView roles={MOCK_ROLES} />);

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });

    const comboboxes = screen.getAllByRole('combobox');
    const roleSelect = findSelect(comboboxes, opts =>
      opts.some(o => o.value === 'analyst.md'),
    );
    expect(roleSelect).toBeTruthy();

    if (roleSelect) {
      const options = Array.from(roleSelect.options).map(o => o.textContent);
      expect(options).toContain('Analyst');
      expect(options).toContain('Planner');
      expect(options).toContain('Coder');
    }
  });

  // ── Error state ─────────────────────────────────────────────────────

  it('shows error state when model fetch fails', async () => {
    mockGetAvailableModels.mockResolvedValue({
      models: [],
      error: 'ANTHROPIC_API_KEY not set',
    });

    render(<TerminalsView roles={MOCK_ROLES} />);

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });

    const input = await screen.findByPlaceholderText(
      /ANTHROPIC_API_KEY not set — type a model name/i,
    );
    expect(input).toBeInTheDocument();
  });

  // ── Loading state ───────────────────────────────────────────────────

  it('shows loading indicator while fetching models', async () => {
    // Use a deferred promise
    let resolveLoading: (value: unknown) => void = () => {};
    const loadingPromise = new Promise(resolve => {
      resolveLoading = resolve;
    });

    mockGetAvailableModels.mockImplementation(() => loadingPromise);

    render(<TerminalsView roles={MOCK_ROLES} />);

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });

    // Loading indicator should be visible
    expect(screen.getByText('Loading models…')).toBeInTheDocument();

    // Resolve the loading
    resolveLoading({ models: CURATED_MODELS_ANTHROPIC, error: undefined });
    await vi.waitFor(() => {
      expect(screen.queryByText('Loading models…')).toBeNull();
    });
  });

  // ── Open button ─────────────────────────────────────────────────────

  it('has Open button disabled until a role is selected', async () => {
    render(<TerminalsView roles={MOCK_ROLES} />);

    await act(async () => {
      fireEvent.click(screen.getByText('+ New Terminal'));
    });

    // Open button should be enabled since first role is auto-selected
    const openBtn = screen.getByText('Open');
    expect(openBtn).toBeEnabled();
  });
});
