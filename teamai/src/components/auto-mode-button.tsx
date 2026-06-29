'use client';

import { useState, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { getAutoModeStateAction, toggleAutoMode } from '@/app/actions/auto-mode';

export function AutoModeButton() {
  const router = useRouter();
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    getAutoModeStateAction()
      .then(state => { setEnabled(state.enabled); setLoading(false); })
      .catch(() => { setLoading(false); });
  }, []);

  function handleToggle() {
    const next = !enabled;
    setEnabled(next); // optimistic
    setError(null);
    startTransition(async () => {
      try {
        await toggleAutoMode(next);
        router.refresh();
      } catch (e) {
        setEnabled(!next); // revert
        setError(e instanceof Error ? e.message : 'Failed to toggle auto mode');
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
        disabled={isPending}
        title={enabled ? 'Stop Auto mode' : 'Start Auto mode'}
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
