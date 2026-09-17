'use client';

import { useEffect, useState, useRef } from 'react';
import { getTaskFull } from '@/app/actions/tasks';
import { TaskDetail } from './task-detail';
import { useWebSocket } from '@/hooks/use-websocket';

export type FullData = Awaited<ReturnType<typeof getTaskFull>>;

export function TaskPanel({ taskId, onClose, readonly = false, onError, cachedData, onDataLoaded, projectPath }: {
  taskId: string;
  onClose: () => void;
  readonly?: boolean;
  onError?: (error: string) => void;
  cachedData?: FullData | null;
  onDataLoaded?: (data: FullData, taskId: string) => void;
  projectPath?: string;
}) {
  const [data, setData] = useState<FullData | null>(cachedData ?? null);
  const [loading, setLoading] = useState(!cachedData);

  const refresh = (silent = false) => {
    if (!silent) setLoading(true);
    getTaskFull(taskId)
      .then((full) => { setData(full); onDataLoaded?.(full, taskId); })
      .catch((e) => {
        if (!silent && onError) {
          onError(e instanceof Error ? e.message : 'Failed to load task');
        } else if (!onError) {
          console.warn('[task-panel] Failed to load task:', e);
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

  // Re-fetch silently on phase-change/subtask-progress/refinement-update/
  // task-updated so tabs update without close+reopen. subtask-progress
  // matters because phase stays "implement" for the whole implement run —
  // without it the panel shows stale subtask/plan state until the next
  // phase-change. task-updated covers orchestrator-driven mutations that
  // don't change phase at all (human feedback routed, artifacts cleared,
  // title/dependency edits, pause/resume). Guarded by readonly at the
  // message-handler level so the hook is always called at top level.
  const onMessageRef = useRef<(data: Record<string, unknown>) => void>(undefined);
  // eslint-disable-next-line react-hooks/refs
  onMessageRef.current = (msg) => {
    if (!readonly && (
      (msg.type === 'phase-change' && msg.taskId === taskId)
      || (msg.type === 'subtask-progress' && msg.taskId === taskId)
      || (msg.type === 'refinement-update' && msg.taskId === taskId)
      || (msg.type === 'task-updated' && msg.taskId === taskId)
      || msg.type === 'container-log'
    )) {
      refresh(true);
    }
  };

  useWebSocket({
    project: projectPath,
    onMessage: (msg) => onMessageRef.current?.(msg),
  });

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
      <div className="flex-1 min-h-0 flex flex-col">
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
            specVersions={data.specVersions}
            plan={data.plan}
            qaReport={data.qaReport}
            humanFeedback={data.humanFeedback}
            diff={data.diff}
            agentOutput={data.agentOutput}
            subtaskTerminals={data.subtaskTerminals}
            qaLog={data.qaLog}
            specLog={data.specLog}
            planLog={data.planLog}
            mergeLog={data.mergeLog}
            sessionMap={data.sessionMap}
            specPath={data.specPath}
            awaitingReviewReason={data.awaitingReviewReason}
            project={projectPath}
            onClose={onClose}
            readonly={readonly}
            refinementSuggestion={data.refinementSuggestion}
            refinementSuggestions={data.refinementSuggestions}
            refinementMode={data.refinementMode}
            roleFiles={data.roleFiles}
            onRefinementChanged={() => refresh(true)}
          />
        )}
      </div>
    </>
  );
}
