'use client';

import { useUpdater } from '@/hooks/use-updater';

export function UpdateBanner() {
  const { updateReady, downloadProgress, installUpdate } = useUpdater();

  // Show nothing unless update is ready or downloading
  if (!updateReady && downloadProgress === null) return null;

  const isReady = updateReady;
  const pct = downloadProgress ?? 0;

  return (
    <div className="flex items-center justify-between px-4 py-2 bg-emerald-900/40 border-b border-emerald-700/50 text-emerald-100 text-sm">
      <span className="flex items-center gap-3">
        {isReady ? (
          <svg className="w-4 h-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        ) : (
          <svg className="w-4 h-4 shrink-0 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
          </svg>
        )}
        {isReady
          ? 'Update ready — will install when you quit, or install now.'
          : `Downloading update… ${pct}%`}
        {/* Progress bar (shown when downloading) */}
        {!isReady && (
          <span className="inline-block w-24 h-1.5 rounded-full bg-emerald-950/60 overflow-hidden">
            <span
              className="block h-full rounded-full bg-emerald-400 transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </span>
        )}
      </span>
      {isReady && (
        <button
          onClick={installUpdate}
          className="px-3 py-1 rounded bg-emerald-600 hover:bg-emerald-500 transition-colors font-medium text-xs shrink-0"
        >
          Install &amp; Restart
        </button>
      )}
    </div>
  );
}
