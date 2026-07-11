'use client';

import { useState, useLayoutEffect } from 'react';
import Link from 'next/link';
import type { ToolStatus } from '@/lib/tool-checker';

const STORAGE_KEY = 'teamai:missing-tools-banner-dismissed';

/** Check sessionStorage (survives refreshes, cleared on tab close). */
function isDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  return sessionStorage.getItem(STORAGE_KEY) === '1';
}

export function MissingToolsBanner({ tools }: { tools: ToolStatus[] }) {
  const [hidden, setHidden] = useState(false);

  useLayoutEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isDismissed()) setHidden(true);
  }, []);

  const missing = tools.filter(t => !t.found);

  if (missing.length === 0 || hidden) return null;

  const critical = missing.filter(t => t.name === 'claude' || t.name === 'git');
  const optional = missing.filter(t => t.name !== 'claude' && t.name !== 'git');

  return (
    <div className="flex justify-center pointer-events-none">
      <div className="pointer-events-auto mt-2 mx-4 max-w-xl w-full bg-gradient-to-r from-red-950/90 via-red-900/85 to-red-950/90 border border-red-800/40 rounded-xl shadow-lg shadow-red-950/30 backdrop-blur-sm px-4 py-2.5 flex items-start justify-between gap-3 animate-modal-in">
        <div className="min-w-0">
          <p className="text-xs text-red-200/90 leading-relaxed">
            <span className="font-semibold">⚠ {missing.length} required tool{missing.length !== 1 ? 's' : ''} not found</span>
          </p>
          <ul className="mt-1 text-[11px] text-red-300/80 space-y-0.5">
            {critical.map(t => (
              <li key={t.name}>
                <span className="font-medium">{t.label}</span>
                <span className="text-red-400/60"> — {t.error}</span>
              </li>
            ))}
            {optional.length > 0 && (
              <li className="text-red-400/60">
                Also missing: {optional.map(t => t.label).join(', ')}
              </li>
            )}
          </ul>
          <p className="mt-1.5 text-[11px] text-red-400/70">
            {'These are required for the pipeline to run. Configure custom paths in '}
            <Link
              href="/settings"
              className="underline decoration-red-500/40 hover:text-red-300 transition-colors"
            >
              Settings → Tool Paths
            </Link>
            .
          </p>
        </div>
        <button
          onClick={() => { sessionStorage.setItem(STORAGE_KEY, '1'); setHidden(true); }}
          title="Dismiss"
          className="shrink-0 w-6 h-6 flex items-center justify-center rounded-lg text-red-400/60 hover:text-red-200 hover:bg-red-800/30 transition-colors text-sm leading-none"
        >
          ×
        </button>
      </div>
    </div>
  );
}
