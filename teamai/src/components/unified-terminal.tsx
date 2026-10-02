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
  { key: 'qa',          label: 'QA Review',     color: 'border-green-500',   ansiColor: '\x1b[32m' },
  { key: 'spec',        label: 'Spec (Analyst)',color: 'border-purple-500',  ansiColor: '\x1b[35m' },
  { key: 'plan',        label: 'Plan (Planner)',color: 'border-blue-500',    ansiColor: '\x1b[36m' },
  { key: 'merge',       label: 'Merge (Merger)',color: 'border-teal-500',    ansiColor: '\x1b[96m' },
  { key: 'orchestrator',label: 'Orchestrator',  color: 'border-rose-500',   ansiColor: '\x1b[91m' },
];

const ROLE_MAP = new Map(ROLES.map(r => [r.key, r]));

/** Map any sessionMap key (role name or subtask id) to its canonical role key.
 *  Known roles (qa, spec, plan, merge) map to themselves; everything else
 *  (e.g. subtask ids like "1", "2") maps to 'coder'. */
function resolveRoleKey(sessionMapKey: string): string {
  if (sessionMapKey === 'qa') return 'qa';
  if (sessionMapKey === 'spec') return 'spec';
  if (sessionMapKey === 'plan') return 'plan';
  if (sessionMapKey === 'merge') return 'merge';
  return 'coder';
}

// ── Types ───────────────────────────────────────────────────────────────────

interface SubtaskTerminalInfo {
  id: number;
  title: string;
  log: string | null;
}

interface ParsedLine {
  role: string;
  /** Display timestamp: MM-DD HH:MM:SS for dated lines, HH:MM:SS for legacy lines. */
  timestamp: string;
  /**
   * Chronological sort key. Dated lines (`[YYYY-MM-DDTHH:MM:SS]`, written
   * since timestamps started including the date) sort correctly across day
   * boundaries. Legacy lines (`[HH:MM:SS]` only, from before that change)
   * carry a '0000-00-00T'-prefixed key so old, undated content always
   * sorts before anything dated — never masquerading as "most recent" just
   * because its bare clock time happens to be numerically later in the day
   * (e.g. a stale 22:58 line from two days ago outranking a fresh 14:25
   * line from today under naive HH:MM:SS string comparison).
   */
  sortKey: string;
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
  project?: string;
}

// ── Log parsing ─────────────────────────────────────────────────────────────

// Current format: `[YYYY-MM-DDTHH:MM:SS] ...` (process-manager.ts writes the
// full ISO date-time). Legacy format: `[HH:MM:SS] ...`, from before dates
// were included — still present in log files written prior to that change.
const TS_RE_DATED = /^\[(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})\]\s/;
const TS_RE_LEGACY = /^\[(\d{2}:\d{2}:\d{2})\]\s/;

function parseTimestamp(line: string): { display: string; sortKey: string; rest: string } {
  const dated = line.match(TS_RE_DATED);
  if (dated) {
    return { display: `${dated[1].slice(5)} ${dated[2]}`, sortKey: `${dated[1]}T${dated[2]}`, rest: line.slice(dated[0].length) };
  }
  const legacy = line.match(TS_RE_LEGACY);
  if (legacy) {
    return { display: legacy[1], sortKey: `0000-00-00T${legacy[1]}`, rest: line.slice(legacy[0].length) };
  }
  return { display: '00:00:00', sortKey: '', rest: line };
}

