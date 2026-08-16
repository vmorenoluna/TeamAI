'use client';

import { useState } from 'react';
import { dismissDefaultsSyncReport } from '@/app/actions/projects';
import type { DefaultsSyncReport } from '@/lib/project-store';

interface Props {
  /** Auto-sync report persisted at the last startup sync (from SSR). */
  initialReport?: DefaultsSyncReport | null;
}

/**
 * Informational banner shown after TeamAI force-synced default commands at
 * startup. Unlike the old "Defaults update available" prompt, there is no
 * click-to-sync action — the sync already happened; this only informs the
 * user of what changed and can be dismissed.
 */
export function DefaultsUpdater({ initialReport }: Props) {
  const [report, setReport] = useState<DefaultsSyncReport | null>(
    initialReport ?? null,
  );
  const [dismissing, setDismissing] = useState(false);

  if (!report || report.projects.length === 0) return null;

  async function handleDismiss() {
    setDismissing(true);
    try {
      await dismissDefaultsSyncReport();
      setReport(null);
    } catch {
      // best-effort: the banner hides locally even if the action fails
      setReport(null);
    } finally {
      setDismissing(false);
    }
  }

  return (
    <div className="px-3 py-2 border-b border-[#1e293b] bg-[#0f1219]">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium text-slate-300 flex items-center gap-1.5">
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
            <circle cx="6" cy="6" r="5" stroke="currentColor" strokeWidth="1.2" />
            <path d="M6 3v3" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            <circle cx="6" cy="9" r="0.6" fill="currentColor" />
          </svg>
          TeamAI defaults auto-synced
        </span>
        <button
          onClick={handleDismiss}
          disabled={dismissing}
          className="shrink-0 px-2 py-0.5 text-[10px] text-slate-500 hover:text-slate-300 rounded border border-transparent hover:border-[#1e293b] transition-colors disabled:opacity-40"
        >
          {dismissing ? 'Dismissing…' : 'Dismiss'}
        </button>
      </div>

      <p className="text-[11px] text-slate-500 mt-0.5">
        Default command templates were updated to match the latest TeamAI
        workflow so every project runs the current orchestration contract.
      </p>

      <ul className="mt-1 space-y-0.5">
        {report.projects.map(p => (
          <li key={p.projectPath} className="text-[10px] text-slate-500">
            <span className="text-slate-400 font-medium">{p.projectName}</span>
            {' · '}
            {p.updatedFiles.length} file{p.updatedFiles.length !== 1 ? 's' : ''}:{' '}
            {p.updatedFiles.slice(0, 3).join(', ')}
            {p.updatedFiles.length > 3 && ` +${p.updatedFiles.length - 3} more`}
          </li>
        ))}
      </ul>
    </div>
  );
}
