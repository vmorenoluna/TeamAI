'use client';

import { useState, useTransition, useRef, useEffect, useCallback } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AgentPanel } from './agent-panel';
import { ReviewPanel } from './review-panel';
import { PhaseSyncer } from './phase-syncer';
import { setTaskRoleOverride, addDependency, removeDependency, addBlock, removeBlock, deleteTask, retryTask, restartCurrentPhase, markTaskDone } from '@/app/actions/tasks';
import type { Task } from '@/lib/task-store';
import type { PlanData, PlanSubtask, QAReportData, QACriterion } from '@/lib/stream-types';
import type { RoleDefinition } from '@/app/actions/roles';

const PHASE_BADGE: Record<string, string> = {
  backlog:           'bg-slate-800 text-slate-300',
  spec:              'bg-blue-900/40 text-blue-300',
  plan:              'bg-indigo-900/40 text-indigo-300',
  implement:         'bg-amber-900/40 text-amber-300',
  'qa-review':       'bg-orange-900/40 text-orange-300',
  'awaiting-review': 'bg-purple-900/40 text-purple-300',
  merge:             'bg-teal-900/40 text-teal-300',
  'create-pr':       'bg-teal-900/40 text-teal-300',
  'pr-open':         'bg-sky-900/40 text-sky-300',
  failed:            'bg-red-900/40 text-red-300',
  done:              'bg-green-900/40 text-green-300',
};

const PHASE_LABELS: Record<string, string> = {
  backlog:           'Backlog',
  spec:              'Spec',
  plan:              'Plan',
  implement:         'In Progress',
  'qa-review':       'QA Review',
  'awaiting-review': 'Awaiting Review',
  merge:             'Merging',
  'create-pr':       'Creating PR',
  'pr-open':         'PR Open',
  failed:            'Failed',
  done:              'Done',
};

type Tab = 'overview' | 'terminal' | 'spec' | 'plan' | 'qa';

interface Props {
  task: Task;
  allTasks: Task[];
  dependencies: Task[];
  dependents: Task[];
  spec: string | null;
  plan: PlanData | null;
  qaReport: QAReportData | null;
  diff: string | null;
  agentOutput?: string | null;
  roles: RoleDefinition[];
  onClose?: () => void;
  readonly?: boolean;
}

function TaskPill({ task }: { task: Task }) {
  const badge = PHASE_BADGE[task.phase] ?? PHASE_BADGE.backlog;
  return (
    <Link
      href={`/task/${task.id}`}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#1e293b] bg-[#1e2333] hover:bg-[#1a1f2e] transition-colors text-sm"
    >
      <span className="font-medium text-white truncate">{task.title}</span>
      <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${badge}`}>
        {PHASE_LABELS[task.phase] ?? task.phase}
      </span>
    </Link>
  );
}

function DepPicker({
  label,
  candidates,
  selectedIds,
  onToggle,
}: {
  label: string;
  candidates: Task[];
  selectedIds: string[];
  onToggle: (id: string, checked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  const filtered = candidates.filter(t =>
    t.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => { setOpen(o => !o); setSearch(''); }}
        className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md border border-[#334155] bg-[#1e2333] text-slate-300 hover:bg-[#1a1f2e] transition-colors"
      >
        + {label}
      </button>

      {open && (
        <div className="absolute z-20 top-full left-0 mt-1.5 w-72 bg-[#1e2333] rounded-lg border border-[#1e293b] shadow-xl overflow-hidden">
          <div className="p-2 border-b border-[#1e293b]">
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search tasks…"
              className="w-full px-2.5 py-1.5 text-sm bg-[#11131b] border border-[#334155] rounded text-white focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-xs text-slate-400">No tasks found.</li>
            )}
            {filtered.map(t => {
              const checked = selectedIds.includes(t.id);
              const badge = PHASE_BADGE[t.phase] ?? PHASE_BADGE.backlog;
              return (
                <li key={t.id}>
                  <label className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-[#1a1f2e] transition-colors">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={e => onToggle(t.id, e.target.checked)}
                      className="rounded border-[#334155] bg-[#11131b]"
                    />
                    <span className="flex-1 text-sm text-slate-200 truncate">{t.title}</span>
                    <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${badge}`}>
                      {PHASE_LABELS[t.phase] ?? t.phase}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [text]);
  return (
    <button
      onClick={handleCopy}
      className="text-xs px-2 py-1 rounded border border-[#334155] text-slate-400 hover:text-white hover:border-[#475569] transition-colors"
      title={`Copy ${label || 'content'} to clipboard`}
    >
      {copied ? '✓ Copied' : '📋 Copy'}
    </button>
  );
}

