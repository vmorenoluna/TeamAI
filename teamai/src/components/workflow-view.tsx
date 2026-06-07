'use client';

import type { WorkflowTask } from '@/app/actions/workflow';

const PIPELINE_PHASES: { phase: string; label: string; color: string }[] = [
  { phase: 'spec', label: 'Spec', color: 'border-indigo-500 bg-indigo-500/10' },
  { phase: 'plan', label: 'Plan', color: 'border-violet-500 bg-violet-500/10' },
  { phase: 'implement', label: 'Implement', color: 'border-amber-500 bg-amber-500/10' },
  { phase: 'qa-review', label: 'QA Review', color: 'border-orange-500 bg-orange-500/10' },
  { phase: 'awaiting-review', label: 'Awaiting Review', color: 'border-yellow-500 bg-yellow-500/10' },
  { phase: 'merge', label: 'Merge', color: 'border-teal-500 bg-teal-500/10' },
  { phase: 'create-pr', label: 'Create PR', color: 'border-cyan-500 bg-cyan-500/10' },
  { phase: 'pr-open', label: 'PR Open', color: 'border-emerald-500 bg-emerald-500/10' },
];

interface Props {
  workflowTasks: WorkflowTask[];
}

function timeInPhase(enteredPhaseAt: string | null): string {
  if (!enteredPhaseAt) return '';
  const elapsed = Date.now() - new Date(enteredPhaseAt).getTime();
  const mins = Math.floor(elapsed / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function TaskCard({ wt }: { wt: WorkflowTask }) {
  return (
    <div
      className={`rounded-lg border px-3 py-2 text-xs transition-colors ${
        wt.qaBounces > 0
          ? 'border-amber-500/40 bg-amber-500/5'
          : 'border-slate-700 bg-slate-800/30 hover:border-slate-600'
      }`}
    >
      <div className="font-medium text-slate-200 truncate" title={wt.task.title}>
        {wt.task.title}
      </div>
      <div className="flex items-center gap-3 mt-1 text-[10px] text-slate-500">
        {wt.qaBounces > 0 && (
          <span className="flex items-center gap-1 text-amber-400" title={`${wt.qaBounces} QA bounce${wt.qaBounces !== 1 ? 's' : ''}`}>
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500/60" />
            {wt.qaBounces}x QA
          </span>
        )}
        {wt.enteredPhaseAt && (
          <span>{timeInPhase(wt.enteredPhaseAt)}</span>
        )}
      </div>
    </div>
  );
}

function PhaseTaskCards({ tasks }: { tasks: WorkflowTask[] }) {
  return (
    <div className="mt-3 space-y-2" style={{ width: 200 }}>
      {tasks.map(wt => (
        <TaskCard key={wt.task.id} wt={wt} />
      ))}
      {tasks.length === 0 && <div className="h-1" />}
    </div>
  );
}

export function WorkflowView({ workflowTasks }: Props) {
  const tasksByPhase = new Map<string, WorkflowTask[]>();
  const otherTasks: WorkflowTask[] = [];
  for (const phase of PIPELINE_PHASES) {
    tasksByPhase.set(phase.phase, []);
  }
  for (const wt of workflowTasks) {
    const existing = tasksByPhase.get(wt.task.phase);
    if (existing) {
      existing.push(wt);
    } else {
      otherTasks.push(wt);
    }
  }

  return (
    <div className="flex flex-col h-full bg-[#11131b]">
      {/* Header */}
      <div className="shrink-0 flex items-center justify-between px-6 py-4 border-b border-[#1e293b] bg-[#11131b]">
        <div>
          <h1 className="text-base font-semibold text-white">Workflow</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Active tickets flowing through the pipeline. Each card shows QA bounces and time in phase.
          </p>
        </div>
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-500/60" /> QA bounce &ge; 1
        </div>
      </div>

      {/* Pipeline flow chart */}
      <div className="flex-1 overflow-auto p-4">
        <div className="flex gap-0 min-w-max">
          {PIPELINE_PHASES.map((phase, idx) => {
            const tasks = tasksByPhase.get(phase.phase) ?? [];
            const isLast = idx === PIPELINE_PHASES.length - 1;
            const hasTasks = tasks.length > 0;

            return (
              <div key={phase.phase} className="flex flex-col items-stretch">
                {/* Phase header with connector */}
                <div className="flex items-center">
                  <div
                    className={`shrink-0 px-3 py-1.5 rounded-lg border-2 text-xs font-semibold whitespace-nowrap transition-colors ${
                      hasTasks ? `${phase.color} text-white border-opacity-100` : 'border-slate-700 bg-slate-800/50 text-slate-500'
                    }`}
                  >
                    {phase.label}
                    {hasTasks && (
                      <span className="ml-1.5 text-[10px] opacity-75">{tasks.length}</span>
                    )}
                  </div>
                  {!isLast && (
                    <div className="flex items-center">
                      <div className={`w-8 h-0.5 ${hasTasks ? 'bg-slate-600' : 'bg-slate-800'}`} />
                      <div className={`w-0 h-0 border-t-4 border-b-4 border-l-4 border-t-transparent border-b-transparent ${hasTasks ? 'border-l-slate-600' : 'border-l-slate-800'}`} />
                    </div>
                  )}
                </div>
                <PhaseTaskCards tasks={tasks} />
              </div>
            );
          })}
          {/* Catch-all for unrecognized phases */}
          {otherTasks.length > 0 && (
            <div className="flex flex-col items-stretch">
              <div className="flex items-center">
                <div className="shrink-0 px-3 py-1.5 rounded-lg border-2 border-slate-600 bg-slate-800/40 text-xs font-semibold text-slate-400">
                  Other
                  <span className="ml-1.5 text-[10px] opacity-75">{otherTasks.length}</span>
                </div>
              </div>
              <PhaseTaskCards tasks={otherTasks} />
            </div>
          )}
        </div>

        {/* Empty state */}
        {workflowTasks.length === 0 && (
          <div className="flex items-center justify-center mt-12 text-sm text-slate-500">
            No active tickets — start a task from the Board to see it here.
          </div>
        )}
      </div>
    </div>
  );
}
