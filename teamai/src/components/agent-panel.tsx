'use client';

import { useEffect, useRef } from 'react';
import { useAgentStream } from '@/hooks/use-agent-stream';

function formatEvent(event: any): string | null {
  switch (event.type) {
    case 'system':
      if (event.subtype === 'init') {
        return `\x1b[36m◆ Session started — ${event.model}\x1b[0m\r\n`;
      }
      return null;

    case 'assistant': {
      const blocks: any[] = event.message?.content ?? [];
      const parts: string[] = [];
      for (const block of blocks) {
        if (block.type === 'text' && block.text) {
          // Ensure Windows-style newlines work in xterm
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

export function AgentPanel({ taskId }: { taskId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ terminal: any; fitAddon: any } | null>(null);
  const events = useAgentStream(taskId);

  // Initialise xterm once on mount
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let terminal: any;
    let fitAddon: any;
    let observer: ResizeObserver;

    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([{ Terminal }, { FitAddon }]) => {
      if (!container.isConnected) return;

      terminal = new Terminal({
        theme: {
          background: '#0f172a',
          foreground: '#e2e8f0',
          cursor: '#94a3b8',
          selectionBackground: '#334155',
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
      termRef.current = { terminal, fitAddon };

      observer = new ResizeObserver(() => fitAddon.fit());
      observer.observe(container);
    });

    return () => {
      observer?.disconnect();
      terminal?.dispose();
      termRef.current = null;
    };
  }, []);

  // Write each new event to the terminal
  useEffect(() => {
    if (!termRef.current || events.length === 0) return;
    const { terminal } = termRef.current;
    const latest = events[events.length - 1];
    const text = formatEvent(latest.event);
    if (text) terminal.write(text);
  }, [events]);

  return (
    <div className="flex flex-col h-full rounded-lg overflow-hidden border border-slate-700 bg-slate-950">
      <div className="flex items-center justify-between px-4 py-2 border-b border-slate-700 bg-slate-900 shrink-0">
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
          Agent Output
        </span>
        <span className="text-xs text-slate-500">{events.length} events</span>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 p-1" />
    </div>
  );
}
