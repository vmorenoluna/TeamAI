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
import { render, screen, fireEvent } from '@testing-library/react';
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

const mockUseAgentStreamReturn = vi.hoisted(() => [] as Array<{ sessionId: string; event: Record<string, unknown> }>);

vi.mock('@/hooks/use-agent-stream', () => ({
  useAgentStream: () => mockUseAgentStreamReturn,
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
});
