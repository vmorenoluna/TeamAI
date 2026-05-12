import { getTasks } from '@/app/actions/tasks';
import { InsightsChat } from '@/components/insights-chat';
import type { Task } from '@/lib/task-store';

const PHASE_COLORS: Record<string, string> = {
  backlog: '#475569',
  spec: '#3b82f6',
  plan: '#6366f1',
  implement: '#f59e0b',
  'qa-review': '#f97316',
  'qa-fix': '#f97316',
  'awaiting-review': '#a855f7',
  merge: '#14b8a6',
  'create-pr': '#14b8a6',
  failed: '#ef4444',
  done: '#22c55e',
};

const PHASE_LABELS: Record<string, string> = {
  backlog: 'Backlog',
  spec: 'Spec',
  plan: 'Plan',
  implement: 'Implement',
  'qa-review': 'QA',
  'qa-fix': 'QA Fix',
  'awaiting-review': 'Review',
  merge: 'Merge',
  'create-pr': 'Create PR',
  failed: 'Failed',
  done: 'Done',
};

export default async function InsightsPage() {
  let tasks: Task[] = [];
  try {
    tasks = await getTasks();
  } catch { /* no active project */ }

  const total = tasks.length;
  const completed = tasks.filter(t => t.phase === 'done').length;
  const inProgress = tasks.filter(t => !['backlog', 'done', 'failed'].includes(t.phase)).length;
  const failed = tasks.filter(t => t.phase === 'failed').length;
  const completionRate = total > 0 ? Math.round((completed / total) * 100) : 0;

  // Phase distribution
  const phaseCounts: Record<string, number> = {};
  for (const t of tasks) {
    phaseCounts[t.phase] = (phaseCounts[t.phase] || 0) + 1;
  }

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-6 py-4 border-b border-[#1e293b]">
        <h1 className="text-base font-semibold text-white">Insights</h1>
        <p className="text-xs text-slate-400 mt-0.5">Pipeline analytics and project chat.</p>
      </div>

      <div className="flex-1 min-h-0 flex flex-col">
        {/* Stats cards */}
        {total > 0 && (
          <div className="shrink-0 px-6 py-4">
            <div className="grid grid-cols-4 gap-3">
              <StatCard label="Total Tasks" value={total} color="text-slate-200" />
              <StatCard label="Completed" value={completed} color="text-green-400" />
              <StatCard label="In Progress" value={inProgress} color="text-amber-400" />
              <StatCard label="Failed" value={failed} color="text-red-400" />
            </div>

            {/* Completion rate bar */}
            <div className="mt-4">
              <div className="flex items-center justify-between mb-1.5">
                <span className="text-xs text-slate-400">Completion Rate</span>
                <span className="text-xs font-medium text-slate-300">{completionRate}%</span>
              </div>
              <div className="h-2 bg-[#1a1f2e] rounded-full overflow-hidden">
                <div
                  className="h-full bg-gradient-to-r from-[#2563eb] to-[#22c55e] rounded-full transition-all duration-500"
                  style={{ width: `${completionRate}%` }}
                />
              </div>
            </div>

            {/* Phase distribution */}
            <div className="mt-4">
              <p className="text-xs text-slate-400 mb-2">Phase Distribution</p>
              <div className="flex h-5 rounded-full overflow-hidden">
                {Object.entries(phaseCounts).map(([phase, count]) => {
                  const pct = (count / total) * 100;
                  if (pct < 1) return null;
                  return (
                    <div
                      key={phase}
                      className="h-full transition-all duration-300"
                      style={{
                        width: `${pct}%`,
                        backgroundColor: PHASE_COLORS[phase] || '#475569',
                      }}
                      title={`${PHASE_LABELS[phase] || phase}: ${count} (${Math.round(pct)}%)`}
                    />
                  );
                })}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 mt-2">
                {Object.entries(phaseCounts).map(([phase, count]) => (
                  <div key={phase} className="flex items-center gap-1.5">
                    <div
                      className="w-2.5 h-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: PHASE_COLORS[phase] || '#475569' }}
                    />
                    <span className="text-[11px] text-slate-400">
                      {PHASE_LABELS[phase] || phase} ({count})
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {total === 0 && (
          <div className="shrink-0 px-6 py-8 text-center">
            <p className="text-sm text-slate-400">No tasks yet. Create tasks to see analytics.</p>
          </div>
        )}

        {/* Chat section */}
        <div className="flex-1 min-h-0 border-t border-[#1e293b]">
          <InsightsChat />
        </div>
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="bg-[#1e2333] border border-[#1e293b] rounded-lg p-3">
      <p className="text-xs text-slate-400">{label}</p>
      <p className={`text-2xl font-bold mt-0.5 ${color}`}>{value}</p>
    </div>
  );
}
