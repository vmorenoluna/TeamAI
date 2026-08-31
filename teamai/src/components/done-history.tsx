'use client';

import { useEffect, useState } from 'react';
import { getDoneTicketSpec } from '@/app/actions/history';
import { formatActionError } from '@/lib/error-format';
import type { DoneTicketFromHistory } from '@/lib/history-scanner';

/**
 * DONE-column cards for tickets whose local folder was deleted on
 * completion (§3f) — reconstructed from commit trailers / merged-PR
 * bodies by the HistoryScanner. Read-only by design: the durable record
 * lives in git, so there is nothing to drag, edit, or retry here.
 */

function relativeTime(date: Date): string {
  const diff = Date.now() - date.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

/** QA trailer → compact badge (PASS green / FAIL red / unknown neutral). */
function qaBadgeClass(qaResult?: string): string {
  if (!qaResult) return 'bg-slate-800 text-slate-400';
  if (/^PASS/i.test(qaResult)) return 'bg-green-900/40 text-green-300';
  if (/^FAIL/i.test(qaResult)) return 'bg-red-900/40 text-red-300';
  return 'bg-slate-800 text-slate-400';
}

interface CardProps {
  ticket: DoneTicketFromHistory;
  onSelect: (slug: string) => void;
}

export function DoneHistoryCard({ ticket, onSelect }: CardProps) {
  return (
    <div
      data-component="done-history-card"
      data-slug={ticket.slug}
      onClick={() => onSelect(ticket.slug)}
      className="rounded-lg border border-[#1e293b] bg-[#141824] p-2.5 cursor-pointer hover:border-[#334155] transition-colors"
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') onSelect(ticket.slug); }}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium text-slate-200 line-clamp-2">{ticket.title}</span>
        <span className={`shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full ${qaBadgeClass(ticket.qaResult)}`}>
          {ticket.qaResult ? ticket.qaResult.split('(')[0].trim() : 'QA ?'}
        </span>
      </div>
      {ticket.summary && (
        <p className="mt-1 text-[11px] text-slate-500 line-clamp-2">{ticket.summary}</p>
      )}
      <div className="mt-1.5 flex items-center gap-2 text-[10px] text-slate-600">
        <span>{relativeTime(ticket.completedAt)}</span>
        {ticket.prUrl ? (
          <span className="text-sky-700">PR</span>
        ) : (
          <span>local merge</span>
        )}
      </div>
    </div>
  );
}

interface ModalProps {
  slug: string;
  onClose: () => void;
}

/** Lightweight read-only detail: spec fetched on open, never preloaded. */
export function DoneHistoryModal({ slug, onClose }: ModalProps) {
  const [spec, setSpec] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    // Reset via lazy re-mount key instead of synchronous setState — the
    // modal remounts per slug in the board, so initial state is fresh.
    getDoneTicketSpec(slug)
      .then(res => { if (!cancelled) setSpec(res.spec); })
      .catch(err => { if (!cancelled) setError(formatActionError('load ticket spec', err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [slug]);

  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div className="absolute inset-0 z-40 flex items-center justify-center p-6" data-component="done-history-modal" data-slug={slug}>
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative w-[640px] max-w-[95vw] h-full max-h-[600px] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] bg-[#11131b] overflow-hidden flex flex-col animate-modal-in"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[#1e293b]">
          <span className="text-sm font-semibold text-slate-200">Completed ticket</span>
          <button onClick={onClose} className="text-slate-500 hover:text-slate-300 text-sm leading-none" aria-label="Close">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {loading && <p className="text-xs text-slate-500" data-component="spec-loading">Loading spec…</p>}
          {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
          {!loading && !error && (
            <pre className="whitespace-pre-wrap text-xs text-slate-300 font-mono leading-relaxed" data-component="spec-content">
              {spec ?? 'No specification recorded for this ticket.'}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
