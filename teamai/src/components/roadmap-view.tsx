'use client';

import { useState, useEffect, useTransition, useCallback, useMemo, useRef } from 'react';
import {
  startRoadmapGeneration,
  startChangelogGeneration,
  getRoadmapReports,
  getRoadmapReport,
  getChangelogReports,
  getLatestChangelog,
  getActiveRoadmapSession,
  cancelRoadmapGeneration,
  isRoadmapSessionAlive,
  convertToTask,
  convertMultipleToTasks,
  type ConvertMultipleInput,
  clearLinkedTaskId,
  deleteRoadmapItem,
  getLinkedTaskStatuses,
  type RoadmapItem,
  type RoadmapReport,
} from '@/app/actions/roadmap';
import { useSessionStream } from '@/hooks/use-session-stream';
import { extractText } from '@/lib/stream-types';
import { usePhaseSync } from '@/hooks/use-phase-sync';
import { TaskPanel, type FullData } from './task-panel';
import { PHASE_BADGE, PHASE_LABELS as TASK_PHASE_LABELS, PRIORITY_COLORS } from '@/constants/phases';

// ── Helpers ──────────────────────────────────────────────────────────────────

const PHASE_LABELS: Record<keyof RoadmapReport['phases'], string> = {
  now: 'Phase 1 — Now',
  next: 'Phase 2 — Next',
  later: 'Phase 3 — Later',
  icebox: 'Icebox',
};

