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

// Tracks per-terminal-instance how many chars of initialOutput have been written.
// Using the terminal object as key means a fresh xterm always starts at 0,
// surviving React StrictMode double-invoke and Fast Refresh ref preservation.
const termWriteMap = new WeakMap<object, number>();

export function AgentPanel({ taskId, initialOutput }: { taskId: string; initialOutput?: string | null }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ terminal: Terminal; fitAddon: FitAddon } | null>(null);
  const writtenRef = useRef(0);           // index into live events array
  const initialOutputRef = useRef(initialOutput); // always holds the latest value for the init callback
  const [termReady, setTermReady] = useState(false);
  const events = useAgentStream(taskId);
  const userScrolledRef = useRef(false);

  // Initialise xterm once on mount
  useEffect(() => {
    initialOutputRef.current = initialOutput;
    const container = containerRef.current;
    if (!container) return;

    let terminal: Terminal;
    let fitAddon: FitAddon;
    let observer: ResizeObserver;

    // Reset live-event counter whenever xterm re-initialises
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

      // Track user scroll position — pause auto-scroll when user scrolls up to read old output
      terminal.onScroll(() => {
        const atBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
        userScrolledRef.current = !atBottom;
      });

      // Write persisted log immediately — avoids race with termReady state updates
      const logContent = initialOutputRef.current;
      if (logContent) {
        terminal.write(logContent.replace(/\n/g, '\r\n'));
        termWriteMap.set(terminal, logContent.length);
        requestAnimationFrame(() => terminal.scrollToTop());
      }

      termRef.current = { terminal, fitAddon };
      setTermReady(true); // triggers live event streaming

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
  }, []);

  // Append historical log incrementally per terminal instance, then stream live events.
  // termWriteMap (WeakMap keyed on the terminal object) tracks how many chars of
  // initialOutput this specific xterm instance has already received — surviving
  // StrictMode double-invoke and Fast Refresh ref preservation.
  useEffect(() => {
    if (!termReady || !termRef.current) return;
    const { terminal } = termRef.current;

    // Write new portion of persisted log for THIS terminal instance
    if (initialOutput) {
      const written = termWriteMap.get(terminal) ?? 0;
      if (initialOutput.length > written) {
        const isFirstWrite = written === 0;
        const delta = initialOutput.slice(written);
        termWriteMap.set(terminal, initialOutput.length);
        terminal.write(delta.replace(/\n/g, '\r\n'));
        if (isFirstWrite) requestAnimationFrame(() => terminal.scrollToTop());
      }
    }

    // Append only new live events since last render
    const hadNewEvents = events.length > writtenRef.current;
    let pendingWrites = 0;
    for (let i = writtenRef.current; i < events.length; i++) {
      const text = formatEvent(events[i].event);
      if (text) {
        pendingWrites++;
        terminal.write(text, () => {
          pendingWrites--;
          // Only auto-scroll after ALL writes render if the user hasn't manually scrolled up
          if (pendingWrites === 0 && !userScrolledRef.current) terminal.scrollToBottom();
        });
      }
    }
    writtenRef.current = events.length;
    // If no text was written (all null events), still scroll to keep in sync
    // Only auto-scroll if the user hasn't manually scrolled up
    if (hadNewEvents && pendingWrites === 0 && !userScrolledRef.current) terminal.scrollToBottom();
  }, [events, termReady, initialOutput]);

  return (
    <div className="flex flex-col h-full rounded-lg overflow-hidden border border-[#1e293b] bg-black relative">
      <div className="flex items-center justify-between px-4 py-2 border-b border-[#1e293b] bg-[#0f172a] shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Agent Output
        </span>
        <span className="text-xs text-slate-500">
          {events.length > 0 ? `${events.length} events` : initialOutput ? 'history' : '0 events'}
        </span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 p-1" />
    </div>
  );
}
