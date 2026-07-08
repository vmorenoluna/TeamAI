'use client';

import { useState, useEffect } from 'react';
import { useServerMutation } from '@/hooks/use-server-mutation';
import {
  getAllProjectsSyncStatus,
  syncProjectDefaults,
} from '@/app/actions/projects';
import type { ProjectSyncStatus } from '@/app/actions/projects';
import { formatActionError } from '@/lib/error-format';

export function ProjectsSettings() {
  const { run } = useServerMutation();
  /* eslint-disable local/no-async-fetch-on-mount */
  const [projects, setProjects] = useState<ProjectSyncStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState<string | null>(null);
  const [syncResults, setSyncResults] = useState<Record<string, { updated: string[]; error?: string }>>({});
  // Regression-fix contract: surfaces Server Action failures (raw-throw path).
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const data = await getAllProjectsSyncStatus();
        setProjects(data);
      } catch (err) {
        setError(formatActionError('load project status', err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);
  /* eslint-enable local/no-async-fetch-on-mount */

  function handleRefresh() {
    setLoading(true);
    setError(null);
    setSyncResults({});
    (async () => {
      try {
        const data = await getAllProjectsSyncStatus();
        setProjects(data);
      } catch (err) {
        setError(formatActionError('refresh project status', err));
      } finally {
        setLoading(false);
      }
    })();
  }

  function handleSync(projectPath: string) {
    setSyncing(projectPath);
    (async () => {
      try {
        const updated = await syncProjectDefaults(projectPath);
        setSyncResults(prev => ({ ...prev, [projectPath]: { updated } }));
        setProjects(prev =>
          prev.map(p =>
            p.projectPath === projectPath ? { ...p, upToDate: true, outdatedFiles: [] } : p,
          ),
        );
      } catch (err) {
        setSyncResults(prev => ({
          ...prev,
          [projectPath]: {
            updated: [],
            // Deliberately inline (NOT formatActionError) — 'Sync failed:' prefix
            // avoids 'Failed to sync: Sync failed: …' double-prefix in row UI.
            error: `Sync failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
          },
        }));
      } finally {
        setSyncing(null);
        run(async () => {}); // trigger router.refresh()
      }
    })();
  }

  function handleSyncAll() {
    const stale = projects.filter(p => !p.upToDate);
    if (stale.length === 0) return;
    // Sync sequentially to avoid race conditions
    (async () => {
      for (const p of stale) {
        setSyncing(p.projectPath);
        try {
          const updated = await syncProjectDefaults(p.projectPath);
          setSyncResults(prev => ({ ...prev, [p.projectPath]: { updated } }));
          setProjects(prev =>
            prev.map(x =>
              x.projectPath === p.projectPath ? { ...x, upToDate: true, outdatedFiles: [] } : x,
            ),
          );
        } catch (err) {
          setSyncResults(prev => ({
            ...prev,                [p.projectPath]: {
                  updated: [],
                  // See handleSync's catch comment for the no-formatActionError rationale.
                  error: `Sync failed: ${err instanceof Error ? err.message : 'Unknown error'}`,
                },
              }));
            }
          }
      setSyncing(null);
      run(async () => {}); // trigger router.refresh()
    })();
  }

  const staleCount = projects.filter(p => !p.upToDate).length;
  const hasCompletedSyncs = Object.keys(syncResults).length > 0;

  if (loading) {
    return (
      <section>
        <h2 className="text-sm font-semibold text-slate-200 mb-1">Project Defaults</h2>
        <p className="text-xs text-slate-400 mb-4">
          Track and update TeamAI default files across registered projects.
        </p>
        <div className="text-xs text-slate-500 animate-pulse">Loading project status…</div>
      </section>
    );
  }

  return (
    <section>
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold text-slate-200">Project Defaults</h2>
        <div className="flex items-center gap-2">
          {staleCount > 0 && (
            <button
              onClick={handleSyncAll}
              disabled={syncing !== null}
              className="px-3 py-1 text-[11px] font-medium bg-amber-900/50 text-amber-300 rounded border border-amber-800/50 hover:bg-amber-900/70 disabled:opacity-40 transition-colors"
            >
              {syncing !== null ? 'Syncing…' : `Sync All (${staleCount})`}
            </button>
          )}
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="px-2 py-1 text-[11px] text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-40 border border-transparent hover:border-[#1e293b] rounded"
          >
            {loading ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </div>
      <p className="text-xs text-slate-400 mb-4">
        Track and update TeamAI default files across registered projects.
        Projects with customized files are preserved — only uncustomized copies are updated.
      </p>

      {projects.length === 0 ? (
        <div className="text-xs text-slate-500 py-4 text-center border border-dashed border-[#1e293b] rounded-lg">
          No projects registered yet. Add a project to see its default sync status.
        </div>
      ) : (
        <div className="border border-[#1e293b] rounded-lg overflow-hidden">
          {/* Table header */}
          <div className="grid grid-cols-[1fr_100px_1fr_90px] gap-3 px-4 py-2 bg-[#0f1219] border-b border-[#1e293b] text-[11px] font-medium text-slate-400 uppercase tracking-wider">
            <span>Project</span>
            <span>Status</span>
            <span>Outdated Files</span>
            <span className="text-right">Action</span>
          </div>

          {/* Table rows */}
          {projects.map(p => {
            const result = syncResults[p.projectPath];
            const isSyncing = syncing === p.projectPath;

            return (
              <div
                key={p.projectPath}
                className={`grid grid-cols-[1fr_100px_1fr_90px] gap-3 px-4 py-3 border-b border-[#1e293b] last:border-b-0 items-start ${
                  result ? 'bg-green-900/10' : ''
                }`}
              >
                {/* Project name + path */}
                <div className="min-w-0">
                  <span className="text-xs font-medium text-slate-200 truncate block">
                    {p.projectName}
                  </span>
                  <span className="text-[10px] text-slate-600 truncate block mt-0.5" title={p.projectPath}>
                    {p.projectPath}
                  </span>
                </div>

                {/* Status badge */}
                <div className="pt-0.5">
                  {result ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-green-400">
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <circle cx="5" cy="5" r="4" stroke="currentColor" strokeWidth="1" />
                        <path d="M3 5l1.5 1.5L7 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      Synced
                    </span>
                  ) : p.upToDate ? (
                    <span className="inline-flex items-center gap-1 text-[11px] text-green-400/70">
                      <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
                        <circle cx="4" cy="4" r="3" fill="currentColor" />
                      </svg>
                      Up to date
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 text-[11px] text-amber-400">
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                        <path d="M5 1.5L9 8H1L5 1.5Z" stroke="currentColor" strokeWidth="1" strokeLinejoin="round" />
                        <line x1="5" y1="4.5" x2="5" y2="6" stroke="currentColor" strokeWidth="1" />
                        <circle cx="5" cy="7.2" r="0.5" fill="currentColor" />
                      </svg>
                      {p.outdatedFiles.length} file{p.outdatedFiles.length !== 1 ? 's' : ''}
                    </span>
                  )}
                </div>

                {/* Outdated files list */}
                <div className="min-w-0">
                  {result ? (
                    <span className="text-[11px] text-green-400/80">
                      {result.updated.length} file{result.updated.length !== 1 ? 's' : ''} updated
                      {result.error && <span className="text-red-400 ml-1">({result.error})</span>}
                    </span>
                  ) : p.upToDate ? (
                    <span className="text-[11px] text-slate-600">—</span>
                  ) : (
                    <div className="space-y-0.5">
                      {p.outdatedFiles.map(f => (
                        <span key={f} className="text-[10px] text-amber-400/80 block truncate font-mono">
                          {f}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* Sync button */}
                <div className="text-right">
                  {result ? (
                    <span className="text-[11px] text-green-400">✓</span>
                  ) : p.upToDate ? (
                    <span className="text-[11px] text-slate-600">—</span>
                  ) : (
                    <button
                      onClick={() => handleSync(p.projectPath)}
                      disabled={isSyncing}
                      className="px-2.5 py-1 text-[11px] font-medium bg-amber-900/50 text-amber-300 rounded border border-amber-800/50 hover:bg-amber-900/70 disabled:opacity-40 transition-colors"
                    >
                      {isSyncing ? 'Syncing…' : 'Sync'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Error banner — surfaces Server Action throws from mount, handleRefresh, etc. */}
      {error && (
        <div
          role="alert"
          className="mb-3 p-2.5 bg-red-900/30 border border-red-800/50 rounded-lg flex items-start justify-between gap-2"
        >
          <p className="text-xs text-red-300 flex-1">{error}</p>
          <button
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="text-red-500 hover:text-red-300 text-sm leading-none transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      {/* Synced summary */}
      {hasCompletedSyncs && staleCount === 0 && (
        <div className="mt-3 text-[11px] text-green-400/80 flex items-center gap-1.5">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1" />
            <path d="M3.5 6l2 2L8.5 4.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          All projects are up to date with the latest TeamAI defaults.
        </div>
      )}
    </section>
  );
}
