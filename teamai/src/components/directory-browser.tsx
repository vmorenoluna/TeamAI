'use client';

import { useEffect, useState, useTransition } from 'react';
import { browseDirectory, type BrowseResult } from '@/app/actions/projects';

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
  const [isPending, startTransition] = useTransition();

  useEffect(() => { navigate(undefined); }, []);

  function navigate(path?: string) {
    startTransition(async () => {
      setResult(await browseDirectory(path));
    });
  }

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />
      <div className="relative bg-white dark:bg-slate-800 rounded-lg shadow-xl w-full max-w-lg mx-4 flex flex-col overflow-hidden" style={{ maxHeight: '70vh' }}>

        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-200 dark:border-slate-700 shrink-0">
          <span className="text-sm font-semibold text-slate-900 dark:text-white">Select folder</span>
          <button
            onClick={onClose}
            className="text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 text-lg leading-none"
          >
            ×
          </button>
        </div>

        {/* Breadcrumb / current path */}
        <div className="flex items-center gap-2 px-4 py-2 bg-slate-50 dark:bg-slate-900 border-b border-slate-200 dark:border-slate-700 shrink-0">
          {result?.parent != null && (
            <button
              onClick={() => navigate(result.parent!)}
              disabled={isPending}
              className="text-xs font-medium text-slate-500 hover:text-slate-800 dark:hover:text-slate-200 disabled:opacity-40 shrink-0"
            >
              ← Up
            </button>
          )}
          <span className="text-xs font-mono text-slate-600 dark:text-slate-400 truncate">
            {result?.path ?? '…'}
          </span>
        </div>

        {/* Directory listing */}
        <div className="flex-1 overflow-y-auto">
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
              className="flex items-center gap-2.5 w-full px-4 py-2 text-sm text-left text-slate-700 dark:text-slate-300 hover:bg-slate-100 dark:hover:bg-slate-700 transition-colors"
            >
              <FolderIcon />
              {entry.name}
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-4 py-3 border-t border-slate-200 dark:border-slate-700 shrink-0">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => result && onSelect(result.path)}
            disabled={!result || isPending}
            className="px-3 py-1.5 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-md hover:bg-slate-700 dark:hover:bg-slate-100 transition-colors disabled:opacity-50"
          >
            Select this folder
          </button>
        </div>
      </div>
    </div>
  );
}
