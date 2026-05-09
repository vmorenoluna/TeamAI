'use client';

import { useState, useEffect, useTransition, useCallback } from 'react';
import {
  startRoadmapGeneration,
  startChangelogGeneration,
  getRoadmapReports,
  getRoadmapReport,
  getChangelogReports,
  getLatestChangelog,
  getActiveRoadmapSession,
  type RoadmapItem,
  type RoadmapReport,
} from '@/app/actions/roadmap';
import { useSessionStream } from '@/hooks/use-session-stream';

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
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map(n => (
        <span
          key={n}
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

// ── Roadmap item card ────────────────────────────────────────────────────────

function RoadmapCard({ item }: { item: RoadmapItem }) {
  return (
    <div className="bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 p-4 flex flex-col gap-2">
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${PRIORITY_COLORS[item.priority]}`}>
            {item.priority}
          </span>
          <span className="text-sm font-semibold text-slate-900 dark:text-white truncate">
            {item.title}
          </span>
        </div>
        <span className="shrink-0 text-xs text-slate-500 dark:text-slate-400">
          {item.category}
        </span>
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
        <span>Complexity:</span>
        <ComplexityDots value={item.complexity} />
        <span className="tabular-nums">({item.complexity}/5)</span>
      </div>

      <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">
        {item.description}
      </p>

      <div className="flex items-center gap-3 text-xs text-slate-400 dark:text-slate-500">
        <span className="italic">Source: {item.source}</span>
        {item.competitive_context && (
          <span className="italic text-amber-600 dark:text-amber-400">
            {item.competitive_context}
          </span>
        )}
      </div>
    </div>
  );
}

// ── Phase section (collapsible) ──────────────────────────────────────────────

function PhaseSection({
  label,
  items,
  defaultOpen = true,
}: {
  label: string;
  items: RoadmapItem[];
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div>
      <button
        onClick={() => setOpen(o => !o)}
        className="w-full flex items-center gap-2 py-2 text-left group"
      >
        <span className="text-xs text-slate-400 transition-transform group-hover:text-slate-500">
          {open ? '▾' : '▸'}
        </span>
        <span className="flex-1 text-sm font-medium text-slate-700 dark:text-slate-300">
          {label}
        </span>
        <span className="text-xs text-slate-400">({items.length} items)</span>
      </button>
      {open && (
        <div className="space-y-2 pl-5 pb-2">
          {items.length === 0 ? (
            <p className="text-xs text-slate-400 italic py-2">No items</p>
          ) : (
            items.map((item, i) => <RoadmapCard key={i} item={item} />)
          )}
        </div>
      )}
    </div>
  );
}

// ── Phased card view ─────────────────────────────────────────────────────────

function PhasedView({ report }: { report: RoadmapReport }) {
  const phases = report.phases;

  return (
    <div className="space-y-2">
      {report.executive_summary && (
        <p className="text-sm text-slate-600 dark:text-slate-400 leading-relaxed mb-4">
          {report.executive_summary}
        </p>
      )}

      {report.competitor_analysis_run && (
        <p className="text-xs text-amber-600 dark:text-amber-400 mb-3">
          Competitor analysis was run for this roadmap.
        </p>
      )}

      <div className="divide-y divide-slate-200 dark:divide-slate-700 border-y border-slate-200 dark:border-slate-700">
        {(['now', 'next', 'later', 'icebox'] as const).map(phaseKey => (
          <PhaseSection
            key={phaseKey}
            label={PHASE_LABELS[phaseKey]}
            items={phases[phaseKey]}
            defaultOpen={phaseKey === 'now'}
          />
        ))}
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
      <div className="flex flex-col h-full p-6 bg-white dark:bg-slate-900">
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
        <p className="text-sm text-slate-400">Select or add a project from the sidebar to get started.</p>
      </div>
    );
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="flex flex-col h-full p-6 bg-white dark:bg-slate-900">
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

            {/* Phased card view */}
            {rmReport && <PhasedView report={rmReport} />}

            {/* Empty state */}
            {!rmRunning && !rmReport && !rmLatestText && (
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
                disabled={isPending || (clRunning && !clDone)}
                className="px-4 py-2 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-md hover:bg-slate-700 dark:hover:bg-slate-200 disabled:opacity-40 transition-colors"
              >
                {clRunning && !clDone ? 'Generating…' : 'Generate Changelog'}
              </button>

              {clHistory.length > 0 && (
                <div className="flex items-center gap-2 text-sm text-slate-600 dark:text-slate-400">
                  <span>Previous changelogs:</span>
                  <select
                    onChange={e => { if (e.target.value) handleSelectChangelogHistory(e.target.value); }}
                    defaultValue=""
                    className="text-sm border border-slate-300 dark:border-slate-600 rounded px-2 py-1 bg-white dark:bg-slate-800 text-slate-900 dark:text-white"
                  >
                    <option value="" disabled>Select</option>
                    {clHistory.map(c => (
                      <option key={c.filename} value={c.filename}>{c.date}</option>
                    ))}
                  </select>
                </div>
              )}
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
              <p className="text-sm text-slate-400">
                No changelog generated yet. Click &apos;Generate Changelog&apos; to start.
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
