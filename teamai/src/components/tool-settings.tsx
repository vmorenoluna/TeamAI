'use client';

import { useState } from 'react';
import { useServerMutation } from '@/hooks/use-server-mutation';
import { checkTools, updateToolPath, resetToolPath } from '@/app/actions/tools';
import type { ToolName, ToolStatus } from '@/lib/tool-checker';
import { formatActionError } from '@/lib/error-format';

const STATUS_ORDER: Record<string, number> = {
  claude: 0, git: 1, gh: 2, glab: 3, docker: 4, devcontainer: 5,
};

export function ToolSettings({ initialTools }: { initialTools: ToolStatus[] }) {
  const { run } = useServerMutation();
  const [tools, setTools] = useState<ToolStatus[]>(
    initialTools.sort((a, b) => (STATUS_ORDER[a.name] ?? 99) - (STATUS_ORDER[b.name] ?? 99))
  );
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [editPaths, setEditPaths] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  async function handleRefresh() {
    setLoading(true);
    setError(null);
    try {
      const data = await checkTools();
      setTools(data.sort((a, b) => (STATUS_ORDER[a.name] ?? 99) - (STATUS_ORDER[b.name] ?? 99)));
      setEditPaths({});
    } catch (err) {
      setError(formatActionError('refresh tool status', err));
    } finally {
      setLoading(false);
    }
  }

  async function handleSave(toolName: ToolName) {
    const newPath = editPaths[toolName]?.trim();
    setSaving(toolName);
    try {
      const updated = await updateToolPath(toolName, newPath || toolName);
      setTools(prev => prev.map(t => t.name === toolName ? updated : t));
      setEditPaths(prev => { const n = { ...prev }; delete n[toolName]; return n; });
      run(async () => {});
    } catch (err) {
      setError(formatActionError('save tool path', err));
    } finally {
      setSaving(null);
    }
  }

  async function handleReset(toolName: ToolName) {
    setSaving(toolName);
    try {
      const updated = await resetToolPath(toolName);
      setTools(prev => prev.map(t => t.name === toolName ? updated : t));
      setEditPaths(prev => { const n = { ...prev }; delete n[toolName]; return n; });
      run(async () => {});
    } catch (err) {
      setError(formatActionError('reset tool path', err));
    } finally {
      setSaving(null);
    }
  }

  const missingCount = tools.filter(t => !t.found).length;
  const customCount = tools.filter(t => t.customPath).length;

  if (loading) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-slate-200 mb-1">Tool Paths</h2>
        <p className="text-xs text-slate-400 mb-4">
          Detect and configure paths for external CLI tools used by TeamAI.
        </p>
        <div className="text-xs text-slate-500 animate-pulse">Checking tools…</div>
      </section>
    );
  }

  return (
    <section data-component="tool-settings">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold text-slate-200">Tool Paths</h2>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-40 border border-transparent hover:border-[#1e293b] rounded"
        >
          {loading ? 'Refreshing…' : 'Recheck'}
        </button>
      </div>
      <p className="text-xs text-slate-400 mb-4">
        Detect and configure paths for external CLI tools. Set a custom path if a tool is
        installed in a non-standard location.
        {missingCount > 0 && (
          <span className="text-amber-400 font-medium"> {missingCount} tool{missingCount !== 1 ? 's' : ''} not found</span>
        )}
        {customCount > 0 && (
          <span className="text-blue-400"> · {customCount} custom path{customCount !== 1 ? 's' : ''}</span>
        )}
      </p>

      {error && (
        <div role="alert" className="mb-3 p-2.5 bg-red-900/30 border border-red-800/50 rounded-lg flex items-start justify-between gap-2">
          <p className="text-xs text-red-300 flex-1">{error}</p>
          <button onClick={() => setError(null)} aria-label="Dismiss error" className="text-red-500 hover:text-red-300 text-sm leading-none transition-colors">✕</button>
        </div>
      )}

      {tools.length === 0 ? (
        <div className="text-xs text-slate-500 py-4 text-center border border-dashed border-[#1e293b] rounded-lg">
          No tool status available. Click Recheck to detect tools.
        </div>
      ) : (
        <div className="border border-[#1e293b] rounded-lg overflow-hidden">
          {tools.map(t => {
            const isSaving = saving === t.name;
            const hasEdit = t.name in editPaths;

            return (
              <div key={t.name} className={`px-4 py-3 border-b border-[#1e293b] last:border-b-0 ${t.found ? '' : 'bg-red-900/10'}`}>
                <div className="flex items-center gap-3">
                  {/* Status indicator */}
                  <span className={`shrink-0 w-2 h-2 rounded-full ${t.found ? 'bg-green-500' : 'bg-red-500'}`} title={t.found ? 'Found' : 'Not found'} />

                  {/* Tool info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-medium text-slate-200">{t.label}</span>
                      <code className="text-[10px] text-slate-500 bg-[#0f1219] px-1.5 py-0.5 rounded">{t.path}</code>
                      {t.customPath && <span className="text-[10px] text-blue-400 font-medium">custom</span>}
                      {t.version && (
                        <span className="text-[10px] text-slate-600 truncate max-w-[300px]" title={t.version}>
                          {t.version.slice(0, 80)}
                        </span>
                      )}
                    </div>
                    {!t.found && t.error && (
                      <p className="text-[10px] text-red-400 mt-0.5">{t.error}</p>
                    )}
                  </div>

                  {/* Actions */}
                  <div className="flex items-center gap-2 shrink-0">
                    {t.customPath && (
                      <button
                        onClick={() => handleReset(t.name)}
                        disabled={isSaving}
                        className="text-[10px] text-slate-500 hover:text-amber-400 transition-colors disabled:opacity-40"
                        title="Reset to default"
                      >
                        Reset
                      </button>
                    )}
                    {hasEdit ? (
                      <button
                        onClick={() => handleSave(t.name)}
                        disabled={isSaving}
                        className="px-2 py-0.5 text-[10px] font-medium bg-blue-900/50 text-blue-300 rounded border border-blue-800/50 hover:bg-blue-900/70 disabled:opacity-40 transition-colors"
                      >
                        {isSaving ? 'Saving…' : 'Save'}
                      </button>
                    ) : (
                      <button
                        onClick={() => setEditPaths(prev => ({ ...prev, [t.name]: t.path }))}
                        className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
                        title="Set custom path"
                      >
                        Edit
                      </button>
                    )}
                  </div>
                </div>

                {/* Inline path editor */}
                {hasEdit && (
                  <div className="mt-2 ml-5 flex items-center gap-2">
                    <input
                      autoFocus
                      value={editPaths[t.name] ?? ''}
                      onChange={e => setEditPaths(prev => ({ ...prev, [t.name]: e.target.value }))}
                      onKeyDown={e => { if (e.key === 'Enter') handleSave(t.name); if (e.key === 'Escape') setEditPaths(prev => { const n = { ...prev }; delete n[t.name]; return n; }); }}
                      placeholder={`Path to ${t.label} binary…`}
                      className="flex-1 px-2 py-1 text-xs bg-[#0f1219] border border-[#334155] rounded text-white focus:outline-none focus:ring-1 focus:ring-[#2563eb] font-mono"
                    />
                    <button
                      onClick={() => setEditPaths(prev => { const n = { ...prev }; delete n[t.name]; return n; })}
                      className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
}
