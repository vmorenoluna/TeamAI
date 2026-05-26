'use client';

import { useState, useTransition, useEffect, useCallback, useRef } from 'react';
import { saveProvidersConfig, getAvailableModels } from '@/app/actions/providers';
import type { ProvidersConfig } from '@/app/actions/providers';

const ROLES = ['analyst', 'planner', 'coder', 'qa-reviewer', 'qa-fixer', 'merger'] as const;
const PROVIDERS = ['anthropic', 'bedrock', 'vertex', 'openai', 'gemini', 'ollama'] as const;

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
  provider,
  onModel,
  onProvider,
}: {
  label: string;
  model: string;
  provider: string;
  onModel: (v: string) => void;
  onProvider: (v: string) => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [loading, setLoading] = useState(true); // start as loading
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [showCustom, setShowCustom] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const fetchVersion = useRef(0); // increment to discard stale responses

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
          title={`Refresh ${provider} models`}
          className="p-1.5 text-slate-500 hover:text-slate-300 disabled:opacity-40 transition-colors"
        >
          {loading ? <Spinner /> : <RefreshIcon />}
        </button>
      </div>

      <select
        value={provider}
        onChange={e => onProvider(e.target.value)}
        className="px-2 py-1 text-xs border border-[#334155] rounded bg-[#11131b] text-slate-300 focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
      >
        {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
      </select>
    </div>
  );
}

export function ProviderConfigEditor({ config }: { config: ProvidersConfig }) {
  const [cfg, setCfg] = useState(config);
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function setDefault(field: 'model' | 'provider', value: string) {
    setCfg(c => ({ ...c, default: { ...c.default, [field]: value } }));
  }

  function setRole(role: string, field: 'model' | 'provider', value: string) {
    setCfg(c => ({
      ...c,
      roles: { ...c.roles, [role]: { ...(c.roles[role] ?? {}), [field]: value } },
    }));
  }

  function handleSave() {
    startTransition(async () => {
      await saveProvidersConfig(cfg);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-xs font-medium text-slate-400 mb-2">Default (all roles)</p>
        <ModelRow
          label="Default"
          model={cfg.default.model}
          provider={cfg.default.provider}
          onModel={v => setDefault('model', v)}
          onProvider={v => setDefault('provider', v)}
        />
      </div>
      <div>
        <p className="text-xs font-medium text-slate-400 mb-2">Role overrides</p>
        {ROLES.map(role => (
          <ModelRow
            key={role}
            label={role}
            model={cfg.roles[role]?.model ?? ''}
            provider={cfg.roles[role]?.provider ?? cfg.default.provider}
            onModel={v => setRole(role, 'model', v)}
            onProvider={v => setRole(role, 'provider', v)}
          />
        ))}
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
