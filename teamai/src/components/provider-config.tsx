'use client';

import { useState, useTransition } from 'react';
import { saveProvidersConfig } from '@/app/actions/providers';
import type { ProvidersConfig } from '@/app/actions/providers';

const ROLES = ['planner', 'coder', 'qa-reviewer', 'qa-fixer', 'merger'] as const;
const PROVIDERS = ['anthropic', 'bedrock', 'vertex', 'ollama'] as const;

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
  return (
    <div className="flex items-center gap-3 py-2 border-b border-[#1e293b] last:border-0">
      <span className="w-28 text-sm text-slate-400 shrink-0 capitalize">{label}</span>
      <input
        value={model}
        onChange={e => onModel(e.target.value)}
        placeholder="claude-sonnet-4-6"
        className="flex-1 px-2 py-1 text-xs border border-[#334155] rounded bg-[#11131b] text-white focus:outline-none focus:ring-1 focus:ring-[#2563eb] placeholder-slate-500"
      />
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
