'use client';

import { useState, useLayoutEffect } from 'react';
import type { InterruptedTask } from '@/lib/recovery';

const STORAGE_KEY = 'teamai:recovery-banner-dismissed';

/** Check sessionStorage (survives refreshes, cleared on tab close = server restart). */
function isDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  return sessionStorage.getItem(STORAGE_KEY) === '1';
}

/** Reset dismissal state — exposed for tests. */
export function resetRecoveryBannerDismissed() {
  if (typeof window !== 'undefined') sessionStorage.removeItem(STORAGE_KEY);
}

export function RecoveryBanner({ tasks }: { tasks: InterruptedTask[] }) {
  // Always start false to match SSR (server never knows about dismissals).
  // useLayoutEffect fires sync before paint → no visible flash.
  const [hidden, setHidden] = useState(false);

  useLayoutEffect(() => {
    if (isDismissed()) setHidden(true);
  }, []);

  // Note: isDismissed() is NOT in this guard — it's only checked in useLayoutEffect.
  // Including it here would cause SSR hydration mismatch (server=false, client=true).
  if (tasks.length === 0 || hidden) return null;

  return (
    <div className="flex justify-center pointer-events-none">
      <div className="pointer-events-auto mt-2 mx-4 max-w-xl w-full bg-gradient-to-r from-amber-950/90 via-amber-900/85 to-amber-950/90 border border-amber-800/40 rounded-xl shadow-lg shadow-amber-950/30 backdrop-blur-sm px-4 py-2.5 flex items-center justify-between gap-3 animate-modal-in">
        <p className="text-xs text-amber-200/90 leading-relaxed min-w-0">
          <span className="font-semibold">⚠ {tasks.length} interrupted task{tasks.length > 1 ? 's' : ''}</span>
          {' '}detected — auto-resumed on server startup.
          {tasks.length === 1 && (
            <span className="text-amber-400/70"> ({tasks[0].title})</span>
          )}
        </p>
        <button
          onClick={() => { sessionStorage.setItem(STORAGE_KEY, '1'); setHidden(true); }}
          title="Dismiss"
          className="shrink-0 w-6 h-6 flex items-center justify-center rounded-lg text-amber-400/60 hover:text-amber-200 hover:bg-amber-800/30 transition-colors text-sm leading-none"
        >
          ×
        </button>
      </div>
    </div>
  );
}
