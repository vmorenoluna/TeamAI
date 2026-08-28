'use client';

import { useState, useTransition, useEffect, useCallback, useRef } from 'react';
import { saveProvidersConfig, getAvailableModels, applyProvidersMigration, dismissProvidersMigrationHint } from '@/app/actions/providers';
import type { ProvidersConfig } from '@/app/actions/providers';
import { migrateProvidersConfig } from '@/lib/providers-migration';
import type { ModelMigrationChange } from '@/lib/providers-migration';
import { formatActionError } from '@/lib/error-format';

const ROLES = ['analyst', 'planner', 'coder', 'qa-reviewer', 'merger'] as const;

/** Deduplicate concurrent fetch requests for the same provider on the client. */
const inflightFetches = new Map<string, Promise<{ models: string[]; error?: string }>>();

async function fetchModels(provider: string, refresh = false): Promise<{ models: string[]; error?: string }> {
  const key = `${provider}:${refresh}`;
  // Only dedup non-refresh calls — refresh calls always hit the server
  if (!refresh) {
    const existing = inflightFetches.get(key);
    if (existing) return existing;
  }
  const promise = getAvailableModels(provider, refresh);
  inflightFetches.set(key, promise);
  promise.finally(() => inflightFetches.delete(key));
  return promise;
}

function RefreshIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 2v6h-6" />
      <path d="M3 12a9 9 0 0 1 15-6.7L21 8" />
      <path d="M3 22v-6h6" />
      <path d="M21 12a9 9 0 0 1-15 6.7L3 16" />
    </svg>
  );
}

function Spinner() {
  return (
    <svg className="animate-spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 12a9 9 0 1 1-6.219-8.56" />
    </svg>
  );
}

function ModelRow({
  label,
  model,
  onModel,
}: {
  label: string;
  model: string;
  onModel: (v: string) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true); // start as loading
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const fetchVersion = useRef(0); // increment to discard stale responses

  // Provider is always Anthropic — hardcoded so the dropdown is removed
  // but the backend ProviderConfig still stores it for future multi-provider support.
  const provider = 'anthropic';

  const loadModels = useCallback(async (prov: string, refresh = false) => {
    const version = ++fetchVersion.current;
    setLoading(true);
    setFetchError(null);
    try {
      const result = await fetchModels(prov, refresh);
      if (fetchVersion.current !== version) return; // stale response
      setModels(result.models);
      if (result.error) {
        setFetchError(result.error);
      }
    } catch {
      if (fetchVersion.current === version) {
        setFetchError('Failed to fetch models');
      }
    } finally {
      if (fetchVersion.current === version) setLoading(false);
    }
  }, []);

  // On mount and when provider changes, reload models
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadModels(provider);
  }, [provider, loadModels]);

  // When models are loaded, determine if current model value matches a known model
  useEffect(() => {
    if (models.length > 0) {
      if (models.includes(model)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setShowCustom(false);
        setCustomValue('');
      } else if (model) {
        setShowCustom(true);
        setCustomValue(model);
      } else {
        setShowCustom(false);
        setCustomValue('');
      }
    }
  }, [models, model]);

  function handleSelectChange(value: string) {
    if (value === '__custom__') {
      setShowCustom(true);
      setCustomValue(model || '');
    } else {
      setShowCustom(false);
      setCustomValue('');
      onModel(value);
    }
  }

  function handleCustomBlur() {
    onModel(customValue);
  }

  function handleCustomKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      onModel(customValue);
    }
  }

  function handleRefresh() {
    loadModels(provider, true);
  }

  // Determine what to show in the model area
  function renderModelControl() {
    if (loading) {
      return (
        <div className="flex-1 flex items-center gap-2 px-2 py-1 text-xs text-slate-500 border border-[#334155] rounded bg-[#11131b]">
          <Spinner />
          Loading models…
        </div>
      );
    }

    if (models.length > 0) {
      return (
        <>
          <select
            value={showCustom ? '__custom__' : (models.includes(model) ? model : '__custom__')}
            onChange={e => handleSelectChange(e.target.value)}
            className="flex-1 px-2 py-1 text-xs border border-[#334155] rounded bg-[#11131b] text-white focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
          >
            {models.map(m => (
              <option key={m} value={m} className="bg-[#11131b]">{m}</option>
            ))}
            <option value="__custom__" className="bg-[#11131b] border-t border-[#334155]">Custom…</option>
          </select>
          {showCustom && (
            <input
              value={customValue}
              onChange={e => setCustomValue(e.target.value)}
              onBlur={handleCustomBlur}
              onKeyDown={handleCustomKeyDown}
              placeholder="Type a model name…"
              className="w-48 px-2 py-1 text-xs border border-[#334155] rounded bg-[#11131b] text-white focus:outline-none focus:ring-1 focus:ring-[#2563eb] placeholder-slate-500"
              autoFocus
            />
          )}
        </>
      );
    }

    // No models loaded — show free text input
    return (
      <input
        value={model}
        onChange={e => onModel(e.target.value)}
        placeholder={fetchError ? `${fetchError} — type a model name` : 'Type a model name…'}
        className="flex-1 px-2 py-1 text-xs border border-[#334155] rounded bg-[#11131b] text-white focus:outline-none focus:ring-1 focus:ring-[#2563eb] placeholder-slate-500"
      />
    );
  }

  return (
    <div className="flex items-center gap-3 py-2 border-b border-[#1e293b] last:border-0">
      <span className="w-28 text-sm text-slate-400 shrink-0 capitalize">{label}</span>

      <div className="flex-1 flex items-center gap-1.5">
        {renderModelControl()}
        <button
          onClick={handleRefresh}
          disabled={loading}
          title="Refresh Anthropic models"
          className="p-1.5 text-slate-500 hover:text-slate-300 disabled:opacity-40 transition-colors"
        >
          {loading ? <Spinner /> : <RefreshIcon />}
        </button>
      </div>
    </div>
  );
}