export function parseRoleLog(role: string, content: string | null): ParsedLine[] {
  if (!content) return [];
  const roleDef = ROLE_MAP.get(role);
  const ansi = roleDef?.ansiColor ?? '\x1b[37m';
  const label = roleDef?.label ?? role;
  const lines = content.split('\n');
  const result: ParsedLine[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    const { display, sortKey, rest } = parseTimestamp(line);
    const prefixed = `\x1b[90m[${display}]\x1b[0m ${ansi}[${label}]\x1b[0m ${rest}\r\n`;
    result.push({ role, timestamp: display, sortKey, text: rest, prefixed });
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
    let firstDisplay = '00:00:00';
    let firstSortKey = '';
    let sawTimestamp = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      const { display, sortKey, rest } = parseTimestamp(line);
      if (!sawTimestamp && display !== '00:00:00') {
        firstDisplay = display;
        firstSortKey = sortKey;
        sawTimestamp = true;
      }
      contentLines.push({
        role: 'coder',
        timestamp: display,
        sortKey,
        text: rest,
        prefixed: `\x1b[90m[${display}]\x1b[0m ${ansi}[${label}]\x1b[0m ${rest}\r\n`,
      });
    }
    result.push({
      role: 'coder',
      timestamp: firstDisplay,
      sortKey: firstSortKey,
      text: `═══ Subtask ${st.id}: ${st.title} ═══`,
      prefixed: `\x1b[90m[${firstDisplay}]\x1b[0m \x1b[33;1m═══ Subtask ${st.id}: ${st.title} ═══\x1b[0m\r\n`,
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

/** Format a live event with the role label and timestamp prefix, matching
 *  the appearance of parsed log lines from parseRoleLog / parseCoderLogs.
 *  Leading \r\n in the body (e.g. from result/error events) is moved before
 *  the label so the label stays on the same visual line as the content. */
export function formatLiveEventWithLabel(
  event: StreamEvent,
  roleLabel: string,
  ansiColor: string,
): string | null {
  const body = formatLiveEvent(event);
  if (!body) return null;
  // Use UTC to match process-manager.ts's toISOString() timestamps.
  const now = new Date();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const day = String(now.getUTCDate()).padStart(2, '0');
  const time = `${String(now.getUTCHours()).padStart(2, '0')}:${String(now.getUTCMinutes()).padStart(2, '0')}:${String(now.getUTCSeconds()).padStart(2, '0')}`;
  const ts = `${month}-${day} ${time}`;
  const prefix = `\x1b[90m[${ts}]\x1b[0m ${ansiColor}[${roleLabel}]\x1b[0m `;
  // Move any leading \r\n before the label so the content stays next to it.
  if (body.startsWith('\r\n')) return `\r\n${prefix}${body.slice(2)}`;
  return `${prefix}${body}`;
}

// ── Terminal sizing ─────────────────────────────────────────────────────────

const FONT_SIZE = 13;
const LINE_HEIGHT = 1.5;
/** Minimum container height (one row) before calling fitAddon.fit().
 *  Guards only against a 0-height container (hidden tab, unmounted layout).
 *  Any larger height MUST be fitted: the terminal opens with a fixed
 *  `rows: 24`, so skipping the fit for a short container leaves xterm taller
 *  than its `overflow-hidden` box and clips the last log line with nothing
 *  left to scroll. */
const MIN_FIT_HEIGHT = FONT_SIZE * LINE_HEIGHT;

// ── Component ───────────────────────────────────────────────────────────────

export function UnifiedTerminal({
  taskId, subtaskTerminals, qaLog, specLog, planLog, mergeLog, orchestratorLog, sessionMap, project,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ terminal: Terminal; fitAddon: FitAddon } | null>(null);
  // eslint-disable-next-line local/no-async-fetch-on-mount
  const [termReady, setTermReady] = useState(false);
  const { events, connected } = useAgentStream(taskId, project);
  const userScrolledRef = useRef(false);
  const liveWrittenRef = useRef(0);
  const hasWrittenRef = useRef(false);

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
    all.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
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
    let jsdomFallback: ReturnType<typeof setTimeout>;
    let cancelled = false;

    liveWrittenRef.current = 0;

    Promise.all([
      import('@xterm/xterm'),
      import('@xterm/addon-fit'),
    ]).then(([xterm, addonFit]) => {
      if (cancelled || !container.isConnected) return;

      const TerminalCtor = xterm.Terminal;
      const FitAddonCtor = addonFit.FitAddon;

      // Force DOM renderer so terminal content is accessible in DOM
      // queries.  xterm.js v6 defaults to the WebGL renderer, which
      // renders to a <canvas> element and does not populate .xterm-rows
      // with text nodes — making innerText/textContent return only
      // whitespace in headless Chrome.
      // The DOM renderer is fast enough for a log-viewing terminal.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts: any = {
        theme: {
          background: '#000000',
          foreground: '#e2e8f0',
          cursor: '#94a3b8',
          selectionBackground: '#1e293b',
        },
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        fontSize: FONT_SIZE,
        lineHeight: LINE_HEIGHT,
        cursorBlink: false,
        disableStdin: true,
        convertEol: false,
        scrollback: 50000,
        rendererType: 'dom',
        // Prevent a 1-row collapse that loses the first log line to
        // scrollback.  When the container is 0-height at mount time
        // (common under E2E suite load in headless Chrome), xterm
        // defaults to 1 row.  An explicit rows value guarantees
        // enough rows exist from the moment the terminal opens.
        rows: 24,
      };
      terminal = new TerminalCtor(opts);

      fitAddon = new FitAddonCtor();
      terminal.loadAddon(fitAddon);
      terminal.open(container);

      // `rows: 24` guarantees enough rows from the moment the terminal
      // opens — content can be written immediately without waiting for the
      // container to reach any particular height.
      //
      // The ResizeObserver is set up in the write effect (after content
      // is safely in the buffer) to avoid a race where headless Chrome
      // under load fires the observer before content is written, fitting
      // the terminal to an intermediate height and collapsing the viewport.
      const isNode = typeof process !== 'undefined' && process.versions?.node;
      if (isNode) {
        fitAddon.fit();
      }
      termRef.current = { terminal, fitAddon };
      setTermReady(true);

      // JSDOM escape hatch: in simulated DOM the container is always 0
      // height, so fit once after 500 ms so unit tests have a sized terminal.
      if (isNode) {
        jsdomFallback = setTimeout(() => {
          if (container.clientHeight === 0) {
            fitAddon.fit();
          }
        }, 500);
      }

      terminal.onScroll(() => {
        const atBottom = terminal.buffer.active.viewportY >= terminal.buffer.active.baseY;
        userScrolledRef.current = !atBottom;
      });
    }).catch((err: unknown) => {
      console.error('[UnifiedTerminal] Failed to load xterm modules:', err);
    });

    return () => {
      cancelled = true;
      clearTimeout(jsdomFallback);
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
      if (selectedRoles.has(resolveRoleKey(k))) ids.add(v);
    }
    return ids;
  }, [sessionMap, selectedRoles]);

  // ── Reverse map: sessionId → { label, ansiColor } for live-event labels ─

  const sessionRoleMap = useMemo(() => {
    const map = new Map<string, { label: string; ansiColor: string }>();
    if (!sessionMap) return map;
    for (const [k, v] of Object.entries(sessionMap)) {
      const def = ROLE_MAP.get(resolveRoleKey(k));
      if (def) map.set(v, { label: def.label, ansiColor: def.ansiColor });
    }
    return map;
  }, [sessionMap]);

  // ── Write interleaved output ──────────────────────────────────────────

  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  useEffect(() => {
    if (!termReady || !termRef.current) return;
    const { terminal, fitAddon } = termRef.current;
    const container = containerRef.current;
    // Use clear() instead of reset() — reset() tears down the full terminal
    // buffer and DOM renderer state, and under headless-Chrome load the DOM
    // renderer may not finish rebuilding before the synchronous write()
    // below, causing the first line to be dropped from the viewport.
    // clear() only wipes the screen and scrollback without a full teardown.
    // On first mount the terminal is already empty, so skip clearing entirely.
    if (hasWrittenRef.current) {
      terminal.clear();
    }
    hasWrittenRef.current = true;
    userScrolledRef.current = false;
    if (interleavedOutput) {
      terminal.write(interleavedOutput);
    }

    // Set up the ResizeObserver AFTER content is safely in the buffer.
    // This avoids a race where headless Chrome under E2E load fires the
    // observer before content is written, fitting to an intermediate
    // height and collapsing the viewport to 1-2 rows.
    // MIN_FIT_HEIGHT (one row) only skips a 0-height container; every other
    // height is fitted, and the view is re-pinned to the bottom afterwards.
    if (!resizeObserverRef.current && container) {
      resizeObserverRef.current = new ResizeObserver(() => {
        if (container.clientHeight >= MIN_FIT_HEIGHT) {
          fitAddon.fit();
          if (!userScrolledRef.current) terminal.scrollToBottom();
        }
      });
      resizeObserverRef.current.observe(container);
    }

    requestAnimationFrame(() => {
      if (termRef.current && !userScrolledRef.current) {
        termRef.current.terminal.scrollToBottom();
      }
    });
    liveWrittenRef.current = 0;
  }, [interleavedOutput, termReady, selectedSessionIds]);

  // ── Cleanup ResizeObserver on unmount ─────────────────────────────────

  useEffect(() => {
    return () => {
      resizeObserverRef.current?.disconnect();
      resizeObserverRef.current = null;
    };
  }, []);

  // ── Append live events ────────────────────────────────────────────────

  useEffect(() => {
    if (!termReady || !termRef.current) return;
    const { terminal } = termRef.current;

    const filteredEvents = sessionMap
      ? events.filter(e => e.sessionId && selectedSessionIds.has(e.sessionId))
      : events;

    let pendingWrites = 0;
    for (let i = liveWrittenRef.current; i < filteredEvents.length; i++) {
      const { sessionId, event } = filteredEvents[i];
      // Look up the role label for this session; fall back to plain format
      // if sessionMap isn't available or the session isn't mapped (e.g.
      // events arriving before the session_map.json was written to disk).
      const roleInfo = sessionRoleMap.get(sessionId);
      const text = roleInfo
        ? formatLiveEventWithLabel(event, roleInfo.label, roleInfo.ansiColor)
        : formatLiveEvent(event);
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
  }, [events, termReady, selectedSessionIds, sessionMap, sessionRoleMap]);

  // ── Render ────────────────────────────────────────────────────────────

  const hasAnyLog = Object.values(roleStats).some(n => n > 0);

  return (
    <div className="flex flex-col h-full gap-2">
      {/* Filter bar */}
      {hasAnyLog && (
        <div className="shrink-0 flex items-center gap-2 px-1 flex-wrap" data-component="unified-terminal">
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
                    role.key === 'qa' ? 'bg-green-500' :
                    role.key === 'spec' ? 'bg-purple-500' :
                    role.key === 'plan' ? 'bg-blue-500' :
                    role.key === 'merge' ? 'bg-teal-500' :
                    'bg-rose-500'
                  }`}
                />
                {role.label}
                <span className="text-slate-600">{count}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Reconnecting banner */}
      {!connected && hasAnyLog && (
        <div
          className="shrink-0 flex items-center gap-2 px-3 py-1.5 rounded-md bg-amber-950/50 border border-amber-800/50 text-amber-300 text-xs"
          data-component="terminal-reconnecting-banner"
        >
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2 w-2 bg-amber-500" />
          </span>
          Reconnecting…
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
      <div className="relative flex-1 min-h-0 rounded-lg overflow-hidden border border-[#1e293b]" data-component="terminal-container">
        {!hasAnyLog && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-slate-400 pointer-events-none" data-component="terminal-empty-state">
            No agent output yet. Run the pipeline to see terminal output.
          </div>
        )}
        <div ref={containerRef} className="w-full h-full" />
      </div>
    </div>
  );
}
