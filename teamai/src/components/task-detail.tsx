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
  backlog:           'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300',
  spec:              'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  plan:              'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
  implement:         'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  'qa-review':       'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  'qa-fix':          'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  'awaiting-review': 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  merge:             'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  failed:            'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  done:              'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
};

type Tab = 'overview' | 'terminal' | 'spec' | 'plan' | 'qa';

interface Props {
  task: Task;
  allTasks: Task[];
  dependencies: Task[];
  dependents: Task[];
  spec: string | null;
  plan: any;
  qaReport: any;
  diff: string | null;
  agentOutput?: string | null;
  roles: RoleDefinition[];
  onClose?: () => void;
}

function TaskPill({ task }: { task: Task }) {
  const badge = PHASE_BADGE[task.phase] ?? PHASE_BADGE.backlog;
  return (
    <Link
      href={`/task/${task.id}`}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors text-sm"
    >
      <span className="font-medium text-slate-800 dark:text-slate-200 truncate">{task.title}</span>
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
        className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md border border-slate-300 dark:border-slate-600 bg-white dark:bg-slate-800 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors"
      >
        + {label}
      </button>

      {open && (
        <div className="absolute z-20 top-full left-0 mt-1.5 w-72 bg-white dark:bg-slate-800 rounded-lg border border-slate-200 dark:border-slate-700 shadow-xl overflow-hidden">
          <div className="p-2 border-b border-slate-100 dark:border-slate-700">
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search tasks…"
              className="w-full px-2.5 py-1.5 text-sm bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-600 rounded text-slate-800 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-slate-400"
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
                  <label className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700 transition-colors">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={e => onToggle(t.id, e.target.checked)}
                      className="rounded border-slate-300 dark:border-slate-600"
                    />
                    <span className="flex-1 text-sm text-slate-700 dark:text-slate-300 truncate">{t.title}</span>
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

function PlanSubtasks({ plan }: { plan: any }) {
  if (!plan?.subtasks?.length) return <p className="text-sm text-slate-400">No plan generated yet.</p>;
  return (
    <div className="space-y-2">
      {plan.subtasks.map((s: any, i: number) => (
        <div key={i} className="p-3 rounded-lg border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
          <p className="text-sm font-medium text-slate-800 dark:text-slate-200">
            {s.id}. {s.title}
          </p>
          {s.description && (
            <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">{s.description}</p>
          )}
          {s.files?.length > 0 && (
            <p className="mt-1 text-xs text-slate-400 font-mono">
              {s.files.join(', ')}
            </p>
          )}
        </div>
      ))}
    </div>
  );
}

function QAReportView({ qaReport }: { qaReport: any }) {
  if (!qaReport) return <p className="text-sm text-slate-400">No QA report generated yet.</p>;
  return (
    <div className="space-y-3">
      <div className={`inline-flex items-center px-2.5 py-1 rounded text-sm font-bold ${
        qaReport.overall === 'PASS'
          ? 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300'
          : 'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300'
      }`}>
        {qaReport.overall}
      </div>
      {qaReport.criteria?.map((c: any, i: number) => (
        <div key={i} className="flex items-start gap-2 text-sm">
          <span className={`shrink-0 font-bold ${c.status === 'PASS' ? 'text-green-600' : 'text-red-600'}`}>
            {c.status === 'PASS' ? '✓' : '✗'}
          </span>
          <div>
            <p className="text-slate-700 dark:text-slate-300">{c.name}</p>
            {c.notes && <p className="text-xs text-slate-500 mt-0.5">{c.notes}</p>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function TaskDetail({ task, allTasks, dependencies, dependents, spec, plan, qaReport, diff, agentOutput, roles, onClose }: Props) {
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
      <PhaseSyncer />

      {/* Header */}
      <div className="shrink-0 px-6 pt-5 pb-0 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        {/* Row 1: breadcrumb + phase badge + delete */}
        <div className="flex items-center justify-between gap-3 mb-2">
          <Link href="/" className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
            ← Board
          </Link>
          <div className="flex items-center gap-2">
            <span className={`text-xs font-semibold uppercase tracking-wider px-2.5 py-1 rounded ${badge}`}>
              {task.phase}
            </span>
            <button
              onClick={handleDelete}
              disabled={isPending}
              title="Delete task"
              className="text-slate-400 hover:text-red-500 dark:hover:text-red-400 transition-colors disabled:opacity-50 text-sm px-1"
            >
              🗑
            </button>
          </div>
        </div>

        {/* Row 2: title */}
        <h1 className="text-lg font-semibold text-slate-900 dark:text-white leading-snug mb-1">
          {task.title}
        </h1>

        {/* Row 3: description */}
        {task.description && (
          <p className="mb-2 text-sm text-slate-600 dark:text-slate-300">
            {task.description}
          </p>
        )}

        {/* Rate-limit banner */}
        {task.rateLimitedUntil && (
          <div className="mt-2 mb-1 flex items-center gap-2 text-xs bg-amber-50 dark:bg-amber-950 border border-amber-200 dark:border-amber-700 text-amber-800 dark:text-amber-300 rounded-md px-3 py-1.5">
            <span>⏳</span>
            <span>
              Pipeline paused — API token limit hit. Auto-resuming at{' '}
              <strong>{new Date(task.rateLimitedUntil).toLocaleTimeString()}</strong>
              {' '}({new Date(task.rateLimitedUntil).toLocaleDateString()}).
            </span>
          </div>
        )}

        {/* Meta row: timestamps + role override */}
        <div className="flex items-center gap-4 flex-wrap mb-3">
          <p className="text-xs text-slate-400">
            Created {new Date(task.createdAt).toLocaleString()}
            {' · '}Updated {new Date(task.updatedAt).toLocaleString()}
          </p>
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-400">Agent:</span>
            <select
              value={task.roleOverride ?? ''}
              onChange={e => handleRoleOverride(e.target.value)}
              disabled={isPending}
              className="text-xs border border-slate-200 dark:border-slate-600 rounded px-2 py-0.5 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 focus:outline-none focus:ring-1 focus:ring-slate-400 disabled:opacity-50"
            >
              <option value="">Auto (pipeline default)</option>
              {roles.map(r => (
                <option key={r.filename} value={r.filename}>{r.name}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Tabs */}
        <div className="flex gap-0">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setActiveTab(t.id)}
              className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
                activeTab === t.id
                  ? 'border-slate-900 dark:border-white text-slate-900 dark:text-white'
                  : 'border-transparent text-slate-500 dark:text-slate-400 hover:text-slate-700 dark:hover:text-slate-200'
              }`}
            >
              {t.label}
              {t.badge != null && t.badge > 0 && (
                <span className="ml-1.5 text-[10px] bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 px-1.5 py-0.5 rounded-full">
                  {t.badge}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Tab content — overflow-hidden when terminal tab is active so xterm handles its own scroll */}
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
                  <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
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
                  <p className="text-xs font-medium text-slate-500 dark:text-slate-400 uppercase tracking-wider mb-1.5">
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
              <pre className="text-sm text-slate-700 dark:text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
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
    </div>
  );
}
