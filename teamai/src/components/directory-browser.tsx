'use client';

import { useEffect, useState, useTransition } from 'react';
import { browseDirectory, type BrowseResult } from '@/app/actions/projects';
import { formatActionError } from '@/lib/error-format';

interface Props {
  onSelect: (path: string) => void;
  onClose: () => void;
}

function FolderIcon() {
  return (
    <svg className="w-4 h-4 shrink-0 text-slate-400" fill="currentColor" viewBox="0 0 20 20">
      <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
    </svg>
  );
}

export function DirectoryBrowser({ onSelect, onClose }: Props) {
  const [result, setResult] = useState<BrowseResult | null>(null);
  // Regression-fix contract: surfaces Server Action failures (raw-throw path)
  // when browseDirectory rejects mid-navigation.
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => { navigate(undefined); }, []);

  function navigate(path?: string) {
    setError(null);
    startTransition(async () => {
      try {
        setResult(await browseDirectory(path));
      } catch (err) {
        setError(formatActionError('browse directory', err));
      }
    });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-[#1e2333] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] w-full max-w-lg mx-4 flex flex-col overflow-hidden" style={{ maxHeight: '70vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e293b] shrink-0">
          <span className="text-sm font-semibold text-white">Select folder</span>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-white text-lg leading-none transition-colors"
          >
            ×
          </button>
        </div>

        {/* Breadcrumb / current path */}
        <div className="flex items-center gap-2 px-4 py-2 bg-[#11131b] border-b border-[#1e293b] shrink-0">
          {result?.parent != null && (
            <button
              onClick={() => navigate(result.parent!)}
              disabled={isPending}
              className="text-xs font-medium text-slate-400 hover:text-white disabled:opacity-40 shrink-0 transition-colors"
            >
              ← Up
            </button>
          )}
          <span className="text-xs font-mono text-slate-400 truncate">
            {result?.path ?? '…'}
          </span>
        </div>

        {/* Directory listing */}
        <div className="flex-1 overflow-y-auto">
          {/* Error banner — surfaces Server Action throws from browseDirectory. */}
          {error && (
            <div
              role="alert"
              className="mx-3 my-2 p-2 bg-red-900/30 border border-red-800/50 rounded flex items-start justify-between gap-2"
            >
              <p className="text-xs text-red-300 flex-1">{error}</p>
              <button
                onClick={() => setError(null)}
                aria-label="Dismiss error"
                className="text-red-500 hover:text-red-300 text-xs leading-none transition-colors"
              >
                ✕
              </button>
            </div>
          )}
          {isPending && (
            <p className="text-xs text-slate-400 px-4 py-4">Loading…</p>
          )}
          {!isPending && result?.entries.length === 0 && (
            <p className="text-xs text-slate-400 px-4 py-4">No subdirectories</p>
          )}
          {!isPending && result?.entries.map(entry => (
            <button
              key={entry.path}
              onClick={() => navigate(entry.path)}
              className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-left text-slate-300 hover:bg-[#1a1f2e] transition-colors"
            >
              <FolderIcon />
              {entry.name}
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-[#1e293b] shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-slate-400 hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => result && onSelect(result.path)}
            disabled={!result || isPending}
            className="px-3 py-1.5 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] transition-colors disabled:opacity-50"
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}
