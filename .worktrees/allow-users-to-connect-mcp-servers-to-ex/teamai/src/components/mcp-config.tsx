'use client';

import { useState, useTransition } from 'react';
import { saveMcpConfig } from '@/app/actions/mcp';
import type { McpConfig } from '@/app/actions/mcp';

type EnvPair = { key: string; value: string };

type DraftEntry = {
  id: string;
  name: string;
  command: string;
  args: string;
  env: EnvPair[];
  errors: { name?: string; command?: string };
};

function fromConfig(config: McpConfig): DraftEntry[] {
  return Object.entries(config.mcpServers).map(([name, server]) => ({
    id: crypto.randomUUID(),
    name,
    command: server.command,
    args: server.args?.join(', ') ?? '',
    env: Object.entries(server.env ?? {}).map(([key, value]) => ({ key, value })),
    errors: {},
  }));
}

function toConfig(entries: DraftEntry[]): McpConfig {
  const mcpServers: McpConfig['mcpServers'] = {};
  for (const entry of entries) {
    const argsList = entry.args
      .split(/[,\n]/)
      .map(a => a.trim())
      .filter(Boolean);
    const env: Record<string, string> = {};
    for (const { key, value } of entry.env) {
      if (key.trim()) env[key.trim()] = value;
    }
    mcpServers[entry.name.trim()] = {
      command: entry.command.trim(),
      ...(argsList.length > 0 ? { args: argsList } : {}),
      ...(Object.keys(env).length > 0 ? { env } : {}),
      type: 'stdio',
    };
  }
  return { mcpServers };
}

function validate(entries: DraftEntry[]): DraftEntry[] {
  const trimmedNames = entries.map(e => e.name.trim());
  return entries.map((entry, i) => {
    const errors: DraftEntry['errors'] = {};
    if (!entry.name.trim()) {
      errors.name = 'Name is required';
    } else if (trimmedNames.indexOf(entry.name.trim()) !== i) {
      errors.name = 'Duplicate server name';
    }
    if (!entry.command.trim()) {
      errors.command = 'Command is required';
    }
    return { ...entry, errors };
  });
}

