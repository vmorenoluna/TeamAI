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

  // Debounced router.refresh() — batches rapid phase-change events.
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
      if (data.type === 'phase-change') {
        onPhaseChangeRef.current?.(data.taskId as string, data.phase as string);
        if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = setTimeout(() => {
          router.refresh();
        }, debounceMs);
      } else if (data.type === 'subtask-progress') {
        if (onSubtaskProgressRef.current) {
          onSubtaskProgressRef.current(
            data.taskId as string,
            data.completed as number,
            data.total as number,
          );
        } else {
          router.refresh();
        }
      }
    }, [router, debounceMs]),
    onConnectionChange: useCallback(
      (connected: boolean) => onConnectionChangeRef.current?.(connected),
      [],
    ),
  });

  return { reconnect };
}