function PlanSubtasks({ plan }: { plan: PlanData | null }) {
  if (!plan?.subtasks?.length) return <p className="text-sm text-slate-400">No plan generated yet.</p>;
  const completed = plan.subtasks.filter((s: PlanSubtask) => s.completed).length;
  const total = plan.subtasks.length;
  const planText = JSON.stringify(plan, null, 2);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 mb-3">
        <p className="text-xs text-slate-500">
          {completed} / {total} subtasks completed
        </p>
        <CopyButton text={planText} label="plan" />
        {completed > 0 && completed < total && (
          <div className="flex-1 h-1.5 bg-[#1e293b] rounded-full overflow-hidden" data-testid="subtask-progress-track">
            <div
              className="h-full bg-[#2563eb] rounded-full transition-all duration-500"
              style={{ width: `${(completed / total) * 100}%` }}
              data-testid="subtask-progress-bar"
            />
          </div>
        )}
      </div>
      {plan.subtasks.map((s: PlanSubtask, i: number) => (
        <div key={i} data-testid="plan-subtask" className={`p-3 rounded-lg border transition-colors ${
          s.completed
            ? 'border-green-900/40 bg-green-950/20'
            : 'border-[#1e293b] bg-[#11131b]'
        }`}>
          <div className="flex items-start gap-2.5">
            {s.completed ? (
              <span className="shrink-0 mt-0.5 text-green-500 text-sm font-bold">✓</span>
            ) : (
              <span className="shrink-0 mt-0.5 w-3.5 h-3.5 rounded-full border-2 border-slate-600" />
            )}
            <div className="flex-1 min-w-0">
              <p className={`text-sm font-medium ${s.completed ? 'text-green-300 line-through decoration-green-700/50' : 'text-white'}`}>
                {s.title}
              </p>
              {!s.completed && s.description && (
                <p className="mt-1 text-xs text-slate-400">{s.description}</p>
              )}
              {!s.completed && s.files && s.files.length > 0 && (
                <p className="mt-1 text-xs text-slate-400 font-mono">
                  {s.files.join(', ')}
                </p>
              )}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function QAReportView({ qaReport }: { qaReport: QAReportData | null }) {
  if (!qaReport) return <p className="text-sm text-slate-400">No QA report generated yet.</p>;
  const qaText = JSON.stringify(qaReport, null, 2);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className={`inline-flex items-center px-2.5 py-1 rounded text-sm font-bold ${
          qaReport.overall === 'PASS'
            ? 'bg-green-900/40 text-green-300'
            : 'bg-red-900/40 text-red-300'
        }`}>
          {qaReport.overall}
        </div>
        <CopyButton text={qaText} label="QA report" />
      </div>
      {qaReport.criteria?.map((c: QACriterion, i: number) => (
        <div key={i} className="flex items-start gap-2 text-sm">
          <span className={`shrink-0 font-bold ${c.status === 'PASS' ? 'text-green-600' : 'text-red-600'}`}>
            {c.status === 'PASS' ? '✓' : '✗'}
          </span>
          <div>
            <p className="text-slate-300">{c.criterion || c.name}</p>
            {c.notes && <p className="text-xs text-slate-400 mt-0.5">{c.notes}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function TaskDetail({ task, allTasks, dependencies, dependents, spec, plan, qaReport, diff, agentOutput, roles, onClose, readonly = false }: Props) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [isPending, startTransition] = useTransition();

  const badge = PHASE_BADGE[task.phase] ?? PHASE_BADGE.backlog;
  const isAwaiting = task.phase === 'awaiting-review';
  const isPrOpen = task.phase === 'pr-open';
  const restartablePhases = new Set<string>(['spec', 'plan', 'implement', 'qa-review']);
  const canRestart = restartablePhases.has(task.phase);

  const tabs: { id: Tab; label: string; badge?: number }[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'terminal', label: 'Terminal' },
    { id: 'spec', label: 'Spec', badge: spec ? 1 : 0 },
    { id: 'plan', label: 'Plan', badge: plan?.subtasks?.length ?? 0 },
    { id: 'qa', label: 'QA', badge: qaReport ? 1 : 0 },
  ];

  function handleRoleOverride(role: string) {
    startTransition(async () => {
      await setTaskRoleOverride(task.id, role === '' ? null : role);
      router.refresh();
    });
  }

  function handleDepToggle(depId: string, checked: boolean) {
    startTransition(async () => {
      if (checked) await addDependency(task.id, depId);
      else await removeDependency(task.id, depId);
      router.refresh();
    });
  }

  function handleBlockToggle(blockedId: string, checked: boolean) {
    startTransition(async () => {
      if (checked) await addBlock(task.id, blockedId);
      else await removeBlock(task.id, blockedId);
      router.refresh();
    });
  }

  function handleDelete() {
    if (!confirm(`Delete "${task.title}"? This cannot be undone.`)) return;
    startTransition(async () => {
      await deleteTask(task.id);
      if (onClose) {
        onClose();
        router.refresh();
      } else {
        router.push('/');
        router.refresh();
      }
    });
  }

  function handleRestart() {
    if (!confirm(`Restart "${task.title}" from scratch? This will clear the current phase's work and re-run it.`)) return;
    startTransition(async () => {
      const result = await restartCurrentPhase(task.id);
      if (result.success) {
        router.refresh();
      } else {
        alert(`Failed to restart task: ${result.error}`);
      }
    });
  }

  const otherTasks = allTasks.filter(t => t.id !== task.id);
  const dependencyIds = dependencies.map(t => t.id);
  const dependentIds = dependents.map(t => t.id);

  return (
    <div className="flex flex-col h-full">
      {!readonly && <PhaseSyncer />}

      {/* Header */}
      <div className={`shrink-0 px-6 pt-5 pb-0 ${readonly ? '' : 'border-b border-[#1e293b]'} bg-[#11131b]`}>
        {/* Row 1: breadcrumb + phase badge + delete (hidden in readonly) */}
        <div className="flex items-center justify-between gap-3 mb-2">
          <Link href="/" className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
            ← Board
          </Link>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold uppercase tracking-wider px-2.5 py-1 rounded ${badge}`}>
              {PHASE_LABELS[task.phase] ?? task.phase}
            </span>
            {task.prUrl && (
              <a
                href={task.prUrl}
                target="_blank"
                rel="noopener noreferrer"
                title="View Pull Request"
                className="shrink-0 text-sm px-1.5 py-0.5 rounded text-teal-400 hover:text-teal-300 hover:bg-teal-950/30 transition-colors"
              >
                🔗
              </a>
            )}
            {!readonly && canRestart && (
              <button
                onClick={handleRestart}
                disabled={isPending}
                title={`Restart ${task.phase} from scratch — clear current work and re-run`}
                data-testid="restart-phase-button"
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
        <p data-testid="task-id" className="mb-2 text-xs text-slate-500 font-mono select-all">
          {task.id}
        </p>

        {/* Row 3: description */}
        {task.description && (
          <p className="mb-2 text-sm text-slate-400">
            {task.description}
          </p>
        )}

        {/* Source info (for tasks converted from roadmap) */}
        {task.source && (
          <div className="mb-3 flex items-center gap-3 text-xs">
            <span className="text-slate-500">Source:</span>
            <span className={`px-2 py-0.5 rounded font-medium ${
              task.source === 'competitor-analysis'
                ? 'bg-amber-900/30 text-amber-400'
                : 'bg-blue-900/30 text-blue-400'
            }`}>
              {task.source === 'competitor-analysis' ? 'Competitor Analysis' : 'Ideation'}
            </span>
            {task.competitiveContext && (
              <span className="text-amber-400 italic">{task.competitiveContext}</span>
            )}
          </div>
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

        {/* Meta row: timestamps + role override (hidden in readonly) */}
        <div className="flex items-center gap-4 flex-wrap mb-3">
          <p className="text-xs text-slate-400">
            Created {new Date(task.createdAt).toLocaleString()}
            {' · '}Updated {new Date(task.updatedAt).toLocaleString()}
          </p>
          {!readonly && (
            <div className="flex items-center gap-2">
              <span className="text-xs text-slate-400">Agent:</span>
              <select
                value={task.roleOverride ?? ''}
                onChange={e => handleRoleOverride(e.target.value)}
                disabled={isPending}
                className="text-xs border border-[#334155] rounded-lg px-2 py-0.5 bg-[#1a1f2e] text-slate-300 focus:outline-none focus:ring-1 focus:ring-[#2563eb] disabled:opacity-50"
              >
                <option value="">Auto (pipeline default)</option>
                {roles.map(r => (
                  <option key={r.filename} value={r.filename}>{r.name}</option>
                ))}
              </select>
            </div>
          )}
        </div>

        {/* Tabs (hidden in readonly) */}
        {!readonly && (
          <div className="flex gap-0">
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

      {/* Tab content — hidden entirely in readonly mode */}
      {!readonly && (
        <div className={`flex-1 min-h-0 ${activeTab === 'terminal' ? 'overflow-hidden' : 'overflow-auto'}`}>

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
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        await navigator.clipboard.writeText(task.completionSummary || '');
                      }}
                      className="text-[10px] px-2 py-0.5 rounded border border-red-900/50 text-red-400 hover:text-red-300 hover:border-red-700 transition-colors"
                      title="Copy summary to clipboard"
                    >
                      📋 Copy
                    </button>
                    <button
                      onClick={async (e) => {
                        e.stopPropagation();
                        startTransition(async () => {
                          const result = await retryTask(task.id);
                          if (result.success) {
                            router.refresh();
                          }
                        });
                      }}
                      disabled={isPending}
                      data-testid="detail-retry-button"
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

            {/* Review panel if awaiting */}
            {isAwaiting && (
              <ReviewPanel
                taskId={task.id}
                spec={spec}
                qaReport={qaReport}
                diff={diff}
              />
            )}

            {/* PR open — waiting for human to review and merge */}
            {isPrOpen && (
              <div className="rounded-lg border border-sky-800/50 bg-sky-950/20 p-4">
                <p className="text-sm text-sky-300 mb-3">
                  The PR is open for review. Merge it on GitHub, then mark this task as done.
                </p>
                <button
                  onClick={() => startTransition(async () => { await markTaskDone(task.id); router.refresh(); })}
                  disabled={isPending}
                  className="px-4 py-2 rounded-md bg-green-700/60 text-green-200 hover:bg-green-600/70 transition-colors text-sm font-medium disabled:opacity-50"
                >
                  {isPending ? 'Marking done…' : 'Mark as Done'}
                </button>
              </div>
            )}

            {/* PR link */}
            {task.prUrl && (
              <section>
                <a
                  href={task.prUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-teal-800/50 bg-teal-950/30 text-teal-400 hover:bg-teal-900/40 hover:text-teal-300 transition-colors text-sm"
                >
                  <span className="text-base">🔗</span>
                  <span className="font-medium">View Pull Request</span>
                  <svg className="w-3.5 h-3.5 opacity-70" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              </section>
            )}

            {/* Depends on */}
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
          <div className="p-4 h-full">
            <AgentPanel taskId={task.id} initialOutput={agentOutput} />
          </div>
        )}

        {/* SPEC */}
        {activeTab === 'spec' && (
          <div className="p-6">
            {spec ? (
              <>
                <div className="flex items-center justify-between mb-3">
                  <span className="text-xs text-slate-500">Specification</span>
                  <CopyButton text={spec} />
                </div>
                <pre className="text-sm text-emerald-400 whitespace-pre-wrap font-mono leading-relaxed">
                  {spec}
                </pre>
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
            <QAReportView qaReport={qaReport} />
          </div>
        )}
      </div>
      )}

      {/* Copy button helper */}
    </div>
  );
}
