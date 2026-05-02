'use client';

import { useEffect, useState } from 'react';
import { getTaskFull } from '@/app/actions/tasks';
import { getRoles } from '@/app/actions/roles';
import { TaskDetail } from './task-detail';
import type { RoleDefinition } from '@/app/actions/roles';

type FullData = Awaited<ReturnType<typeof getTaskFull>>;

export function TaskPanel({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const [data, setData] = useState<FullData | null>(null);
  const [roles, setRoles] = useState<RoleDefinition[]>([]);
  const [loading, setLoading] = useState(true);

  const refresh = (silent = false) => {
    if (!silent) setLoading(true);
    Promise.all([getTaskFull(taskId), getRoles()])
      .then(([full, r]) => { setData(full); setRoles(r); })
      .finally(() => { if (!silent) setLoading(false); });
  };

  // Initial load
  useEffect(() => {
    setData(null);
    refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Re-fetch silently on phase-change so Spec/Plan/QA/Terminal update without close+reopen
  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.type === 'phase-change' && msg.taskId === taskId) {
          refresh(true);
        }
      } catch { /* ignore */ }
    };
    return () => {
      if (ws.readyState === WebSocket.CONNECTING) ws.addEventListener('open', () => ws.close());
      else ws.close();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  return (
    <div className="flex flex-col h-full bg-white dark:bg-slate-900 border-l border-slate-200 dark:border-slate-700 overflow-hidden">
      {/* Close strip */}
      <div className="shrink-0 flex items-center justify-end px-3 py-1 border-b border-slate-100 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
        <button
          onClick={onClose}
          title="Close panel"
          className="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 text-lg leading-none px-1 transition-colors"
        >
          ×
        </button>
      </div>

      {loading && (
        <div className="flex-1 flex items-center justify-center text-sm text-slate-400">Loading…</div>
      )}

      {!loading && !data && (
        <div className="flex-1 flex items-center justify-center text-sm text-red-400">Failed to load task.</div>
      )}

      {!loading && data && (
        <div className="flex-1 min-h-0 overflow-auto">
          <TaskDetail
            task={data.task}
            allTasks={data.allTasks}
            dependencies={data.dependencies}
            dependents={data.dependents}
            spec={data.spec}
            plan={data.plan}
            qaReport={data.qaReport}
            diff={data.diff}
            agentOutput={data.agentOutput}
            roles={roles}
          />
        </div>
      )}
    </div>
  );
}
