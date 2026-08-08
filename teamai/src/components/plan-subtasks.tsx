'use client';

import { CopyButton } from './copy-button';
import type { PlanData, PlanSubtask } from '@/lib/stream-types';

export function PlanSubtasks({ plan }: { plan: PlanData | null }) {
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
          <div className="flex-1 h-1.5 bg-[#1e293b] rounded-full overflow-hidden" data-component="subtask-progress-track">
            <div
              className="h-full bg-[#2563eb] rounded-full transition-all duration-500"
              style={{ width: `${(completed / total) * 100}%` }}
              data-component="subtask-progress-bar"
            />
          </div>
        )}
      </div>
      {plan.subtasks.map((s: PlanSubtask, i: number) => (
        <div key={i} data-component="plan-subtask" className={`p-3 rounded-lg border transition-colors ${
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
              <p className={`text-sm font-medium ${s.completed ? 'text-green-300' : 'text-white'}`}>
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
