'use client';

import { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import { useAgentStream } from '@/hooks/use-agent-stream';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';
import { type StreamEvent } from '@/lib/stream-types';

// Static side-effect import — bundlers reliably pick this up across
// dev/prod (Turbopack, webpack, Vite). A dynamic `import('xterm.css')` inside
// the runtime Promise.all below silently drops the CSS in production, which
// renders xterm at 0 rows so the user sees only one overwriting line.
import '@xterm/xterm/css/xterm.css';

// ── Role definitions ────────────────────────────────────────────────────────

interface RoleDef {
  key: string;
  label: string;
  color: string;
  ansiColor: string;
}

const ROLES: RoleDef[] = [
  { key: 'coder',       label: 'Coder',        color: 'border-amber-500',   ansiColor: '\x1b[33m' },
  { key: 'qa',          label: 'QA Review',     color: 'border-orange-500',  ansiColor: '\x1b[93m' },
  { key: 'spec',        label: 'Spec (Analyst)',color: 'border-purple-500',  ansiColor: '\x1b[35m' },
  { key: 'plan',        label: 'Plan (Planner)',color: 'border-blue-500',    ansiColor: '\x1b[36m' },
  { key: 'merge',       label: 'Merge (Merger)',color: 'border-teal-500',    ansiColor: '\x1b[96m' },
  { key: 'orchestrator',label: 'Orchestrator',  color: 'border-slate-500',   ansiColor: '\x1b[37m' },
];

const ROLE_MAP = new Map(ROLES.map(r => [r.key, r]));

// ── Types ───────────────────────────────────────────────────────────────────

interface SubtaskTerminalInfo {
  id: number;
  title: string;
  log: string | null;
}

interface ParsedLine {
  role: string;
  timestamp: string;
  text: string;
  prefixed: string;
}

interface Props {
  taskId: string;
  subtaskTerminals: SubtaskTerminalInfo[];
  qaLog: string | null;
  specLog: string | null;
  planLog: string | null;
  mergeLog: string | null;
  orchestratorLog: string | null;
  sessionMap?: Record<string, string>;
}

// ── Log parsing ─────────────────────────────────────────────────────────────

const TS_RE = /^\[(\d{2}:\d{2}:\d{2})\]\s/;

export function parseRoleLog(role: string, content: string | null): ParsedLine[] {
  if (!content) return [];
  const roleDef = ROLE_MAP.get(role);
  const ansi = roleDef?.ansiColor ?? '\x1b[37m';
  const label = roleDef?.label ?? role;
  const lines = content.split('\n');
  const result: ParsedLine[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const m = line.match(TS_RE);
    const ts = m ? m[1] : '00:00:00';
    const text = m ? line.slice(m[0].length) : line;
    const prefixed = `\x1b[90m[${ts}]\x1b[0m ${ansi}[${label}]\x1b[0m ${text}\r\n`;
    result.push({ role, timestamp: ts, text, prefixed });
  }

  return result;
}

export function parseCoderLogs(subtaskTerminals: SubtaskTerminalInfo[]): ParsedLine[] {
  const roleDef = ROLE_MAP.get('coder')!;
  const ansi = roleDef.ansiColor;
  const label = roleDef.label;
  const result: ParsedLine[] = [];

  for (const st of subtaskTerminals) {
    if (!st.log) continue;
    const lines = st.log.split('\n');
    const contentLines: ParsedLine[] = [];
    let firstTs = '00:00:00';
    for (const line of lines) {
      if (!line.trim()) continue;
      const m = line.match(TS_RE);
      const ts = m ? m[1] : '00:00:00';
      if (firstTs === '00:00:00' && ts !== '00:00:00') firstTs = ts;
      const text = m ? line.slice(m[0].length) : line;
      contentLines.push({
        role: 'coder',
        timestamp: ts,
        text,
        prefixed: `\x1b[90m[${ts}]\x1b[0m ${ansi}[${label}]\x1b[0m ${text}\r\n`,
      });
    }
    result.push({
      role: 'coder',
      timestamp: firstTs,
      text: `═══ Subtask ${st.id}: ${st.title} ═══`,
      prefixed: `\x1b[90m[${firstTs}]\x1b[0m \x1b[33;1m═══ Subtask ${st.id}: ${st.title} ═══\x1b[0m\r\n`,
    });
    result.push(...contentLines);
  }

  return result;
}

// ── Live event formatting ───────────────────────────────────────────────────

export function formatLiveEvent(event: StreamEvent): string | null {
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
          ? ` — $${event.total_cost_usd.toFixed(4)}` : '';
        return `\r\n\x1b[32m✓ Done${cost} (${event.duration_ms}ms)\x1b[0m\r\n`;
      }
      return `\r\n\x1b[31m✗ Failed: ${event.result ?? 'unknown error'}\x1b[0m\r\n`;
    case 'error':
      return `\x1b[31m⚠ ${event.error}\x1b[0m\r\n`;
    default:
      return null;
  }
}

