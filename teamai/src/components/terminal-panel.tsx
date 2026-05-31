'use client';

import { useEffect, useRef, useState } from 'react';
import { closeTerminalSession } from '@/app/actions/terminals';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

interface Props {
  sessionId: string;
  role: string;
  onClose: () => void;
}

const ROLE_COLORS: Record<string, string> = {
  'planner.md':      'border-blue-500',
  'coder.md':        'border-amber-500',
  'qa-reviewer.md':  'border-orange-500',
  'merger.md':       'border-teal-500',
  'analyst.md':      'border-indigo-500',
};

export function TerminalPanel({ sessionId, role, onClose }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ terminal: Terminal; fitAddon: FitAddon } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let terminal: Terminal;
    let fitAddon: FitAddon;
    let observer: ResizeObserver;

    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([{ Terminal }, { FitAddon }]) => {
      if (!container.isConnected) return;

      terminal = new Terminal({
        theme: { background: '#0f172a', foreground: '#e2e8f0', cursor: '#94a3b8' },
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.5,
        cursorBlink: true,
        scrollback: 10000,
      });

      fitAddon = new FitAddon();
      terminal.loadAddon(fitAddon);
      terminal.open(container);
      fitAddon.fit();
      termRef.current = { terminal, fitAddon };

      const safeSend = (msg: object) => {
        if (wsRef.current?.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify(msg));
        }
      };

      // Send user keystrokes to PTY via WebSocket
      terminal.onData((data: string) => {
        safeSend({ type: 'terminal-input', sessionId, data });
      });

      observer = new ResizeObserver(() => {
        fitAddon.fit();
        const { cols, rows } = terminal;
        safeSend({ type: 'terminal-resize', sessionId, cols, rows });
      });
      observer.observe(container);

      // WebSocket for PTY output
      const ws = new WebSocket(`ws://${window.location.host}/ws`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onmessage = (msg) => {
        try {
          const data = JSON.parse(msg.data);
          if (data.type === 'terminal' && data.sessionId === sessionId) {
            terminal.write(data.data);
          }
        } catch { /* ignore */ }
      };
      ws.onclose = () => setConnected(false);
    });

    return () => {
      observer?.disconnect();
      terminal?.dispose();
      wsRef.current?.close();
      termRef.current = null;
    };
  }, [sessionId]);

  async function handleClose() {
    wsRef.current?.close();
    await closeTerminalSession(sessionId);
    onClose();
  }

  const borderColor = ROLE_COLORS[role] ?? 'border-slate-600';

  return (
    <div className={`flex flex-col rounded-lg overflow-hidden border-2 ${borderColor} bg-slate-950 h-full`}>
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#1a1f2e] shrink-0">
        <span className="text-xs font-medium text-slate-300">
          {role.replace('.md', '')} {!connected && <span className="text-slate-500">(connecting…)</span>}
        </span>
        <button
          onClick={handleClose}
          className="text-slate-500 hover:text-slate-200 text-sm leading-none"
        >
          ×
        </button>
      </div>
      <div ref={containerRef} className="flex-1 min-h-0 p-1" />
    </div>
  );
}
