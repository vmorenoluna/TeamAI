// @vitest-environment happy-dom

/**
 * Unit tests for LoadingSpinner component.
 *
 * Tests the loading indicator that shows a spinner and "Starting {label}…"
 * message before stream events arrive.
 */

import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { LoadingSpinner } from '@/components/loading-spinner';

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderComponent(label: string) {
  render(<LoadingSpinner label={label} />);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('LoadingSpinner', () => {
  // ── Label display ─────────────────────────────────────────────────────

  describe('label display', () => {
    it('renders "Starting {label}…" with the given label', () => {
      renderComponent('issue listing');

      expect(screen.getByText('Starting issue listing…')).toBeInTheDocument();
    });

    it('renders a different label correctly', () => {
      renderComponent('ideation scan');

      expect(screen.getByText('Starting ideation scan…')).toBeInTheDocument();
    });

    it('renders labels with generation context', () => {
      renderComponent('roadmap generation');

      expect(screen.getByText('Starting roadmap generation…')).toBeInTheDocument();
    });

    it('renders labels with changelog context', () => {
      renderComponent('changelog generation');

      expect(screen.getByText('Starting changelog generation…')).toBeInTheDocument();
    });
  });

  // ── Spinner element ───────────────────────────────────────────────────

  describe('spinner element', () => {
    it('renders a spinning indicator div', () => {
      renderComponent('test');

      // The spinner is a div with animate-spin class
      const container = screen.getByText('Starting test…').closest('div')!;
      const spinnerDiv = container.querySelector('.animate-spin');
      expect(spinnerDiv).toBeInTheDocument();
    });

    it('renders the spinner with a ring shape (rounded-full + border)', () => {
      renderComponent('test');

      const container = screen.getByText('Starting test…').closest('div')!;
      const spinnerDiv = container.querySelector('.animate-spin') as HTMLElement;
      expect(spinnerDiv).toHaveClass('rounded-full');
      expect(spinnerDiv).toHaveClass('border-2');
    });

    it('renders the spinner with blue border styling', () => {
      renderComponent('test');

      const container = screen.getByText('Starting test…').closest('div')!;
      const spinnerDiv = container.querySelector('.animate-spin') as HTMLElement;
      expect(spinnerDiv.className).toContain('border-blue-400');
      expect(spinnerDiv.className).toContain('border-t-transparent');
    });

    it('renders the spinner at a 16px (w-4 h-4) size', () => {
      renderComponent('test');

      const container = screen.getByText('Starting test…').closest('div')!;
      const spinnerDiv = container.querySelector('.animate-spin') as HTMLElement;
      expect(spinnerDiv).toHaveClass('w-4');
      expect(spinnerDiv).toHaveClass('h-4');
    });
  });

  // ── Container styling ─────────────────────────────────────────────────

  describe('container styling', () => {
    it('renders inside a dark background container', () => {
      renderComponent('test');

      const outer = screen.getByText('Starting test…').closest('div')!;
      expect(outer.className).toContain('bg-[#1a1f2e]');
    });

    it('has border and rounded styling', () => {
      renderComponent('test');

      const outer = screen.getByText('Starting test…').closest('div')!;
      expect(outer.className).toContain('rounded-lg');
      expect(outer.className).toContain('border');
    });

    it('uses a flex row layout with gap', () => {
      renderComponent('test');

      const outer = screen.getByText('Starting test…').closest('div')!;
      expect(outer.className).toContain('flex');
      expect(outer.className).toContain('items-center');
      expect(outer.className).toContain('gap-3');
    });

    it('renders the label text in slate-400 color', () => {
      renderComponent('test');

      const label = screen.getByText('Starting test…');
      expect(label.className).toContain('text-slate-400');
    });
  });

  // ── Edge cases ────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('renders with an empty string label', () => {
      renderComponent('');

      expect(screen.getByText('Starting …')).toBeInTheDocument();
    });

    it('renders with a very long label', () => {
      const longLabel = 'comprehensive multi-phase agent pipeline orchestration';
      renderComponent(longLabel);

      expect(screen.getByText(`Starting ${longLabel}…`)).toBeInTheDocument();
    });

    it('renders the spinner and text side by side', () => {
      renderComponent('test');

      const outer = screen.getByText('Starting test…').closest('div')!;
      const children = outer.children;
      // Should have 2 children: spinner div + text span
      expect(children.length).toBe(2);
    });
  });
});
