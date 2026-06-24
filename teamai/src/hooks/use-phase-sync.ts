import { useRef, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useWebSocket } from './use-websocket';

interface UsePhaseSyncOptions {
  /** Active project path — forwarded to useWebSocket so the server filters broadcasts by project. */
  project?: string;
  onPhaseChange?: (taskId: string, phase: string) => void;
  onConnectionChange?: (connected: boolean) => void;
}

export function usePhaseSync(opts?: UsePhaseSyncOptions) {
  const router = useRouter();
  const onPhaseChangeRef = useRef(opts?.onPhaseChange);
  const onConnectionChangeRef = useRef(opts?.onConnectionChange);
  // eslint-disable-next-line react-hooks/refs
  onPhaseChangeRef.current = opts?.onPhaseChange;
  // eslint-disable-next-line react-hooks/refs
  onConnectionChangeRef.current = opts?.onConnectionChange;

  const { reconnect } = useWebSocket({
    project: opts?.project,
    onMessage: useCallback((data: Record<string, unknown>) => {
      if (data.type === 'phase-change') {
        onPhaseChangeRef.current?.(data.taskId as string, data.phase as string);
        router.refresh();
      }
    }, [router]),
    onConnectionChange: useCallback(
      (connected: boolean) => onConnectionChangeRef.current?.(connected),
      [],
    ),
  });

  return { reconnect };
}
