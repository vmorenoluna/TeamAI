'use client';

import { useEffect, useState } from 'react';
import { getTaskFull } from '@/app/actions/tasks';
import { getRoles } from '@/app/actions/roles';
import { TaskDetail } from './task-detail';
import type { RoleDefinition } from '@/app/actions/roles';

export type FullData = Awaited<ReturnType<typeof getTaskFull>>;

export function TaskPanel({ taskId, onClose, readonly = false, onError, cachedData, cachedRoles, onDataLoaded }: {
  taskId: string;
  onClose: () => void;
  readonly?: boolean;
  onError?: (error: string) => void;
  cachedData?: FullData | null;
  cachedRoles?: RoleDefinition[];
  onDataLoaded?: (data: FullData, roles: RoleDefinition[], taskId: string) => void;
}) {
  const [data, setData] = useState<FullData | null>(cachedData ?? null);
  const [roles, setRoles] = useState<RoleDefinition[]>(cachedRoles ?? []);
  const [loading, setLoading] = useState(!cachedData);

  const refresh = (silent = false) => {
    if (!silent) setLoading(true);
    Promise.all([getTaskFull(taskId), getRoles()])
      .then(([full, r]) => { setData(full); setRoles(r); onDataLoaded?.(full, r, taskId); })
      .catch((e) => {
        if (!silent && onError) {
          onError(e instanceof Error ? e.message : 'Failed to load task');
        }
      })
      .finally(() => { if (!silent) setLoading(false); });
  };

  // Initial load — skip fetch if parent provided cached data
  useEffect(() => {
    if (cachedData) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData(null);
    refresh();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  // Re-fetch silently on phase-change so Spec/Plan/QA/Terminal update without close+reopen
  // Skip in readonly mode — no tabs to update
  useEffect(() => {
    if (readonly) return;
    let ws: WebSocket | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let reconnectAttempt = 0;
    let closed = false;

    const MAX_RECONNECT_ATTEMPTS = 10;

    function scheduleReconnect() {
      if (closed || reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) return;
      reconnectAttempt++;
      const delay = Math.min(500 * Math.pow(2, reconnectAttempt - 1) + Math.random() * 1000, 16000);
      reconnectTimer = setTimeout(() => {
        if (!closed) createConnection();
      }, delay);
    }

    function createConnection() {
      if (closed) return;
      ws = new WebSocket(`ws://${window.location.host}/ws`);

      ws.onopen = () => {
        reconnectAttempt = 0;
      };

      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === 'phase-change' && msg.taskId === taskId) {
            refresh(true);
          }
          // Silently refresh on container-log to show devcontainer startup progress in real-time
          if (msg.type === 'container-log') {
            refresh(true);
          }
        } catch (err) { console.error('[task-panel] Failed to parse WebSocket message', err instanceof Error ? err.message : err); }
      };

      ws.onclose = () => {
        ws = null;
        scheduleReconnect();
      };

      ws.onerror = () => {
        // onclose fires after onerror — let onclose handle reconnection
      };
    }

    createConnection();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        const s = ws;
        if (s.readyState === WebSocket.CONNECTING) s.addEventListener('open', () => s.close());
        else s.close();
        ws = null;
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId, readonly]);

  return (
    <>
      {/* Title bar */}
      <div className="shrink-0 flex items-center justify-between px-5 py-3 border-b border-[#1e293b] bg-[#1a1f2e] select-none">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-white truncate">
            {loading ? 'Loading…' : data?.task?.title ?? 'Task Details'}
          </span>
        </div>
        <button
          onClick={onClose}
          title="Close window"
          className="shrink-0 ml-3 w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-white hover:bg-[#1e293b] transition-colors text-lg leading-none"
        >
          ×
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {loading && (
          <div className="h-full flex items-start justify-center pt-8 text-sm text-slate-500">Loading…</div>
        )}

        {!loading && !data && (
          <div className="h-full flex items-center justify-center text-sm text-red-400">Failed to load task.</div>
        )}

        {!loading && data && (
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
            onClose={onClose}
            readonly={readonly}
          />
        )}
      </div>
    </>
  );
}
