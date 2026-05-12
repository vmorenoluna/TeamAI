'use client';

import { useState, useTransition, useRef, useEffect } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AgentPanel } from './agent-panel';
import { ReviewPanel } from './review-panel';
import { PhaseSyncer } from './phase-syncer';
import { setTaskRoleOverride, addDependency, removeDependency, addBlock, removeBlock, deleteTask } from '@/app/actions/tasks';
import type { Task } from '@/lib/task-store';
import type { RoleDefinition } from '@/app/actions/roles';

const PHASE_BADGE: Record<string, string> = {
  backlog:           'bg-slate-800 text-slate-300',
  spec:              'bg-blue-900/40 text-blue-300',
  plan:              'bg-indigo-900/40 text-indigo-300',
  implement:         'bg-amber-900/40 text-amber-300',
  'qa-review':       'bg-orange-900/40 text-orange-300',
  'qa-fix':          'bg-orange-900/40 text-orange-300',
  'awaiting-review': 'bg-purple-900/40 text-purple-300',
  merge:             'bg-teal-900/40 text-teal-300',
  failed:            'bg-red-900/40 text-red-300',
  done:              'bg-green-900/40 text-green-300',
};

interface PlanSubtask {
  id: string;
  title: string;
  description?: string;
  files?: string[];
}

export interface PlanData {
  subtasks?: PlanSubtask[];
}

interface QACriterion {
  name: string;
  status: 'PASS' | 'FAIL';
  notes?: string;
}

export interface QAReportData {
  overall: 'PASS' | 'FAIL';
  criteria?: QACriterion[];
}

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
        {task.phase}
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
                      {t.phase}
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

function PlanSubtasks({ plan }: { plan: PlanData | null }) {
  if (!plan?.subtasks?.length) return <p className="text-sm text-slate-400">No plan generated yet.</p>;
  return (
    <div className="space-y-2">
      {plan.subtasks.map((s: PlanSubtask, i: number) => (
        <div key={i} data-testid="plan-subtask" className="p-3 rounded-lg border border-[#1e293b] bg-[#11131b]">
          <p className="text-sm font-medium text-white">
            {s.id}. {s.title}
          </p>
          {s.description && (
            <p className="mt-1 text-xs text-slate-400">{s.description}</p>
          )}
          {s.files && s.files.length > 0 && (
            <p className="mt-1 text-xs text-slate-400 font-mono">
              {s.files.join(', ')}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function QAReportView({ qaReport }: { qaReport: QAReportData | null }) {
  if (!qaReport) return <p className="text-sm text-slate-400">No QA report generated yet.</p>;
  return (
    <div className="space-y-3">
      <div className={`inline-flex items-center px-2.5 py-1 rounded text-sm font-bold ${
        qaReport.overall === 'PASS'
          ? 'bg-green-900/40 text-green-300'
          : 'bg-red-900/40 text-red-300'
      }`}>
        {qaReport.overall}
      </div>
      {qaReport.criteria?.map((c: QACriterion, i: number) => (
        <div key={i} className="flex items-start gap-2 text-sm">
          <span className={`shrink-0 font-bold ${c.status === 'PASS' ? 'text-green-600' : 'text-red-600'}`}>
            {c.status === 'PASS' ? '✓' : '✗'}
          </span>
          <div>
            <p className="text-slate-300">{c.name}</p>
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
              {task.phase}
            </span>
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

            {/* Review panel if awaiting */}
            {isAwaiting && (
              <ReviewPanel
                taskId={task.id}
                spec={spec}
                qaReport={qaReport}
                diff={diff}
              />
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
              <pre className="text-sm text-emerald-400 whitespace-pre-wrap font-mono leading-relaxed">
                {spec}
              </pre>
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
    </div>
  );
}
