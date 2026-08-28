'use client';

import { useState, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useServerMutation } from '@/hooks/use-server-mutation';
import { UnifiedTerminal } from './unified-terminal';
import { ReviewPanel } from './review-panel';
import { PhaseSyncer } from './phase-syncer';
import { ErrorBanner } from './error-banner';
import { DepPicker, TaskPill } from './dep-picker';
import { PlanSubtasks } from './plan-subtasks';
import { QAReportView } from './qa-report-view';
import { CopyButton } from './copy-button';
import { addDependency, removeDependency, addBlock, removeBlock, deleteTask, retryTask, restartCurrentPhase } from '@/app/actions/tasks';
import { markAutoReviewed } from '@/app/actions/auto-mode';
import type { Task } from '@/lib/task-store';
import type { PlanData, QAReportData } from '@/lib/stream-types';
import { formatActionError } from '@/lib/error-format';
import { PHASE_BADGE, PHASE_LABELS, RESTARTABLE_PHASES } from '@/constants/phases';
import { SpecDiffView } from './spec-diff-view';
import { RoleRefinementCard } from './role-refinement-card';
import type { RoleRefinementMode, RoleRefinementSuggestion } from '@/lib/role-refinement';

// Re-export sub-components for external consumers
export { PlanSubtasks } from './plan-subtasks';
export { QAReportView } from './qa-report-view';

type Tab = 'overview' | 'terminal' | 'spec' | 'plan' | 'qa';

interface Props {
  task: Task;
  allTasks: Task[];
  dependencies: Task[];
  dependents: Task[];
  spec: string | null;
  specVersions?: Record<string, string>;
  plan: PlanData | null;
  qaReport: QAReportData | null;
  humanFeedback?: string | null;
  diff: string | null;
  agentOutput?: string | null;
  subtaskTerminals?: { id: number; title: string; log: string | null }[];
  qaLog?: string | null;
  specLog?: string | null;
  planLog?: string | null;
  mergeLog?: string | null;
  sessionMap?: Record<string, string>;
  specPath?: string;
  /** Populated when the last approval attempt failed and the task bounced
   *  back to awaiting-review — surfaced in the review panel as a persistent
   *  banner so the reason is visible even after a page refresh. */
  approvalError?: string | null;
  project?: string;
  onClose?: () => void;
  readonly?: boolean;
  /** Role Refinement Assistant — the latest suggestion for this task and the
   *  current role-file contents (props-over-async-fetch, so the diff renders
   *  without a client fetch). */
  refinementSuggestion?: RoleRefinementSuggestion | null;
  refinementMode?: RoleRefinementMode;
  roleFiles?: Record<string, string>;
  /** Client-managed data consumers (TaskPanel) re-fetch after apply/dismiss. */
  onRefinementChanged?: () => void;
}

const VALID_TABS: Tab[] = ['overview', 'terminal', 'spec', 'plan', 'qa'];