// ── Component ───────────────────────────────────────────────────────────────

export function UnifiedTerminal({
  taskId, subtaskTerminals, qaLog, specLog, planLog, mergeLog, orchestratorLog, sessionMap,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ terminal: Terminal; fitAddon: FitAddon } | null>(null);
  // eslint-disable-next-line local/no-async-fetch-on-mount
  const [termReady, setTermReady] = useState(false);
  const events = useAgentStream(taskId);
  const userScrolledRef = useRef(false);
  const liveWrittenRef = useRef(0);

  const [selectedRoles, setSelectedRoles] = useState<Set<string>>(
    () => new Set(ROLES.map(r => r.key))
  );

  // ── Parse all logs ────────────────────────────────────────────────────

  const coderLines = useMemo(
    () => parseCoderLogs(subtaskTerminals),
    [subtaskTerminals]
  );
  const qaLines = useMemo(() => parseRoleLog('qa', qaLog), [qaLog]);
  const specLines = useMemo(() => parseRoleLog('spec', specLog), [specLog]);
  const planLines = useMemo(() => parseRoleLog('plan', planLog), [planLog]);
  const mergeLines = useMemo(() => parseRoleLog('merge', mergeLog), [mergeLog]);
  const orchLines = useMemo(() => parseRoleLog('orchestrator', orchestratorLog), [orchestratorLog]);

  const roleLogMap = useMemo<Record<string, ParsedLine[]>>(() => ({
    coder: coderLines,
    qa: qaLines,
    spec: specLines,
    plan: planLines,
    merge: mergeLines,
    orchestrator: orchLines,
  }), [coderLines, qaLines, specLines, planLines, mergeLines, orchLines]);

  const interleavedOutput = useMemo(() => {
    const all: ParsedLine[] = [];
    for (const [role, lines] of Object.entries(roleLogMap)) {
      if (selectedRoles.has(role)) {
        all.push(...lines);
      }
    }
    all.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return all.map(l => l.prefixed).join('');
  }, [roleLogMap, selectedRoles]);

  // ── Line counts for chips ─────────────────────────────────────────────

  const roleStats = useMemo(() => {
    const stats: Record<string, number> = {};
    for (const role of ROLES) {
      stats[role.key] = (roleLogMap[role.key]?.length ?? 0);
    }
    return stats;
  }, [roleLogMap]);

  // ── Toggle role ───────────────────────────────────────────────────────

  const toggleRole = useCallback((roleKey: string) => {
    setSelectedRoles(prev => {
      const next = new Set(prev);
      if (next.has(roleKey)) next.delete(roleKey);
      else next.add(roleKey);
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    setSelectedRoles(new Set(ROLES.map(r => r.key)));
  }, []);

  const selectNone = useCallback(() => {
    setSelectedRoles(new Set());
  }, []);

  // ── Initialise xterm ──────────────────────────────────────────────────

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let terminal: Terminal;
    let fitAddon: FitAddon;
    let observer: ResizeObserver;
    let cancelled = false;

    liveWrittenRef.current = 0;

    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([xterm, addonFit]) => {
      if (cancelled || !container.isConnected) return;

      const TerminalCtor = xterm.Terminal;
      const FitAddonCtor = addonFit.FitAddon;

      terminal = new TerminalCtor({
        theme: {
          background: '#000000',
          foreground: '#e2e8f0',
          cursor: '#94a3b8',
          selectionBackground: '#1e293b',
        },
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: 13,
        lineHeight: 1.5,
        cursorBlink: false,
        disableStdin: true,
        convertEol: true,
        scrollback: 50000,
      });

      fitAddon = new FitAddonCtor();
      terminal.loadAddon(fitAddon);
      terminal.open(container);
      // Defer the first fit() to the next animation frame so the flex chain
      // has time to resolve a non-zero pixel height. xterm.js needs the
      // container to have a definite size at measurement time — without
      // this, the very first fit() can see a 0×N viewport and render
      // a single row even when the ResizeObserver eventually re-fires.
      // Belt-and-suspenders: if rAF still fires before layout settles,
      // retry via setTimeout(0). The ResizeObserver remains the ultimate
      // safety net for any subsequent resize.
      requestAnimationFrame(() => {
        // Guard against unmount between Promise.all resolving and rAF firing.
        // The synchronous .fitAddon.fit() had the same exposure; this is the
        // belt-and-suspenders fix.
        if (!container.isConnected) return;
        if (container.clientHeight > 0) {
          fitAddon.fit();
        } else {
          setTimeout(() => {
            if (container.isConnected) fitAddon.fit();
          }, 0);
        }
      });

      terminal.onScroll(() => {
        const atBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
        userScrolledRef.current = !atBottom;
      });

      termRef.current = { terminal, fitAddon };
      setTermReady(true);

      observer = new ResizeObserver(() => fitAddon.fit());
      observer.observe(container);
    });

    return () => {
      cancelled = true;
      observer?.disconnect();
      terminal?.dispose();
      termRef.current = null;
      liveWrittenRef.current = 0;
      setTermReady(false);
    };
  }, []);

  // ── Compute selected session ids (must come BEFORE the effects below) ───

  const selectedSessionIds = useMemo(() => {
    if (!sessionMap) return new Set<string>();
    const ids = new Set<string>();
    for (const [k, v] of Object.entries(sessionMap)) {
      let role: string;
      if (k === 'qa') role = 'qa';
      else if (k === 'spec') role = 'spec';
      else if (k === 'plan') role = 'plan';
      else if (k === 'merge') role = 'merge';
      else role = 'coder';
      if (selectedRoles.has(role)) ids.add(v);
    }
    return ids;
  }, [sessionMap, selectedRoles]);

  // ── Write interleaved output ──────────────────────────────────────────

  useEffect(() => {
    if (!termReady || !termRef.current) return;
    const { terminal } = termRef.current;
    terminal.reset();
    // After reset the buffer is empty and cursor sits at top — treat that
    // as "user is at the bottom" so the auto-scroll below still runs.
    userScrolledRef.current = false;
    if (interleavedOutput) {
      terminal.write(interleavedOutput);
    }
    // Scroll to bottom so user sees the latest content; if they scroll up
    // afterwards, userScrolledRef stops auto-scroll on live events.
    requestAnimationFrame(() => {
      if (!userScrolledRef.current) terminal.scrollToBottom();
    });
    liveWrittenRef.current = 0;
  }, [interleavedOutput, termReady, selectedSessionIds]);

  // ── Append live events ────────────────────────────────────────────────

  useEffect(() => {
    if (!termReady || !termRef.current) return;
    const { terminal } = termRef.current;

    const filteredEvents = sessionMap
      ? events.filter(e => e.sessionId && selectedSessionIds.has(e.sessionId))
      : events;

    let pendingWrites = 0;
    for (let i = liveWrittenRef.current; i < filteredEvents.length; i++) {
      const text = formatLiveEvent(filteredEvents[i].event);
      if (text) {
        pendingWrites++;
        terminal.write(text, () => {
          pendingWrites--;
          if (pendingWrites === 0 && !userScrolledRef.current) terminal.scrollToBottom();
        });
      }
    }
    liveWrittenRef.current = filteredEvents.length;
    if (filteredEvents.length > 0 && pendingWrites === 0 && !userScrolledRef.current) {
      terminal.scrollToBottom();
    }
  }, [events, termReady, selectedSessionIds, sessionMap]);

  // ── Render ────────────────────────────────────────────────────────────

  const hasAnyLog = Object.values(roleStats).some(n => n > 0);

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Filter bar */}
      {hasAnyLog && (
        <div className="shrink-0 flex items-center gap-2 px-1 flex-wrap" data-testid="unified-terminal">
          <button
            onClick={selectAll}
            className="text-[10px] font-medium px-1.5 py-0.5 rounded text-slate-400 hover:text-white hover:bg-[#1e293b] transition-colors shrink-0"
          >
            All
          </button>
          <button
            onClick={selectNone}
            className="text-[10px] font-medium px-1.5 py-0.5 rounded text-slate-400 hover:text-white hover:bg-[#1e293b] transition-colors shrink-0"
          >
            None
          </button>
          <span className="text-slate-600 mx-0.5 shrink-0">|</span>
          {ROLES.map(role => {
            const selected = selectedRoles.has(role.key);
            const count = roleStats[role.key] ?? 0;
            if (count === 0) return null;
            return (
              <button
                key={role.key}
                onClick={() => toggleRole(role.key)}
                className={`flex items-center gap-1.5 text-[10px] font-medium px-2 py-0.5 rounded border transition-colors shrink-0 ${
                  selected
                    ? `${role.color} bg-[#1a1f2e] text-slate-200`
                    : 'border-transparent bg-[#11131b] text-slate-500 hover:text-slate-300'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    role.key === 'coder' ? 'bg-amber-500' :
                    role.key === 'qa' ? 'bg-orange-500' :
                    role.key === 'spec' ? 'bg-purple-500' :
                    role.key === 'plan' ? 'bg-blue-500' :
                    role.key === 'merge' ? 'bg-teal-500' :
                    'bg-slate-500'
                  }`}
                />
                {role.label}
                <span className="text-slate-600">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Terminal — always mounted so xterm initializes on the very first
          render, even before any log exists. Gating this div on hasAnyLog
          used to mean the mount-once init effect (deps: []) would find
          containerRef.current null and give up for good; a later re-render
          with real logs would flip hasAnyLog to true and mount the div, but
          the init effect never reruns on the same component instance, so
          the terminal stayed permanently blank while the filter chips (fed
          by roleStats, independent of DOM mount state) rendered normally. */}
      <div className="relative flex-1 min-h-0 rounded-lg overflow-hidden border border-[#1e293b]">
        {!hasAnyLog && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400 pointer-events-none">
            No agent output yet. Run the pipeline to see terminal output.
          </div>
        )}
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
}
