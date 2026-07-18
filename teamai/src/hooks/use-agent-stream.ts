import { useEffect, useRef, useState } from 'react';
import type { StreamEvent } from '@/lib/stream-types';
import { useWebSocket } from '@/hooks/use-websocket';

export interface AgentEvent {
  sessionId: string;
  taskId: string;
  event: StreamEvent;
}

export function useAgentStream(taskId: string, project?: string): { events: AgentEvent[]; connected: boolean } {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const wasEverConnectedRef = useRef(false);
  const taskIdRef = useRef(taskId);
  // eslint-disable-next-line react-hooks/refs
  taskIdRef.current = taskId;

  useWebSocket({
    project,
    onMessage: (data) => {
      const currentTaskId = taskIdRef.current;
      if (data.taskId === currentTaskId && data.event !== undefined) {
        setEvents(prev => [...prev, data as unknown as AgentEvent]);
      }
    },
    onConnectionChange: (isConnected) => {
      if (isConnected) {
        wasEverConnectedRef.current = true;
        setConnected(true);
      } else if (wasEverConnectedRef.current) {
        // Only report disconnected after first connection (avoids flash on mount)
        setConnected(false);
      }
    },
  });

  // Reset events when taskId changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reset on taskId change
    setEvents([]);
  }, [taskId]);

  return { events, connected };
}
