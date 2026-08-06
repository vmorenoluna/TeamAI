'use client';

import { useState, useLayoutEffect } from 'react';
import { dismissGitattributesRenormalizeSuggestion } from '@/app/actions/projects';

const STORAGE_KEY = 'teamai:gitattributes-renormalize-dismissed';

/** Check sessionStorage (survives refreshes, cleared on tab close = server restart). */
function isDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  return sessionStorage.getItem(STORAGE_KEY) === '1';
}

/** Reset dismissal state — exposed for tests. */
export function resetGitattributesRenormalizeBannerDismissed() {
  if (typeof window !== 'undefined') sessionStorage.removeItem(STORAGE_KEY);
}

export function GitattributesRenormalizeBanner({ projectPath }: { projectPath: string }) {
  // Always start false to match SSR (server never knows about dismissals).
  // useLayoutEffect fires sync before paint → no visible flash.
  const [hidden, setHidden] = useState(false);

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isDismissed()) setHidden(true);
  }, []);

  if (!projectPath || hidden) return null;

  return (
    <div className="flex justify-center pointer-events-none">
      <div className="pointer-events-auto mt-2 mx-4 max-w-xl w-full bg-gradient-to-r from-blue-950/90 via-blue-900/85 to-blue-950/90 border border-blue-800/40 rounded-xl shadow-lg shadow-blue-950/30 backdrop-blur-sm px-4 py-2.5 flex items-center justify-between gap-3 animate-modal-in">
        <p className="text-xs text-blue-200/90 leading-relaxed min-w-0">
          <span className="font-semibold">⚡ New .gitattributes added</span>
          {' — run '}
          <code className="px-1 py-0.5 rounded bg-blue-800/50 text-blue-100 text-[11px] font-mono">git add --renormalize .</code>
          {' to normalize line endings now, avoiding a large auto-commit later.'}
        </p>
        <button
          onClick={async () => {
            sessionStorage.setItem(STORAGE_KEY, '1');
            setHidden(true);
            // Persist the dismissal to disk so the banner never reappears.
            try { await dismissGitattributesRenormalizeSuggestion(); } catch { /* best-effort */ }
          }}
          title="Dismiss"
          className="shrink-0 w-6 h-6 flex items-center justify-center rounded-lg text-blue-400/60 hover:text-blue-200 hover:bg-blue-800/30 transition-colors text-sm leading-none"
        >
          ×
        </button>
      </div>
    </div>
  );
}