export function TaskDetail({ task, allTasks, dependencies, dependents, spec, specVersions, plan, qaReport, humanFeedback, diff, agentOutput, subtaskTerminals, qaLog, specLog, planLog, mergeLog, sessionMap, specPath, approvalError, project, onClose, readonly = false, refinementSuggestion, refinementMode = 'manual', roleFiles = {}, onRefinementChanged }: Props) {
  const router = useRouter();
  const { run, isPending } = useServerMutation();
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const syncFromHash = () => {
      const hash = window.location.hash.replace(/^#/, '');
      if (hash && VALID_TABS.includes(hash as Tab)) {
        setActiveTab(hash as Tab);
      }
    };
    syncFromHash();
    window.addEventListener('hashchange', syncFromHash);
    return () => window.removeEventListener('hashchange', syncFromHash);
  }, []);
  const [specVersion, setSpecVersion] = useState<string | null>(null);
  const [compareMode, setCompareMode] = useState(false);
  const [leftVersion, setLeftVersion] = useState<string | null>(null);
  const [rightVersion, setRightVersion] = useState<string | null>(null);

  const badge = PHASE_BADGE[task.phase] ?? PHASE_BADGE.backlog;
  const isAwaiting = task.phase === 'awaiting-review';
  const isPrOpen = task.phase === 'pr-open';
  const canRestart = RESTARTABLE_PHASES.has(task.phase);

  // Compute the highest spec revision number from available versions.
  // Used by the review panel to detect when the auto-revision limit was reached.
  const specRevision = specVersions
    ? Math.max(0, ...Object.keys(specVersions).map(k => parseInt(k.replace('v', ''), 10)))
    : undefined;

  // v1 can be absent on tasks whose pipeline entered tracked execution after
  // spec.md already existed (resumed/pre-seeded state) or whose original
  // spec was never archived. The version chips only show what's on disk, but
  // without a note a v2..vN run reads like a miscount — say so explicitly.
  const hasSpecV1Gap = !!specVersions && Object.keys(specVersions).length > 0 && !specVersions['v1'];

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'terminal', label: 'Terminal' },
    { id: 'spec', label: 'Spec', badge: spec ? 1 + (specVersions ? Object.keys(specVersions).length : 0) : 0 },
    { id: 'plan', label: 'Plan', badge: plan?.subtasks?.length ?? 0 },
    { id: 'qa', label: 'QA', badge: qaReport ? 1 : 0 },
  ];

  function handleDepToggle(depId: string, checked: boolean) {
    setError(null);
    run(async () => {
      try {
        if (checked) await addDependency(task.id, depId);
        else await removeDependency(task.id, depId);
      } catch (err) {
        const msg = formatActionError(checked ? 'add dependency' : 'remove dependency', err);
        setError(msg);
        throw err;
      }
    });
  }

  function handleBlockToggle(blockedId: string, checked: boolean) {
    setError(null);
    run(async () => {
      try {
        if (checked) await addBlock(task.id, blockedId);
        else await removeBlock(task.id, blockedId);
      } catch (err) {
        const msg = formatActionError(checked ? 'add block' : 'remove block', err);
        setError(msg);
        throw err;
      }
    });
  }

  function handleDelete() {
    if (!confirm(`Delete "${task.title}"? This cannot be undone.`)) return;
    setError(null);
    run(async () => {
      try {
        await deleteTask(task.id);
        if (onClose) {
          onClose();
        } else {
          router.push('/');
        }
      } catch (err) {
        setError(formatActionError('delete task', err));
        throw err;
      }
    });
  }

  function handleRestart() {
    if (!confirm(`Restart "${task.title}" from scratch? This will clear the current phase's work and re-run it.`)) return;
    setError(null);
    run(async () => {
      try {
        const result = await restartCurrentPhase(task.id);
        if (!result.success) throw new Error(result.error || 'Unknown error');
      } catch (err) {
        setError(formatActionError('restart task', err));
        throw err;
      }
    });
  }

  function handleMarkReviewed() {
    if (!confirm(`Mark "${task.title}" as manually reviewed? This will remove the auto-processed highlight.`)) return;
    setError(null);
    run(async () => {
      try {
        await markAutoReviewed(task.id);
      } catch (err) {
        setError(formatActionError('mark task as reviewed', err));
        throw err;
      }
    });
  }

  function handleInlineRetry() {
    setError(null);
    run(async () => {
      try {
        const result = await retryTask(task.id);
        if (!result.success) throw new Error(result.error || 'Unknown error');
      } catch (err) {
        setError(formatActionError('retry task', err));
        throw err;
      }
    });
  }

  const otherTasks = allTasks.filter(t => t.id !== task.id);
  const dependencyIds = dependencies.map(t => t.id);
  const dependentIds = dependents.map(t => t.id);

  return (
    <div id="task-detail-root" className="flex flex-col h-full">
      {!readonly && <PhaseSyncer />}

      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} />}

      {/* Header */}
      <div className={`shrink-0 px-6 pt-5 pb-0 ${readonly ? '' : 'border-b border-[#1e293b]'} bg-[#11131b]`}>
        {/* Row 1: breadcrumb + phase badge + delete */}
        <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
          <Link href="/" className="text-xs text-slate-500 hover:text-slate-300 transition-colors shrink-0">
            ← Board
          </Link>
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={`text-xs font-semibold uppercase tracking-wider px-2.5 py-1 rounded ${badge}`}>
              {PHASE_LABELS[task.phase] ?? task.phase}
            </span>
            {!readonly && canRestart && (
              <button
                onClick={handleRestart}
                disabled={isPending}
                title={`Restart ${task.phase} from scratch — clear current work and re-run`}
                data-component="restart-phase-button"
                className="text-[11px] font-medium px-2.5 py-1 rounded-md bg-amber-900/30 text-amber-400 hover:bg-amber-800/40 hover:text-amber-300 transition-colors disabled:opacity-50 flex items-center gap-1"
              >
                {isPending ? (
                  <span className="w-3 h-3 rounded-full border border-amber-400 border-t-transparent animate-spin" />
                ) : (
                  <span>↺</span>
                )}
                Restart
              </button>
            )}
            {!readonly && (
              <button
                onClick={handleDelete}
                disabled={isPending}
                title="Delete task"
                className="text-slate-500 hover:text-red-400 transition-colors disabled:opacity-50 text-sm px-1"
              >
                🗑
              </button>
            )}
          </div>
        </div>

        {/* Row 2: title */}
        <h1 className="text-lg font-bold text-white leading-snug mb-1">
          {task.title}
        </h1>

        {/* Ticket ID */}
        <p data-component="task-id" className="mb-2 text-xs text-slate-500 font-mono select-all">
          {task.id}
        </p>

        {/* Row 3: description — bounded so a long description scrolls within
            a fixed height instead of growing the header and squeezing the
            tab content below. */}
        {task.description && (
          <p
            data-component="task-description"
            className="mb-2 text-sm text-slate-400 max-h-48 overflow-y-auto break-words pr-1"
          >
            {task.description}
          </p>
        )}

        {/* Rate-limit banner */}
        {!readonly && task.rateLimitedUntil && (
          <div className="mt-2 mb-1 flex items-center gap-2 text-xs bg-amber-950/30 border border-amber-800/50 text-amber-300 rounded-md px-3 py-1.5">
            <span>⏳</span>
            <span>
              Pipeline paused — API token limit hit. Auto-resuming at{' '}
              <strong>{new Date(task.rateLimitedUntil).toLocaleTimeString()}</strong>
              {' '}({new Date(task.rateLimitedUntil).toLocaleDateString()}).
            </span>
          </div>
        )}

        {/* Auto-processed banner */}
        {!readonly && task.autoProcessed && !task.autoReviewed && task.phase === 'done' && (
          <div className="mt-2 mb-1 flex items-center gap-2 text-xs bg-amber-950/30 border border-amber-800/50 text-amber-300 rounded-md px-3 py-1.5">
            <span>🤖</span>
            <span>
              This task was auto-processed by Auto mode — the PR was merged automatically.
            </span>
            <button
              onClick={handleMarkReviewed}
              disabled={isPending}
              className="ml-auto shrink-0 text-[11px] font-medium px-2 py-0.5 rounded bg-amber-700/40 text-amber-200 hover:bg-amber-600/50 transition-colors disabled:opacity-50"
            >
              ✓ Mark Reviewed
            </button>
          </div>
        )}

        {/* Meta row: source + timestamps */}
        <div className="flex items-center gap-3 flex-wrap mb-3">
          {task.source && (
            <>
              <span className="text-xs text-slate-500">Source:</span>
              <span className={`text-xs px-2 py-0.5 rounded font-medium ${
                task.source === 'competitor-analysis'
                  ? 'bg-amber-900/30 text-amber-400'
                  : 'bg-blue-900/30 text-blue-400'
              }`}>
                {task.source === 'competitor-analysis' ? 'Competitor Analysis' : 'Ideation'}
              </span>
              {task.competitiveContext && (
                <span className="text-amber-400 italic text-xs break-words">{task.competitiveContext}</span>
              )}
              <span className="text-slate-400 text-xs">·</span>
            </>
          )}
          <p className="text-xs text-slate-400">
            Created {new Date(task.createdAt).toLocaleString()}
            {' · '}Updated {new Date(task.updatedAt).toLocaleString()}
          </p>
        </div>

        {/* Tabs */}
        {!readonly && (
          <div className="flex gap-0 overflow-x-auto -mx-6 px-6">
            {tabs.map(t => (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                  activeTab === t.id
                    ? 'border-[#2563eb] text-white'
                    : 'border-transparent text-slate-500 hover:text-slate-300'
                }`}
              >
                {t.label}
                {t.badge != null && t.badge > 0 && (
                  <span className="ml-1.5 text-[10px] bg-[#1e293b] text-slate-400 px-1.5 py-0.5 rounded-full">
                    {t.badge}
                  </span>
                )}
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Tab content */}
      {!readonly && (
        <div className={`flex-1 min-h-0 ${activeTab === 'terminal' ? 'flex flex-col overflow-hidden' : 'overflow-auto'}`}>

        {/* OVERVIEW */}
        {activeTab === 'overview' && (
          <div className="p-6 space-y-6">

            {/* Completion summary banner (failed tasks) */}
            {task.phase === 'failed' && task.completionSummary && (
              <div className="rounded-lg border border-red-900/40 bg-red-950/20 p-4">
                <div className="flex items-center gap-2 mb-3">
                  <span className="text-red-400 text-sm font-bold">✗</span>
                  <h3 className="text-sm font-semibold text-red-300">Task Failed</h3>
                  <div className="ml-auto flex items-center gap-2">
                    <CopyButton text={task.completionSummary || ''} />
                    <button
                      onClick={(e) => { e.stopPropagation(); handleInlineRetry(); }}
                      disabled={isPending}
                      data-component="detail-retry-button"
                      className="text-[11px] font-medium px-2.5 py-1 rounded-md bg-red-900/30 text-red-400 hover:bg-red-800/40 hover:text-red-300 transition-colors disabled:opacity-50 flex items-center gap-1"
                    >
                      {isPending ? (
                        <span className="w-3 h-3 rounded-full border border-red-400 border-t-transparent animate-spin" />
                      ) : (
                        <span>↻</span>
                      )}
                      Retry
                    </button>
                    <span className="text-[10px] text-red-400/60">Max QA attempts reached</span>
                  </div>
                </div>
                <pre className="text-xs text-slate-400 whitespace-pre-wrap font-mono leading-relaxed max-h-48 overflow-y-auto">
                  {task.completionSummary}
                </pre>
              </div>
            )}

            {/* Role Refinement Assistant — post-mortem card on failed tasks */}
            {!readonly && (
              <RoleRefinementCard
                task={task}
                suggestion={refinementSuggestion ?? null}
                roleFiles={roleFiles}
                mode={refinementMode}
                onRefinementChanged={onRefinementChanged}
              />
            )}

            {/* Review panel */}
            {(isAwaiting || isPrOpen) && (
              <ReviewPanel
                taskId={task.id}
                spec={spec}
                qaReport={qaReport}
                humanFeedback={humanFeedback}
                diff={diff}
                prUrl={task.prUrl}
                phase={task.phase}
                specRevision={specRevision}
                specPath={specPath}
                approvalError={approvalError}
                subtasks={plan?.subtasks?.map(s => ({ id: Number(s.id), title: s.title, files: s.files }))}
              />
            )}

            {/* Dependencies */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <DepPicker
                  label="Depends on"
                  candidates={otherTasks}
                  selectedIds={dependencyIds}
                  onToggle={handleDepToggle}
                />
                <DepPicker
                  label="Blocks"
                  candidates={otherTasks}
                  selectedIds={dependentIds}
                  onToggle={handleBlockToggle}
                />
              </div>

              {dependencies.length > 0 && (
                <div className="mb-4">
                  <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5">
                    Depends on
                  </p>
                  <div className="space-y-1.5">
                    {dependencies.map(t => (
                      <div key={t.id} className="flex items-center gap-2 group">
                        <TaskPill task={t} />
                        <button
                          onClick={() => handleDepToggle(t.id, false)}
                          disabled={isPending}
                          className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-400 text-sm leading-none transition-all disabled:opacity-30"
                          title="Remove"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {dependents.length > 0 && (
                <div>
                  <p className="text-xs font-medium text-slate-400 uppercase tracking-wider mb-1.5">
                    Blocks
                  </p>
                  <div className="space-y-1.5">
                    {dependents.map(t => (
                      <div key={t.id} className="flex items-center gap-2 group">
                        <TaskPill task={t} />
                        <button
                          onClick={() => handleBlockToggle(t.id, false)}
                          disabled={isPending}
                          className="opacity-0 group-hover:opacity-100 text-slate-400 hover:text-red-400 text-sm leading-none transition-all disabled:opacity-30"
                          title="Remove"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {dependencies.length === 0 && dependents.length === 0 && (
                <p className="text-xs text-slate-400">No dependencies set.</p>
              )}
            </section>
          </div>
        )}

        {/* TERMINAL */}
        {activeTab === 'terminal' && (
          <div className="p-3 flex-1 min-h-0 flex flex-col">
            <UnifiedTerminal
              taskId={task.id}
              subtaskTerminals={subtaskTerminals ?? []}
              qaLog={qaLog ?? null}
              specLog={specLog ?? null}
              planLog={planLog ?? null}
              mergeLog={mergeLog ?? null}
              orchestratorLog={agentOutput ?? null}
              sessionMap={sessionMap}
              project={project}
            />
          </div>
        )}

        {/* SPEC */}
        {activeTab === 'spec' && (
          <div className="p-6">
            {spec || (specVersions && Object.keys(specVersions).length > 0) ? (
              <>
                <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-slate-500">Specification</span>

                    {specVersions && Object.keys(specVersions).length >= 2 && (
                      <button
                        onClick={() => { setCompareMode(c => !c); setLeftVersion(null); setRightVersion(null); }}
                        data-component="compare-toggle"
                        className={`text-[10px] font-medium px-2 py-0.5 rounded-md border transition-colors ${
                          compareMode
                            ? 'border-emerald-600 bg-emerald-950/30 text-emerald-300'
                            : 'border-[#334155] bg-[#1a1f2e] text-slate-400 hover:text-slate-300'
                        }`}
                      >
                        {compareMode ? 'Compare ✓' : '⚖ Compare'}
                      </button>
                    )}

                    {!compareMode && specVersions && Object.keys(specVersions).length > 0 && (
                      <div className="flex items-center gap-0.5 ml-2">
                        {Object.entries(specVersions).map(([label]) => (
                          <button
                            key={label}
                            onClick={() => setSpecVersion(label)}
                            className={`text-[10px] font-medium px-2 py-0.5 border transition-colors first:rounded-l-md last:rounded-r-md ${
                              specVersion === label
                                ? 'border-[#2563eb] bg-[#2563eb]/20 text-blue-300'
                                : 'border-[#334155] bg-[#1a1f2e] text-slate-400 hover:text-slate-300'
                            }`}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    )}

                    {hasSpecV1Gap && (
                      <span
                        className="text-[10px] text-slate-500 italic"
                        title="spec_v1.md is missing for this task — it predates version tracking or its original spec could not be archived"
                      >
                        original version unavailable
                      </span>
                    )}
                  </div>

                  {!compareMode && (
                    <CopyButton text={specVersion && specVersions ? specVersions[specVersion] : (spec || '')} />
                  )}
                </div>

                {compareMode && specVersions ? (
                  <SpecDiffView
                    specVersions={specVersions}
                    leftVersion={leftVersion}
                    rightVersion={rightVersion}
                    onSetLeft={setLeftVersion}
                    onSetRight={setRightVersion}
                  />
                ) : (
                  <pre className="text-sm text-emerald-400 whitespace-pre-wrap font-mono leading-relaxed">
                    {specVersion && specVersions ? specVersions[specVersion] : spec}
                  </pre>
                )}
              </>
            ) : (
              <p className="text-sm text-slate-400">No spec generated yet. Run the pipeline to create one.</p>
            )}
          </div>
        )}

        {/* PLAN */}
        {activeTab === 'plan' && (
          <div className="p-6">
            <PlanSubtasks plan={plan} />
          </div>
        )}

        {/* QA */}
        {activeTab === 'qa' && (
          <div className="p-6">
            <QAReportView qaReport={qaReport} humanFeedback={humanFeedback} />
          </div>
        )}
      </div>
      )}
    </div>
  );
}
