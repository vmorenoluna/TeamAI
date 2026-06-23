'use client';

import { useState, useMemo, useEffect } from 'react';
import type { SessionEvent } from './use-session-stream';

/**
 * Manages the `running` boolean by watching stream events.
 *
 * - Derives whether the agent is streaming (last event type is 'assistant')
 * - Syncs `running` to true when streaming, false when a result arrives
 * - Returns `running` and `setRunning` so components can also set it manually
 *   (e.g. in start/cancel handlers)
 */
export function useStreamingState(streamEvents: SessionEvent[]): {
  running: boolean;
  setRunning: (v: boolean) => void;
} {
  const [running, setRunning] = useState(false);

  // Compute whether the agent is currently streaming from stream events
  const isStreaming = useMemo(() => {
    if (streamEvents.length === 0) return false;
    const lastType = streamEvents[streamEvents.length - 1].event.type;
    return lastType === 'assistant';
  }, [streamEvents]);

  // Sync running state from stream events
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRunning(isStreaming);
  }, [isStreaming]);

  return { running, setRunning };
}
