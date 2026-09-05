'use client';

import { useEffect, useRef, useState } from 'react';
import { closeTerminalSession } from '@/app/actions/terminals';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

interface Props {
  sessionId: string;
  role: string;
  model: string;
  onClose: () => void;
}

const ROLE_COLORS: Record<string, string> = {
  'planner.md':      'border-blue-500',
  'coder.md':        'border-amber-500',
  'qa-reviewer.md':  'border-orange-500',
  'merger.md':       'border-teal-500',
  'analyst.md':      'border-indigo-500',
};

export function TerminalPanel({ sessionId, role, model, onClose }: Props) {
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

      // xterm.js core doesn't wire up paste on its own: Ctrl+V/Cmd+V is
      // otherwise swallowed by its keydown handling before the browser's
      // native paste ever fires. Tell xterm to leave that combo alone (so
      // the browser dispatches a real 'paste' event on its hidden textarea),
      // then forward the pasted text into the PTY via terminal.paste().
      terminal.attachCustomKeyEventHandler((event) => {
        const isPasteShortcut = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v';
        return !(event.type === 'keydown' && isPasteShortcut);
      });
      const textarea = container.querySelector('textarea');
      const handlePaste = (event: ClipboardEvent) => {
        const text = event.clipboardData?.getData('text/plain');
        if (text) {
          event.preventDefault();
          terminal.paste(text);
        }
      };
      textarea?.addEventListener('paste', handlePaste);

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
      ws.onopen = () => {
        setConnected(true);
        // The PTY is spawned server-side with a fixed placeholder size
        // (see ProcessManager.createTerminalSession) before this socket
        // exists, so any ResizeObserver firing during that window has its
        // resize message silently dropped by safeSend's readyState check —
        // the server-side PTY is then permanently out of sync with the
        // panel's real, fitted dimensions, and full-screen CLI UIs (status
        // bars, input boxes) misrender against the wrong height. Push the
        // already-fitted size the moment the socket opens so the PTY is
        // corrected immediately, not just on the next incidental resize.
        const { cols, rows } = terminal;
        safeSend({ type: 'terminal-resize', sessionId, cols, rows });
      };
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
          {role.replace('.md', '')}
          {' — '}
          <span className="text-slate-500">{model}</span>
          {!connected && <span className="text-slate-500"> (connecting…)</span>}
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
