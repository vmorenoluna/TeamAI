'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { getOutdatedProjects, syncProjectDefaults } from '@/app/actions/projects';
import type { StaleDefaults } from '@/lib/project-store';

interface Props {
  /** Pre-fetched stale data (optional, component can fetch on its own). */
  initialStale?: StaleDefaults[];
}

export function DefaultsUpdater({ initialStale }: Props) {
  const router = useRouter();
  // Client-fetched stale data — only used when initialStale is not provided.
  // When initialStale IS provided, it's the source of truth (always fresh from server).
  const [clientStale, setClientStale] = useState<StaleDefaults[]>([]);
  const [loading, setLoading] = useState(initialStale === undefined);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, { updated: string[]; error?: string }>>({});

  // stale: derived from server prop when available, else from client fetch
  const stale = initialStale !== undefined ? initialStale : clientStale;

  // Fetch on mount when no server data is provided
  useEffect(() => {
    if (initialStale === undefined) {
      (async () => {
        try {
          const data = await getOutdatedProjects();
          setClientStale(data);
        } finally {
          setLoading(false);
        }
      })();
    }
  }, [initialStale]);

  function handleCheck() {
    // When server-provided data exists, trigger a fresh server render.
    // (Setting clientStale would be ignored since stale derives from initialStale.)
    if (initialStale !== undefined) {
      router.refresh();
      return;
    }
    setLoading(true);
    (async () => {
      try {
        const data = await getOutdatedProjects();
        setClientStale(data);
      } finally {
        setLoading(false);
      }
    })();
  }

  async function handleSync(projectPath: string) {
    setSyncing(projectPath);
    try {
      const updated = await syncProjectDefaults(projectPath);
      setResults(prev => ({ ...prev, [projectPath]: { updated } }));
    } catch {
      setResults(prev => ({
        ...prev,
        [projectPath]: { updated: [], error: 'Sync failed' },
      }));
    } finally {
      setSyncing(null);
      // router.refresh() triggers a server re-render with fresh initialStale.
      // Since stale is derived from initialStale (when provided), it updates
      // automatically — no need to manually filter the local state.
      router.refresh();
    }
  }

  // Filter out already-synced projects (tracked locally via results)
  const pendingStale = stale.filter(s => !results[s.projectPath]);
  const hasResults = Object.keys(results).length > 0;

  if (pendingStale.length === 0 && !hasResults) {
    return null;
  }

  // After all syncs complete, only show the results summary (no warning header)
  if (pendingStale.length === 0 && hasResults) {
    return (
      <div className="px-3 py-2 border-b border-[#1e293b] bg-[#0f1219]">
        <CompletedResults results={results} />
      </div>
    );
  }

  return (
    <div className="px-3 py-2 border-b border-[#1e293b] bg-[#0f1219]">
      <div className="flex items-center gap-2 mb-1">
        <span className="text-xs font-medium text-amber-400 flex items-center gap-1">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <path d="M6 1L11 10H1L6 1Z" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round"/>
            <line x1="6" y1="5" x2="6" y2="7.5" stroke="currentColor" strokeWidth="1.2"/>
            <circle cx="6" cy="9.2" r="0.6" fill="currentColor"/>
          </svg>
          Defaults update available
        </span>
        <button
          onClick={handleCheck}
          disabled={loading}
          className="text-[10px] text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-40"
        >
          {loading ? 'Checking…' : 'Refresh'}
        </button>
      </div>

      {pendingStale.map(s => (
        <div key={s.projectPath} className="flex items-center justify-between gap-3 py-1.5">
          <div className="min-w-0 flex-1">
            <span className="text-xs text-slate-300 truncate block">{s.projectName}</span>
            <span className="text-[10px] text-slate-600 truncate block">
              {s.outdatedFiles.length} file{s.outdatedFiles.length !== 1 ? 's' : ''}:{' '}
              {s.outdatedFiles.slice(0, 3).join(', ')}
              {s.outdatedFiles.length > 3 && ` +${s.outdatedFiles.length - 3} more`}
            </span>
          </div>
          <button
            onClick={() => handleSync(s.projectPath)}
            disabled={syncing === s.projectPath}
            className="shrink-0 px-2.5 py-1 text-[11px] font-medium bg-amber-900/50 text-amber-300 rounded border border-amber-800/50 hover:bg-amber-900/70 disabled:opacity-40 transition-colors"
          >
            {syncing === s.projectPath ? 'Updating…' : 'Sync'}
          </button>
        </div>
      ))}

      {/* Completed results (collapsed after sync, shown alongside pending items) */}
      {hasResults && <CompletedResults results={results} />}
    </div>
  );
}

/** Renders the synced-projects summary in a collapsible details element. */
function CompletedResults({
  results,
}: {
  results: Record<string, { updated: string[]; error?: string }>;
}) {
  const entries = Object.entries(results);
  return (
    <details className="mt-1">
      <summary className="text-[10px] text-slate-500 cursor-pointer hover:text-slate-400">
        {entries.length} project{entries.length !== 1 ? 's' : ''} synced
      </summary>
      <div className="mt-1 space-y-0.5">
        {entries.map(([path, r]) => (
          <div key={path} className="text-[10px] text-green-400/80">
            {path.split(/[\\/]/).pop()}: {r.updated.length} file
            {r.updated.length !== 1 ? 's' : ''} updated
            {r.error && (
              <span className="text-red-400 ml-1">({r.error})</span>
            )}
          </div>
        ))}
      </div>
    </details>
  );
}
