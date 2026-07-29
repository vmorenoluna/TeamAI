// @vitest-environment happy-dom

/**
 * Unit tests for StreamingOutput component.
 *
 * Tests the streaming output display with Agent Output header, event count,
 * progress text, and Initialising fallback when no text is available.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { StreamingOutput } from '@/components/streaming-output';

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderComponent(text: string, eventCount: number, className?: string) {
  render(<StreamingOutput text={text} eventCount={eventCount} className={className} />);
}

/** Get the outermost container div via data-component. */
function getOuterContainer(): HTMLElement {
  return screen.getByTestId('streaming-output');
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('StreamingOutput', () => {
  // ── Header ────────────────────────────────────────────────────────────

  describe('header', () => {
    it('renders the Agent Output label', () => {
      renderComponent('some output', 1);
      expect(screen.getByText('Agent Output')).toBeInTheDocument();
    });

    it('shows singular event count for 1 event', () => {
      renderComponent('hello', 1);
      expect(screen.getByText('1 event')).toBeInTheDocument();
    });

    it('shows plural event count for multiple events', () => {
      renderComponent('hello', 5);
      expect(screen.getByText('5 events')).toBeInTheDocument();
    });

    it('shows plural event count for 0 events', () => {
      renderComponent('', 0);
      expect(screen.getByText('0 events')).toBeInTheDocument();
    });
  });

  // ── Content display ───────────────────────────────────────────────────

  describe('content display', () => {
    it('renders progress text inside a <pre> element', () => {
      renderComponent('Listing issues...', 2);

      const pre = screen.getByText('Listing issues...');
      expect(pre).toBeInTheDocument();
      expect(pre.tagName).toBe('PRE');
    });

    it('renders multi-line text preserving whitespace', () => {
      renderComponent('Line 1\nLine 2\nLine 3', 3);

      const pre = screen.getByText(/Line 1/);
      expect(pre).toBeInTheDocument();
      expect(pre.textContent).toContain('Line 2');
      expect(pre.textContent).toContain('Line 3');
    });

    it('renders the pre with monospace font styling', () => {
      renderComponent('console.log("hello")', 1);

      const pre = screen.getByText('console.log("hello")');
      expect(pre).toHaveClass('font-mono');
      expect(pre).toHaveClass('whitespace-pre-wrap');
    });
  });

  // ── Initialising fallback ─────────────────────────────────────────────

  describe('Initialising fallback', () => {
    it('shows "Initialising…" when text is empty string', () => {
      renderComponent('', 5);

      expect(screen.getByText('Initialising…')).toBeInTheDocument();
    });

    it('shows the pulse animation on the fallback', () => {
      renderComponent('', 1);

      const fallback = screen.getByText('Initialising…');
      expect(fallback).toHaveClass('animate-pulse');
    });

    it('does not show "Initialising…" when text is non-empty', () => {
      renderComponent('Working...', 2);

      expect(screen.queryByText('Initialising…')).not.toBeInTheDocument();
    });

    it('shows event count alongside the fallback', () => {
      renderComponent('', 3);

      expect(screen.getByText('3 events')).toBeInTheDocument();
      expect(screen.getByText('Initialising…')).toBeInTheDocument();
    });
  });

  // ── Container styling ─────────────────────────────────────────────────

  describe('container styling', () => {
    it('renders the outer container with the dark background', () => {
      renderComponent('test', 1);

      const outer = getOuterContainer();
      expect(outer.className).toContain('bg-[#1a1f2e]');
    });

    it('applies additional className when provided', () => {
      renderComponent('test', 1, 'min-h-[100px] max-h-80');

      const outer = getOuterContainer();
      expect(outer.className).toContain('min-h-[100px]');
      expect(outer.className).toContain('max-h-80');
    });

    it('does not include extra class fragments when className is omitted', () => {
      renderComponent('test', 1);

      const outer = getOuterContainer();
      expect(outer.className).toContain('flex-1');
      expect(outer.className).toContain('overflow-y-auto');
    });

    it('has the border and rounded styling', () => {
      renderComponent('test', 1);

      const outer = getOuterContainer();
      expect(outer.className).toContain('rounded-lg');
      expect(outer.className).toContain('border');
    });
  });

  // ── Large text ────────────────────────────────────────────────────────

  describe('large text', () => {
    it('renders long progress text without truncation', () => {
      const longText = 'A'.repeat(2000);
      renderComponent(longText, 10);

      expect(screen.getByText(longText)).toBeInTheDocument();
    });

    it('renders text containing special characters', () => {
      renderComponent('▶ bash: npm test\n▶ read_file: package.json\nError: failed', 4);

      expect(screen.getByText(/▶ bash/)).toBeInTheDocument();
      expect(screen.getByText(/Error: failed/)).toBeInTheDocument();
    });
  });
});
