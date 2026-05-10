'use client';

import { useState, useEffect, useTransition, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import {
  startRoadmapGeneration,
  startChangelogGeneration,
  getRoadmapReports,
  getRoadmapReport,
  getChangelogReports,
  getLatestChangelog,
  getActiveRoadmapSession,
  convertToTask,
  deleteRoadmapItem,
  getLinkedTaskStatuses,
  type RoadmapItem,
  type RoadmapReport,
} from '@/app/actions/roadmap';
import { useSessionStream } from '@/hooks/use-session-stream';
import { usePhaseSync } from '@/hooks/use-phase-sync';

// ── Helpers ──────────────────────────────────────────────────────────────────

function extractText(event: any): string {
  if (event.type !== 'assistant') return '';
  return (event.message?.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
}

const PHASE_LABELS: Record<keyof RoadmapReport['phases'], string> = {
  now: 'Phase 1 — Now',
  next: 'Phase 2 — Next',
  later: 'Phase 3 — Later',
  icebox: 'Icebox',
};

const PRIORITY_COLORS: Record<string, string> = {
  P0: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
  P1: 'bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400',
  P2: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  P3: 'bg-slate-100 text-slate-500 dark:bg-slate-800 dark:text-slate-400',
};

function ComplexityDots({ value }: { value: number }) {
  return (
    <span className="inline-flex gap-0.5" role="img" aria-label={`Complexity ${value} out of 5`}>
      {[1, 2, 3, 4, 5].map(n => (
        <span
          key={n}
          aria-hidden
          className={`text-xs ${n <= value ? 'text-blue-500 dark:text-blue-400' : 'text-slate-300 dark:text-slate-600'}`}
        >
          ●
        </span>
      ))}
    </span>
  );
}

// ── Streaming output block ───────────────────────────────────────────────────

function StreamingBlock({ text }: { text: string }) {
  return (
    <div className="bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 p-4 max-h-80 overflow-y-auto">
      <pre className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
        {text}
      </pre>
    </div>
  );
}

const LINKED_PHASE_BADGE: Record<string, string> = {
  backlog: 'bg-slate-200 text-slate-700 dark:bg-slate-600 dark:text-slate-200',
  spec: 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  plan: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
  implement: 'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  'qa-review': 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  'qa-fix': 'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  'awaiting-review': 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  merge: 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  'create-pr': 'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  failed: 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  done: 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
};

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
  onSelectTask: (taskId: string) => void;
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
  onToggle,
  onSelectTask,
}: RoadmapCardProps) {
  const isLinked = !!item.linkedTaskId;
  const statusBadge = linkedStatus
    ? (LINKED_PHASE_BADGE[linkedStatus.phase] ?? LINKED_PHASE_BADGE.backlog)
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
      onToggle();
    }
  }

  return (
    <div
      onClick={handleCardClick}
      className={`bg-white dark:bg-slate-800 rounded-lg border p-3 flex flex-col gap-2 group/card transition-all cursor-pointer ${
        hasError
          ? 'border-red-300 dark:border-red-700 bg-red-50 dark:bg-red-950/20'
          : isExpanded
            ? 'border-blue-300 dark:border-blue-700 bg-blue-50/30 dark:bg-blue-950/10 hover:border-blue-400 dark:hover:border-blue-500'
            : 'border-slate-200 dark:border-slate-700 hover:border-slate-400 dark:hover:border-slate-500'
      } hover:shadow-md`}
    >
      {/* Header: priority + title + category */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${PRIORITY_COLORS[item.priority]}`}>
            {item.priority}
          </span>
          <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">
            {item.title}
          </span>
        </div>
        <span className="shrink-0 text-[10px] text-slate-400 dark:text-slate-500">
          {item.category}
        </span>
      </div>

      {/* Complexity */}
      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span>Complexity:</span>
        <ComplexityDots value={item.complexity} />
        <span className="tabular-nums">({item.complexity}/5)</span>
      </div>

      {/* Description — truncated when collapsed, full when expanded */}
      <p className={`text-xs text-slate-600 dark:text-slate-400 leading-relaxed ${isExpanded ? '' : 'line-clamp-3'}`}>
        {item.description}
      </p>

      {/* Affected files — only shown when expanded */}
      {isExpanded && item.affected_files && item.affected_files.length > 0 && (
        <div className="border-t border-slate-100 dark:border-slate-700 pt-2">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 dark:text-slate-500">
            Affected Files
          </span>
          <ul className="mt-1 space-y-0.5">
            {item.affected_files.map((f, i) => (
              <li key={i} className="text-[10px] text-slate-500 dark:text-slate-400 font-mono truncate">
                {f}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Source */}
      <div className="flex items-center gap-3 text-[11px] text-slate-400 dark:text-slate-500">
        <span className="italic">Source: {item.source}</span>
        {item.competitive_context && (
          <span className="italic text-amber-600 dark:text-amber-400">
            {item.competitive_context}
          </span>
        )}
      </div>

      {/* Error message */}
      {hasError && (
        <p className="text-[10px] text-red-600 dark:text-red-400">
          Action failed — please try again.
        </p>
      )}

      {/* Expand hint — only on unlinked, collapsed cards */}
      {!isLinked && !isExpanded && !hasError && (
        <p className="text-[10px] text-slate-400 dark:text-slate-500 italic">
          Click to expand details
        </p>
      )}

      {/* Actions row */}
      <div className="flex items-center justify-between gap-2 pt-1 border-t border-slate-100 dark:border-slate-700">
        {/* Left: linked status badge or convert button */}
        {isLinked ? (
          statusBadge ? (
            <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${statusBadge}`}>
              {linkedStatus?.phase ?? '…'}
            </span>
          ) : (
            <span className="text-[10px] text-slate-400 dark:text-slate-500">…</span>
          )
        ) : (
          <button
            onClick={handleConvertClick}
            disabled={isConverting || hasError}
            className="text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:text-blue-800 dark:hover:text-blue-300 disabled:opacity-40 transition-colors"
          >
            {isConverting ? 'Converting…' : '+ Convert to ticket'}
          </button>
        )}

        {/* Right: delete button (subtle, visible on hover) */}
        <button
          onClick={handleDeleteClick}
          disabled={isDeleting}
          title="Delete from roadmap"
          className="text-[11px] text-slate-300 dark:text-slate-600 hover:text-red-500 dark:hover:text-red-400 disabled:opacity-40 opacity-40 group-hover/card:opacity-100 focus-visible:opacity-100 transition-all"
        >
          {isDeleting ? '…' : '✕'}
        </button>
      </div>

      {/* Collapse hint — only on expanded cards */}
      {isExpanded && !isLinked && (
        <p className="text-[10px] text-blue-500 dark:text-blue-400 italic">
          Click to collapse
        </p>
      )}

      {/* Navigation hint — only on linked cards */}
      {isLinked && (
        <p className="text-[10px] text-slate-400 dark:text-slate-500 italic">
          Click to view task
        </p>
      )}
    </div>
  );
}

