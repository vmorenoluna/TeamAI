// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { ProviderConfigEditor } from '@/components/provider-config';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockGetAvailableModels = vi.fn();
const mockSaveProvidersConfig = vi.fn().mockResolvedValue(undefined);
const mockApplyMigration = vi.fn();
const mockDismissMigration = vi.fn().mockResolvedValue(undefined);

vi.mock('@/app/actions/providers', () => ({
  getAvailableModels: (...args: unknown[]) => mockGetAvailableModels(...args),
  saveProvidersConfig: (...args: unknown[]) => mockSaveProvidersConfig(...args),
  applyProvidersMigration: (...args: unknown[]) => mockApplyMigration(...args),
  dismissProvidersMigrationHint: (...args: unknown[]) => mockDismissMigration(...args),
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
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
    expect(screen.getByText('Default (all roles)')).toBeInTheDocument();
    expect(screen.getByText('Role overrides')).toBeInTheDocument();
  });

  it('renders label for each role', async () => {
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
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
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });
    await waitFor(() => {
      expect(mockGetAvailableModels).toHaveBeenCalledWith('anthropic', false);
    });
  });

  // ── Model select ────────────────────────────────────────────────────

  it('shows model select with options after models load', async () => {
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
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
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
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
    await act(async () => {
      render(<ProviderConfigEditor config={configWithCustomModel}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });
    const customInput = await screen.findByPlaceholderText('Type a model name…');
    expect(customInput).toHaveValue('my-custom-model-v1');
  });

  // ── Provider select ─────────────────────────────────────────────────

  it('does not render provider selects (provider is always Anthropic)', async () => {
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
    // Provider dropdowns have been removed — only model comboboxes remain.
    // All comboboxes should show model names, not provider values.
    const comboboxes = screen.getAllByRole('combobox');
    // Each row has exactly one combobox (the model selector), no provider select.
    // 1 default + 5 roles + 1 exploration = 7 comboboxes total.
    expect(comboboxes.length).toBe(7);
    // No option elements with provider names like 'openai' or 'bedrock' should exist.
    expect(screen.queryByRole('option', { name: 'openai' })).toBeNull();
    expect(screen.queryByRole('option', { name: 'bedrock' })).toBeNull();
  });

  // ── Refresh button ──────────────────────────────────────────────────

  it('calls getAvailableModels with refresh=true when refresh button is clicked', async () => {
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });

    // Wait for initial load to complete so the refresh button is enabled
    await waitFor(() => {
      expect(screen.queryByText('Loading models…')).toBeNull();
    });

    const refreshButtons = screen.getAllByTitle('Refresh Anthropic models');
    expect(refreshButtons.length).toBeGreaterThanOrEqual(1);

    await act(async () => {
      fireEvent.click(refreshButtons[0]);
    });

    expect(mockGetAvailableModels).toHaveBeenCalledWith('anthropic', true);
  });

  // ── Custom model input ──────────────────────────────────────────────

  it('shows custom model input when "Custom…" is selected', async () => {
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
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
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
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

  // Provider dropdown removed — provider is always Anthropic.
  // Provider change tests are removed since there's no UI for switching providers.

  // ── Error state ─────────────────────────────────────────────────────

  it('shows error state when model fetch fails', async () => {
    mockGetAvailableModels.mockResolvedValue({
      models: [],
      error: 'ANTHROPIC_API_KEY not set',
    });

    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });

    await waitFor(() => expect(mockGetAvailableModels).toHaveBeenCalled());
    const inputs = await screen.findAllByPlaceholderText(
      /ANTHROPIC_API_KEY not set — type a model name/i,
    );
    expect(inputs.length).toBeGreaterThanOrEqual(1);
  });

  // ── Save button ─────────────────────────────────────────────────────

  it('renders save button', async () => {
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
    expect(screen.getByText('Save Provider Config')).toBeInTheDocument();
  });

  it('calls saveProvidersConfig when save button is clicked', async () => {
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
    const saveButton = screen.getByText('Save Provider Config');
    await act(async () => {
      fireEvent.click(saveButton);
    });
    expect(mockSaveProvidersConfig).toHaveBeenCalledWith(DEFAULT_CONFIG);
  });

  it('shows "Saved!" text after saving', async () => {
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
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

    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });

    const indicators = screen.getAllByText('Loading models…');
    expect(indicators).toHaveLength(7); // default + 5 roles + exploration

    // Resolve the loading so inflightFetches cleans up
    await act(async () => {
      resolveLoading({ models: CURATED_MODELS_ANTHROPIC, error: undefined });
    });
    await vi.waitFor(() => {
      expect(screen.queryByText('Loading models…')).toBeNull();
    });
  });

  // ── Exploration model section ───────────────────────────────────────

  it('renders exploration section with model picker', async () => {
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
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
    await act(async () => {
      render(<ProviderConfigEditor config={configWithExploration}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
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
    await act(async () => {
      render(<ProviderConfigEditor config={configWithExploration}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
    const saveButton = screen.getByText('Save Provider Config');
    await act(async () => {
      fireEvent.click(saveButton);
    });
    expect(mockSaveProvidersConfig).toHaveBeenCalledWith(configWithExploration);
  });

  it('shows empty exploration model picker when not set', async () => {
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG}      />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());
    // The exploration row label should be visible
    expect(screen.getByText('Exploration')).toBeInTheDocument();
    // Exploration row exists and renders a model selector (no provider dropdowns)
    const comboboxes = screen.getAllByRole('combobox');
    // One combobox per row: default + 5 roles + exploration = 7
    expect(comboboxes.length).toBe(7);
  });

  // ── Raw-throw path (regression) ───────────────────────────────────

  describe('raw-throw path (regression)', () => {
    it('surfaces role="alert" banner when saveProvidersConfig rejects', async () => {
      mockSaveProvidersConfig.mockRejectedValueOnce(new Error('config validation failed: unknown role'));

      await act(async () => {
        render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
        if (!vi.isFakeTimers()) {
          await new Promise(r => setTimeout(r, 0));
        }
      });
      await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());

      const saveButton = screen.getByText('Save Provider Config');
      await act(async () => {
        fireEvent.click(saveButton);
      });

      await waitFor(() => {
        const banner = screen.getByRole('alert');
        expect(banner).toHaveTextContent('Failed to save provider config: config validation failed: unknown role');
      });
    });

    it('does not show "Saved!" when saveProvidersConfig throws', async () => {
      mockSaveProvidersConfig.mockRejectedValueOnce(new Error('disk full'));

      await act(async () => {
        render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
        if (!vi.isFakeTimers()) {
          await new Promise(r => setTimeout(r, 0));
        }
      });
      await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());

      await act(async () => {
        fireEvent.click(screen.getByText('Save Provider Config'));
      });

      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });
      expect(screen.queryByText('Saved!')).not.toBeInTheDocument();
      // Button reverts to idle label since setSaved(true) was never reached.
      expect(screen.getByText('Save Provider Config')).toBeInTheDocument();
    });

    it('uses "Unknown error" fallback for non-Error rejects', async () => {
      mockSaveProvidersConfig.mockRejectedValueOnce('plain string reason' as unknown as Error);

      await act(async () => {
        render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
        if (!vi.isFakeTimers()) {
          await new Promise(r => setTimeout(r, 0));
        }
      });
      await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());

      await act(async () => {
        fireEvent.click(screen.getByText('Save Provider Config'));
      });

      await waitFor(() => {
        expect(screen.getByRole('alert')).toHaveTextContent('Failed to save provider config: Unknown error');
      });
    });

    it('dismisses the role="alert" banner when the ✕ button is clicked', async () => {
      mockSaveProvidersConfig.mockRejectedValueOnce(new Error('temporary'));

      await act(async () => {
        render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
        if (!vi.isFakeTimers()) {
          await new Promise(r => setTimeout(r, 0));
        }
      });
      await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());

      await act(async () => {
        fireEvent.click(screen.getByText('Save Provider Config'));
      });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Dismiss error' }));
      });

      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('a subsequent successful save clears a prior error banner', async () => {
      mockSaveProvidersConfig.mockRejectedValueOnce(new Error('first attempt fails'));
      mockSaveProvidersConfig.mockResolvedValueOnce(undefined);

      await act(async () => {
        render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
        if (!vi.isFakeTimers()) {
          await new Promise(r => setTimeout(r, 0));
        }
      });
      await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());

      await act(async () => {
        fireEvent.click(screen.getByText('Save Provider Config'));
      });
      await waitFor(() => {
        expect(screen.getByRole('alert')).toBeInTheDocument();
      });

      // handleSave calls setError(null) before re-running
      await act(async () => {
        fireEvent.click(screen.getByText('Save Provider Config'));
      });

      await waitFor(() => {
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
        expect(screen.getByText('Saved!')).toBeInTheDocument();
      });
    });
  });

  // ── Superseded-model migration hint ───────────────────────────────────

  const MIGRATION_HINT = {
    changes: [
      { from: 'claude-sonnet-4-6', to: 'claude-sonnet-5', count: 2 },
      { from: 'claude-opus-4-8', to: 'claude-opus-5', count: 1 },
    ],
  };

  it('renders no migration banner when migrationHint is null/omitted', async () => {
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText(/Superseded model IDs/)).toBeNull();
  });

  it('renders the pending changes when a migration hint is provided', async () => {
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} migrationHint={MIGRATION_HINT} />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });

    expect(screen.getByRole('status')).toBeInTheDocument();
    const entries = screen.getAllByRole('listitem');
    expect(entries[0].textContent).toBe('claude-sonnet-4-6 → claude-sonnet-5 (2 entries)');
    expect(entries[1].textContent).toBe('claude-opus-4-8 → claude-opus-5 (1 entry)');
    expect(screen.getByRole('button', { name: 'Update to current defaults' })).toBeInTheDocument();
  });

  it('apply migrates the editor state to the new IDs and hides the banner', async () => {
    mockApplyMigration.mockResolvedValueOnce({ ok: true, changes: MIGRATION_HINT.changes });

    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} migrationHint={MIGRATION_HINT} />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });
    await waitFor(() => expect(screen.queryByText('Loading models…')).toBeNull());

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update to current defaults' }));
    });

    await waitFor(() => {
      expect(mockApplyMigration).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole('status')).toBeNull();
      // Apply writes the file via its own action — surfaced by the saved indicator
      expect(screen.getByText('Saved!')).toBeInTheDocument();
    });

    // The mocked model list doesn't include gen-5 IDs, so the migrated default
    // renders as a custom input (in production the live/prewarmed model list
    // carries the gen-5 IDs once refreshed)
    const customInput = await screen.findByPlaceholderText('Type a model name…');
    expect(customInput).toHaveValue('claude-sonnet-5');

    // Apply persists via its own server action — the editor does not auto-save
    expect(mockSaveProvidersConfig).not.toHaveBeenCalled();
  });

  it('apply failure surfaces the error banner and keeps the migration hint visible', async () => {
    mockApplyMigration.mockResolvedValueOnce({ ok: false, error: 'disk exploded' });

    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} migrationHint={MIGRATION_HINT} />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Update to current defaults' }));
    });

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByRole('alert').textContent).toContain('disk exploded');
    });
    expect(screen.queryByRole('status')).not.toBeNull();
  });

  it('dismiss hides the banner and calls the dismiss action', async () => {
    await act(async () => {
      render(<ProviderConfigEditor config={DEFAULT_CONFIG} migrationHint={MIGRATION_HINT} />);
      if (!vi.isFakeTimers()) {
        await new Promise(r => setTimeout(r, 0));
      }
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Dismiss migration hint' }));
    });

    expect(mockDismissMigration).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
