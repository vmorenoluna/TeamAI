import { useEffect, useState } from 'react';

export interface SessionEvent {
  sessionId: string;
  event: any;
}

export function useSessionStream(sessionId: string | null): SessionEvent[] {
  const [events, setEvents] = useState<SessionEvent[]>([]);

  useEffect(() => {
    if (!sessionId) return;
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        if (data.sessionId === sessionId && data.event !== undefined) {
          setEvents(prev => [...prev, data as SessionEvent]);
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
  }, [sessionId]);

  return events;
}
