import { useEffect, useState } from 'react';
import type { StreamEvent } from '@/lib/stream-types';

export interface AgentEvent {
  sessionId: string;
  taskId: string;
  event: StreamEvent;
}

export function useAgentStream(taskId: string): AgentEvent[] {
  const [events, setEvents] = useState<AgentEvent[]>([]);

  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    ws.onmessage = (msg) => {
      try {
        const data = JSON.parse(msg.data);
        // Only handle agent event messages (not phase-change or other server events)
        if (data.taskId === taskId && data.event !== undefined) {
          setEvents(prev => [...prev, data as AgentEvent]);
        }
      } catch {
        // ignore malformed messages
      }
    };
    return () => {
      // Avoid "closed before connection established" warning in React StrictMode
      if (ws.readyState === WebSocket.CONNECTING) {
        ws.addEventListener('open', () => ws.close());
      } else {
        ws.close();
      }
    };
  }, [taskId]);

  return events;
}