export function ProviderConfigEditor({
  config,
  migrationHint = null,
}: {
  config: ProvidersConfig;
  /** Pending superseded-model migration for this project (server-fetched), or null when nothing to offer. */
  migrationHint?: { changes: ModelMigrationChange[] } | null;
}) {
  const [cfg, setCfg] = useState(config);
  const [saved, setSaved] = useState(false);
  // Regression-fix contract: surfaces Server Action failures (raw-throw path).
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const [hint, setHint] = useState(migrationHint);

  function handleApplyMigration() {
    setError(null);
    startTransition(async () => {
      try {
        const result = await applyProvidersMigration();
        if (!result.ok) {
          setError(result.error ?? 'Model migration failed');
          return;
        }
        // Mirror the same pure migration into the editor's local state — the
        // editor may hold DEFAULT-merged fields that aren't in the on-disk
        // file, so don't replace state with the action's file-shaped result.
        setCfg(current => migrateProvidersConfig(current).config);
        setHint(null);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch (err) {
        setError(formatActionError('apply model migration', err));
      }
    });
  }

  function handleDismissMigration() {
    setHint(null);
    startTransition(async () => {
      try {
        await dismissProvidersMigrationHint();
      } catch { /* non-fatal — hint stays hidden for this session either way */ }
    });
  }

  function setDefault(value: string) {
    setCfg(c => ({ ...c, default: { ...c.default, model: value, provider: 'anthropic' } }));
  }

  function setRole(role: string, value: string) {
    setCfg(c => ({
      ...c,
      roles: { ...c.roles, [role]: { ...(c.roles[role] ?? {}), model: value, provider: 'anthropic' } },
    }));
  }

  function setExplorationModel(value: string) {
    setCfg(c => ({
      ...c,
      exploration: { model: value },
    }));
  }

  function handleSave() {
    setError(null);
    startTransition(async () => {
      try {
        await saveProvidersConfig(cfg);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch (err) {
        setError(formatActionError('save provider config', err));
      }
    });
  }

  return (
    <div className="space-y-4">
      {/* Superseded-model migration hint — server-fetched, opt-in adoption of newer defaults. */}
      {hint && hint.changes.length > 0 && (
        <div
          role="status"
          className="p-3 bg-amber-900/20 border border-amber-800/50 rounded-lg space-y-2"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-xs font-semibold text-amber-200">
                Superseded model IDs in this project&apos;s config
              </p>
              <p className="text-xs text-amber-200/80 mt-1">
                This project was seeded with models one generation behind the current defaults.
                Updating replaces only the IDs below — your other settings are kept.
              </p>
            </div>
            <button
              onClick={handleDismissMigration}
              aria-label="Dismiss migration hint"
              className="text-amber-500 hover:text-amber-300 text-sm leading-none transition-colors"
            >
              ✕
            </button>
          </div>
          <ul className="text-xs text-amber-100/90 font-mono space-y-0.5">
            {hint.changes.map(c => (
              <li key={c.from}>
                {c.from} → {c.to}
                <span className="text-amber-400/70"> ({c.count} {c.count === 1 ? 'entry' : 'entries'})</span>
              </li>
            ))}
          </ul>
          <button
            onClick={handleApplyMigration}
            disabled={isPending}
            className="px-3 py-1 text-xs font-medium bg-amber-600 text-white rounded-lg hover:bg-amber-500 disabled:opacity-40 transition-colors"
          >
            {isPending ? 'Updating…' : 'Update to current defaults'}
          </button>
        </div>
      )}
      {/* Error banner — surfaces Server Action throws from handleSave. */}
      {error && (
        <div
          role="alert"
          className="p-2.5 bg-red-900/30 border border-red-800/50 rounded-lg flex items-start justify-between gap-2"
        >
          <p className="text-xs text-red-300 flex-1">{error}</p>
          <button
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="text-red-500 hover:text-red-300 text-sm leading-none transition-colors"
          >
            ✕
          </button>
        </div>
      )}
      <div>
        <p className="text-xs font-medium text-slate-400 mb-2">Default (all roles)</p>
        <ModelRow
          label="Default"
          model={cfg.default.model}
          onModel={v => setDefault(v)}
        />
      </div>
      <div>
        <p className="text-xs font-medium text-slate-400 mb-2">Role overrides</p>
        {ROLES.map(role => (
          <ModelRow
            key={role}
            label={role}
            model={cfg.roles[role]?.model ?? ''}
            onModel={v => setRole(role, v)}
          />
        ))}
      </div>
      <div>
        <p className="text-xs font-medium text-slate-400 mb-2">Exploration (ideation &amp; roadmap)</p>
        <p className="text-xs text-slate-500 mb-2">
          Model used for ideation scans and roadmap generation. Falls back to the Default model when left blank.
        </p>
        <ModelRow
          label="Exploration"
          model={cfg.exploration?.model ?? ''}
          onModel={setExplorationModel}
        />
      </div>
      <button
        onClick={handleSave}
        disabled={isPending}
        className="px-4 py-1.5 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors"
      >
        {saved ? 'Saved!' : isPending ? 'Saving…' : 'Save Provider Config'}
      </button>
    </div>
  );
}
