import { useRef, useCallback, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useWebSocket } from './use-websocket';

interface UsePhaseSyncOptions {
  /** Active project path — forwarded to useWebSocket so the server filters broadcasts by project. */
  project?: string;
  onPhaseChange?: (taskId: string, phase: string) => void;
  /** Called when a subtask completes during implement.  Provides completed/total
   *  counts so the consumer can patch the UI locally without a full router.refresh().
   *  When omitted, router.refresh() is called as a fallback. */
  onSubtaskProgress?: (taskId: string, completed: number, total: number) => void;
  onConnectionChange?: (connected: boolean) => void;
  /** Called (debounced) after phase-change / task-updated / action-result events
   *  with the affected task ids (may be empty), and with `null` after a WebSocket
   *  reconnect (re-sync everything).  When provided, router.refresh() is skipped
   *  for those events (except `done` phase and refinement-update). */
  onResync?: (changedTaskIds: string[] | null) => void;
  /** Debounce window in ms for router.refresh() calls (default 300).
   *  Rapid phase-change events (e.g. auto mode processing multiple tasks)
   *  are batched into a single refresh. */
  refreshDebounceMs?: number;
}

export function usePhaseSync(opts?: UsePhaseSyncOptions) {
  const router = useRouter();
  const onPhaseChangeRef = useRef(opts?.onPhaseChange);
  const onSubtaskProgressRef = useRef(opts?.onSubtaskProgress);
  const onConnectionChangeRef = useRef(opts?.onConnectionChange);
  // eslint-disable-next-line react-hooks/refs
  onPhaseChangeRef.current = opts?.onPhaseChange;
  // eslint-disable-next-line react-hooks/refs
  onSubtaskProgressRef.current = opts?.onSubtaskProgress;
  // eslint-disable-next-line react-hooks/refs
  onConnectionChangeRef.current = opts?.onConnectionChange;

  const onResyncRef = useRef(opts?.onResync);
  // eslint-disable-next-line react-hooks/refs
  onResyncRef.current = opts?.onResync;

  // Debounced refresh / resync — batches rapid events into one update.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTaskIdsRef = useRef<Set<string>>(new Set());
  const needsResyncRef = useRef(false);
  const needsRefreshRef = useRef(false);
  const hasOpenedRef = useRef(false);
  const debounceMs = opts?.refreshDebounceMs ?? 300;

  // Cleanup the debounce timer on unmount.
  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
  }, []);

  const { reconnect } = useWebSocket({
    project: opts?.project,
    onMessage: useCallback((data: Record<string, unknown>) => {
      const schedule = (kind: 'resync' | 'refresh', taskId?: unknown) => {
        if (kind === 'resync') {
          needsResyncRef.current = true;
          if (typeof taskId === 'string' && taskId !== '') pendingTaskIdsRef.current.add(taskId);
        } else {
          needsRefreshRef.current = true;
        }
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => {
          refreshTimerRef.current = null;
          const resync = needsResyncRef.current;
          const refresh = needsRefreshRef.current;
          const ids = [...pendingTaskIdsRef.current];
          needsResyncRef.current = false;
          needsRefreshRef.current = false;
          pendingTaskIdsRef.current.clear();
          const onResync = onResyncRef.current;
          if (resync && onResync) onResync(ids);
          if (refresh || (resync && !onResync)) router.refresh();
        }, debounceMs);
      };

      if (data.type === 'phase-change') {
        onPhaseChangeRef.current?.(data.taskId as string, data.phase as string);
        schedule('resync', data.taskId);
        // A finished task changes server-rendered state a targeted resync can't patch.
        if (data.phase === 'done') schedule('refresh');
      } else if (data.type === 'subtask-progress') {
        if (onSubtaskProgressRef.current) {
          onSubtaskProgressRef.current(
            data.taskId as string,
            data.completed as number,
            data.total as number,
          );
        } else {
          schedule('resync', data.taskId);
        }
      } else if (data.type === 'refinement-update') {
        // Role Refinement Assistant — a failure analysis finished; refresh so
        // the inline card shows the verdict.
        schedule('refresh');
      } else if (data.type === 'task-updated' || data.type === 'action-result') {
        // Generic task mutation (TaskStore write) not covered by the events
        // above — e.g. human feedback routed, artifacts cleared, dependency
        // or title edits, pause/resume, background action results.
        schedule('resync', data.taskId);
      }
    }, [router, debounceMs]),
    onConnectionChange: useCallback(
      (connected: boolean) => {
        if (connected) {
          if (hasOpenedRef.current) {
            // Reconnected: events may have been missed while offline — re-sync everything.
            if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
            refreshTimerRef.current = null;
            pendingTaskIdsRef.current.clear();
            needsResyncRef.current = false;
            needsRefreshRef.current = false;
            router.refresh();
            onResyncRef.current?.(null);
          }
          hasOpenedRef.current = true;
        }
        onConnectionChangeRef.current?.(connected);
      },
      [router],
    ),
  });

  return { reconnect };
}
