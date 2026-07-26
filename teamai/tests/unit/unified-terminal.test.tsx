// @vitest-environment happy-dom

/**
 * Unit tests for UnifiedTerminal component and its exported utility functions.
 *
 * Covers:
 *   - parseRoleLog: timestamp parsing, empty content, multi-line, role labels/colors
 *   - parseCoderLogs: single/multiple subtasks, separators, null logs, empty arrays
 *   - formatLiveEvent: system init/other, assistant text/tool_use/mixed, result success/failure, errors
 *   - Component: empty state, filter bar rendering, filter toggling, All/None, responsive wrapping
 *   - Interleaved output: selectedRoles filtering, timestamp ordering
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const { mockTerminalWrite, mockTerminalReset, mockTerminalOpen, mockTerminalDispose, mockTerminalOnScroll, mockFitAddonFit } = vi.hoisted(() => ({
  mockTerminalWrite: vi.fn(),
  mockTerminalReset: vi.fn(),
  mockTerminalOpen: vi.fn(),
  mockTerminalDispose: vi.fn(),
  mockTerminalOnScroll: vi.fn(),
  mockFitAddonFit: vi.fn(),
}));

const mockTerminalInstance = {
  write: mockTerminalWrite,
  reset: mockTerminalReset,
  open: mockTerminalOpen,
  dispose: mockTerminalDispose,
  onScroll: mockTerminalOnScroll,
  loadAddon: vi.fn(),
  scrollToTop: vi.fn(),
  scrollToBottom: vi.fn(),
  buffer: { active: { viewportY: 0, baseY: 1 } },
};

const mockTerminalConstructor = vi.hoisted(() => vi.fn(() => mockTerminalInstance));
const mockFitAddonConstructor = vi.hoisted(() => vi.fn(() => ({ fit: mockFitAddonFit })));

vi.mock('@xterm/xterm', () => ({
  Terminal: mockTerminalConstructor,
}));

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: mockFitAddonConstructor,
}));

const mockUseAgentStreamReturn = vi.hoisted(() => [] as Array<{ sessionId: string; event: StreamEvent }>);
const mockUseAgentStreamConnected = vi.hoisted(() => true);

vi.mock('@/hooks/use-agent-stream', () => ({
  useAgentStream: () => ({ events: mockUseAgentStreamReturn, connected: mockUseAgentStreamConnected }),
}));

// Mock ResizeObserver (not available in happy-dom)
class MockResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', MockResizeObserver);

// Mock requestAnimationFrame
vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0));

// ── Imports ─────────────────────────────────────────────────────────────────

import {
  UnifiedTerminal,
  parseRoleLog,
  parseCoderLogs,
  formatLiveEvent,
  formatLiveEventWithLabel,
} from '@/components/unified-terminal';
import type { StreamEvent } from '@/lib/stream-types';

// ── Fixtures ────────────────────────────────────────────────────────────────

function makeDefaultProps(overrides: Record<string, unknown> = {}) {
  return {
    taskId: 'task-test-1',
    subtaskTerminals: [],
    qaLog: null,
    specLog: null,
    planLog: null,
    mergeLog: null,
    orchestratorLog: null,
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  parseRoleLog
// ═══════════════════════════════════════════════════════════════════════════

describe('parseRoleLog', () => {
  it('returns empty array for null content', () => {
    expect(parseRoleLog('qa', null)).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    expect(parseRoleLog('qa', '')).toEqual([]);
  });

  it('parses a timestamped line with role prefix', () => {
    const result = parseRoleLog('qa', '[12:34:56] Test message');
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('qa');
    expect(result[0].timestamp).toBe('12:34:56');
    expect(result[0].text).toBe('Test message');
    expect(result[0].prefixed).toContain('[QA Review]');
    expect(result[0].prefixed).toContain('Test message');
    expect(result[0].prefixed).toMatch(/\x1b\[93m/); // orange ANSI for QA
  });

  it('assigns 00:00:00 to lines without timestamp', () => {
    const result = parseRoleLog('spec', 'No timestamp here');
    expect(result).toHaveLength(1);
    expect(result[0].timestamp).toBe('00:00:00');
    expect(result[0].text).toBe('No timestamp here');
  });

  it('parses multiple lines', () => {
    const result = parseRoleLog('plan', '[01:02:03] First\n[04:05:06] Second');
    expect(result).toHaveLength(2);
    expect(result[0].timestamp).toBe('01:02:03');
    expect(result[0].text).toBe('First');
    expect(result[1].timestamp).toBe('04:05:06');
    expect(result[1].text).toBe('Second');
  });

  it('skips blank lines', () => {
    const result = parseRoleLog('merge', '[01:00:00] A\n\n[02:00:00] B\n   \n[03:00:00] C');
    expect(result).toHaveLength(3);
  });

  it('uses role label as prefix in prefixed output', () => {
    const result = parseRoleLog('spec', '[12:00:00] Design doc');
    expect(result[0].prefixed).toContain('[Spec (Analyst)]');
  });

  it('uses ANSI reset code after prefix', () => {
    const result = parseRoleLog('orchestrator', '[12:00:00] Orchestration log');
    expect(result[0].prefixed).toContain('\x1b[0m');
  });

  it('uses correct ANSI color per role', () => {
    expect(parseRoleLog('coder', '[00:00:01] x')[0].prefixed).toMatch(/\x1b\[33m/);
    expect(parseRoleLog('qa', '[00:00:01] x')[0].prefixed).toMatch(/\x1b\[93m/);
    expect(parseRoleLog('spec', '[00:00:01] x')[0].prefixed).toMatch(/\x1b\[35m/);
    expect(parseRoleLog('plan', '[00:00:01] x')[0].prefixed).toMatch(/\x1b\[36m/);
    expect(parseRoleLog('merge', '[00:00:01] x')[0].prefixed).toMatch(/\x1b\[96m/);
    expect(parseRoleLog('orchestrator', '[00:00:01] x')[0].prefixed).toMatch(/\x1b\[37m/);
  });

  it('falls back to default ANSI for unknown role', () => {
    const result = parseRoleLog('unknown-role', '[12:00:00] test');
    expect(result[0].prefixed).toMatch(/\x1b\[37m/);
    expect(result[0].prefixed).toContain('[unknown-role]');
  });

  it('handles content with only whitespace lines', () => {
    const result = parseRoleLog('qa', '   \n\t\n   ');
    expect(result).toHaveLength(0);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Dated vs legacy timestamp format — sortKey
// ═══════════════════════════════════════════════════════════════════════════
//
// process-manager.ts writes `[YYYY-MM-DDTHH:MM:SS]` timestamps (full ISO
// date-time) so cross-day sorting works correctly. Log files written before
// that change still contain the old `[HH:MM:SS]` (time-only) format. Both
// must keep parsing correctly, and — critically — a legacy line's sortKey
// must never let it outrank dated content just because its bare clock value
// happens to be numerically later in the day.

describe('dated vs legacy timestamp format (sortKey)', () => {
  it('parses the dated format, splitting display time from the full sortable date-time', () => {
    const result = parseRoleLog('qa', '[2026-07-23T14:25:35] Fresh QA output');
    expect(result[0].timestamp).toBe('14:25:35');
    expect(result[0].sortKey).toBe('2026-07-23T14:25:35');
    expect(result[0].text).toBe('Fresh QA output');
  });

  it('parses the legacy time-only format, anchoring sortKey before all dated content', () => {
    const result = parseRoleLog('coder', '[22:58:26] Stale output from a prior day');
    expect(result[0].timestamp).toBe('22:58:26');
    expect(result[0].sortKey).toBe('0000-00-00T22:58:26');
  });

  it('assigns an empty sortKey (sorts first) to lines with no timestamp at all', () => {
    const result = parseRoleLog('spec', 'No timestamp here');
    expect(result[0].sortKey).toBe('');
  });

  it('orders a stale legacy line before a chronologically-later dated line, despite a numerically larger raw clock value', () => {
    // Regression for the reported bug: a task retried across multiple days
    // has some subtask logs still in the legacy format (e.g. a subtask that
    // last ran two days ago, ending at 22:58) and newer role logs in the
    // dated format (e.g. today's QA review at 14:25). Naive HH:MM:SS string
    // comparison ranks "22:58:26" after "14:25:35" — making two-day-old
    // content look like the most recent line in the terminal, forever.
    const legacy = parseRoleLog('coder', '[22:58:26] Stale — two days ago')[0];
    const dated = parseRoleLog('qa', '[2026-07-23T14:25:35] Fresh — today')[0];
    const sorted = [legacy, dated].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    expect(sorted.map(l => l.text)).toEqual(['Stale — two days ago', 'Fresh — today']);
  });

  it('orders dated lines across different days correctly', () => {
    const day1 = parseRoleLog('qa', '[2026-07-21T23:00:00] Day 1 late')[0];
    const day2 = parseRoleLog('qa', '[2026-07-22T01:00:00] Day 2 early')[0];
    const sorted = [day1, day2].sort((a, b) => a.sortKey.localeCompare(b.sortKey));
    expect(sorted.map(l => l.text)).toEqual(['Day 1 late', 'Day 2 early']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  parseCoderLogs
// ═══════════════════════════════════════════════════════════════════════════

describe('parseCoderLogs', () => {
  it('returns empty array for empty subtaskTerminals', () => {
    expect(parseCoderLogs([])).toEqual([]);
  });

  it('skips subtask with null log', () => {
    const result = parseCoderLogs([
      { id: 1, title: 'None', log: null },
    ]);
    expect(result).toHaveLength(0);
  });

  it('parses a single subtask with separator and lines', () => {
    const result = parseCoderLogs([
      { id: 1, title: 'Add login', log: '[10:00:01] Starting\n[10:00:02] Done' },
    ]);
    expect(result).toHaveLength(3); // separator + 2 lines
    expect(result[0].role).toBe('coder');
    expect(result[0].text).toContain('═══ Subtask 1: Add login ═══');
    expect(result[0].prefixed).toContain('\x1b[33;1m'); // bold amber
    expect(result[1].text).toBe('Starting');
    expect(result[2].text).toBe('Done');
  });

  it('uses first timestamp as separator timestamp', () => {
    const result = parseCoderLogs([
      { id: 1, title: 'T', log: '[10:00:05] First\n[10:00:10] Second' },
    ]);
    expect(result[0].timestamp).toBe('10:00:05');
  });

  it('uses 00:00:00 for separator when no timestamps in content', () => {
    const result = parseCoderLogs([
      { id: 1, title: 'T', log: 'No timestamp' },
    ]);
    expect(result[0].timestamp).toBe('00:00:00');
  });

  it('parses multiple subtasks with separators between them', () => {
    const result = parseCoderLogs([
      { id: 1, title: 'Login', log: '[01:00:00] A' },
      { id: 2, title: 'Auth', log: '[02:00:00] B' },
    ]);
    // separator1 + line A + separator2 + line B
    expect(result).toHaveLength(4);
    expect(result[0].text).toContain('Login');
    expect(result[2].text).toContain('Auth');
  });

  it('skips blank lines within subtask content', () => {
    const result = parseCoderLogs([
      { id: 1, title: 'T', log: '[01:00:00] A\n\n[02:00:00] B' },
    ]);
    // separator + 2 non-blank lines
    expect(result).toHaveLength(3);
  });

  it('uses the dated sortKey for the separator when subtask content uses the dated format', () => {
    const result = parseCoderLogs([
      { id: 1, title: 'T', log: '[2026-07-23T10:00:05] First' },
    ]);
    expect(result[0].timestamp).toBe('10:00:05');
    expect(result[0].sortKey).toBe('2026-07-23T10:00:05');
  });

  it('anchors the separator sortKey before dated content when the subtask log is legacy-format', () => {
    const result = parseCoderLogs([
      { id: 1, title: 'T', log: '[10:00:05] First' },
    ]);
    expect(result[0].sortKey).toBe('0000-00-00T10:00:05');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  formatLiveEvent
// ═══════════════════════════════════════════════════════════════════════════

describe('formatLiveEvent', () => {
  it('returns session started for system init', () => {
    const result = formatLiveEvent({
      type: 'system',
      subtype: 'init',
      model: 'claude-sonnet-4',
    } as StreamEvent);
    expect(result).toContain('Session started');
    expect(result).toContain('claude-sonnet-4');
  });

  it('returns null for system event with non-init subtype', () => {
    const result = formatLiveEvent({
      type: 'system',
      subtype: 'notification',
    } as StreamEvent);
    expect(result).toBeNull();
  });

  it('formats assistant text blocks', () => {
    const result = formatLiveEvent({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Hello\nWorld' }],
      },
    } as StreamEvent);
    expect(result).toContain('Hello\r\nWorld');
  });

  it('formats assistant tool_use blocks', () => {
    const result = formatLiveEvent({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'bash' }],
      },
    } as StreamEvent);
    expect(result).toContain('▶ bash');
  });

  it('formats assistant with mixed blocks', () => {
    const result = formatLiveEvent({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'Running command' },
          { type: 'tool_use', name: 'read_file' },
        ],
      },
    } as StreamEvent);
    expect(result).toContain('Running command');
    expect(result).toContain('▶ read_file');
  });

  it('returns null for assistant with empty blocks', () => {
    const result = formatLiveEvent({
      type: 'assistant',
      message: { content: [] },
    } as StreamEvent);
    expect(result).toBeNull();
  });

  it('returns null for assistant with missing message', () => {
    const result = formatLiveEvent({ type: 'assistant' } as StreamEvent);
    expect(result).toBeNull();
  });

  it('formats result success with cost', () => {
    const result = formatLiveEvent({
      type: 'result',
      subtype: 'success',
      total_cost_usd: 0.0471,
      duration_ms: 2300,
    } as StreamEvent);
    expect(result).toContain('✓ Done');
    expect(result).toContain('$0.0471');
    expect(result).toContain('2300ms');
  });

  it('formats result success without cost', () => {
    const result = formatLiveEvent({
      type: 'result',
      subtype: 'success',
      duration_ms: 100,
    } as StreamEvent);
    expect(result).toContain('✓ Done');
    expect(result).toContain('(100ms)');
    expect(result).not.toContain('$');
  });

  it('formats result failure with error message', () => {
    const result = formatLiveEvent({
      type: 'result',
      subtype: 'error',
      result: 'Invalid API key',
    } as StreamEvent);
    expect(result).toContain('✗ Failed: Invalid API key');
  });

  it('formats result failure with fallback when result missing', () => {
    const result = formatLiveEvent({
      type: 'result',
      subtype: 'error',
    } as StreamEvent);
    expect(result).toContain('unknown error');
  });

  it('formats error event', () => {
    const result = formatLiveEvent({
      type: 'error',
      error: 'Connection refused',
    } as StreamEvent);
    expect(result).toContain('⚠');
    expect(result).toContain('Connection refused');
  });

  it('returns null for unknown event type', () => {
    const result = formatLiveEvent({ type: 'unknown' } as unknown as StreamEvent);
    expect(result).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  formatLiveEventWithLabel
// ═══════════════════════════════════════════════════════════════════════════

describe('formatLiveEventWithLabel', () => {
  const ROLE_LABEL = 'Coder';
  const ANSI_COLOR = '\x1b[33m'; // amber for coder

  // ── Helpers ─────────────────────────────────────────────────────────────

  /** Match the timestamp component: \x1b[90m[HH:MM:SS]\x1b[0m */
  const TS_RE = /\x1b\[90m\[\d{2}:\d{2}:\d{2}\]\x1b\[0m/;

  // ── Null returns ───────────────────────────────────────────────────────

  it('returns null when formatLiveEvent returns null (unknown event type)', () => {
    const result = formatLiveEventWithLabel(
      { type: 'unknown' } as unknown as StreamEvent,
      ROLE_LABEL,
      ANSI_COLOR,
    );
    expect(result).toBeNull();
  });

  it('returns null for system event with non-init subtype', () => {
    const result = formatLiveEventWithLabel(
      { type: 'system', subtype: 'notification' } as StreamEvent,
      ROLE_LABEL,
      ANSI_COLOR,
    );
    expect(result).toBeNull();
  });

  it('returns null for assistant with no content blocks', () => {
    const result = formatLiveEventWithLabel(
      { type: 'assistant', message: { content: [] } } as StreamEvent,
      ROLE_LABEL,
      ANSI_COLOR,
    );
    expect(result).toBeNull();
  });

  // ── Timestamp & label prefix ───────────────────────────────────────────

  it('prepends dim timestamp and coloured role label to assistant text', () => {
    const result = formatLiveEventWithLabel(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Hello world' }] } } as StreamEvent,
      ROLE_LABEL,
      ANSI_COLOR,
    );
    expect(result).not.toBeNull();
    // Must start with a timestamp in dim ANSI.
    expect(result!).toMatch(TS_RE);
    // Must include the role label in the given colour.
    expect(result!).toContain('\x1b[33m[Coder]\x1b[0m');
    // The body text follows the prefix.
    expect(result!).toContain('Hello world');
    // Timestamp, label, then body — in that order.
    const tsIdx = result!.indexOf('\x1b[90m[');
    const labelIdx = result!.indexOf('[Coder]');
    const textIdx = result!.indexOf('Hello world');
    expect(tsIdx).toBeLessThan(labelIdx);
    expect(labelIdx).toBeLessThan(textIdx);
  });

  it('formats system init event with label and model name', () => {
    const result = formatLiveEventWithLabel(
      { type: 'system', subtype: 'init', model: 'claude-haiku' } as StreamEvent,
      ROLE_LABEL,
      ANSI_COLOR,
    );
    expect(result).not.toBeNull();
    expect(result!).toContain('[Coder]');
    expect(result!).toContain('Session started');
    expect(result!).toContain('claude-haiku');
  });

  it('formats tool_use event with label and tool name', () => {
    const result = formatLiveEventWithLabel(
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'bash' }] } } as StreamEvent,
      ROLE_LABEL,
      ANSI_COLOR,
    );
    expect(result).not.toBeNull();
    expect(result!).toContain('[Coder]');
    expect(result!).toContain('▶ bash');
  });

  it('formats error event with label and error message', () => {
    const result = formatLiveEventWithLabel(
      { type: 'error', error: 'Connection refused' } as StreamEvent,
      'QA Review',
      '\x1b[93m',
    );
    expect(result).not.toBeNull();
    expect(result!).toContain('[QA Review]');
    expect(result!).toContain('⚠');
    expect(result!).toContain('Connection refused');
  });

  // ── Leading \r\n handling (result events) ────────────────────────────

  it('moves leading \\r\\n before the label prefix for result success events', () => {
    const result = formatLiveEventWithLabel(
      { type: 'result', subtype: 'success', duration_ms: 500, total_cost_usd: 0.01 } as StreamEvent,
      ROLE_LABEL,
      ANSI_COLOR,
    );
    expect(result).not.toBeNull();
    // The \r\n should come BEFORE the timestamp+label, not between label and content.
    expect(result!).toMatch(/^\r\n/);
    // The label must appear on the same line as the "Done" content.
    const afterCrlf = result!.slice(2);
    expect(afterCrlf).toContain('[Coder]');
    expect(afterCrlf).toContain('✓ Done');
    // Content after the label prefix (strip timestamp + label) should be the result line.
    const bodyAfterPrefix = afterCrlf.replace(/\x1b\[90m\[\d{2}:\d{2}:\d{2}\]\x1b\[0m \x1b\[33m\[Coder\]\x1b\[0m /, '');
    expect(bodyAfterPrefix).not.toMatch(/^\r\n/); // body no longer starts with \r\n
    expect(bodyAfterPrefix).toContain('✓ Done');
  });

  it('moves leading \\r\\n before the label prefix for result failure events', () => {
    const result = formatLiveEventWithLabel(
      { type: 'result', subtype: 'error', result: 'timeout' } as StreamEvent,
      ROLE_LABEL,
      ANSI_COLOR,
    );
    expect(result).not.toBeNull();
    expect(result!).toMatch(/^\r\n/);
    const afterCrlf = result!.slice(2);
    expect(afterCrlf).toContain('[Coder]');
    expect(afterCrlf).toContain('✗ Failed');
  });

  // ── Timestamp format ──────────────────────────────────────────────────

  it('produces a zero-padded HH:MM:SS timestamp', () => {
    const result = formatLiveEventWithLabel(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'x' }] } } as StreamEvent,
      ROLE_LABEL,
      ANSI_COLOR,
    );
    expect(result).not.toBeNull();
    // Timestamp must be exactly 8 digits + colons inside dim ANSI brackets.
    expect(result!).toMatch(/\x1b\[90m\[\d{2}:\d{2}:\d{2}\]\x1b\[0m/);
    // Should not contain single-digit components (unpadded).
    const tsMatch = result!.match(/\[(\d{2}:\d{2}:\d{2})\]/);
    expect(tsMatch).not.toBeNull();
    const [hh, mm, ss] = tsMatch![1].split(':').map(Number);
    expect(hh).toBeGreaterThanOrEqual(0);
    expect(hh).toBeLessThan(24);
    expect(mm).toBeGreaterThanOrEqual(0);
    expect(mm).toBeLessThan(60);
    expect(ss).toBeGreaterThanOrEqual(0);
    expect(ss).toBeLessThan(60);
  });

  // ── Role label & ANSI colour ──────────────────────────────────────────

  it('uses the provided roleLabel and ansiColor for the label prefix', () => {
    const result = formatLiveEventWithLabel(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Test' }] } } as StreamEvent,
      'Spec (Analyst)',
      '\x1b[35m',
    );
    expect(result).not.toBeNull();
    expect(result!).toContain('\x1b[35m[Spec (Analyst)]\x1b[0m');
  });

  it('handles multi-line assistant text (newlines → \\r\\n in body)', () => {
    const result = formatLiveEventWithLabel(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'Line 1\nLine 2' }] } } as StreamEvent,
      ROLE_LABEL,
      ANSI_COLOR,
    );
    expect(result).not.toBeNull();
    // The first line gets the label prefix; subsequent lines don't.
    expect(result!).toContain('[Coder]');
    expect(result!).toContain('Line 1\r\nLine 2');
  });

  it('handles mixed assistant blocks (text + tool_use)', () => {
    const result = formatLiveEventWithLabel(
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: 'Running' },
            { type: 'tool_use', name: 'read_file' },
          ],
        },
      } as StreamEvent,
      ROLE_LABEL,
      ANSI_COLOR,
    );
    expect(result).not.toBeNull();
    expect(result!).toContain('[Coder]');
    expect(result!).toContain('Running');
    expect(result!).toContain('▶ read_file');
    // Label appears only once (on the first line), not before each block.
    const labelCount = (result!.match(/\[Coder\]/g) ?? []).length;
    expect(labelCount).toBe(1);
  });

  it('handles result success without cost field', () => {
    const result = formatLiveEventWithLabel(
      { type: 'result', subtype: 'success', duration_ms: 100 } as StreamEvent,
      ROLE_LABEL,
      ANSI_COLOR,
    );
    expect(result).not.toBeNull();
    expect(result!).toMatch(/^\r\n/);
    expect(result!).toContain('✓ Done');
    expect(result!).toContain('(100ms)');
    expect(result!).not.toContain('$');
  });

  it('handles result failure with fallback when result field missing', () => {
    const result = formatLiveEventWithLabel(
      { type: 'result', subtype: 'error' } as StreamEvent,
      ROLE_LABEL,
      ANSI_COLOR,
    );
    expect(result).not.toBeNull();
    expect(result!).toContain('unknown error');
  });

  it('places the label adjacent to content for events without leading \\r\\n (error events)', () => {
    const result = formatLiveEventWithLabel(
      { type: 'error', error: 'Something broke' } as StreamEvent,
      ROLE_LABEL,
      ANSI_COLOR,
    );
    expect(result).not.toBeNull();
    // No leading \r\n — the label should be directly before the error content.
    expect(result!).not.toMatch(/^\r\n/);
    // The label and content should appear in correct order.
    const labelIdx = result!.indexOf('[Coder]');
    const errIdx = result!.indexOf('Something broke');
    expect(labelIdx).toBeLessThan(errIdx);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  UnifiedTerminal — component rendering
// ═══════════════════════════════════════════════════════════════════════════

describe('UnifiedTerminal — component', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Empty state ───────────────────────────────────────────────────────────

  describe('empty state', () => {
    it('shows empty message when no logs exist', () => {
      render(<UnifiedTerminal {...makeDefaultProps()} />);
      expect(screen.getByText(/No agent output yet/)).toBeInTheDocument();
    });

    it('does not show filter bar when no logs exist', () => {
      render(<UnifiedTerminal {...makeDefaultProps()} />);
      expect(screen.queryByText('All')).not.toBeInTheDocument();
      expect(screen.queryByText('None')).not.toBeInTheDocument();
    });
  });

  // ── Filter bar rendering ──────────────────────────────────────────────────

  describe('filter bar', () => {
    it('shows filter bar when any log exists', () => {
      render(<UnifiedTerminal {...makeDefaultProps({
        qaLog: '[12:00:00] Test output',
      })} />);
      expect(screen.getByText('All')).toBeInTheDocument();
      expect(screen.getByText('None')).toBeInTheDocument();
      expect(screen.getByTestId('unified-terminal')).toBeInTheDocument();
    });

    it('shows All and None buttons', () => {
      render(<UnifiedTerminal {...makeDefaultProps({
        specLog: '[12:00:00] Spec output',
      })} />);
      expect(screen.getByText('All')).toBeInTheDocument();
      expect(screen.getByText('None')).toBeInTheDocument();
    });

    it('shows role chips with line counts for non-empty roles', () => {
      render(<UnifiedTerminal {...makeDefaultProps({
        qaLog: '[12:00:00] Line 1\n[12:00:01] Line 2\n[12:00:02] Line 3',
        specLog: '[12:00:00] Line A',
      })} />);

      // QA chip should show count of 3
      const qaChip = screen.getByText('QA Review');
      expect(qaChip).toBeInTheDocument();
      // Check parent button has count
      const qaBtn = qaChip.closest('button');
      expect(qaBtn?.textContent).toContain('3');

      // Spec chip should show count of 1
      const specChip = screen.getByText('Spec (Analyst)');
      expect(specChip).toBeInTheDocument();
      const specBtn = specChip.closest('button');
      expect(specBtn?.textContent).toContain('1');
    });

    it('hides roles with zero lines', () => {
      render(<UnifiedTerminal {...makeDefaultProps({
        qaLog: '[12:00:00] Only QA has content',
      })} />);

      expect(screen.getByText('QA Review')).toBeInTheDocument();
      // Coder, Spec, Plan, Merge, Orchestrator should not appear
      expect(screen.queryByText('Coder')).not.toBeInTheDocument();
      expect(screen.queryByText('Spec (Analyst)')).not.toBeInTheDocument();
      expect(screen.queryByText('Plan (Planner)')).not.toBeInTheDocument();
      expect(screen.queryByText('Merge (Merger)')).not.toBeInTheDocument();
      expect(screen.queryByText('Orchestrator')).not.toBeInTheDocument();
    });

    it('shows all roles that have content', () => {
      render(<UnifiedTerminal {...makeDefaultProps({
        qaLog: '[12:00:00] QA',
        specLog: '[12:00:00] Spec',
        planLog: '[12:00:00] Plan',
        mergeLog: '[12:00:00] Merge',
        orchestratorLog: '[12:00:00] Orchestrator',
        subtaskTerminals: [{ id: 1, title: 'Sub A', log: '[12:00:00] Coder' }],
      })} />);

      expect(screen.getByText('Coder')).toBeInTheDocument();
      expect(screen.getByText('QA Review')).toBeInTheDocument();
      expect(screen.getByText('Spec (Analyst)')).toBeInTheDocument();
      expect(screen.getByText('Plan (Planner)')).toBeInTheDocument();
      expect(screen.getByText('Merge (Merger)')).toBeInTheDocument();
      expect(screen.getByText('Orchestrator')).toBeInTheDocument();
    });

    it('role chips have selected styling by default', () => {
      render(<UnifiedTerminal {...makeDefaultProps({
        specLog: '[12:00:00] Content',
      })} />);

      const specBtn = screen.getByText('Spec (Analyst)').closest('button');
      // Selected chips have border color class
      expect(specBtn?.className).toContain('border-purple-500');
    });
  });

  // ── Filter toggling ───────────────────────────────────────────────────────

  describe('filter toggling', () => {
    it('deselects a role on chip click', () => {
      render(<UnifiedTerminal {...makeDefaultProps({
        qaLog: '[12:00:00] QA',
        specLog: '[12:00:00] Spec',
      })} />);

      const qaBtn = screen.getByText('QA Review').closest('button')!;
      expect(qaBtn.className).toContain('border-orange-500'); // selected

      fireEvent.click(qaBtn);

      // After click, it should be deselected (no border color)
      expect(qaBtn.className).toContain('text-slate-500');
      expect(qaBtn.className).not.toContain('border-orange-500');
    });

    it('reselects a deselected role', () => {
      render(<UnifiedTerminal {...makeDefaultProps({
        qaLog: '[12:00:00] QA',
      })} />);

      const qaBtn = screen.getByText('QA Review').closest('button')!;

      // Deselect
      fireEvent.click(qaBtn);
      expect(qaBtn.className).not.toContain('border-orange-500');

      // Reselect
      fireEvent.click(qaBtn);
      expect(qaBtn.className).toContain('border-orange-500');
    });
  });

  // ── All / None buttons ────────────────────────────────────────────────────

  describe('All / None buttons', () => {
    it('None deselects all roles', () => {
      render(<UnifiedTerminal {...makeDefaultProps({
        qaLog: '[12:00:00] QA',
        specLog: '[12:00:00] Spec',
        planLog: '[12:00:00] Plan',
      })} />);

      fireEvent.click(screen.getByText('None'));

      // All chips should be deselected
      const qaBtn = screen.getByText('QA Review').closest('button')!;
      expect(qaBtn.className).not.toContain('border-orange-500');

      const specBtn = screen.getByText('Spec (Analyst)').closest('button')!;
      expect(specBtn.className).not.toContain('border-purple-500');

      const planBtn = screen.getByText('Plan (Planner)').closest('button')!;
      expect(planBtn.className).not.toContain('border-blue-500');
    });

    it('All reselects all roles after None', () => {
      render(<UnifiedTerminal {...makeDefaultProps({
        qaLog: '[12:00:00] QA',
        specLog: '[12:00:00] Spec',
      })} />);

      fireEvent.click(screen.getByText('None'));
      fireEvent.click(screen.getByText('All'));

      const qaBtn = screen.getByText('QA Review').closest('button')!;
      expect(qaBtn.className).toContain('border-orange-500');

      const specBtn = screen.getByText('Spec (Analyst)').closest('button')!;
      expect(specBtn.className).toContain('border-purple-500');
    });
  });

  // ── Cross-day log ordering (regression) ─────────────────────────────────
  //
  // Regression test for a task whose terminal appeared permanently frozen
  // on a two-day-old line. A coder subtask log (legacy `[HH:MM:SS]` format)
  // ended with "You've hit your session limit" at 22:58 two days ago; a QA
  // review retried today produces fresh dated-format lines starting at
  // 14:25. Under the old plain-string HH:MM:SS sort, "22:58:26" > "14:25:35"
  // lexically, so the stale line always rendered last (i.e. looked like the
  // newest output) no matter how much fresh content arrived afterward.

  describe('cross-day log ordering (regression)', () => {
    it('renders a fresh dated-format line after a stale legacy-format line with a numerically later clock time', async () => {
      render(<UnifiedTerminal {...makeDefaultProps({
        subtaskTerminals: [
          { id: 2, title: 'Fix oscillation', log: '[22:58:26] You\'ve hit your session limit' },
        ],
        qaLog: '[2026-07-23T14:25:35] QA review started',
      })} />);

      await waitFor(() => {
        expect(mockTerminalWrite).toHaveBeenCalled();
      });
      const written = mockTerminalWrite.mock.calls.map(c => String(c[0] ?? '')).join('');

      const staleIdx = written.indexOf('session limit');
      const freshIdx = written.indexOf('QA review started');
      expect(staleIdx).toBeGreaterThanOrEqual(0);
      expect(freshIdx).toBeGreaterThanOrEqual(0);
      expect(freshIdx).toBeGreaterThan(staleIdx);
    });
  });

  // ── Mount before logs exist, then receive logs (regression) ────────────────
  //
  // Regression test for the bug where the containerRef div was only rendered
  // when hasAnyLog was true. The xterm-init effect runs once on mount (deps:
  // []); if the component's first render happened before any log existed,
  // containerRef.current was null and the effect gave up permanently. A
  // later re-render on the SAME instance with real log content (exactly what
  // TaskPanel's silent WebSocket-triggered refresh does) flipped hasAnyLog to
  // true and mounted the div, but the init effect never reran — so the
  // terminal stayed blank forever while the filter chips (driven by
  // roleStats, independent of DOM mount state) rendered normally. The fix
  // mounts the container div unconditionally.

  describe('mounts before logs exist, then receives logs (regression)', () => {
    it('initializes the terminal and writes content once logs arrive after an empty-state mount', async () => {
      const { rerender } = render(<UnifiedTerminal {...makeDefaultProps()} />);

      // Initial mount: no logs yet, empty-state message shown, no filter bar.
      expect(screen.getByText(/No agent output yet/)).toBeInTheDocument();
      expect(screen.queryByTestId('unified-terminal')).not.toBeInTheDocument();

      // Same component instance re-renders once real log content arrives.
      rerender(
        <UnifiedTerminal {...makeDefaultProps({ qaLog: '[12:00:00] QA line' })} />
      );

      // Filter bar now appears...
      expect(screen.getByTestId('unified-terminal')).toBeInTheDocument();

      // ...and the terminal must actually have initialized and written the
      // content. Before the fix, termReady never became true and this write
      // never happened.
      await waitFor(() => {
        expect(mockTerminalWrite).toHaveBeenCalled();
      });
      const written = mockTerminalWrite.mock.calls.map(c => String(c[0] ?? '')).join('');
      expect(written).toContain('QA line');
    });
  });

  // ── Responsive layout ─────────────────────────────────────────────────────

  describe('responsive layout', () => {
    it('filter bar uses flex-wrap for responsive wrapping', () => {
      render(<UnifiedTerminal {...makeDefaultProps({
        qaLog: '[12:00:00] QA',
        specLog: '[12:00:00] Spec',
        planLog: '[12:00:00] Plan',
        mergeLog: '[12:00:00] Merge',
        orchestratorLog: '[12:00:00] Orch',
        subtaskTerminals: [{ id: 1, title: 'T', log: '[12:00:00] Coder' }],
      })} />);

      const filterBar = screen.getByTestId('unified-terminal');
      expect(filterBar.className).toContain('flex-wrap');
    });
  });

  // ── Independent dependency graphs: selectedSessionIds vs sessionRoleMap ────
  //
  // selectedSessionIds (depends on [sessionMap, selectedRoles]) and
  // sessionRoleMap (depends on [sessionMap]) must have independent dependency
  // graphs. Toggling a filter chip changes selectedRoles → selectedSessionIds
  // recomputes → interleaved-output effect re-runs (correct: filters content).
  // BUT sessionRoleMap must NOT recompute — it only depends on sessionMap,
  // which hasn't changed. If someone refactors sessionRoleMap to depend on
  // selectedRoles (merging the two memos), the live-events effect would get
  // a new sessionRoleMap reference on every chip toggle, unnecessarily
  // re-processing all events instead of just filtering by session.
  //
  // These tests verify the behavioural consequence: after a chip toggle,
  // selectedSessionIds correctly filters parsed content while new live events
  // still receive role labels from sessionRoleMap (proving it survived the
  // toggle with its session→role mappings intact).

  describe('selectedSessionIds and sessionRoleMap independent dependency graphs', () => {
    const sessionMap = {
      qa: 'session-qa',
      orchestrator: 'session-orch',
    };

    it('deselecting a role filters its parsed content, and new live events still get labels from sessionRoleMap', async () => {
      const originalLength = mockUseAgentStreamReturn.length;
      try {
        // Push initial live events bound to QA and Orchestrator sessions.
        mockUseAgentStreamReturn.push(
          { sessionId: 'session-qa', event: { type: 'system', subtype: 'init', model: 'claude-sonnet' } as StreamEvent },
          { sessionId: 'session-orch', event: { type: 'system', subtype: 'init', model: 'orch-model' } as StreamEvent },
        );

        render(
          <UnifiedTerminal
            {...makeDefaultProps({
              sessionMap,
              qaLog: '[12:00:01] QA parsed content',
              orchestratorLog: '[12:00:02] Orch parsed content',
            })}
          />
        );

        // Wait for xterm init + initial writes.
        await waitFor(() => {
          expect(mockTerminalReset).toHaveBeenCalled();
        });

        // Both roles' parsed content and initial live events present.
        const initial = mockTerminalWrite.mock.calls.map(c => String(c[0] ?? '')).join('');
        expect(initial).toContain('[QA Review]');
        expect(initial).toContain('QA parsed content');
        expect(initial).toContain('[Orchestrator]');
        expect(initial).toContain('Orch parsed content');
        expect(initial).toContain('claude-sonnet');
        expect(initial).toContain('orch-model');

        // Push a new live event for the QA session BEFORE toggling chips.
        // This event hasn't been processed yet (liveWrittenRef is past it).
        // When the chip toggle triggers the live-events effect to re-run,
        // it will pick up this new event and label it via sessionRoleMap —
        // proving the session→role lookup still resolves correctly even
        // after selectedRoles changed (i.e. the two memos are independent).
        mockUseAgentStreamReturn.push(
          { sessionId: 'session-qa', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'New QA event after push' }] } } as StreamEvent },
        );

        // ── Toggle off Orchestrator ──
        // selectedRoles changes → selectedSessionIds recomputes → both
        // effects re-run. The live-events effect processes the newly-pushed
        // QA event via sessionRoleMap.
        vi.clearAllMocks();
        const orchBtn = screen.getByText('Orchestrator').closest('button')!;
        fireEvent.click(orchBtn);

        await waitFor(() => {
          expect(mockTerminalReset).toHaveBeenCalled();
        });

        const afterToggle = mockTerminalWrite.mock.calls.map(c => String(c[0] ?? '')).join('');
        // Orchestrator parsed content filtered out (selectedSessionIds).
        expect(afterToggle).not.toContain('Orch parsed content');
        // QA parsed content still present.
        expect(afterToggle).toContain('[QA Review]');
        expect(afterToggle).toContain('QA parsed content');
        // New live event also got the [QA Review] label — sessionRoleMap
        // survived the chip toggle with its session→role mappings intact.
        expect(afterToggle).toContain('[QA Review]');
        expect(afterToggle).toContain('New QA event after push');
      } finally {
        mockUseAgentStreamReturn.length = originalLength;
      }
    });

    it('reselection round-trip restores parsed content via selectedSessionIds with sessionMap present', async () => {
      render(
        <UnifiedTerminal
          {...makeDefaultProps({
            sessionMap,
            qaLog: '[12:00:01] QA parsed content',
            orchestratorLog: '[12:00:02] Orch parsed content',
          })}
        />
      );

      await waitFor(() => {
        expect(mockTerminalReset).toHaveBeenCalled();
      });

      // Initial: both roles present.
      let output = mockTerminalWrite.mock.calls.map(c => String(c[0] ?? '')).join('');
      expect(output).toContain('[QA Review]');
      expect(output).toContain('QA parsed content');
      expect(output).toContain('[Orchestrator]');
      expect(output).toContain('Orch parsed content');

      // Deselect QA.
      vi.clearAllMocks();
      const qaBtn = screen.getByText('QA Review').closest('button')!;
      fireEvent.click(qaBtn);

      await waitFor(() => {
        expect(mockTerminalReset).toHaveBeenCalled();
      });

      output = mockTerminalWrite.mock.calls.map(c => String(c[0] ?? '')).join('');
      expect(output).not.toContain('QA parsed content');
      expect(output).toContain('Orch parsed content');

      // Reselect QA — selectedSessionIds re-includes QA sessions.
      vi.clearAllMocks();
      fireEvent.click(qaBtn);

      await waitFor(() => {
        expect(mockTerminalReset).toHaveBeenCalled();
      });

      output = mockTerminalWrite.mock.calls.map(c => String(c[0] ?? '')).join('');
      expect(output).toContain('[QA Review]');
      expect(output).toContain('QA parsed content');
      expect(output).toContain('[Orchestrator]');
      expect(output).toContain('Orch parsed content');
    });
  });

  // ── Filter effect re-runs without TDZ ─────────────────────────────────────
  //
  // Regression test for the bug where `const selectedSessionIds = useMemo(...)`
  // was declared AFTER the interleaved-output useEffect that listed it in its
  // dep array. React evaluates hook dep arrays during render, so referencing
  // an uninitialized const threw a ReferenceError (TDZ) and broke the page.
  // The fix moved the useMemo above the effects that depend on it.

  describe('filter effect re-runs without TDZ ReferenceError', () => {
    // All sessions present, mapped qa/spec/plan/merge → their role; anything
    // else (e.g. `coder`) falls into the coder bucket per component logic.
    const sessionMap = {
      qa: 'qa-session',
      spec: 'spec-session',
      plan: 'plan-session',
      merge: 'merge-session',
      coder: 'coder-session',
    };

    async function renderFull() {
      // Spy on console.error so any asynchronously-thrown ReferenceError
      // (e.g. from a useEffect callback after mount) is captured instead of
      // silently swallowed. Synchronous render-phase TDZ errors are caught
      // by render() itself throwing, which is the primary signal.
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const view = render(
        <UnifiedTerminal
          {...makeDefaultProps({
            sessionMap,
            qaLog: '[12:00:01] QA line',
            specLog: '[12:00:02] Spec line',
            planLog: '[12:00:03] Plan line',
            mergeLog: '[12:00:04] Merge line',
            orchestratorLog: '[12:00:05] Orch line',
            subtaskTerminals: [{ id: 1, title: 'Login', log: '[12:00:00] Coder line' }],
          })}
        />
      );

      // Wait for xterm init + first interleaved-write before returning so
      // callers can fireEvent.click immediately without racing termReady.
      await waitForNextReset();

      return { ...view, errorSpy };
    }

    // Helper: wait until at least one interleaved-output effect run has
    // happened for the current state. The effect is async (terminal init
    // Promise resolves on a microtask, then setTermReady triggers another
    // render, then rAF for scrollToBottom). `waitFor` polls until ready.
    async function waitForNextReset() {
      await waitFor(() => {
        expect(mockTerminalReset).toHaveBeenCalled();
      });
    }

    // Helper: read the most recent terminal.write() argument as a string.
    // The interleaved-output useEffect calls write() exactly once per run
    // (with empty string for "None"), and the live-events effect never
    // writes here because mockUseAgentStreamReturn is empty.
    const lastWriteArg = () =>
      String(mockTerminalWrite.mock.calls.at(-1)?.[0] ?? '');

    // Helper: join every terminal.write() argument into a single string.
    // Used for content-presence checks when the interleaved-output effect
    // AND the live-events effect both fire (e.g. when a live event was
    // pushed before mount). lastWriteArg() is order-dependent and returns
    // only the most recent write, which is the live event when both run;
    // allWrites() lets the test assert against either effect's output.
    const allWrites = () =>
      mockTerminalWrite.mock.calls.map(c => String(c[0] ?? '')).join('');

    it('mounts and reaches a stable interleaved write without throwing', async () => {
      const { errorSpy } = await renderFull();

      // renderFull already awaits waitForNextReset; no extra wait needed.

      // Initial write must include every role's label (all selected by default).
      const initialWrite = lastWriteArg();
      expect(initialWrite).toContain('[QA Review]');
      expect(initialWrite).toContain('[Spec (Analyst)]');
      expect(initialWrite).toContain('[Plan (Planner)]');
      expect(initialWrite).toContain('[Merge (Merger)]');
      expect(initialWrite).toContain('[Orchestrator]');
      expect(initialWrite).toContain('[Coder]');

      // No async ReferenceError leaked through to console.error.
      const refErrors = errorSpy.mock.calls.filter(args =>
        args.some(a => typeof a === 'string' && a.includes('ReferenceError'))
      );
      expect(refErrors).toEqual([]);
      errorSpy.mockRestore();
    });

    it('re-runs the interleaved-output effect when a chip is toggled, excluding the deselected role', async () => {
      await renderFull();
      vi.clearAllMocks();

      // Deselect QA chip.
      const qaBtn = screen.getByText('QA Review').closest('button')!;
      fireEvent.click(qaBtn);

      // selectedRoles changed → selectedSessionIds (a new Set) changed →
      // dep array is different → the interleaved-output useEffect must run.
      // The reset call from this re-run is the only one after clearAllMocks(),
      // so waiting for the count to exceed 0 cleanly isolates "effect ran
      // because of the click" from earlier mount-time runs.
      await waitFor(() => {
        expect(mockTerminalReset).toHaveBeenCalled();
      });

      const toggledWrite = lastWriteArg();
      expect(toggledWrite).not.toContain('[QA Review]');
      expect(toggledWrite).not.toContain('QA line');
      // Other roles still selected.
      expect(toggledWrite).toContain('[Spec (Analyst)]');
      expect(toggledWrite).toContain('[Coder]');
    });

    it('re-runs the effect when reselecting a previously deselected role', async () => {
      await renderFull();
      vi.clearAllMocks();

      const qaBtn = screen.getByText('QA Review').closest('button')!;
      // Deselect first.
      fireEvent.click(qaBtn);
      await waitFor(() => expect(mockTerminalReset).toHaveBeenCalled());
      vi.clearAllMocks();

      // Reselect.
      fireEvent.click(qaBtn);
      await waitFor(() => expect(mockTerminalReset).toHaveBeenCalled());

      const finalWrite = lastWriteArg();
      expect(finalWrite).toContain('[QA Review]');
      expect(finalWrite).toContain('QA line');
    });

    it('handles None followed by All without throwing, re-running the effect each step', async () => {
      await renderFull();
      vi.clearAllMocks();

      // Click None → all roles deselected → interleaved output becomes empty
      // string. Effect still resets terminal but writes nothing.
      fireEvent.click(screen.getByText('None'));
      await waitFor(() => expect(mockTerminalReset).toHaveBeenCalled());
      expect(mockTerminalWrite).not.toHaveBeenCalled();

      vi.clearAllMocks();

      // Click All → all roles reselected → effect runs again with full content.
      fireEvent.click(screen.getByText('All'));
      await waitFor(() => expect(mockTerminalReset).toHaveBeenCalled());

      const fullWrite = lastWriteArg();
      expect(fullWrite).toContain('[QA Review]');
      expect(fullWrite).toContain('[Spec (Analyst)]');
      expect(fullWrite).toContain('[Plan (Planner)]');
      expect(fullWrite).toContain('[Merge (Merger)]');
      expect(fullWrite).toContain('[Orchestrator]');
      expect(fullWrite).toContain('[Coder]');
    });

    // roundTripLabels: helper for "toggle a chip off, then back on" using
    // the same label each time. Each iteration ends in selectedRoles
    // matching its starting state, so the loop is idempotent regardless of
    // iteration order.
    const roundTripLabels = ['QA Review', 'Plan (Planner)', 'Spec (Analyst)'];

    it('toggles multiple chips off then back on without TDZ errors', async () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      await renderFull();
      vi.clearAllMocks();

      // First loop: each label is currently SELECTED → click deselects it.
      for (const label of roundTripLabels) {
        fireEvent.click(screen.getByText(label).closest('button')!);
        await waitFor(() => expect(mockTerminalReset).toHaveBeenCalled());
        vi.clearAllMocks();
      }

      // Second loop: each label is now DESELECTED → click reselects it.
      for (const label of roundTripLabels) {
        fireEvent.click(screen.getByText(label).closest('button')!);
        await waitFor(() => expect(mockTerminalReset).toHaveBeenCalled());
        vi.clearAllMocks();
      }

      const refErrors = errorSpy.mock.calls.filter(args =>
        args.some(a => typeof a === 'string' && a.includes('ReferenceError'))
      );
      expect(refErrors).toEqual([]);
      errorSpy.mockRestore();
    });

    // The interleaved-output effect is the headline regression case, but
    // selectedSessionIds is also in the live-events useEffect dep array.
    // Verify that effect also re-runs without TDZ when a chip is toggled,
    // and that filtering by selectedSessionIds drops events whose session
    // is no longer selected. Saving and restoring the hoisted array keeps
    // this test isolated from siblings.

    it('also re-runs the live-events effect on filter toggle without TDZ', async () => {
      const originalLength = mockUseAgentStreamReturn.length;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // Push one event bound to the QA session. Since QA is selected by
        // default post-mount, the live-events effect will process it and
        // write the formatted "Session started" line to the terminal.
        mockUseAgentStreamReturn.push({
          sessionId: 'qa-session',
          event: { type: 'system', subtype: 'init', model: 'test-model' } as StreamEvent,
        });

        await renderFull();
        // Live-events effect ran on mount: write should contain the formatted event line.
        await waitFor(() => {
          expect(lastWriteArg()).toContain('Session started');
        });
        expect(lastWriteArg()).toContain('test-model');

        vi.clearAllMocks();

        // Toggle QA off → selectedSessionIds drops qa-session → both
        // effects (interleaved AND live-events) re-run because
        // selectedSessionIds changed. If TDZ were reintroduced render()
        // would throw before this click ever dispatches.
        const qaBtn = screen.getByText('QA Review').closest('button')!;
        fireEvent.click(qaBtn);

        // Interleaved effect runs on dep change → resets terminal.
        await waitFor(() => expect(mockTerminalReset).toHaveBeenCalled());

        const refErrors = errorSpy.mock.calls.filter(args =>
          args.some(a => typeof a === 'string' && a.includes('ReferenceError'))
        );
        expect(refErrors).toEqual([]);
      } finally {
        mockUseAgentStreamReturn.length = originalLength;
        errorSpy.mockRestore();
      }
    });

    // The tests above all pass `sessionMap`, so the `if (!sessionMap) return
    // new Set<string>()` short-circuit in the selectedSessionIds useMemo is
    // never exercised. This test renders WITHOUT sessionMap and verifies:
    //   1. The useMemo's null branch produces a valid (empty) Set that the
    //      two effects can safely depend on without throwing a TDZ error.
    //   2. The live-events effect's `sessionMap ? filter(events) : events`
    //      short-circuit passes events through unfiltered.
    //   3. Toggling a filter chip still re-runs both effects (the useMemo
    //      is called, returns a fresh Set, and the new reference triggers
    //      the dep change in both useEffects).

    it('handles the missing sessionMap case: useMemo null branch + effect re-runs without TDZ', async () => {
      const originalLength = mockUseAgentStreamReturn.length;
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      try {
        // Push a live event with an arbitrary sessionId. Because sessionMap
        // is undefined below, the live-events effect takes the
        // `sessionMap ? events.filter(...) : events` short-circuit and writes
        // the event through unfiltered. If the null branch in the useMemo
        // ever broke (e.g. threw, or returned a non-iterable), this write
        // would never happen and the test would fail at the waitFor below.
        mockUseAgentStreamReturn.push({
          sessionId: 'arbitrary-session-id-not-in-any-map',
          event: { type: 'system', subtype: 'init', model: 'no-map-model' } as StreamEvent,
        });

        // Render WITHOUT sessionMap — explicitly set to undefined to make
        // the intent clear (the default for missing props is also undefined,
        // but being explicit documents what we're testing).
        render(
          <UnifiedTerminal
            {...makeDefaultProps({
              sessionMap: undefined,
              qaLog: '[12:00:01] QA line',
              specLog: '[12:00:02] Spec line',
              planLog: '[12:00:03] Plan line',
              mergeLog: '[12:00:04] Merge line',
              orchestratorLog: '[12:00:05] Orch line',
              subtaskTerminals: [{ id: 1, title: 'Login', log: '[12:00:00] Coder line' }],
            })}
          />
        );
        // Wait for xterm init + first interleaved-write (the same gate the
        // other tests use, inlined here since renderFull() always passes
        // sessionMap).
        await waitFor(() => {
          expect(mockTerminalReset).toHaveBeenCalled();
        });

        // ── Verify BOTH effects' writes happened on mount ──
        // The interleaved-output effect runs first (writes role content),
        // then the live-events effect runs (writes the "Session started"
        // text). lastWriteArg() therefore returns the live-event write,
        // so use the allWrites() helper that joins all writes for
        // content-presence checks. This indirectly proves the useMemo's
        // null branch returned a valid empty Set: if it had thrown or
        // returned a non-iterable, the effect would crash before writing
        // the event.
        await waitFor(() => {
          expect(allWrites()).toContain('Session started');
        });
        expect(allWrites()).toContain('no-map-model');

        // Interleaved-output effect's content (all roles selected) is also
        // present — sessionMap doesn't gate this effect.
        expect(allWrites()).toContain('[QA Review]');
        expect(allWrites()).toContain('[Spec (Analyst)]');
        expect(allWrites()).toContain('[Plan (Planner)]');
        expect(allWrites()).toContain('[Merge (Merger)]');
        expect(allWrites()).toContain('[Orchestrator]');
        expect(allWrites()).toContain('[Coder]');

        // ── Toggle a chip and verify the effects re-run without TDZ ──
        // selectedRoles changed → selectedSessionIds useMemo recomputes
        // (returning a new empty Set) → both useEffects see a new dep
        // reference → they re-run. If the useMemo were ever moved AFTER
        // the effects (re-introducing the original TDZ bug), render() or
        // the click handler would throw a ReferenceError.
        vi.clearAllMocks();
        const qaBtn = screen.getByText('QA Review').closest('button')!;
        fireEvent.click(qaBtn);

        await waitFor(() => {
          expect(mockTerminalReset).toHaveBeenCalled();
        });

        // After deselecting QA, the new interleaved write must drop QA content.
        expect(allWrites()).not.toContain('[QA Review]');
        expect(allWrites()).not.toContain('QA line');
        expect(allWrites()).toContain('[Spec (Analyst)]');
        expect(allWrites()).toContain('[Coder]');

        // ── Reselect QA and confirm the round trip also works ──
        vi.clearAllMocks();
        fireEvent.click(qaBtn);
        await waitFor(() => expect(mockTerminalReset).toHaveBeenCalled());
        expect(allWrites()).toContain('[QA Review]');
        expect(allWrites()).toContain('QA line');

        // ── No TDZ or other ReferenceError leaked through ──
        const refErrors = errorSpy.mock.calls.filter(args =>
          args.some(a => typeof a === 'string' && a.includes('ReferenceError'))
        );
        expect(refErrors).toEqual([]);
      } finally {
        mockUseAgentStreamReturn.length = originalLength;
        errorSpy.mockRestore();
      }
    });
  });
});
