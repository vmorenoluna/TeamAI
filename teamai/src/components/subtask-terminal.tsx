'use client';

import { useEffect, useRef, useState } from 'react';
import { useAgentStream } from '@/hooks/use-agent-stream';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { type StreamEvent } from '@/lib/stream-types';

function formatEvent(event: StreamEvent): string | null {
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        return `\x1b[36m◆ Session started — ${event.model}\x1b[0m\r\n`;
      }
      return null;

    case 'assistant': {
      const blocks = event.message?.content ?? [];
      const parts: string[] = [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          parts.push(block.text.replace(/\n/g, '\r\n'));
        } else if (block.type === 'tool_use') {
          parts.push(`\x1b[33m▶ ${block.name}\x1b[0m\r\n`);
        }
      }
      return parts.length ? parts.join('') : null;
    }

    case 'result':
      if (event.subtype === 'success') {
        const cost = typeof event.total_cost_usd === 'number'
          ? `$${event.total_cost_usd.toFixed(4)}`
          : '';
        return `\r\n\x1b[32m✓ Done${cost ? ` — ${cost}` : ''} (${event.duration_ms}ms)\x1b[0m\r\n`;
      }
      return `\r\n\x1b[31m✗ Failed: ${event.result ?? 'unknown error'}\x1b[0m\r\n`;

    case 'error':
      return `\x1b[31m⚠ ${event.error}\x1b[0m\r\n`;

    default:
      return null;
  }
}

interface Props {
  taskId: string;
  terminalKey: string;
  initialOutput: string | null;
  sessionIds?: string[];
}

export function SubtaskTerminal({ taskId, terminalKey, initialOutput, sessionIds }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ terminal: Terminal; fitAddon: FitAddon } | null>(null);
  const writtenRef = useRef(0);
  const [termReady, setTermReady] = useState(false);
  const events = useAgentStream(taskId);
  const userScrolledRef = useRef(false);
  const sessionIdSet = new Set(sessionIds ?? []);

  // Initialise xterm once on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let terminal: Terminal;
    let fitAddon: FitAddon;
    let observer: ResizeObserver;

    writtenRef.current = 0;

    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([{ Terminal }, { FitAddon }]) => {
      if (!container.isConnected) return;

      terminal = new Terminal({
        theme: {
          background: '#000000',
          foreground: '#34d399',
          cursor: '#34d399',
          selectionBackground: '#064e3b',
        },
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.5,
        cursorBlink: false,
        disableStdin: true,
        convertEol: true,
        scrollback: 10000,
      });

      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);
      fitAddon.fit();

      terminal.onScroll(() => {
        const atBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
        userScrolledRef.current = !atBottom;
      });

      if (initialOutput) {
        terminal.write(initialOutput.replace(/\n/g, '\r\n'));
        requestAnimationFrame(() => terminal.scrollToTop());
      }

      termRef.current = { terminal, fitAddon };
      setTermReady(true);

      observer = new ResizeObserver(() => fitAddon.fit());
      observer.observe(container);
    });

    return () => {
      observer?.disconnect();
      terminal?.dispose();
      termRef.current = null;
      writtenRef.current = 0;
      setTermReady(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [terminalKey]);

  // Append live events — filtered by sessionIds if provided
  useEffect(() => {
    if (!termReady || !termRef.current) return;
    const { terminal } = termRef.current;

    // Filter events to this terminal's sessions
    const filteredEvents = sessionIdSet.size > 0
      ? events.filter(e => sessionIdSet.has(e.sessionId))
      : events;

    let pendingWrites = 0;
    for (let i = writtenRef.current; i < filteredEvents.length; i++) {
      const text = formatEvent(filteredEvents[i].event);
      if (text) {
        pendingWrites++;
        terminal.write(text, () => {
          pendingWrites--;
          if (pendingWrites === 0 && !userScrolledRef.current) terminal.scrollToBottom();
        });
      }
    }
    writtenRef.current = filteredEvents.length;
    if (filteredEvents.length > writtenRef.current && pendingWrites === 0 && !userScrolledRef.current) {
      terminal.scrollToBottom();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events, termReady, sessionIds?.join(',')]);

  return (
    <div ref={containerRef} className="h-full min-h-[200px] p-1" />
  );
}
