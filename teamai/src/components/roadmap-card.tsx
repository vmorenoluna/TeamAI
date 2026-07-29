'use client';

import type { RoadmapItem, RoadmapReport } from '@/app/actions/roadmap';
import { PHASE_BADGE, PHASE_LABELS as TASK_PHASE_LABELS, PRIORITY_COLORS } from '@/constants/phases';

// ── Helpers ──────────────────────────────────────────────────────────────────

export const PHASE_LABELS: Record<keyof RoadmapReport['phases'], string> = {
  now: 'Phase 1 — Now',
  next: 'Phase 2 — Next',
  later: 'Phase 3 — Later',
  icebox: 'Icebox',
};

export function ComplexityDots({ value }: { value: number }) {
  return (
    <span className="inline-flex gap-0.5" role="img" aria-label={`Complexity ${value} out of 5`}>
      {[1, 2, 3, 4, 5].map(n => (
        <span
          key={n}
          aria-hidden
          className={`text-xs ${n <= value ? 'text-blue-400' : 'text-slate-600'}`}
        >
          ●
        </span>
      ))}
    </span>
  );
}

// ── Roadmap item card ────────────────────────────────────────────────────────

export interface RoadmapCardProps {
  item: RoadmapItem;
  linkedStatus: { phase: string; title: string } | null | undefined;
  onConvert: () => void;
  onDelete: () => void;
  isConverting: boolean;
  isDeleting: boolean;
  hasError: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  isSelected: boolean;
  onToggleSelect: () => void;
  onSelectTask: (taskId: string) => void;
  onOpenDetail: (item: RoadmapItem) => void;
}

export function RoadmapCard({
  item,
  linkedStatus,
  onConvert,
  onDelete,
  isConverting,
  isDeleting,
  hasError,
  isExpanded,
  onToggle: _onToggle,
  isSelected,
  onToggleSelect,
  onSelectTask,
  onOpenDetail,
}: RoadmapCardProps) {
  const isLinked = !!item.linkedTaskId;
  const statusBadge = linkedStatus
    ? (PHASE_BADGE[linkedStatus.phase] ?? PHASE_BADGE.backlog)
    : null;

  function handleConvertClick(e: React.MouseEvent) {
    e.stopPropagation();
    onConvert();
  }

  function handleDeleteClick(e: React.MouseEvent) {
    e.stopPropagation();
    onDelete();
  }

  function handleCardClick() {
    if (isLinked) {
      onSelectTask(item.linkedTaskId!);
    } else {
      onOpenDetail(item);
    }
  }

  return (
    <div
      onClick={handleCardClick}
      className={`bg-[#1e2333] rounded-lg border p-3 flex flex-col gap-2 group/card transition-all cursor-pointer ${
        hasError
          ? 'border-red-800 bg-red-950/20'
          : isExpanded
            ? 'border-[#2563eb] bg-blue-950/10 hover:border-blue-400'
            : isSelected
              ? 'border-[#2563eb] bg-blue-950/20'
              : 'border-[#1e293b] hover:border-[#334155]'
      } hover:shadow-md`}
    >
      {/* Selection checkbox */}
      {isLinked ? null : (
        <div className="absolute top-2 right-2" onClick={e => e.stopPropagation()}>
          <input
            type="checkbox"
            aria-label="Select roadmap item"
            checked={isSelected}
            onChange={onToggleSelect}
            className="w-4 h-4 rounded border-[#334155] bg-[#0f1320] text-[#2563eb] focus:ring-[#2563eb] focus:ring-1 cursor-pointer"
          />
        </div>
      )}
      {/* Header: priority + title + category */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${PRIORITY_COLORS[item.priority]}`}>
            {item.priority}
          </span>
          <span className="text-sm font-semibold text-white truncate">
            {item.title}
          </span>
        </div>
        <span className="shrink-0 text-[10px] text-slate-500">
          {item.category}
        </span>
      </div>

      {/* Complexity */}
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <span>Complexity:</span>
        <ComplexityDots value={item.complexity} />
        <span className="tabular-nums">({item.complexity}/5)</span>
      </div>

      {/* Description — truncated when collapsed, full when expanded */}
      <p className={`text-xs text-slate-400 leading-relaxed ${isExpanded ? '' : 'line-clamp-3'}`}>
        {item.description}
      </p>

      {/* Affected files — only shown when expanded */}
      {isExpanded && item.affected_files && item.affected_files.length > 0 && (
        <div className="border-t border-[#1e293b] pt-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Affected Files
          </span>
          <ul className="mt-1 space-y-0.5">
            {item.affected_files.map((f, i) => (
              <li key={i} className="text-[10px] text-slate-400 font-mono truncate">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Source */}
      <div className="flex items-center gap-3 text-[11px] text-slate-400">
        <span className="italic">Source: {item.source}</span>
        {item.competitive_context && (
          <span className="italic text-amber-400">
            {item.competitive_context}
          </span>
        )}
      </div>

      {/* Error message */}
      {hasError && (
        <p className="text-[10px] text-red-400">
          Action failed — please try again.
        </p>
      )}

      {/* Hint — on unlinked cards */}
      {!isLinked && !hasError && (
        <p className="text-[10px] text-slate-500 italic">
          Click to view details
        </p>
      )}

      {/* Actions row */}
      <div className="flex items-center justify-between gap-2 pt-1 border-t border-[#1e293b]">
        {/* Left: linked status badge or convert button */}
        {isLinked ? (
          statusBadge ? (
            <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${statusBadge}`}>
              {linkedStatus ? (TASK_PHASE_LABELS[linkedStatus.phase] ?? linkedStatus.phase) : '…'}
            </span>
          ) : (
            <span className="text-[10px] text-slate-400">…</span>
          )
        ) : (
          <button
            onClick={handleConvertClick}
            disabled={isConverting || hasError}
            className="text-[11px] font-medium text-blue-400 hover:text-blue-300 disabled:opacity-40 transition-colors"
          >
            {isConverting ? 'Converting…' : '+ Convert to ticket'}
          </button>
        )}

        {/* Right: delete button (subtle, visible on hover) */}
        <button
          onClick={handleDeleteClick}
          disabled={isDeleting}
          title="Delete from roadmap"
          className="text-[11px] text-slate-600 hover:text-red-400 disabled:opacity-40 opacity-40 group-hover/card:opacity-100 focus-visible:opacity-100 transition-all"
        >
          {isDeleting ? '…' : '✕'}
        </button>
      </div>


    </div>
  );
}
