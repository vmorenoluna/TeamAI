'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { AgentPanel } from './agent-panel';
import { ReviewPanel } from './review-panel';
import { PhaseSyncer } from './phase-syncer';
import { RunTaskButton } from './run-task-button';
import { setTaskRoleOverride, setTaskDependencies } from '@/app/actions/tasks';
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
  roles: RoleDefinition[];
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

export function TaskDetail({ task, allTasks, dependencies, dependents, spec, plan, qaReport, diff, roles }: Props) {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState<Tab>('overview');
  const [isPending, startTransition] = useTransition();
  const [showDepPicker, setShowDepPicker] = useState(false);
  const [selectedDeps, setSelectedDeps] = useState<string[]>(task.dependencies ?? []);

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

  function toggleDep(id: string) {
    setSelectedDeps(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  function saveDeps() {
    startTransition(async () => {
      await setTaskDependencies(task.id, selectedDeps);
      setShowDepPicker(false);
      router.refresh();
    });
  }

  const otherTasks = allTasks.filter(t => t.id !== task.id);

  return (
    <div className="flex flex-col h-full">
      <PhaseSyncer />

      {/* Header */}
      <div className="shrink-0 px-6 pt-5 pb-0 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        <div className="flex items-start justify-between gap-4 mb-3">
          <div className="min-w-0">
            <Link href="/" className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 mb-1 inline-block">
              ← Board
            </Link>
            <h1 className="text-lg font-semibold text-slate-900 dark:text-white leading-snug">
              {task.title}
            </h1>
            {task.description && (
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">
                {task.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {task.phase === 'backlog' && <RunTaskButton taskId={task.id} />}
            <span className={`text-xs font-semibold uppercase tracking-wider px-2.5 py-1 rounded ${badge}`}>
              {task.phase}
            </span>
          </div>
        </div>

        {/* Meta row: timestamps + role override */}
        <div className="flex items-center gap-4 flex-wrap mb-3">
          <p className="text-xs text-slate-400">
            Created {new Date(task.createdAt).toLocaleString()}
            {task.updatedAt !== task.createdAt && (
              <> · Updated {new Date(task.updatedAt).toLocaleString()}</>
            )}
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

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-auto">

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

            {/* Dependencies */}
            <section>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300">
                  Dependencies ({dependencies.length})
                </h3>
                <button
                  onClick={() => setShowDepPicker(p => !p)}
                  className="text-xs text-slate-400 hover:text-slate-700 dark:hover:text-slate-200"
                >
                  {showDepPicker ? 'Cancel' : 'Edit'}
                </button>
              </div>

              {showDepPicker ? (
                <div className="border border-slate-200 dark:border-slate-700 rounded-lg p-3 space-y-2 bg-white dark:bg-slate-900">
                  {otherTasks.length === 0 && (
                    <p className="text-xs text-slate-400">No other tasks yet.</p>
                  )}
                  {otherTasks.map(t => (
                    <label key={t.id} className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={selectedDeps.includes(t.id)}
                        onChange={() => toggleDep(t.id)}
                        className="rounded border-slate-300"
                      />
                      <span className="text-sm text-slate-700 dark:text-slate-300 truncate">{t.title}</span>
                      <span className={`shrink-0 text-[10px] font-semibold uppercase px-1.5 py-0.5 rounded ${PHASE_BADGE[t.phase] ?? PHASE_BADGE.backlog}`}>
                        {t.phase}
                      </span>
                    </label>
                  ))}
                  <button
                    onClick={saveDeps}
                    disabled={isPending}
                    className="mt-2 px-3 py-1 text-xs font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded disabled:opacity-40"
                  >
                    Save
                  </button>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {dependencies.length === 0 ? (
                    <p className="text-xs text-slate-400">None</p>
                  ) : (
                    dependencies.map(t => <TaskPill key={t.id} task={t} />)
                  )}
                </div>
              )}
            </section>

            {/* Dependents */}
            <section>
              <h3 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-2">
                Required by ({dependents.length})
              </h3>
              <div className="space-y-1.5">
                {dependents.length === 0 ? (
                  <p className="text-xs text-slate-400">Nothing depends on this task.</p>
                ) : (
                  dependents.map(t => <TaskPill key={t.id} task={t} />)
                )}
              </div>
            </section>
          </div>
        )}

        {/* TERMINAL */}
        {activeTab === 'terminal' && (
          <div className="p-4 h-full">
            <AgentPanel taskId={task.id} />
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
