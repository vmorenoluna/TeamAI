'use client';

import { useState, useEffect, useTransition, useCallback, useRef } from 'react';
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
  clearLinkedTaskId,
  type RoadmapItem,
  type RoadmapReport,
} from '@/app/actions/roadmap';
import { useSessionStream } from '@/hooks/use-session-stream';
import { useRateLimitAutoResume } from '@/hooks/use-rate-limit-auto-resume';
import { useStreamProgress } from '@/hooks/use-stream-progress';
import { ComplexityDots, PHASE_LABELS } from './roadmap-card';
import { PhasedKanban } from './phased-kanban';
export { PhasedKanban };
import { TaskModal } from './task-modal';
import type { FullData } from './task-panel';
import { PRIORITY_COLORS } from '@/constants/phases';
import { RateLimitBanner } from './rate-limit-banner';
import { StreamingOutput } from './streaming-output';
import { LoadingSpinner } from './loading-spinner';


// ── Main component ───────────────────────────────────────────────────────────

type Tab = 'roadmap' | 'changelog';

export function RoadmapView({ noProject, projectPath }: { noProject: boolean; projectPath: string }) {
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

  const [rmCancelling, setRmCancelling] = useState(false);
  const [clCancelling, setClCancelling] = useState(false);

  const taskCacheRef = useRef<Map<string, { data: FullData }>>(new Map());
  const rmCancelRequestedRef = useRef(false);
  const clCancelRequestedRef = useRef(false);
  const rmStream = useSessionStream(rmSessionId);
  const clStream = useSessionStream(clSessionId);

  const {
    rateLimited: rmRateLimited,
    rateLimitMessage: rmRateLimitMessage,
    autoResumeAt: rmAutoResumeAt,
    countdown: rmCountdown,
    resetRateLimit: rmResetRateLimit,
    handleCancelAutoResume: handleCancelRmAutoResume,
  } = useRateLimitAutoResume(rmStream, handleGenerateRoadmap, () => setRmRunning(false));

  const {
    rateLimited: clRateLimited,
    rateLimitMessage: clRateLimitMessage,
    autoResumeAt: clAutoResumeAt,
    countdown: clCountdown,
    resetRateLimit: clResetRateLimit,
    handleCancelAutoResume: handleCancelClAutoResume,
  } = useRateLimitAutoResume(clStream, handleGenerateChangelog, () => setClRunning(false));

  const rmFullText = useStreamProgress(rmStream);
  const clFullText = useStreamProgress(clStream);

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
      const [rpts, creps] = await Promise.all([
        getRoadmapReports().catch(() => [] as { filename: string; date: string }[]),
        getChangelogReports().catch(() => [] as { filename: string; date: string }[]),
      ]);
      setRmHistory(rpts);
      setClHistory(creps);

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
        rmAlive = await isRoadmapSessionAlive(activeRm).catch(() => false);
        if (rmAlive) {
          setRmSessionId(activeRm);
          setRmRunning(true);
        } else {
          try { sessionStorage.removeItem('roadmap-session'); } catch { /* noop */ }
        }
      }
      if (!rmAlive && rpts.length > 0) {
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
        try {
          const md = await getLatestChangelog(creps[0].filename);
          setClMarkdown(md);
        } catch { /* ignore */ }
      }
    }
    load();
  }, [noProject]);

  useEffect(() => {
    if (!rmDone || !rmSessionId) return;
    (async () => {
      setRmRunning(false);
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
    try { sessionStorage.setItem('roadmap-session', rmSessionId); } catch { /* noop */ }
  }, [rmDone, rmSessionId]);

  useEffect(() => {
    if (!clDone || !clSessionId) return;
    (async () => {
      setClRunning(false);
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

  const handleSelectTask = useCallback((taskId: string) => {
    setSelectedTaskId(taskId);
    setSelectedRoadmapItem(null);
  }, []);

  const handleOpenRoadmapItem = useCallback((item: RoadmapItem, phaseKey: string, itemIndex: number) => {
    if (!rmFilename) return;
    setSelectedTaskId(null);
    setSelectedRoadmapItem({ item, phaseKey, itemIndex, filename: rmFilename });
  }, [rmFilename]);

  const refreshRoadmapReport = useCallback(async () => {
    if (!rmFilename) return;
    try {
      const report = await getRoadmapReport(rmFilename);
      setRmReport(report);
    } catch { /* ignore */ }
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
  }, [selectedRoadmapItem, refreshRoadmapReport]);

  function handleGenerateRoadmap() {
    rmCancelRequestedRef.current = false;
    setRmRunning(true);
    setRmSessionId(null);
    setRmReport(null);
    rmResetRateLimit();
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
    try { await cancelRoadmapGeneration('roadmap'); } catch { /* best-effort */ }
    setRmRunning(false);
    setRmSessionId(null);
    rmResetRateLimit();
    try { sessionStorage.removeItem('roadmap-session'); } catch { /* noop */ }
    setRmCancelling(false);
  }

  function handleGenerateChangelog() {
    clCancelRequestedRef.current = false;
    setClRunning(true);
    setClSessionId(null);
    setClMarkdown(null);
    clResetRateLimit();
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
    try { await cancelRoadmapGeneration('changelog'); } catch { /* best-effort */ }
    setClRunning(false);
    setClSessionId(null);
    clResetRateLimit();
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

  async function handleSelectChangelogHistory(filename: string) {
    setClSessionId(null);
    setClRunning(false);
    const md = await getLatestChangelog(filename);
    setClMarkdown(md);
  }

  if (noProject) {
    return (
      <div className="flex flex-col h-full p-6 bg-[#11131b]">
        <div className="flex gap-0 border-b border-[#1e293b] mb-4">
          <button onClick={() => persistTab('roadmap')} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'roadmap' ? 'border-[#2563eb] text-white' : 'border-transparent text-slate-400 hover:text-slate-300'}`}>Roadmap</button>
          <button onClick={() => persistTab('changelog')} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'changelog' ? 'border-[#2563eb] text-white' : 'border-transparent text-slate-400 hover:text-slate-300'}`}>Changelog</button>
        </div>
        <p className="text-sm text-slate-400">Select or add a project from the sidebar to get started.</p>
      </div>
    );
  }

  return (
    <div className={`flex flex-col h-full p-6 bg-[#11131b] relative ${selectedTaskId ? 'overflow-hidden' : ''}`}>
      {/* Tab bar */}
      <div className="flex gap-0 border-b border-[#1e293b] mb-4 shrink-0">
        <button onClick={() => persistTab('roadmap')} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'roadmap' ? 'border-[#2563eb] text-white' : 'border-transparent text-slate-400 hover:text-slate-300'}`}>Roadmap</button>
        <button onClick={() => persistTab('changelog')} className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'changelog' ? 'border-[#2563eb] text-white' : 'border-transparent text-slate-400 hover:text-slate-300'}`}>Changelog</button>
      </div>

      {/* Tab content */}
      <div className={`flex-1 overflow-y-auto min-h-0 ${selectedTaskId ? 'pointer-events-none select-none' : ''}`}>
        {activeTab === 'roadmap' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-4 flex-wrap">
              <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer select-none">
                <input type="checkbox" checked={skipCompetitors} onChange={e => setSkipCompetitors(e.target.checked)} className="rounded border-slate-300" />
                Skip competitor research
              </label>
              <button onClick={handleGenerateRoadmap} disabled={isPending || rmRunning} className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors">
                {rmRunning && !rmDone ? 'Generating…' : 'Generate Roadmap'}
              </button>
              {rmRunning && (
                <button onClick={handleCancelRoadmap} disabled={rmCancelling} className="px-3 py-2 text-sm font-medium text-red-400 border border-red-800 rounded-lg hover:bg-red-950/30 disabled:opacity-40 transition-colors">
                  {rmCancelling ? 'Stopping…' : '✕ Stop'}
                </button>
              )}
              {rmHistory.length > 0 && (
                <div className="flex items-center gap-2 text-sm text-slate-400">
                  <span>History:</span>
                  <select onChange={e => { if (e.target.value) handleSelectRoadmapHistory(e.target.value); }} defaultValue="" className="text-sm border border-[#334155] rounded px-2 py-1 bg-[#1a1f2e] text-slate-200">
                    <option value="" disabled>Select a previous run</option>
                    {rmHistory.map(r => (<option key={r.filename} value={r.filename}>{r.date}</option>))}
                  </select>
                </div>
              )}
            </div>

            {rmRateLimited && (<RateLimitBanner message={rmRateLimitMessage} autoResumeAt={rmAutoResumeAt} countdown={rmCountdown} onCancelAutoResume={handleCancelRmAutoResume} onRetry={handleGenerateRoadmap} disabled={isPending} />)}
            {rmRunning && !rmRateLimited && rmStream.length > 0 && (<StreamingOutput text={rmFullText} eventCount={rmStream.length} className="max-h-80" />)}
            {rmRunning && !rmRateLimited && rmStream.length === 0 && (<LoadingSpinner label="roadmap generation" />)}

            {rmReport && rmFilename && (
              <PhasedKanban report={rmReport} filename={rmFilename} projectPath={projectPath} onRefresh={refreshRoadmapReport} onSelectTask={handleSelectTask} onOpenRoadmapItem={handleOpenRoadmapItem} />
            )}
            {!rmRunning && !rmReport && !rmFullText && (
              <p className="text-sm text-slate-400">No roadmap generated yet. Click &apos;Generate Roadmap&apos; to start.</p>
            )}
          </div>
        )}

        {activeTab === 'changelog' && (
          <div className="flex flex-col gap-4">
            <div className="flex items-center gap-4 flex-wrap">
              <button onClick={handleGenerateChangelog} disabled={isPending || clRunning} className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors">
                {clRunning && !clDone ? 'Generating…' : 'Generate Changelog'}
              </button>
              {clRunning && (
                <button onClick={handleCancelChangelog} disabled={clCancelling} className="px-3 py-2 text-sm font-medium text-red-400 border border-red-800 rounded-lg hover:bg-red-950/30 disabled:opacity-40 transition-colors">
                  {clCancelling ? 'Stopping…' : '✕ Stop'}
                </button>
              )}
              <div className="flex items-center gap-2 text-sm text-slate-400">
                <span>Previous changelogs:</span>
                <select onChange={e => { if (e.target.value) handleSelectChangelogHistory(e.target.value); }} defaultValue="" disabled={clHistory.length === 0} className="text-sm border border-[#334155] rounded px-2 py-1 bg-[#1a1f2e] text-slate-200 disabled:opacity-40">
                  {clHistory.length === 0 ? (
                    <option value="" disabled>None generated yet</option>
                  ) : [
                    <option key="placeholder" value="" disabled>Select</option>,
                    ...clHistory.map(c => (<option key={c.filename} value={c.filename}>{c.date}</option>))
                  ]}
                </select>
              </div>
            </div>

            {clRateLimited && (<RateLimitBanner message={clRateLimitMessage} autoResumeAt={clAutoResumeAt} countdown={clCountdown} onCancelAutoResume={handleCancelClAutoResume} onRetry={handleGenerateChangelog} disabled={isPending} />)}
            {clRunning && !clRateLimited && clStream.length > 0 && (<StreamingOutput text={clFullText} eventCount={clStream.length} className="max-h-80" />)}
            {clRunning && !clRateLimited && clStream.length === 0 && (<LoadingSpinner label="changelog generation" />)}

            {clMarkdown && (
              <div className="bg-[#1a1f2e] rounded-lg border border-[#1e293b] p-4 max-h-[60vh] overflow-y-auto">
                <pre className="whitespace-pre-wrap font-mono text-xs text-slate-300 leading-relaxed">{clMarkdown}</pre>
              </div>
            )}
            {!clRunning && !clMarkdown && !clFullText && (
              <p className="text-sm text-slate-400">No changelog generated yet. Click &apos;Generate Changelog&apos; to start.</p>
            )}
          </div>
        )}
      </div>

      {/* Task modal */}
      {selectedTaskId && (
        <TaskModal
          taskId={selectedTaskId}
          onClose={() => setSelectedTaskId(null)}
          readonly
          projectPath={projectPath}
          // eslint-disable-next-line react-hooks/refs -- intentional: read mutable cache during render for initial data optimization
          cachedData={taskCacheRef.current.get(selectedTaskId)?.data}
          onDataLoaded={(data, tid) => { taskCacheRef.current.set(tid, { data }); }}
          onError={(errorMsg) => {
            if (!errorMsg.includes('not found')) return;
            setSelectedTaskId(null);
            if (rmReport && rmFilename) {
              for (const phaseKey of ['now', 'next', 'later', 'icebox'] as const) {
                const items = rmReport.phases[phaseKey];
                const idx = items.findIndex(item => item.linkedTaskId === selectedTaskId);
                if (idx !== -1) {
                  clearLinkedTaskId(rmFilename, idx, phaseKey);
                  setSelectedRoadmapItem({ item: items[idx], phaseKey, itemIndex: idx, filename: rmFilename });
                  return;
                }
              }
            }
          }}
        />
      )}

      {/* Roadmap item detail overlay */}
      {selectedRoadmapItem && (
        <div className="absolute inset-0 z-40 flex items-center justify-center p-6">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setSelectedRoadmapItem(null)} />
          <div className="relative w-[700px] h-[550px] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] bg-[#11131b] overflow-hidden flex flex-col animate-modal-in" onClick={e => e.stopPropagation()}>
            <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-[#1e293b] bg-[#1a1f2e]">
              <div className="flex items-center gap-3 min-w-0">
                <span className={`shrink-0 text-[10px] font-bold px-1.5 py-0.5 rounded ${PRIORITY_COLORS[selectedRoadmapItem.item.priority]}`}>{selectedRoadmapItem.item.priority}</span>
                <h2 className="text-base font-semibold text-white truncate">{selectedRoadmapItem.item.title}</h2>
                <span className="shrink-0 text-[10px] text-slate-500">{selectedRoadmapItem.item.category}</span>
              </div>
              <button onClick={() => setSelectedRoadmapItem(null)} title="Close" className="shrink-0 ml-3 w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-white hover:bg-[#1e293b] transition-colors text-lg leading-none">×</button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-4">
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">Source:</span>
                <span className={`px-2 py-0.5 rounded text-xs font-medium ${selectedRoadmapItem.item.source === 'competitor-analysis' ? 'bg-amber-900/30 text-amber-400' : 'bg-blue-900/30 text-blue-400'}`}>
                  {selectedRoadmapItem.item.source === 'competitor-analysis' ? 'Competitor Analysis' : 'Ideation'}
                </span>
                {selectedRoadmapItem.item.competitive_context && (<span className="text-xs text-amber-400 italic break-words">{selectedRoadmapItem.item.competitive_context}</span>)}
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">Complexity:</span>
                <ComplexityDots value={selectedRoadmapItem.item.complexity} />
                <span className="text-xs text-slate-400 tabular-nums">({selectedRoadmapItem.item.complexity}/5)</span>
              </div>
              <div>
                <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Description</h3>
                <p className="text-sm text-slate-300 leading-relaxed">{selectedRoadmapItem.item.description}</p>
              </div>
              {selectedRoadmapItem.item.affected_files && selectedRoadmapItem.item.affected_files.length > 0 && (
                <div>
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Affected Files</h3>
                  <ul className="space-y-1">
                    {selectedRoadmapItem.item.affected_files.map((f, i) => (<li key={i} className="text-xs text-slate-400 font-mono bg-[#1a1f2e] px-2 py-1 rounded">{f}</li>))}
                  </ul>
                </div>
              )}
              <div className="flex items-center gap-3">
                <span className="text-xs text-slate-500">Phase:</span>
                <span className="text-xs text-slate-300">{(PHASE_LABELS as Record<string, string>)[selectedRoadmapItem.phaseKey] ?? selectedRoadmapItem.phaseKey}</span>
              </div>
            </div>
            <div className="shrink-0 flex items-center justify-end gap-3 px-5 py-3 border-t border-[#1e293b] bg-[#1a1f2e]">
              <button onClick={() => setSelectedRoadmapItem(null)} className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors">Close</button>
              <button onClick={handleConvertRoadmapItem} disabled={isPending} className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors">
                {isPending ? 'Converting…' : 'Convert to Ticket'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
