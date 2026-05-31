import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';

const MAX_RECONNECT_ATTEMPTS = 10;
const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 16_000;

interface UsePhaseSyncOptions {
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

  const connectRef = useRef<() => void>(undefined);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    function scheduleReconnect() {
      if (closed || reconnectAttempt >= MAX_RECONNECT_ATTEMPTS) return;
      reconnectAttempt++;
      const delay = Math.min(
        BASE_RECONNECT_DELAY_MS * Math.pow(2, reconnectAttempt - 1) + Math.random() * 1000,
        MAX_RECONNECT_DELAY_MS
      );
      reconnectTimer = setTimeout(() => {
        if (!closed) createConnection();
      }, delay);
    }

    function createConnection() {
      if (closed) return;
      const socket = new WebSocket(`ws://${window.location.host}/ws`);
      ws = socket;

      socket.onopen = () => {
        reconnectAttempt = 0;
        onConnectionChangeRef.current?.(true);
      };

      socket.onmessage = (msg) => {
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

      socket.onclose = () => {
        if (ws === socket) ws = null;
        onConnectionChangeRef.current?.(false);
        scheduleReconnect();
      };

      socket.onerror = () => {
        // onclose fires after onerror — just let onclose handle reconnection
      };
    }

    connectRef.current = () => {
      if (ws) {
        ws.close();
        ws = null;
      }
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      reconnectAttempt = 0;
      createConnection();
    };

    createConnection();

    return () => {
      closed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) {
        const s = ws;
        if (s.readyState === WebSocket.CONNECTING) {
          s.addEventListener('open', () => s.close());
        } else {
          s.close();
        }
        ws = null;
      }
    };
  }, [router]);

  const reconnect = () => connectRef.current?.();
  return { reconnect };
}
