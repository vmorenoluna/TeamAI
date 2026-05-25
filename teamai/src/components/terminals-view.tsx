'use client';

import { useState, useTransition, useEffect, useRef, useCallback } from 'react';
import { createTerminalSession, closeTerminalSession } from '@/app/actions/terminals';
import { getAvailableModels, getProvidersConfig } from '@/app/actions/providers';
import { TerminalPanel } from './terminal-panel';
import type { RoleDefinition } from '@/app/actions/roles';
import type { ProvidersConfig } from '@/app/actions/providers';

const PROVIDERS = ['anthropic', 'bedrock', 'vertex', 'openai', 'gemini', 'ollama'] as const;

interface ActiveTerminal {
  sessionId: string;
  role: string;
}

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

export function TerminalsView({ roles }: { roles: RoleDefinition[] }) {
  const [terminals, setTerminals] = useState<ActiveTerminal[]>([]);
  const [showDialog, setShowDialog] = useState(false);
  const [selectedRole, setSelectedRole] = useState(roles[0]?.filename ?? '');
  const [provider, setProvider] = useState<string>('anthropic');
  const [model, setModel] = useState('');
  const [showCustom, setShowCustom] = useState(false);
  const [customValue, setCustomValue] = useState('');
  const [models, setModels] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(true);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const fetchVersion = useRef(0);
  const [isPending, startTransition] = useTransition();

  // Load default provider from config on mount
  useEffect(() => {
    getProvidersConfig().then(cfg => {
      if (cfg.default.provider) {
        setProvider(cfg.default.provider);
      }
    }).catch(() => {});
  }, []);

  // Fetch models when provider changes
  const loadModels = useCallback(async (prov: string, refresh = false) => {
    const version = ++fetchVersion.current;
    setModelsLoading(true);
    setModelsError(null);
    try {
      const result = await fetchModels(prov, refresh);
      if (fetchVersion.current !== version) return;
      setModels(result.models);
      if (result.error) setModelsError(result.error);
    } catch {
      if (fetchVersion.current === version) {
        setModelsError('Failed to fetch models');
      }
    } finally {
      if (fetchVersion.current === version) setModelsLoading(false);
    }
  }, []);

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

  function handleOpen() {
    startTransition(async () => {
      const finalModel = showCustom ? customValue : model;
      const sessionId = await createTerminalSession(selectedRole, finalModel || undefined);
      setTerminals(prev => [...prev, { sessionId, role: selectedRole }]);
      setShowDialog(false);
      setModel('');
      setShowCustom(false);
      setCustomValue('');
    });
  }

  function handleClose(sessionId: string) {
    closeTerminalSession(sessionId).catch(() => {});
    setTerminals(prev => prev.filter(t => t.sessionId !== sessionId));
  }

  const terminalsRef = useRef(terminals);
  useEffect(() => {
    terminalsRef.current = terminals;
    return () => {
      for (const t of terminalsRef.current) {
        closeTerminalSession(t.sessionId).catch(() => {});
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSelectChange(value: string) {
    if (value === '__custom__') {
      setShowCustom(true);
      setCustomValue(model || '');
    } else {
      setShowCustom(false);
      setCustomValue('');
      setModel(value);
    }
  }

  function handleCustomBlur() {
    setModel(customValue);
  }

  function handleCustomKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter') {
      setModel(customValue);
    }
  }

  function renderModelControl() {
    if (modelsLoading) {
      return (
        <div className="flex items-center gap-2 px-3 py-2 text-sm text-slate-500 border border-[#334155] rounded-lg bg-[#11131b]">
          <Spinner />
          Loading models…
        </div>
      );
    }

    if (models.length > 0) {
      return (
        <div className="flex items-center gap-2">
          <select
            value={showCustom ? '__custom__' : (models.includes(model) ? model : '__custom__')}
            onChange={e => handleSelectChange(e.target.value)}
            className="flex-1 px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
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
              className="flex-1 px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] placeholder-slate-500"
              autoFocus
            />
          )}
        </div>
      );
    }

    // No models loaded — show free text input
    return (
      <input
        value={model}
        onChange={e => setModel(e.target.value)}
        placeholder={modelsError ? `${modelsError} — type a model name` : 'Type a model name…'}
        className="w-full px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] placeholder-slate-500"
      />
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-[#1e293b] bg-[#11131b]">
        <div>
          <h1 className="text-base font-semibold text-white">Terminals</h1>
          <p className="text-xs text-slate-400 mt-0.5">Interactive Claude sessions pre-loaded with a role persona.</p>
        </div>
        <button
          data-testid="new-terminal-btn"
          onClick={() => setShowDialog(true)}
          className="px-3 py-1.5 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] transition-colors"
        >
          + New Terminal
        </button>
      </div>

      {/* Terminal grid */}
      <div className={`flex-1 min-h-0 p-4 grid gap-4 ${
        terminals.length === 0 ? '' :
        terminals.length === 1 ? 'grid-cols-1' :
        'grid-cols-2'
      }`}>
        {terminals.length === 0 && (
          <div className="flex items-center justify-center text-sm text-slate-400">
            Click &quot;+ New Terminal&quot; to open an interactive Claude session.
          </div>
        )}
        {terminals.map(t => (
          <TerminalPanel
            key={t.sessionId}
            sessionId={t.sessionId}
            role={t.role}
            onClose={() => handleClose(t.sessionId)}
          />
        ))}
      </div>

      {/* New Terminal dialog */}
      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div data-testid="dialog-backdrop" className="absolute inset-0 bg-black/60" onClick={() => setShowDialog(false)} />
          <div className="relative bg-[#1e2333] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] p-6 w-full max-w-sm mx-4 space-y-4">
            <h2 className="text-base font-semibold text-white">New Terminal</h2>
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-1">Role</label>
              <select
                value={selectedRole}
                onChange={e => setSelectedRole(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
              >
                {roles.map(r => (
                  <option key={r.filename} value={r.filename}>{r.name}</option>
                ))}
              </select>
            </div>
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300">
                  Model
                  <span className="font-normal text-slate-500 ml-1">(optional override)</span>
                </label>
              </div>
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <select
                    value={provider}
                    onChange={e => { setProvider(e.target.value); setModel(''); setShowCustom(false); }}
                    className="flex-1 px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-slate-300 focus:outline-none focus:ring-2 focus:ring-[#2563eb]"
                  >
                    {PROVIDERS.map(p => <option key={p} value={p}>{p}</option>)}
                  </select>

                </div>
                <div className="flex items-center gap-2">
                  <div className="flex-1">
                    {renderModelControl()}
                  </div>
                  <button
                    onClick={() => loadModels(provider, true)}
                    disabled={modelsLoading}
                    title={`Refresh ${provider} models`}
                    className="p-2 text-slate-500 hover:text-slate-300 disabled:opacity-40 transition-colors shrink-0"
                  >
                    {modelsLoading ? <Spinner /> : <RefreshIcon />}
                  </button>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 pt-1">
              <button onClick={() => setShowDialog(false)} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">Cancel</button>
              <button
                onClick={handleOpen}
                disabled={isPending || !selectedRole}
                className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors"
              >
                {isPending ? 'Opening…' : 'Open'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
