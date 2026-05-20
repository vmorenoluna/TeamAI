// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProviderConfigEditor } from '@/components/provider-config';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockGetAvailableModels = vi.fn();
const mockSaveProvidersConfig = vi.fn().mockResolvedValue(undefined);

vi.mock('@/app/actions/providers', () => ({
  getAvailableModels: (...args: unknown[]) => mockGetAvailableModels(...args),
  saveProvidersConfig: (...args: unknown[]) => mockSaveProvidersConfig(...args),
}));

// ── Fixtures ───────────────────────────────────────────────────────────

const DEFAULT_CONFIG = {
  default: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
  roles: {},
};

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

describe('ProviderConfigEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAvailableModels.mockResolvedValue({ models: CURATED_MODELS_ANTHROPIC, error: undefined });
  });

  // ── Rendering ───────────────────────────────────────────────────────

  it('renders default section and role overrides section', () => {
    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    expect(screen.getByText('Default (all roles)')).toBeInTheDocument();
    expect(screen.getByText('Role overrides')).toBeInTheDocument();
  });

  it('renders label for each role', () => {
    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText('planner')).toBeInTheDocument();
    expect(screen.getByText('coder')).toBeInTheDocument();
    expect(screen.getByText('qa-reviewer')).toBeInTheDocument();
    expect(screen.getByText('qa-fixer')).toBeInTheDocument();
    expect(screen.getByText('merger')).toBeInTheDocument();
  });

  it('calls getAvailableModels on mount with the default provider', async () => {
    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    await waitFor(() => {
      expect(mockGetAvailableModels).toHaveBeenCalledWith('anthropic', false);
    });
  });

  // ── Model select ────────────────────────────────────────────────────

  it('shows model select with options after models load', async () => {
    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    await waitFor(() => {
      const comboboxes = screen.getAllByRole('combobox');
      const modelSelect = findSelect(comboboxes, opts =>
        opts.some(o => o.value === 'claude-sonnet-4-6'),
      );
      expect(modelSelect).toBeTruthy();
    });
  });

  it('selects the current model in the dropdown', async () => {
    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    await waitFor(() => {
      const comboboxes = screen.getAllByRole('combobox');
      const modelSelect = findSelect(comboboxes, opts =>
        opts.some(o => o.value === 'claude-sonnet-4-6'),
      );
      expect(modelSelect).toBeTruthy();
      expect(modelSelect!.value).toBe('claude-sonnet-4-6');
    });
  });

  it('shows custom input when current model is not in the loaded list', async () => {
    const configWithCustomModel = {
      default: { model: 'my-custom-model-v1', provider: 'anthropic' },
      roles: {},
    };
    render(<ProviderConfigEditor config={configWithCustomModel} />);
    const customInput = await screen.findByPlaceholderText('Type a model name…');
    expect(customInput).toHaveValue('my-custom-model-v1');
  });

  // ── Provider select ─────────────────────────────────────────────────

  it('renders provider select with all providers', () => {
    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    expect(screen.getAllByRole('option', { name: 'anthropic' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('option', { name: 'openai' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('option', { name: 'bedrock' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('option', { name: 'vertex' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('option', { name: 'gemini' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('option', { name: 'ollama' }).length).toBeGreaterThanOrEqual(1);
  });

  // ── Refresh button ──────────────────────────────────────────────────

  it('calls getAvailableModels with refresh=true when refresh button is clicked', async () => {
    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);

    // Wait for initial load to complete so the refresh button is enabled
    await waitFor(() => {
      expect(screen.queryByText('Loading models…')).toBeNull();
    });

    const refreshButtons = screen.getAllByTitle('Refresh anthropic models');
    expect(refreshButtons.length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      fireEvent.click(refreshButtons[0]);
    });

    expect(mockGetAvailableModels).toHaveBeenCalledWith('anthropic', true);
  });

  // ── Custom model input ──────────────────────────────────────────────

  it('shows custom model input when "Custom…" is selected', async () => {
    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);

    // Wait for models to load and model select with __custom__ to appear
    const select = await screen.findByDisplayValue('claude-sonnet-4-6');
    expect(select.tagName).toBe('SELECT');

    // Select the "Custom…" option
    await act(async () => {
      fireEvent.change(select, { target: { value: '__custom__' } });
    });

    // Wait for the custom input to appear
    const customInput = await screen.findByPlaceholderText('Type a model name…');
    expect(customInput).toBeInTheDocument();
  });

  it('updates model when custom input is blurred', async () => {
    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);

    // Wait for select to render with current value
    const select = await screen.findByDisplayValue('claude-sonnet-4-6');
    expect(select.tagName).toBe('SELECT');

    // Select "Custom…"  and wait for re-render
    await act(async () => {
      fireEvent.change(select, { target: { value: '__custom__' } });
    });

    // Find custom input (use waitFor for robustness with React 19 async scheduling)
    const customInput = await screen.findByPlaceholderText('Type a model name…');

    expect(customInput).toBeInTheDocument();

    // Type and blur
    await act(async () => {
      fireEvent.change(customInput, { target: { value: 'my-custom-model' } });
      fireEvent.blur(customInput);
    });

    expect(customInput).toHaveValue('my-custom-model');
  });

  // ── Provider change ─────────────────────────────────────────────────

  it('reloads models when default provider is changed', async () => {
    mockGetAvailableModels
      .mockResolvedValueOnce({ models: CURATED_MODELS_ANTHROPIC, error: undefined })
      .mockResolvedValue({ models: ['gpt-4o', 'gpt-4o-mini'], error: undefined });

    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);

    await waitFor(() => {
      expect(mockGetAvailableModels).toHaveBeenCalledWith('anthropic', false);
    });

    // Find default provider select (first select without model options)
    const comboboxes = screen.getAllByRole('combobox');
    const providerSelect = findSelect(comboboxes, opts =>
      opts.every(o =>
        ['anthropic', 'bedrock', 'vertex', 'openai', 'gemini', 'ollama'].includes(o.value),
      ),
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

  // ── Error state ─────────────────────────────────────────────────────

  it('shows error state when model fetch fails', async () => {
    mockGetAvailableModels.mockResolvedValue({
      models: [],
      error: 'ANTHROPIC_API_KEY not set',
    });

    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);

    const inputs = await screen.findAllByPlaceholderText(
      /ANTHROPIC_API_KEY not set — type a model name/i,
    );
    expect(inputs.length).toBeGreaterThanOrEqual(1);
  });

  // ── Save button ─────────────────────────────────────────────────────

  it('renders save button', () => {
    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    expect(screen.getByText('Save Provider Config')).toBeInTheDocument();
  });

  it('calls saveProvidersConfig when save button is clicked', async () => {
    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    const saveButton = screen.getByText('Save Provider Config');
    await act(async () => {
      fireEvent.click(saveButton);
    });
    expect(mockSaveProvidersConfig).toHaveBeenCalledWith(DEFAULT_CONFIG);
  });

  it('shows "Saved!" text after saving', async () => {
    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    const saveButton = screen.getByText('Save Provider Config');
    await act(async () => {
      fireEvent.click(saveButton);
    });
    await waitFor(() => {
      expect(screen.getByText('Saved!')).toBeInTheDocument();
    });
  });

  // ── Loading state (last — avoids inflightFetches cache pollution) ───

  it('shows loading spinners while fetching models', async () => {
    // Use an immediately-resolving promise to avoid hanging async state
    let resolveLoading: (value: unknown) => void = () => {};
    const loadingPromise = new Promise(resolve => {
      resolveLoading = resolve;
    });

    mockGetAvailableModels.mockImplementation(() => loadingPromise);

    render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);

    const indicators = screen.getAllByText('Loading models…');
    expect(indicators).toHaveLength(6);

    // Resolve the loading so inflightFetches cleans up
    resolveLoading({ models: CURATED_MODELS_ANTHROPIC, error: undefined });
    await vi.waitFor(() => {
      expect(screen.queryByText('Loading models…')).toBeNull();
    });
  });


});
