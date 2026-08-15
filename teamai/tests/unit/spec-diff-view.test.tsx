// @vitest-environment happy-dom

/**
 * Unit tests for SpecDiffView component and computeLineDiff/mergeHunks utilities.
 *
 * Tests the side-by-side spec version comparer: selectors, diff engine correctness,
 * edge cases (empty text, identical text, large inputs), and auto-initialization.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { SpecDiffView, computeLineDiff } from '@/components/spec-diff-view';

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderComponent(overrides: {
  spec?: string;
  specVersions?: Record<string, string>;
  leftVersion?: string | null;
  rightVersion?: string | null;
  onSetLeft?: (v: string | null) => void;
  onSetRight?: (v: string | null) => void;
} = {}) {
  const {
    spec = 'Current spec content.',
    specVersions = {},
    leftVersion = null,
    rightVersion = null,
    onSetLeft = vi.fn(),
    onSetRight = vi.fn(),
  } = overrides;

  render(
    <SpecDiffView
      spec={spec}
      specVersions={specVersions}
      leftVersion={leftVersion}
      rightVersion={rightVersion}
      onSetLeft={onSetLeft}
      onSetRight={onSetRight}
    />
  );

  return { onSetLeft, onSetRight };
}

// ── computeLineDiff tests ───────────────────────────────────────────────────

describe('computeLineDiff', () => {
  // ── Identical text ────────────────────────────────────────────────────

  describe('identical text', () => {
    it('returns all unchanged lines for identical text', () => {
      const hunks = computeLineDiff('a\nb\nc', 'a\nb\nc');

      const allLeft = hunks.flatMap(h => h.left);
      const allRight = hunks.flatMap(h => h.right);
      expect(allLeft.every(l => l.type === 'unchanged')).toBe(true);
      expect(allRight.every(l => l.type === 'unchanged')).toBe(true);
      expect(allLeft.map(l => l.line)).toEqual(['a', 'b', 'c']);
    });
  });

  // ── Added lines ───────────────────────────────────────────────────────

  describe('added lines', () => {
    it('detects added lines in new text', () => {
      const hunks = computeLineDiff('a\nb', 'a\nb\nc');

      const allRight = hunks.flatMap(h => h.right);
      const addedLines = allRight.filter(l => l.type === 'added');
      expect(addedLines.length).toBe(1);
      expect(addedLines[0].line).toBe('c');
    });

    it('marks added lines with type "added"', () => {
      const hunks = computeLineDiff('hello', 'hello\nworld');

      const allRight = hunks.flatMap(h => h.right);
      const added = allRight.find(l => l.line === 'world');
      expect(added).toBeDefined();
      expect(added!.type).toBe('added');
    });
  });

  // ── Removed lines ─────────────────────────────────────────────────────

  describe('removed lines', () => {
    it('detects removed lines from old text', () => {
      const hunks = computeLineDiff('a\nb\nc', 'a\nc');

      const allLeft = hunks.flatMap(h => h.left);
      const removed = allLeft.filter(l => l.type === 'removed');
      expect(removed.length).toBe(1);
      expect(removed[0].line).toBe('b');
    });

    it('marks removed lines with type "removed"', () => {
      const hunks = computeLineDiff('foo\nbar\nbaz', 'foo\nbaz');

      const allLeft = hunks.flatMap(h => h.left);
      const removed = allLeft.find(l => l.line === 'bar');
      expect(removed).toBeDefined();
      expect(removed!.type).toBe('removed');
    });
  });

  // ── Mixed changes ─────────────────────────────────────────────────────

  describe('mixed changes', () => {
    it('handles both added and removed lines in the same diff', () => {
      const hunks = computeLineDiff('a\nb\nc', 'a\nx\nc');

      const allLeft = hunks.flatMap(h => h.left);
      const allRight = hunks.flatMap(h => h.right);

      const removed = allLeft.find(l => l.type === 'removed' && l.line === 'b');
      const added = allRight.find(l => l.type === 'added' && l.line === 'x');

      expect(removed).toBeDefined();
      expect(added).toBeDefined();
    });
  });

  // ── Empty inputs ──────────────────────────────────────────────────────

  describe('empty inputs', () => {
    it('returns a single unchanged empty line for two empty strings', () => {
      // ''.split('\n') => [''] so the diff compares one empty line vs one empty line
      const hunks = computeLineDiff('', '');
      const allLeft = hunks.flatMap(h => h.left);
      expect(allLeft.length).toBe(1);
      expect(allLeft[0].type).toBe('unchanged');
      expect(allLeft[0].line).toBe('');
    });

    it('treats all lines as added when old text is empty', () => {
      // ''.split('\n') => [''] so we get one empty old line, then 'a','b','c' as new.
      // The diff produces 4 added lines: 3 real + 1 empty placeholder from the empty old line.
      const hunks = computeLineDiff('', 'a\nb\nc');

      const allRight = hunks.flatMap(h => h.right);
      const addedLines = allRight.filter(l => l.type === 'added');
      // 3 real lines (a, b, c) + 1 empty placeholder = 4 added total
      expect(addedLines.length).toBe(4);
      const rightLines = allRight.map(l => l.line);
      expect(rightLines).toContain('a');
      expect(rightLines).toContain('b');
      expect(rightLines).toContain('c');
    });

    it('treats all lines as removed when new text is empty', () => {
      // '\n'.split('\n') => [''] so we get one empty new line alongside 3 old lines.
      // The diff produces 4 removed lines: 3 real + 1 empty placeholder from the empty new line.
      const hunks = computeLineDiff('a\nb\nc', '');

      const allLeft = hunks.flatMap(h => h.left);
      const removedLines = allLeft.filter(l => l.type === 'removed');
      expect(removedLines.length).toBe(4);
      const leftLines = allLeft.map(l => l.line);
      expect(leftLines).toContain('a');
      expect(leftLines).toContain('b');
      expect(leftLines).toContain('c');
    });
  });

  // ── Large inputs ──────────────────────────────────────────────────────

  describe('large inputs', () => {
    it('handles 100 lines of identical text', () => {
      const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
      const hunks = computeLineDiff(lines, lines);

      const allLeft = hunks.flatMap(h => h.left);
      expect(allLeft.every(l => l.type === 'unchanged')).toBe(true);
    });

    it('handles text with special characters', () => {
      const hunks = computeLineDiff(
        '<div class="foo">\n  {value}\n</div>',
        '<div class="bar">\n  {value}\n</div>'
      );

      const allLeft = hunks.flatMap(h => h.left);
      const allRight = hunks.flatMap(h => h.right);

      const removed = allLeft.find(l => l.line === '<div class="foo">');
      const added = allRight.find(l => l.line === '<div class="bar">');
      expect(removed).toBeDefined();
      expect(added).toBeDefined();
    });
  });

  // ── Line numbers ──────────────────────────────────────────────────────

  describe('line numbers', () => {
    it('assigns correct line numbers to lines', () => {
      const hunks = computeLineDiff('a\nb\nc', 'a\nc\nc2');

      const allLeft = hunks.flatMap(h => h.left);
      const firstUnchanged = allLeft.find(l => l.type === 'unchanged' && l.line === 'a');
      expect(firstUnchanged?.lineNum).toBe(1);
    });
  });
});

// ── SpecDiffView component tests ────────────────────────────────────────────

describe('SpecDiffView', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Selector rendering ────────────────────────────────────────────────

  describe('selector rendering', () => {
    it('renders left and right version selectors', () => {
      renderComponent({
        spec: 'spec content',
        specVersions: {
          v1: 'spec v1 content',
          v2: 'spec v2 content',
        },
      });

      expect(screen.getByTestId('compare-left-select')).toBeInTheDocument();
      expect(screen.getByTestId('compare-right-select')).toBeInTheDocument();
    });

    it('renders "vs" label between selectors', () => {
      renderComponent({
        spec: 'spec',
        specVersions: { v1: 'v1 content' },
      });

      expect(screen.getByText('vs')).toBeInTheDocument();
    });

    it('shows "left" and "right" labels', () => {
      renderComponent({
        spec: 'spec',
        specVersions: { v1: 'v1' },
      });

      expect(screen.getByText('left')).toBeInTheDocument();
      expect(screen.getByText('right')).toBeInTheDocument();
    });

    it('labels the live spec option with its version number, not "current"', () => {
      renderComponent({
        spec: 'latest spec',
        specVersions: { v1: 'v1 content', v2: 'v2 content' },
      });

      const leftSelect = screen.getByTestId('compare-left-select') as HTMLSelectElement;
      const liveOption = Array.from(leftSelect.options).find(o => o.value === 'current');
      expect(liveOption).toBeDefined();
      expect(liveOption?.textContent).toBe('v2 (left)');
    });

    it('shows the live spec version number in column headers', () => {
      renderComponent({
        spec: 'latest spec',
        specVersions: { v1: 'v1 content', v2: 'v2 content' },
        leftVersion: 'current',
        rightVersion: 'v1',
      });

      const headers = document.querySelectorAll('.sticky');
      const headerTexts = Array.from(headers).map(h => h.textContent?.trim());
      // Live spec is v2 (same as the latest snapshot), the right snapshot is v1.
      expect(headerTexts).toContain('v2');
      expect(headerTexts).toContain('v1');
    });
  });

  // ── Diff display ──────────────────────────────────────────────────────

  describe('diff display', () => {
    it('shows unchanged lines with "  " (two spaces) prefix', () => {
      // For identical content, each unchanged line renders with "  " prefix
      renderComponent({
        spec: 'Hello World',
        specVersions: { v1: 'Hello World' },
        leftVersion: 'current',
        rightVersion: 'v1',
      });

      // The left cell (data-component="diff-left-0") contains the unchanged line
      const leftCell = screen.getByTestId('diff-left-0');
      // Its text content is "  Hello World" (two spaces prefix)
      expect(leftCell.textContent).toMatch(/Hello World/);
      // The unchanged line div inside has class text-slate-400
      const lineDiv = leftCell.querySelector('.text-slate-400');
      expect(lineDiv).toBeInTheDocument();
      expect(lineDiv!.textContent).toBe('  Hello World');
    });

    it('shows added lines with + prefix', () => {
      renderComponent({
        spec: 'Hello World\nAdded line',
        specVersions: { v1: 'Hello World' },
        leftVersion: 'v1',
        rightVersion: 'current',
      });

      expect(screen.getByText('+ Added line')).toBeInTheDocument();
    });

    it('shows removed lines with - prefix and line-through', () => {
      renderComponent({
        spec: 'Hello World',
        specVersions: { v1: 'Hello World\nRemoved line' },
        leftVersion: 'v1',
        rightVersion: 'current',
      });

      expect(screen.getByText('- Removed line')).toBeInTheDocument();
    });

    it('renders column headers with sticky positioning', () => {
      renderComponent({
        spec: 'current spec',
        specVersions: { v1: 'v1 spec' },
        leftVersion: 'v1',
        rightVersion: 'current',
      });

      const headers = document.querySelectorAll('.sticky');
      expect(headers.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Version selectors ─────────────────────────────────────────────────

  describe('version selectors', () => {
    it('renders options for each version', () => {
      renderComponent({
        spec: 'current',
        specVersions: { v1: 'v1', v2: 'v2' },
      });

      const leftSelect = screen.getByTestId('compare-left-select') as HTMLSelectElement;
      const options = Array.from(leftSelect.options).map(o => o.value);
      expect(options).toContain('current');
      expect(options).toContain('v1');
      expect(options).toContain('v2');
    });

    it('orders versions numerically (v10 after v9, not after v1)', () => {
      renderComponent({
        spec: 'current',
        specVersions: {
          v10: 'v10',
          v11: 'v11',
          v2: 'v2',
          v1: 'v1',
          v3: 'v3',
        },
      });

      const leftSelect = screen.getByTestId('compare-left-select') as HTMLSelectElement;
      const options = Array.from(leftSelect.options).map(o => o.value);
      expect(options).toEqual(['current', 'v1', 'v2', 'v3', 'v10', 'v11']);
    });

    it('calls onSetLeft when left selector changes', () => {
      const { onSetLeft } = renderComponent({
        spec: 'current',
        specVersions: { v1: 'v1' },
        leftVersion: 'current',
        rightVersion: 'v1',
      });

      const select = screen.getByTestId('compare-left-select');
      fireEvent.change(select, { target: { value: 'v1' } });

      expect(onSetLeft).toHaveBeenCalledWith('v1');
    });

    it('calls onSetRight when right selector changes', () => {
      const { onSetRight } = renderComponent({
        spec: 'current',
        specVersions: { v1: 'v1', v2: 'v2' },
        leftVersion: 'current',
        rightVersion: 'v1',
      });

      const select = screen.getByTestId('compare-right-select');
      fireEvent.change(select, { target: { value: 'v2' } });

      expect(onSetRight).toHaveBeenCalledWith('v2');
    });
  });

  // ── Auto-initialization ───────────────────────────────────────────────

  describe('auto-initialization', () => {
    it('auto-selects versions when both are null and versions exist', () => {
      const onSetLeft = vi.fn();
      const onSetRight = vi.fn();
      renderComponent({
        spec: 'current spec',
        specVersions: { v1: 'v1 spec', v2: 'v2 spec' },
        leftVersion: null,
        rightVersion: null,
        onSetLeft,
        onSetRight,
      });

      // Should auto-initialize: left → second-last, right → last
      expect(onSetLeft).toHaveBeenCalledWith('v1');
      expect(onSetRight).toHaveBeenCalledWith('v2');
    });

    it('does not auto-select when versions are already set', () => {
      const onSetLeft = vi.fn();
      const onSetRight = vi.fn();
      renderComponent({
        spec: 'current spec',
        specVersions: { v1: 'v1 spec' },
        leftVersion: 'current',
        rightVersion: 'v1',
        onSetLeft,
        onSetRight,
      });

      // Should NOT call onSetLeft/onSetRight again
      expect(onSetLeft).not.toHaveBeenCalled();
      expect(onSetRight).not.toHaveBeenCalled();
    });
  });

  // ── Empty diff ────────────────────────────────────────────────────────

  describe('empty diff', () => {
    it('renders without crashing when spec and versions are empty', () => {
      renderComponent({
        spec: '',
        specVersions: {},
      });

      // Should render selectors at minimum
      expect(screen.getByTestId('compare-left-select')).toBeInTheDocument();
      expect(screen.getByTestId('compare-right-select')).toBeInTheDocument();
    });
  });
});