function ComplexityDots({ value }: { value: number }) {
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

interface RoadmapCardProps {
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

function RoadmapCard({
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

// ── Phased kanban view ───────────────────────────────────────────────────────

export function PhasedKanban({
  report,
  filename,
  onRefresh,
  onSelectTask,
  onOpenRoadmapItem,
}: {
  report: RoadmapReport;
  filename: string;
  onRefresh: () => void;
  onSelectTask: (taskId: string) => void;
  onOpenRoadmapItem: (item: RoadmapItem, phaseKey: string, itemIndex: number) => void;
}) {
  const phases = report.phases;
  const [linkedStatuses, setLinkedStatuses] = useState<
    Record<string, { phase: string; title: string } | null>
  >({});
  const [convertingKey, setConvertingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isBulkConverting, setIsBulkConverting] = useState(false);
  const [bulkError, setBulkError] = useState(false);

  // Toggle selection of a single item
  function toggleSelect(phaseKey: string, itemIndex: number) {
    const key = `${phaseKey}:${itemIndex}`;
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Toggle all items in a phase
  function toggleSelectAll(phaseKey: string) {
    const phaseItems = phases[phaseKey];
    if (!phaseItems) return;
    // Don't select already-linked items
    const selectable = phaseItems
      .map((item, i) => ({ item, key: `${phaseKey}:${i}` }))
      .filter(({ item }) => !item.linkedTaskId);
    const allSelected = selectable.every(({ key }) => selectedItems.has(key));
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (allSelected) {
        selectable.forEach(({ key }) => next.delete(key));
      } else {
        selectable.forEach(({ key }) => next.add(key));
      }
      return next;
    });
  }

  // Check if all selectable items in a phase are selected
  function isPhaseAllSelected(phaseKey: string): boolean {
    const phaseItems = phases[phaseKey];
    if (!phaseItems || phaseItems.length === 0) return false;
    const selectable = phaseItems.filter(item => !item.linkedTaskId);
    if (selectable.length === 0) return false;
    return selectable.every((_, i) => {
      const idx = phaseItems.indexOf(selectable[i]);
      return selectedItems.has(`${phaseKey}:${idx}`);
    });
  }

  // Bulk convert selected items to tasks
  async function handleBulkConvert() {
    if (selectedItems.size === 0) return;
    setIsBulkConverting(true);
    setBulkError(false);
    const itemList: ConvertMultipleInput[] = [];
    selectedItems.forEach(key => {
      const [phaseKey, idxStr] = key.split(':');
      itemList.push({ phaseKey, itemIndex: parseInt(idxStr, 10) });
    });
    try {
      await convertMultipleToTasks(filename, itemList);
      setSelectedItems(new Set());
      onRefresh();
    } catch {
      setBulkError(true);
    } finally {
      setIsBulkConverting(false);
    }
  }

  // Collect all linked task IDs
  const allLinkedIds = useMemo(() => {
    const ids: string[] = [];
    for (const pk of ['now', 'next', 'later', 'icebox'] as const) {
      for (const item of phases[pk]) {
        if (item.linkedTaskId) ids.push(item.linkedTaskId);
      }
    }
    return ids;
  }, [phases]);

  // Fetch statuses for all linked items on mount / when report changes
  useEffect(() => {
    if (allLinkedIds.length === 0) return;
    let cancelled = false;
    getLinkedTaskStatuses(allLinkedIds)
      .then(result => {
        if (!cancelled) setLinkedStatuses(prev => ({ ...prev, ...result }));
      })
      .catch(() => { /* network error — statuses will load on next render */ });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLinkedIds.join(',')]);

  // Real-time sync: update linked status when a kanban task phase changes
  usePhaseSync({
    onPhaseChange: (taskId, phase) => {
      if (allLinkedIds.includes(taskId)) {
        setLinkedStatuses(prev => {
          const existing = prev[taskId];
          if (!existing) return prev;
          return { ...prev, [taskId]: { ...existing, phase } };
        });
      }
    },
  });

  async function handleConvert(phaseKey: string, itemIndex: number) {
    const key = `${phaseKey}:${itemIndex}`;
    setExpandedKey(null);
    setErrorKey(null);
    setConvertingKey(key);
    try {
      await convertToTask(filename, itemIndex, phaseKey);
      onRefresh();
    } catch {
      setErrorKey(key);
    } finally {
      setConvertingKey(null);
    }
  }

  async function handleDelete(phaseKey: string, itemIndex: number) {
    if (!window.confirm('Remove this item from the roadmap?')) return;
    const key = `${phaseKey}:${itemIndex}`;
    setExpandedKey(null);
    setErrorKey(null);
    setDeletingKey(key);
    try {
      await deleteRoadmapItem(filename, itemIndex, phaseKey);
      onRefresh();
    } catch {
      setErrorKey(key);
    } finally {
      setDeletingKey(null);
    }
  }



  // Clear individual error after 5s
  useEffect(() => {
    if (!errorKey) return;
    const t = setTimeout(() => setErrorKey(null), 5000);
    return () => clearTimeout(t);
  }, [errorKey]);

  // Clear bulk error after 5s
  useEffect(() => {
    if (!bulkError) return;
    const t = setTimeout(() => setBulkError(false), 5000);
    return () => clearTimeout(t);
  }, [bulkError]);

  return (
    <div className="space-y-2">
      {report.executive_summary && (          <p className="text-sm text-slate-400 leading-relaxed">
            {report.executive_summary}
          </p>
      )}

      {report.competitor_analysis_run && (
        <p className="text-xs text-amber-400">
          Competitor analysis was run for this roadmap.
          {report.competitors && report.competitors.length > 0 && (
            <> Competitors: {report.competitors.join(', ')}</>
          )}
        </p>
      )}

      {/* Bulk actions bar */}
      {selectedItems.size > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 bg-[#1e2333] rounded-lg border border-[#2563eb]">
          <span className="text-xs text-slate-300">
            {selectedItems.size} item{selectedItems.size !== 1 ? 's' : ''} selected
          </span>
          <button
            onClick={handleBulkConvert}
            disabled={isBulkConverting}
            className="px-3 py-1 text-xs font-medium bg-[#2563eb] text-white rounded hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors"
          >
            {isBulkConverting ? 'Converting…' : 'Convert Selected'}
          </button>
          <button
            onClick={() => setSelectedItems(new Set())}
            className="px-2 py-1 text-xs text-slate-400 hover:text-slate-300 transition-colors"
          >
            Clear
          </button>
          {bulkError && (
            <span className="text-xs text-red-400">Conversion failed. Try again.</span>
          )}
        </div>
      )}

      {/* Horizontal kanban columns */}
      <div className="overflow-x-auto">
        <div className="flex gap-3 pt-3" style={{ minWidth: 'max-content' }}>
          {(['now', 'next', 'later', 'icebox'] as const).map(phaseKey => (
            <div
              key={phaseKey}
              className="flex flex-col w-72 shrink-0 rounded-lg bg-[#1a1f2e] overflow-hidden"
            >
              {/* Column header */}
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#1e293b]">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={isPhaseAllSelected(phaseKey)}
                    onChange={() => toggleSelectAll(phaseKey)}
                    className="w-3.5 h-3.5 rounded border-[#334155] bg-[#0f1320] text-[#2563eb] focus:ring-[#2563eb] focus:ring-1 cursor-pointer"
                    title={isPhaseAllSelected(phaseKey) ? 'Deselect all' : 'Select all'}
                  />
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                    {PHASE_LABELS[phaseKey]}
                  </span>
                </div>
                <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-[#1e293b] text-slate-500">
                  {phases[phaseKey].length}
                </span>
              </div>

              {/* Column cards */}
              <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[120px]">
                {phases[phaseKey].length === 0 ? (
                  <p className="text-xs text-slate-400 italic text-center py-4">
                    No items
                  </p>
                ) : (
                  phases[phaseKey].map((item, i) => {
                    const cardKey = `${phaseKey}:${i}`;
                    return (
                      <div className="relative" key={cardKey}>
                      <RoadmapCard
                        item={item}
                        linkedStatus={item.linkedTaskId ? linkedStatuses[item.linkedTaskId] : undefined}
                        onConvert={() => handleConvert(phaseKey, i)}
                        onDelete={() => handleDelete(phaseKey, i)}
                        isConverting={convertingKey === cardKey}
                        isDeleting={deletingKey === cardKey}
                        hasError={errorKey === cardKey}
                        isExpanded={expandedKey === cardKey}
                        onToggle={() => setExpandedKey(prev => prev === cardKey ? null : cardKey)}
                        isSelected={selectedItems.has(cardKey)}
                        onToggleSelect={() => toggleSelect(phaseKey, i)}
                        onSelectTask={onSelectTask}
                        onOpenDetail={(item) => onOpenRoadmapItem(item, phaseKey, i)}
                      />
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────────────

type Tab = 'roadmap' | 'changelog';

export function RoadmapView({ noProject }: { noProject: boolean }) {
  const [activeTab, setActiveTab] = useState<Tab>(() => {
    try { return (sessionStorage.getItem('roadmap-tab') as Tab) ?? 'roadmap'; }
    catch { return 'roadmap'; }
  });
  const [skipCompetitors, setSkipCompetitors] = useState(false);
  const [isPending, startTransition] = useTransition();

  // Roadmap state
  const [rmSessionId, setRmSessionId] = useState<string | null>(null);
  const [rmRunning, setRmRunning] = useState(false);
  const [rmReport, setRmReport] = useState<RoadmapReport | null>(null);
  const [rmHistory, setRmHistory] = useState<{ filename: string; date: string }[]>([]);
  const [rmFilename, setRmFilename] = useState<string | null>(null);

  // Changelog state
  const [clSessionId, setClSessionId] = useState<string | null>(null);
  const [clRunning, setClRunning] = useState(false);
  const [clMarkdown, setClMarkdown] = useState<string | null>(null);
  const [clHistory, setClHistory] = useState<{ filename: string; date: string }[]>([]);

  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedRoadmapItem, setSelectedRoadmapItem] = useState<{
    item: RoadmapItem;
    phaseKey: string;
    itemIndex: number;
    filename: string;
  } | null>(null);

  // Rate-limit state
  const [rmRateLimited, setRmRateLimited] = useState(false);
  const [rmRateLimitMessage, setRmRateLimitMessage] = useState('');
  const [clRateLimited, setClRateLimited] = useState(false);
  const [clRateLimitMessage, setClRateLimitMessage] = useState('');
  // Cancel pending state
  const [rmCancelling, setRmCancelling] = useState(false);
  const [clCancelling, setClCancelling] = useState(false);

  // Cache task data so reopening a task is instant (no re-fetch / loading flash)
  const taskCacheRef = useRef<Map<string, { data: FullData }>>(new Map());
  // Cancel-requested signals to handle rapid start/stop race (Bug 2)
  const rmCancelRequestedRef = useRef(false);
  const clCancelRequestedRef = useRef(false);

  const rmStream = useSessionStream(rmSessionId);
  const clStream = useSessionStream(clSessionId);

  // Accumulate full text from all stream events for terminal view
  const rmFullText = useMemo(() => {
    if (rmStream.length === 0) return '';
    let allText = '';
    for (const e of rmStream) {
      const t = extractText(e.event);
      if (t) allText += (allText ? '\n' : '') + t;
    }
    return allText;
  }, [rmStream]);

  const clFullText = useMemo(() => {
    if (clStream.length === 0) return '';
    let allText = '';
    for (const e of clStream) {
      const t = extractText(e.event);
      if (t) allText += (allText ? '\n' : '') + t;
    }
    return allText;
  }, [clStream]);

  // Detect rate-limit events in the stream
  useEffect(() => {
    if (rmStream.length === 0) return;
    for (const e of rmStream) {
      const text = extractText(e.event);
      if (text && /(session.?limit|rate.?limit|too many requests|usage.?limit)/i.test(text)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRmRateLimited(true);
        setRmRunning(false);
        const match = text.match(/resets\s+(\d+:\d+\s*[ap]m)/i);
        setRmRateLimitMessage(match ? `Session limit hit — resets ${match[1]} UTC` : text.slice(0, 200));
        return;
      }
    }
  }, [rmStream]);

  useEffect(() => {
    if (clStream.length === 0) return;
    for (const e of clStream) {
      const text = extractText(e.event);
      if (text && /(session.?limit|rate.?limit|too many requests|usage.?limit)/i.test(text)) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setClRateLimited(true);
        setClRunning(false);
        const match = text.match(/resets\s+(\d+:\d+\s*[ap]m)/i);
        setClRateLimitMessage(match ? `Session limit hit — resets ${match[1]} UTC` : text.slice(0, 200));
        return;
      }
    }
  }, [clStream]);

  const rmDone = rmStream.some(e => e.event.type === 'result');
  const clDone = clStream.some(e => e.event.type === 'result');

  const persistTab = useCallback((tab: Tab) => {
    setActiveTab(tab);
    try { sessionStorage.setItem('roadmap-tab', tab); } catch { /* noop */ }
  }, []);

  // On mount: load history, auto-load most recent, reconnect running sessions
  useEffect(() => {
    async function load() {
      if (noProject) return;

      // Load history lists
      const [rpts, creps] = await Promise.all([
        getRoadmapReports().catch(() => [] as { filename: string; date: string }[]),
        getChangelogReports().catch(() => [] as { filename: string; date: string }[]),
      ]);
      setRmHistory(rpts);
      setClHistory(creps);

      // Check for active sessions (reconnect): try sessionStorage first, then server-side global
      let activeRm: string | null = null;
      let activeCl: string | null = null;
      try { activeRm = sessionStorage.getItem('roadmap-session'); } catch { /* noop */ }
      try { activeCl = sessionStorage.getItem('changelog-session'); } catch { /* noop */ }
      if (!activeRm || !activeCl) {
        const [srvRm, srvCl] = await Promise.all([
          getActiveRoadmapSession('roadmap').catch(() => null),
          getActiveRoadmapSession('changelog').catch(() => null),
        ]);
        if (!activeRm) activeRm = srvRm;
        if (!activeCl) activeCl = srvCl;
      }

      let rmAlive = false;
      if (activeRm) {
        // Verify the session actually exists on the server before reconnecting.
        // sessionStorage may contain a stale ID from a previous server run.
        rmAlive = await isRoadmapSessionAlive(activeRm).catch(() => false);
        if (rmAlive) {
          setRmSessionId(activeRm);
          setRmRunning(true);
        } else {
          // Stale session — clear sessionStorage and don't reconnect
          try { sessionStorage.removeItem('roadmap-session'); } catch { /* noop */ }
        }
      }
      if (!rmAlive && rpts.length > 0) {
        // Auto-load most recent roadmap
        try {
          const report = await getRoadmapReport(rpts[0].filename);
          setRmReport(report);
          setRmFilename(rpts[0].filename);
        } catch { /* ignore stale files */ }
      }

      let clAlive = false;
      if (activeCl) {
        clAlive = await isRoadmapSessionAlive(activeCl).catch(() => false);
        if (clAlive) {
          setClSessionId(activeCl);
          setClRunning(true);
        } else {
          try { sessionStorage.removeItem('changelog-session'); } catch { /* noop */ }
        }
      }
      if (!clAlive && creps.length > 0) {
        // Auto-load most recent changelog
        try {
          const md = await getLatestChangelog(creps[0].filename);
          setClMarkdown(md);
        } catch { /* ignore */ }
      }
    }
    load();
  }, [noProject]);

  // When roadmap result comes in, load the report
  useEffect(() => {
    if (!rmDone || !rmSessionId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRmRunning(false);
    // Reload history + auto-load most recent report
    (async () => {
      const rpts = await getRoadmapReports().catch(() => [] as { filename: string; date: string }[]);
      setRmHistory(rpts);
      if (rpts.length > 0) {
        try {
          const report = await getRoadmapReport(rpts[0].filename);
          setRmReport(report);
          setRmFilename(rpts[0].filename);
        } catch { /* ignore */ }
      }
    })();
    // Persist session ID so reconnect works on navigation
    try { sessionStorage.setItem('roadmap-session', rmSessionId); } catch { /* noop */ }
  }, [rmDone, rmSessionId]);

  // When changelog result comes in, load the markdown
  useEffect(() => {
    if (!clDone || !clSessionId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClRunning(false);
    (async () => {
      const creps = await getChangelogReports().catch(() => [] as { filename: string; date: string }[]);
      setClHistory(creps);
      if (creps.length > 0) {
        try {
          const md = await getLatestChangelog(creps[0].filename);
          setClMarkdown(md);
        } catch { /* ignore */ }
      }
    })();
    try { sessionStorage.setItem('changelog-session', clSessionId); } catch { /* noop */ }
  }, [clDone, clSessionId]);

  // Close the task window on Escape key
  useEffect(() => {
    if (!selectedTaskId) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedTaskId(null);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedTaskId]);

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleSelectTask = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    setSelectedRoadmapItem(null);
  }, []);

  const handleOpenRoadmapItem = useCallback((item: RoadmapItem, phaseKey: string, itemIndex: number) => {
    if (!rmFilename) return;
    setSelectedTaskId(null); // Close task panel if open
    setSelectedRoadmapItem({ item, phaseKey, itemIndex, filename: rmFilename });
  }, [rmFilename]);

  const handleConvertRoadmapItem = useCallback(async () => {
    if (!selectedRoadmapItem) return;
    const { phaseKey, itemIndex, filename } = selectedRoadmapItem;
    startTransition(async () => {
      try {
        const result = await convertToTask(filename, itemIndex, phaseKey);
        setSelectedRoadmapItem(null);
        setSelectedTaskId(result.taskId);
        await refreshRoadmapReport();
      } catch (e) {
        console.error('Failed to convert roadmap item:', e);
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedRoadmapItem]);

  function handleGenerateRoadmap() {
    rmCancelRequestedRef.current = false;
    setRmRunning(true);
    setRmSessionId(null);
    setRmReport(null);
    setRmRateLimited(false);
    setRmRateLimitMessage('');
    startTransition(async () => {
      const id = await startRoadmapGeneration(skipCompetitors);
      if (rmCancelRequestedRef.current) {
        await cancelRoadmapGeneration('roadmap').catch(() => {});
        setRmRunning(false);
        return;
      }
      try { sessionStorage.setItem('roadmap-session', id); } catch { /* noop */ }
      setRmSessionId(id);
    });
  }

  async function handleCancelRoadmap() {
    rmCancelRequestedRef.current = true;
    setRmCancelling(true);
    try {
      await cancelRoadmapGeneration('roadmap');
    } catch { /* best-effort */ }
    setRmRunning(false);
    setRmSessionId(null);
    setRmRateLimited(false);
    setRmRateLimitMessage('');
    try { sessionStorage.removeItem('roadmap-session'); } catch { /* noop */ }
    setRmCancelling(false);
  }

  function handleGenerateChangelog() {
    clCancelRequestedRef.current = false;
    setClRunning(true);
    setClSessionId(null);
    setClMarkdown(null);
    setClRateLimited(false);
    setClRateLimitMessage('');
    startTransition(async () => {
      const id = await startChangelogGeneration();
      if (clCancelRequestedRef.current) {
        await cancelRoadmapGeneration('changelog').catch(() => {});
        setClRunning(false);
        return;
      }
      try { sessionStorage.setItem('changelog-session', id); } catch { /* noop */ }
      setClSessionId(id);
    });
  }

  async function handleCancelChangelog() {
    clCancelRequestedRef.current = true;
    setClCancelling(true);
    try {
      await cancelRoadmapGeneration('changelog');
    } catch { /* best-effort */ }
    setClRunning(false);
    setClSessionId(null);
    setClRateLimited(false);
    setClRateLimitMessage('');
    try { sessionStorage.removeItem('changelog-session'); } catch { /* noop */ }
    setClCancelling(false);
  }

  async function handleSelectRoadmapHistory(filename: string) {
    setRmSessionId(null);
    setRmRunning(false);
    const report = await getRoadmapReport(filename);
    setRmReport(report);
    setRmFilename(filename);
  }

  async function refreshRoadmapReport() {
    if (!rmFilename) return;
    try {
      const report = await getRoadmapReport(rmFilename);
      setRmReport(report);
    } catch { /* ignore */ }
  }

  async function handleSelectChangelogHistory(filename: string) {
    setClSessionId(null);
    setClRunning(false);
    const md = await getLatestChangelog(filename);
    setClMarkdown(md);
  }

  // ── Empty state ──────────────────────────────────────────────────────────

  if (noProject) {
    return (
      <div className="flex flex-col h-full p-6 bg-[#11131b]">
        {/* Tabs */}
        <div className="flex gap-0 border-b border-[#1e293b] mb-4">
          <button
            onClick={() => persistTab('roadmap')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'roadmap'
                ? 'border-[#2563eb] text-white'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            Roadmap
          </button>
          <button
            onClick={() => persistTab('changelog')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'changelog'
                ? 'border-[#2563eb] text-white'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
          >
            Changelog
          </button>
        </div>
        <p className="text-sm text-slate-400">Select or add a project from the sidebar to get started.</p>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className={`flex flex-col h-full p-6 bg-[#11131b] relative ${selectedTaskId ? 'overflow-hidden' : ''}`}>
      {/* Tab bar */}
      <div className="flex gap-0 border-b border-[#1e293b] mb-4 shrink-0">
        <button
          onClick={() => persistTab('roadmap')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'roadmap'
              ? 'border-[#2563eb] text-white'
              : 'border-transparent text-slate-400 hover:text-slate-300'
          }`}
        >
          Roadmap
        </button>
        <button
          onClick={() => persistTab('changelog')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${            activeTab === 'changelog'
                ? 'border-[#2563eb] text-white'
                : 'border-transparent text-slate-400 hover:text-slate-300'
            }`}
        >
          Changelog
        </button>
      </div>

      {/* Tab content */}
      <div className={`flex-1 overflow-y-auto min-h-0 ${selectedTaskId ? 'pointer-events-none select-none' : ''}`}>
        {activeTab === 'roadmap' && (
          <div className="flex flex-col gap-4">
            {/* Controls */}
            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={skipCompetitors}
                  onChange={e => setSkipCompetitors(e.target.checked)}
                  className="rounded border-slate-300"
                />
                Skip competitor research
              </label>

              <button
                onClick={handleGenerateRoadmap}
                disabled={isPending || rmRunning}
                className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors"
              >
                {rmRunning && !rmDone ? 'Generating…' : 'Generate Roadmap'}
              </button>

              {rmRunning && (
                <button
                  onClick={handleCancelRoadmap}
                  disabled={rmCancelling}
                  className="px-3 py-2 text-sm font-medium text-red-400 border border-red-800 rounded-lg hover:bg-red-950/30 disabled:opacity-40 transition-colors"
                >
                  {rmCancelling ? 'Stopping…' : '✕ Stop'}
                </button>
              )}

              {rmHistory.length > 0 && (
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <span>History:</span>
                  <select
                    onChange={e => { if (e.target.value) handleSelectRoadmapHistory(e.target.value); }}
                    defaultValue=""
                    className="text-sm border border-[#334155] rounded px-2 py-1 bg-[#1a1f2e] text-slate-200"
                  >
                    <option value="" disabled>Select a previous run</option>
                    {rmHistory.map(r => (
                      <option key={r.filename} value={r.filename}>{r.date}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Rate-limit indicator */}
            {rmRateLimited && (
              <div className="bg-amber-950/30 border border-amber-800 rounded-lg p-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-amber-400 text-lg">⏳</span>
                  <span className="text-sm text-amber-300">{rmRateLimitMessage}</span>
                </div>
                <button
                  onClick={handleGenerateRoadmap}
                  disabled={isPending}
                  className="px-4 py-2 text-sm font-medium bg-amber-700 text-amber-100 rounded-lg hover:bg-amber-600 disabled:opacity-40 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Streaming output — show full accumulated text while running */}
            {rmRunning && rmFullText && !rmRateLimited && (
              <div className="bg-[#1a1f2e] rounded-lg border border-[#1e293b] p-4 max-h-80 overflow-y-auto">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Agent Output</span>
                  <span className="text-[10px] text-slate-600">{rmStream.length} event{rmStream.length !== 1 ? 's' : ''}</span>
                </div>
                <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
                  {rmFullText}
                </pre>
              </div>
            )}

            {/* Phased kanban view */}
            {rmReport && rmFilename && (
              <PhasedKanban
                report={rmReport}
                filename={rmFilename}
                onRefresh={refreshRoadmapReport}
                onSelectTask={handleSelectTask}
                onOpenRoadmapItem={handleOpenRoadmapItem}
              />
            )}

            {/* Empty state */}
            {!rmRunning && !rmReport && !rmFullText && (
              <p className="text-sm text-slate-400">
                No roadmap generated yet. Click &apos;Generate Roadmap&apos; to start.
              </p>
            )}
          </div>
        )}

        {activeTab === 'changelog' && (
          <div className="flex flex-col gap-4">
            {/* Controls */}
            <div className="flex items-center gap-4 flex-wrap">
              <button
                onClick={handleGenerateChangelog}
                disabled={isPending || clRunning}
                className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors"
              >
                {clRunning && !clDone ? 'Generating…' : 'Generate Changelog'}
              </button>

              {clRunning && (
                <button
                  onClick={handleCancelChangelog}
                  disabled={clCancelling}
                  className="px-3 py-2 text-sm font-medium text-red-400 border border-red-800 rounded-lg hover:bg-red-950/30 disabled:opacity-40 transition-colors"
                >
                  {clCancelling ? 'Stopping…' : '✕ Stop'}
                </button>
              )}

              <div className="flex items-center gap-2 text-sm text-slate-400">
                <span>Previous changelogs:</span>
                <select
                  onChange={e => { if (e.target.value) handleSelectChangelogHistory(e.target.value); }}
                  defaultValue=""
                  disabled={clHistory.length === 0}
                  className="text-sm border border-[#334155] rounded px-2 py-1 bg-[#1a1f2e] text-slate-200 disabled:opacity-40"
                >
                  {clHistory.length === 0 ? (
                    <option value="" disabled>None generated yet</option>
                  ) : [
                    <option key="placeholder" value="" disabled>Select</option>,
                    ...clHistory.map(c => (
                      <option key={c.filename} value={c.filename}>{c.date}</option>
                    ))
                  ]}
                </select>
              </div>
            </div>

            {/* Rate-limit indicator */}
            {clRateLimited && (
              <div className="bg-amber-950/30 border border-amber-800 rounded-lg p-4 flex items-center justify-between gap-4">
                <div className="flex items-center gap-2">
                  <span className="text-amber-400 text-lg">⏳</span>
                  <span className="text-sm text-amber-300">{clRateLimitMessage}</span>
                </div>
                <button
                  onClick={handleGenerateChangelog}
                  disabled={isPending}
                  className="px-4 py-2 text-sm font-medium bg-amber-700 text-amber-100 rounded-lg hover:bg-amber-600 disabled:opacity-40 transition-colors"
                >
                  Retry
                </button>
              </div>
            )}

            {/* Streaming output — show full accumulated text while running */}
            {clRunning && clFullText && !clRateLimited && (
              <div className="bg-[#1a1f2e] rounded-lg border border-[#1e293b] p-4 max-h-80 overflow-y-auto">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Agent Output</span>
                  <span className="text-[10px] text-slate-600">{clStream.length} event{clStream.length !== 1 ? 's' : ''}</span>
                </div>
                <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
                  {clFullText}
                </pre>
              </div>
            )}

            {/* Changelog result */}
            {clMarkdown && (
              <div className="bg-[#1a1f2e] rounded-lg border border-[#1e293b] p-4 max-h-[60vh] overflow-y-auto">
                <pre className="whitespace-pre-wrap font-mono text-xs text-slate-300 leading-relaxed">
                  {clMarkdown}
                </pre>
              </div>
            )}

            {/* Empty state */}
            {!clRunning && !clMarkdown && !clFullText && (
              <p className="text-sm text-slate-400">
                No changelog generated yet. Click &apos;Generate Changelog&apos; to start.
              </p>
            )}
          </div>
        )}
      </div>

      {/* Floating task window overlay */}
      {selectedTaskId && (
        <div className="absolute inset-0 z-40 flex items-center justify-center p-6">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setSelectedTaskId(null)}
          />
          {/* Window */}
          <div              className="relative w-[800px] max-w-[95vw] max-h-[calc(100%-3rem)] h-[650px] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] bg-[#11131b] overflow-hidden flex flex-col animate-modal-in"
            onClick={e => e.stopPropagation()}
          >
            <TaskPanel
              taskId={selectedTaskId}
              onClose={() => setSelectedTaskId(null)}
              readonly
              cachedData={taskCacheRef.current.get(selectedTaskId)?.data ?? undefined}
              onDataLoaded={(data, tid) => {
                taskCacheRef.current.set(tid, { data });
              }}
              onError={(errorMsg) => {
                // Only handle "not found" errors - other errors (network, etc.) should not redirect
                if (!errorMsg.includes('not found')) return;
                // Task was deleted - auto-clear the stale linkedTaskId and show roadmap item detail
                setSelectedTaskId(null);
                if (rmReport && rmFilename) {
                  for (const phaseKey of ['now', 'next', 'later', 'icebox'] as const) {
                    const items = rmReport.phases[phaseKey];
                    const idx = items.findIndex(item => item.linkedTaskId === selectedTaskId);
                    if (idx !== -1) {
                      // Clear the stale link automatically
                      clearLinkedTaskId(rmFilename, idx, phaseKey);
                      setSelectedRoadmapItem({
                        item: items[idx],
                        phaseKey,
                        itemIndex: idx,
                        filename: rmFilename,
                      });
                      return;
                    }
                  }
                }
              }}
            />
          </div>
        </div>
      )}

      {/* Roadmap item detail overlay */}
      {selectedRoadmapItem && (
        <div className="absolute inset-0 z-40 flex items-center justify-center p-6">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/40 backdrop-blur-sm"
            onClick={() => setSelectedRoadmapItem(null)}
          />
          {/* Window */}
          <div
            className="relative w-[700px] h-[550px] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] bg-[#11131b] overflow-hidden flex flex-col animate-modal-in"
            onClick={e => e.stopPropagation()}
          >
            {/* Title bar */}
            <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-[#1e293b] bg-[#1a1f2e]">
              <div className="flex items-center gap-3 min-w-0">
                <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${PRIORITY_COLORS[selectedRoadmapItem.item.priority]}`}>
                  {selectedRoadmapItem.item.priority}
                </span>
                <h2 className="text-base font-semibold text-white truncate">
                  {selectedRoadmapItem.item.title}
                </h2>
                <span className="shrink-0 text-[10px] text-slate-500">
                  {selectedRoadmapItem.item.category}
                </span>
              </div>
              <button
                onClick={() => setSelectedRoadmapItem(null)}
                title="Close"
                className="shrink-0 ml-3 w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-white hover:bg-[#1e293b] transition-colors text-lg leading-none"
              >
                ×
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
              {/* Source info */}
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">Source:</span>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                  selectedRoadmapItem.item.source === 'competitor-analysis'
                    ? 'bg-amber-900/30 text-amber-400'
                    : 'bg-blue-900/30 text-blue-400'
                }`}>
                  {selectedRoadmapItem.item.source === 'competitor-analysis' ? 'Competitor Analysis' : 'Ideation'}
                </span>
                {selectedRoadmapItem.item.competitive_context && (
                  <span className="text-xs text-amber-400 italic">{selectedRoadmapItem.item.competitive_context}</span>
                )}
              </div>

              {/* Complexity */}
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">Complexity:</span>
                <ComplexityDots value={selectedRoadmapItem.item.complexity} />
                <span className="text-xs text-slate-400 tabular-nums">({selectedRoadmapItem.item.complexity}/5)</span>
              </div>

              {/* Description */}
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Description</h3>
                <p className="text-sm text-slate-300 leading-relaxed">
                  {selectedRoadmapItem.item.description}
                </p>
              </div>

              {/* Affected files */}
              {selectedRoadmapItem.item.affected_files && selectedRoadmapItem.item.affected_files.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Affected Files</h3>
                  <ul className="space-y-1">
                    {selectedRoadmapItem.item.affected_files.map((f, i) => (
                      <li key={i} className="text-xs text-slate-400 font-mono bg-[#1a1f2e] px-2 py-1 rounded">
                        {f}
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {/* Phase info */}
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">Phase:</span>
                <span className="text-xs text-slate-300">
                  {(PHASE_LABELS as Record<string, string>)[selectedRoadmapItem.phaseKey] ?? selectedRoadmapItem.phaseKey}
                </span>
              </div>
            </div>

            {/* Action bar */}
            <div className="shrink-0 flex items-center justify-end gap-3 px-5 py-3 border-t border-[#1e293b] bg-[#1a1f2e]">
              <button
                onClick={() => setSelectedRoadmapItem(null)}
                className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
              >
                Close
              </button>
              <button
                onClick={handleConvertRoadmapItem}
                disabled={isPending}
                className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors"
              >
                {isPending ? 'Converting…' : 'Convert to Ticket'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
