import { useEffect, useState } from 'react';

export interface AgentEvent {
  sessionId: string;
  taskId: string;
  event: any;
}

export function useAgentStream(taskId: string): AgentEvent[] {
  const [events, setEvents] = useState<AgentEvent[]>([]);

  useEffect(() => {
    const ws = new WebSocket(`ws://${window.location.host}/ws`);
    ws.onmessage = (msg) => {
      try {
        const data: AgentEvent = JSON.parse(msg.data);
        if (data.taskId === taskId) {
          setEvents(prev => [...prev, data]);
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
