import { useRef, useCallback } from 'react';
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

  const { reconnect } = useWebSocket({
    project: opts?.project,
    onMessage: useCallback((data: Record<string, unknown>) => {
      if (data.type === 'phase-change') {
        onPhaseChangeRef.current?.(data.taskId as string, data.phase as string);
        router.refresh();
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
    }, [router]),
    onConnectionChange: useCallback(
      (connected: boolean) => onConnectionChangeRef.current?.(connected),
      [],
    ),
  });

  return { reconnect };
}
