'use client';

import { useState, useEffect } from 'react';
import { getAutoModeStateAction, toggleAutoMode } from '@/app/actions/auto-mode';
import { useServerMutation } from '@/hooks/use-server-mutation';

interface Props {
  /** When null, no project is selected — button is disabled and no fetch is made. */
  activeProjectPath?: string | null;
}

export function AutoModeButton({ activeProjectPath }: Props) {
  const { run, isPending } = useServerMutation();
  const noProject = activeProjectPath === null;
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(!noProject);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (noProject) return; // loading already starts as false when noProject is true
    getAutoModeStateAction()
      .then(state => { setEnabled(state.enabled); setLoading(false); })
      .catch(() => { setLoading(false); });
  }, [noProject]);

  function handleToggle() {
    if (noProject) return;
    const next = !enabled;
    setEnabled(next); // optimistic
    setError(null);
    run(async () => {
      try {
        await toggleAutoMode(next);
      } catch (e) {
        setEnabled(!next); // revert
        setError(e instanceof Error ? e.message : 'Failed to toggle auto mode');
        throw e; // prevent router.refresh() on failure
      }
    });
  }

  if (loading) {
    return (
      <div className="shrink-0 px-3 py-1.5 text-xs text-slate-500">
        Loading…
      </div>
    );
  }

  return (
    <div className="shrink-0 flex items-center gap-2">
      {error && (
        <span className="text-[10px] text-red-400">{error}</span>
      )}
      <button
        onClick={handleToggle}
        disabled={isPending || noProject}
        title={noProject ? 'No project selected' : enabled ? 'Stop Auto mode' : 'Start Auto mode'}
        className={`flex items-center gap-2 px-3 py-1.5 text-xs font-medium rounded-lg border transition-all ${
          enabled
            ? 'border-emerald-700/60 bg-emerald-950/40 text-emerald-400 hover:bg-emerald-900/50 hover:text-emerald-300 shadow-[0_0_12px_rgba(16,185,129,0.15)]'
            : 'border-[#334155] bg-[#1a1f2e] text-slate-400 hover:text-slate-300 hover:border-[#475569]'
        }`}
      >
        {enabled ? (
          <>
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Auto</span>
            <span className="text-[10px] text-emerald-500/70">■</span>
          </>
        ) : (
          <>
            <span className="text-sm">▶</span>
            <span>Auto</span>
          </>
        )}
      </button>
    </div>
  );
}