// ── Phased kanban view ───────────────────────────────────────────────────────

function PhasedKanban({
  report,
  filename,
  onRefresh,
  onSelectTask,
}: {
  report: RoadmapReport;
  filename: string;
  onRefresh: () => void;
  onSelectTask: (taskId: string) => void;
}) {
  const phases = report.phases;
  const [linkedStatuses, setLinkedStatuses] = useState<
    Record<string, { phase: string; title: string } | null>
  >({});
  const [convertingKey, setConvertingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);

  // Collect all linked task IDs
  const allLinkedIds = useMemo(() => {
    const ids: string[] = [];
    for (const pk of ['now', 'next', 'later', 'icebox'] as const) {
      for (const item of phases[pk]) {
        if (item.linkedTaskId) ids.push(item.linkedTaskId);
      }
    }
    return ids;
  }, [phases.now, phases.next, phases.later, phases.icebox]);

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

  // Clear error after 5s
  useEffect(() => {
    if (!errorKey) return;
    const t = setTimeout(() => setErrorKey(null), 5000);
    return () => clearTimeout(t);
  }, [errorKey]);

  return (
    <div className="space-y-2">
      {report.executive_summary && (
        <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed">
          {report.executive_summary}
        </p>
      )}

      {report.competitor_analysis_run && (
        <p className="text-xs text-amber-600 dark:text-amber-400">
          Competitor analysis was run for this roadmap.
        </p>
      )}

      {/* Horizontal kanban columns */}
      <div className="overflow-x-auto">
        <div className="flex gap-3 pt-3" style={{ minWidth: 'max-content' }}>
          {(['now', 'next', 'later', 'icebox'] as const).map(phaseKey => (
            <div
              key={phaseKey}
              className="flex flex-col w-72 shrink-0 rounded-lg bg-slate-100 dark:bg-slate-800 overflow-hidden"
            >
              {/* Column header */}
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-200 dark:border-slate-700">
                <span className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                  {PHASE_LABELS[phaseKey]}
                </span>
                <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-slate-200 dark:bg-slate-700 text-slate-400">
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
                      <RoadmapCard
                        key={cardKey}
                        item={item}
                        linkedStatus={item.linkedTaskId ? linkedStatuses[item.linkedTaskId] : undefined}
                        onConvert={() => handleConvert(phaseKey, i)}
                        onDelete={() => handleDelete(phaseKey, i)}
                        isConverting={convertingKey === cardKey}
                        isDeleting={deletingKey === cardKey}
                        hasError={errorKey === cardKey}
                        isExpanded={expandedKey === cardKey}
                        onToggle={() => setExpandedKey(prev => prev === cardKey ? null : cardKey)}
                        onSelectTask={onSelectTask}
                      />
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
  const router = useRouter();
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

  const rmStream = useSessionStream(rmSessionId);
  const clStream = useSessionStream(clSessionId);

  // Accumulate streaming text
  const rmLatestText = (() => {
    for (let i = rmStream.length - 1; i >= 0; i--) {
      const t = extractText(rmStream[i].event);
      if (t) return t;
    }
    return '';
  })();

  const clLatestText = (() => {
    for (let i = clStream.length - 1; i >= 0; i--) {
      const t = extractText(clStream[i].event);
      if (t) return t;
    }
    return '';
  })();

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

      if (activeRm) {
        setRmSessionId(activeRm);
        setRmRunning(true);
      } else if (rpts.length > 0) {
        // Auto-load most recent roadmap
        try {
          const report = await getRoadmapReport(rpts[0].filename);
          setRmReport(report);
          setRmFilename(rpts[0].filename);
        } catch { /* ignore stale files */ }
      }

      if (activeCl) {
        setClSessionId(activeCl);
        setClRunning(true);
      } else if (creps.length > 0) {
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

  // ── Handlers ─────────────────────────────────────────────────────────────

  const handleSelectTask = useCallback((taskId: string) => {
    router.push(`/task/${taskId}`);
  }, [router]);

  function handleGenerateRoadmap() {
    setRmRunning(true);
    setRmReport(null);
    startTransition(async () => {
      const id = await startRoadmapGeneration(skipCompetitors);
      try { sessionStorage.setItem('roadmap-session', id); } catch { /* noop */ }
      setRmSessionId(id);
    });
  }

  function handleGenerateChangelog() {
    setClRunning(true);
    setClMarkdown(null);
    startTransition(async () => {
      const id = await startChangelogGeneration();
      try { sessionStorage.setItem('changelog-session', id); } catch { /* noop */ }
      setClSessionId(id);
    });
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
      <div className="flex flex-col h-full p-6 bg-slate-50 dark:bg-slate-950">
        {/* Tabs */}
        <div className="flex gap-0 border-b border-slate-200 dark:border-slate-700 mb-4">
          <button
            onClick={() => persistTab('roadmap')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'roadmap'
                ? 'border-slate-900 dark:border-white text-slate-900 dark:text-white'
                : 'border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
            }`}
          >
            Roadmap
          </button>
          <button
            onClick={() => persistTab('changelog')}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === 'changelog'
                ? 'border-slate-900 dark:border-white text-slate-900 dark:text-white'
                : 'border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
            }`}
          >
            Changelog
          </button>
        </div>
        <p className="text-sm text-slate-400 dark:text-slate-500">Select or add a project from the sidebar to get started.</p>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full p-6 bg-slate-50 dark:bg-slate-950">
      {/* Tab bar */}
      <div className="flex gap-0 border-b border-slate-200 dark:border-slate-700 mb-4 shrink-0">
        <button
          onClick={() => persistTab('roadmap')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'roadmap'
              ? 'border-slate-900 dark:border-white text-slate-900 dark:text-white'
              : 'border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
          }`}
        >
          Roadmap
        </button>
        <button
          onClick={() => persistTab('changelog')}
          className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
            activeTab === 'changelog'
              ? 'border-slate-900 dark:border-white text-slate-900 dark:text-white'
              : 'border-transparent text-slate-400 hover:text-slate-600 dark:hover:text-slate-300'
          }`}
        >
          Changelog
        </button>
      </div>

      {/* Tab content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        {activeTab === 'roadmap' && (
          <div className="flex flex-col gap-4">
            {/* Controls */}
            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400 cursor-pointer select-none">
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
                disabled={isPending || (rmRunning && !rmDone)}
                className="px-4 py-2 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-md hover:bg-slate-700 dark:hover:bg-slate-200 disabled:opacity-40 transition-colors"
              >
                {rmRunning && !rmDone ? 'Generating…' : 'Generate Roadmap'}
              </button>

              {rmHistory.length > 0 && (
                <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                  <span>History:</span>
                  <select
                    onChange={e => { if (e.target.value) handleSelectRoadmapHistory(e.target.value); }}
                    defaultValue=""
                    className="text-sm border border-slate-300 dark:border-slate-600 rounded px-2 py-1 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                  >
                    <option value="" disabled>Select a previous run</option>
                    {rmHistory.map(r => (
                      <option key={r.filename} value={r.filename}>{r.date}</option>
                    ))}
                  </select>
                </div>
              )}
            </div>

            {/* Streaming output */}
            {rmRunning && rmLatestText && <StreamingBlock text={rmLatestText} />}

            {/* Phased kanban view */}
            {rmReport && rmFilename && (
              <PhasedKanban
                report={rmReport}
                filename={rmFilename}
                onRefresh={refreshRoadmapReport}
                onSelectTask={handleSelectTask}
              />
            )}

            {/* Empty state */}
            {!rmRunning && !rmReport && !rmLatestText && (
              <p className="text-sm text-slate-400 dark:text-slate-500">
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
                disabled={isPending || (clRunning && !clDone)}
                className="px-4 py-2 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-md hover:bg-slate-700 dark:hover:bg-slate-200 disabled:opacity-40 transition-colors"
              >
                {clRunning && !clDone ? 'Generating…' : 'Generate Changelog'}
              </button>

              <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                <span>Previous changelogs:</span>
                <select
                  onChange={e => { if (e.target.value) handleSelectChangelogHistory(e.target.value); }}
                  defaultValue=""
                  disabled={clHistory.length === 0}
                  className="text-sm border border-slate-300 dark:border-slate-600 rounded px-2 py-1 bg-white dark:bg-slate-800 text-slate-900 dark:text-white disabled:opacity-40"
                >
                  {clHistory.length === 0 ? (
                    <option value="" disabled>None generated yet</option>
                  ) : (
                    <>
                      <option value="" disabled>Select</option>
                      {clHistory.map(c => (
                        <option key={c.filename} value={c.filename}>{c.date}</option>
                      ))}
                    </>
                  )}
                </select>
              </div>
            </div>

            {/* Streaming output */}
            {clRunning && clLatestText && <StreamingBlock text={clLatestText} />}

            {/* Changelog result */}
            {clMarkdown && (
              <div className="bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 p-4 max-h-[60vh] overflow-y-auto">
                <pre className="whitespace-pre-wrap font-mono text-xs text-slate-700 dark:text-slate-300 leading-relaxed">
                  {clMarkdown}
                </pre>
              </div>
            )}

            {/* Empty state */}
            {!clRunning && !clMarkdown && !clLatestText && (
              <p className="text-sm text-slate-400 dark:text-slate-500">
                No changelog generated yet. Click &apos;Generate Changelog&apos; to start.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
