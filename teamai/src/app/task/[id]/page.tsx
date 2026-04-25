import { notFound } from 'next/navigation';
import Link from 'next/link';
import { getTask, getTaskArtifacts } from '@/app/actions/tasks';
import { getActiveProject } from '@/app/actions/projects';
import { AgentPanel } from '@/components/agent-panel';
import { RunTaskButton } from '@/components/run-task-button';
import { PhaseSyncer } from '@/components/phase-syncer';
import { ReviewPanel } from '@/components/review-panel';

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

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const activeProject = await getActiveProject();
  if (!activeProject) {
    return <div className="p-6 text-sm text-slate-500">No active project selected.</div>;
  }

  const task = await getTask(id);
  if (!task) notFound();

  const badge = PHASE_BADGE[task.phase] ?? PHASE_BADGE.backlog;
  const isAwaiting = task.phase === 'awaiting-review';

  const artifacts = isAwaiting ? await getTaskArtifacts(id) : null;

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 shrink-0">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <Link href="/" className="text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200">
                ← Board
              </Link>
            </div>
            <h1 className="text-base font-semibold text-slate-900 dark:text-white truncate">
              {task.title}
            </h1>
            {task.description && (
              <p className="mt-1 text-sm text-slate-500 dark:text-slate-400 line-clamp-2">
                {task.description}
              </p>
            )}
          </div>
          <div className="flex items-center gap-3 shrink-0">
            {task.phase === 'backlog' && <RunTaskButton taskId={task.id} />}
            <span className={`text-xs font-semibold uppercase tracking-wider px-2 py-1 rounded ${badge}`}>
              {task.phase}
            </span>
          </div>
        </div>
        <p className="mt-2 text-xs text-slate-400">
          Created {new Date(task.createdAt).toLocaleString()}
          {task.updatedAt !== task.createdAt && (
            <> · Updated {new Date(task.updatedAt).toLocaleString()}</>
          )}
        </p>
      </div>

      <PhaseSyncer />

      {/* Review panel (awaiting-review phase) */}
      {isAwaiting && artifacts && (
        <div className="shrink-0 px-6 py-4 border-b border-slate-200 dark:border-slate-700 bg-slate-50 dark:bg-slate-900 overflow-y-auto max-h-[50vh]">
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-200 mb-3">
            Human Review
          </h2>
          <ReviewPanel
            taskId={task.id}
            spec={artifacts.spec}
            qaReport={artifacts.qaReport}
            diff={artifacts.diff}
          />
        </div>
      )}

      {/* Agent output */}
      <div className="flex-1 min-h-0 p-4">
        <AgentPanel taskId={task.id} />
      </div>
    </div>
  );
}