export function McpConfigEditor({ initialConfig }: { initialConfig: McpConfig }) {
  const [entries, setEntries] = useState<DraftEntry[]>(() => fromConfig(initialConfig));
  const [saved, setSaved] = useState(false);
  const [isPending, startTransition] = useTransition();

  function addServer() {
    setEntries(prev => [
      ...prev,
      { id: crypto.randomUUID(), name: '', command: '', args: '', env: [], errors: {} },
    ]);
  }

  function removeServer(id: string) {
    setEntries(prev => prev.filter(e => e.id !== id));
  }

  function updateEntry(id: string, field: 'name' | 'command' | 'args', value: string) {
    setEntries(prev =>
      prev.map(e =>
        e.id === id
          ? { ...e, [field]: value, errors: { ...e.errors, [field]: undefined } }
          : e
      )
    );
  }

  function addEnvPair(id: string) {
    setEntries(prev =>
      prev.map(e => (e.id === id ? { ...e, env: [...e.env, { key: '', value: '' }] } : e))
    );
  }

  function updateEnvPair(id: string, index: number, field: 'key' | 'value', value: string) {
    setEntries(prev =>
      prev.map(e => {
        if (e.id !== id) return e;
        const env = e.env.map((pair, i) => (i === index ? { ...pair, [field]: value } : pair));
        return { ...e, env };
      })
    );
  }

  function removeEnvPair(id: string, index: number) {
    setEntries(prev =>
      prev.map(e =>
        e.id === id ? { ...e, env: e.env.filter((_, i) => i !== index) } : e
      )
    );
  }

  function handleSave() {
    const validated = validate(entries);
    const hasErrors = validated.some(e => Object.keys(e.errors).length > 0);
    if (hasErrors) {
      setEntries(validated);
      return;
    }
    startTransition(async () => {
      await saveMcpConfig(toConfig(validated));
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  }

  return (
    <div className="space-y-4">
      {entries.length === 0 ? (
        <p className="text-sm text-slate-400">No MCP servers configured</p>
      ) : (
        <div className="space-y-3">
          {entries.map(entry => (
            <div key={entry.id} className="border border-[#1e293b] rounded-lg p-4 bg-[#11131b] space-y-3">
              <div className="flex items-start gap-3">
                <div className="flex-1 space-y-1">
                  <label className="text-xs text-slate-400">Name</label>
                  <input
                    value={entry.name}
                    onChange={e => updateEntry(entry.id, 'name', e.target.value)}
                    placeholder="my-server"
                    className="w-full px-2 py-1 text-xs border border-[#334155] rounded bg-[#1e2333] text-white focus:outline-none focus:ring-1 focus:ring-[#2563eb] placeholder-slate-500"
                  />
                  {entry.errors.name && (
                    <p className="text-xs text-red-400">{entry.errors.name}</p>
                  )}
                </div>
                <div className="flex-1 space-y-1">
                  <label className="text-xs text-slate-400">Command</label>
                  <input
                    value={entry.command}
                    onChange={e => updateEntry(entry.id, 'command', e.target.value)}
                    placeholder="npx"
                    className="w-full px-2 py-1 text-xs border border-[#334155] rounded bg-[#1e2333] text-white focus:outline-none focus:ring-1 focus:ring-[#2563eb] placeholder-slate-500"
                  />
                  {entry.errors.command && (
                    <p className="text-xs text-red-400">{entry.errors.command}</p>
                  )}
                </div>
                <button
                  onClick={() => removeServer(entry.id)}
                  className="mt-5 text-xs text-slate-500 hover:text-red-400 transition-colors"
                >
                  Delete
                </button>
              </div>

              <div className="space-y-1">
                <label className="text-xs text-slate-400">Args (comma or newline separated)</label>
                <input
                  value={entry.args}
                  onChange={e => updateEntry(entry.id, 'args', e.target.value)}
                  placeholder="-y, @modelcontextprotocol/server-filesystem, /path"
                  className="w-full px-2 py-1 text-xs border border-[#334155] rounded bg-[#1e2333] text-white focus:outline-none focus:ring-1 focus:ring-[#2563eb] placeholder-slate-500"
                />
              </div>

              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <label className="text-xs text-slate-400">Environment Variables</label>
                  <button
                    onClick={() => addEnvPair(entry.id)}
                    className="text-xs text-[#2563eb] hover:text-[#1d4ed8] transition-colors"
                  >
                    + Add
                  </button>
                </div>
                {entry.env.map((pair, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <input
                      value={pair.key}
                      onChange={e => updateEnvPair(entry.id, i, 'key', e.target.value)}
                      placeholder="KEY"
                      className="w-32 px-2 py-1 text-xs border border-[#334155] rounded bg-[#1e2333] text-white font-mono focus:outline-none focus:ring-1 focus:ring-[#2563eb] placeholder-slate-500"
                    />
                    <span className="text-slate-500 text-xs">=</span>
                    <input
                      value={pair.value}
                      onChange={e => updateEnvPair(entry.id, i, 'value', e.target.value)}
                      placeholder="value"
                      className="flex-1 px-2 py-1 text-xs border border-[#334155] rounded bg-[#1e2333] text-white focus:outline-none focus:ring-1 focus:ring-[#2563eb] placeholder-slate-500"
                    />
                    <button
                      onClick={() => removeEnvPair(entry.id, i)}
                      className="text-xs text-slate-500 hover:text-red-400 transition-colors"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="flex items-center gap-3">
        <button
          onClick={addServer}
          className="px-4 py-1.5 text-sm font-medium border border-[#334155] text-slate-300 rounded-lg hover:bg-[#1e293b] transition-colors"
        >
          Add Server
        </button>
        {entries.length > 0 && (
          <button
            onClick={handleSave}
            disabled={isPending}
            className="px-4 py-1.5 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors"
          >
            {saved ? 'Saved!' : isPending ? 'Saving…' : 'Save'}
          </button>
        )}
      </div>
    </div>
  );
}
