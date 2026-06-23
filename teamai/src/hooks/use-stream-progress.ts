'use client';

import { useMemo } from 'react';
import { extractProgressText } from '@/lib/stream-types';
import type { SessionEvent } from './use-session-stream';

/**
 * Accumulates progress text from all stream events for display in a terminal-style output.
 * Uses extractProgressText so tool names (▶ bash, ▶ read_file) and system events
 * (◆ Session started) are shown — not just assistant text.
 */
export function useStreamProgress(streamEvents: SessionEvent[]): string {
  return useMemo(() => {
    if (streamEvents.length === 0) return '';
    let allText = '';
    for (const e of streamEvents) {
      const t = extractProgressText(e.event);
      if (t) allText += (allText ? '\n' : '') + t;
    }
    return allText;
  }, [streamEvents]);
}
