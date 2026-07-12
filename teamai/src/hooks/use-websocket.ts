import { useEffect, useRef } from 'react';

export interface UseWebSocketOptions {
  /** WebSocket URL. Defaults to `ws://${window.location.host}/ws`. */
  url?: string;
  /** Active project path — appended as ?project=<encoded-path> so the server can filter broadcasts. */
  project?: string;
  /** Called with the parsed JSON body of every message. */
  onMessage?: (data: Record<string, unknown>) => void;
  /** Called when the connection state changes. */
  onConnectionChange?: (connected: boolean) => void;
  /** Maximum reconnection attempts (default 10). */
  maxReconnectAttempts?: number;
  /** Base delay in ms (default 500). */
  baseReconnectDelayMs?: number;
  /** Maximum delay in ms (default 16_000). */
  maxReconnectDelayMs?: number;
}

export function useWebSocket(opts?: UseWebSocketOptions) {
  const {
    url,
    project,
    onMessage,
    onConnectionChange,
    maxReconnectAttempts = 10,
    baseReconnectDelayMs = 500,
    maxReconnectDelayMs = 16_000,
  } = opts ?? {};

  // Hold latest callbacks in refs so the effect closure always reads the current value
  // without needing to re-create the connection when callbacks change.
  const onMessageRef = useRef(onMessage);
  const onConnectionChangeRef = useRef(onConnectionChange);
  // eslint-disable-next-line react-hooks/refs
  onMessageRef.current = onMessage;
  // eslint-disable-next-line react-hooks/refs
  onConnectionChangeRef.current = onConnectionChange;

  // Store the connect function so the returned `reconnect()` can always
  // invoke the latest version via the ref, even from a stale render closure.
  const connectRef = useRef<() => void>(undefined);

  useEffect(() => {
    let ws: WebSocket | null = null;
    let reconnectAttempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;

    const baseUrl = url ?? `ws://${window.location.host}/ws`;
    const resolvedUrl = project ? `${baseUrl}?project=${encodeURIComponent(project)}` : baseUrl;

    function scheduleReconnect() {
      if (closed || reconnectAttempt >= maxReconnectAttempts) return;
      reconnectAttempt++;
      const delay = Math.min(
        baseReconnectDelayMs * Math.pow(2, reconnectAttempt - 1) + Math.random() * 1000,
        maxReconnectDelayMs,
      );
      reconnectTimer = setTimeout(() => {
        if (!closed) createConnection();
      }, delay);
    }

    function createConnection() {
      if (closed) return;
      const socket = new WebSocket(resolvedUrl);
      ws = socket;

      socket.onopen = () => {
        reconnectAttempt = 0;
        onConnectionChangeRef.current?.(true);
      };

      socket.onmessage = (e) => {
        try {
          const data = JSON.parse(e.data) as Record<string, unknown>;
          onMessageRef.current?.(data);
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, project]);

  const reconnect = () => connectRef.current?.();
  return { reconnect };
}
