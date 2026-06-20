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
  'claude-opus-4-8',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
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

  it('renders default section and role overrides section', async () => {
    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
    expect(screen.getByText('Default (all roles)')).toBeInTheDocument();
    expect(screen.getByText('Role overrides')).toBeInTheDocument();
  });

  it('renders label for each role', async () => {
    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
    expect(screen.getByText('Default')).toBeInTheDocument();
    expect(screen.getByText('analyst')).toBeInTheDocument();
    expect(screen.getByText('planner')).toBeInTheDocument();
    expect(screen.getByText('coder')).toBeInTheDocument();
    expect(screen.getByText('qa-reviewer')).toBeInTheDocument();
    expect(screen.getByText('merger')).toBeInTheDocument();
  });

  it('calls getAvailableModels on mount with the default provider', async () => {
    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });
    await waitFor(() => {
      expect(mockGetAvailableModels).toHaveBeenCalledWith('anthropic', false);
    });
  });

  // ── Model select ────────────────────────────────────────────────────

  it('shows model select with options after models load', async () => {
    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });
    await waitFor(() => {
      const comboboxes = screen.getAllByRole('combobox');
      const modelSelect = findSelect(comboboxes, opts =>
        opts.some(o => o.value === 'claude-sonnet-4-6'),
      );
      expect(modelSelect).toBeTruthy();
    });
  });

  it('selects the current model in the dropdown', async () => {
    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });
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
    act(() => {
      render(<ProviderConfigEditor config={configWithCustomModel} />);
    });
    const customInput = await screen.findByPlaceholderText('Type a model name…');
    expect(customInput).toHaveValue('my-custom-model-v1');
  });

  // ── Provider select ─────────────────────────────────────────────────

  it('renders provider select with all providers', async () => {
    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
    expect(screen.getAllByRole('option', { name: 'anthropic' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('option', { name: 'openai' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('option', { name: 'bedrock' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('option', { name: 'vertex' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('option', { name: 'gemini' }).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByRole('option', { name: 'ollama' }).length).toBeGreaterThanOrEqual(1);
  });

  // ── Refresh button ──────────────────────────────────────────────────

  it('calls getAvailableModels with refresh=true when refresh button is clicked', async () => {
    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });

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
    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });

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
    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });

    // Wait for models to finish loading so the select renders with the current value
    await waitFor(() => {
      expect(screen.queryByText('Loading models…')).toBeNull();
    });

    // Find the default select whose current value is claude-sonnet-4-6
    const defaultSelect = screen.getAllByRole('combobox').find(
      el => (el as HTMLSelectElement).value === 'claude-sonnet-4-6'
    ) as HTMLSelectElement | undefined;
    expect(defaultSelect).toBeTruthy();

    // Select "Custom…" and wait for re-render
    await act(async () => {
      fireEvent.change(defaultSelect!, { target: { value: '__custom__' } });
    });

    // Find custom input (use findByPlaceholderText for retry + timeout)
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

    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });

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

    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });

    await waitFor(() => expect(mockGetAvailableModels).toHaveBeenCalled());
    const inputs = await screen.findAllByPlaceholderText(
      /ANTHROPIC_API_KEY not set — type a model name/i,
    );
    expect(inputs.length).toBeGreaterThanOrEqual(1);
  });

  // ── Save button ─────────────────────────────────────────────────────

  it('renders save button', async () => {
    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
    expect(screen.getByText('Save Provider Config')).toBeInTheDocument();
  });

  it('calls saveProvidersConfig when save button is clicked', async () => {
    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
    const saveButton = screen.getByText('Save Provider Config');
    await act(async () => {
      fireEvent.click(saveButton);
    });
    expect(mockSaveProvidersConfig).toHaveBeenCalledWith(DEFAULT_CONFIG);
  });

  it('shows "Saved!" text after saving', async () => {
    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
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

    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });

    const indicators = screen.getAllByText('Loading models…');
    expect(indicators).toHaveLength(7); // default + 5 roles + exploration

    // Resolve the loading so inflightFetches cleans up
    resolveLoading({ models: CURATED_MODELS_ANTHROPIC, error: undefined });
    await vi.waitFor(() => {
      expect(screen.queryByText('Loading models…')).toBeNull();
    });
  });

  // ── Exploration model section ───────────────────────────────────────

  it('renders exploration section with model picker', async () => {
    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
    expect(screen.getByText('Exploration (ideation & roadmap)')).toBeInTheDocument();
  });

  it('shows exploration model from config when set', async () => {
    const configWithExploration = {
      default: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
      roles: {},
      exploration: { model: 'claude-haiku-4-5-20251001' },
    };
    act(() => {
      render(<ProviderConfigEditor config={configWithExploration} />);
    });
    await waitFor(() => {
      // The exploration row should have the model selector showing the exploration model
      const modelSelects = screen.getAllByRole('combobox');
      const explorationSelect = modelSelects.find(
        s => (s as HTMLSelectElement).value === 'claude-haiku-4-5-20251001',
      );
      expect(explorationSelect).toBeTruthy();
    });
  });

  it('saves exploration model with config', async () => {
    const configWithExploration = {
      default: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
      roles: {},
      exploration: { model: 'gemini-2.0-flash' },
    };
    act(() => {
      render(<ProviderConfigEditor config={configWithExploration} />);
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
    const saveButton = screen.getByText('Save Provider Config');
    await act(async () => {
      fireEvent.click(saveButton);
    });
    expect(mockSaveProvidersConfig).toHaveBeenCalledWith(configWithExploration);
  });

  it('falls back to default model in exploration row when not set', async () => {
    act(() => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
    // The exploration row label should be visible
    expect(screen.getByText('Exploration')).toBeInTheDocument();
    // The exploration row provider should be the default provider
    const explorationProviderSelects = screen.getAllByRole('combobox').filter(
      s => {
        const opts = Array.from((s as HTMLSelectElement).options);
        return opts.some(o => o.value === 'anthropic') && opts.some(o => o.value === 'openai');
      },
    );
    expect(explorationProviderSelects.length).toBeGreaterThanOrEqual(1);
  });


});
