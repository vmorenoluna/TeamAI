import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

interface UsePhaseSyncOptions {
  onPhaseChange?: (taskId: string, phase: string) => void;
}

export function usePhaseSync(opts?: UsePhaseSyncOptions) {
  const router = useRouter();
  const onPhaseChangeRef = useRef(opts?.onPhaseChange);
  onPhaseChangeRef.current = opts?.onPhaseChange;

  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.type === 'phase-change') {
          onPhaseChangeRef.current?.(data.taskId, data.phase);
          router.refresh();
        }
      } catch {
        // ignore malformed messages
      }
    };
    return () => {
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener('open', () => ws.close());
      } else {
        ws.close();
      }
    };
  }, [router]);
}
