// @vitest-environment happy-dom

/**
 * Unit tests for RateLimitBanner component.
 *
 * Tests the shared rate-limit banner used across github-import, ideation-scanner,
 * insights-chat, and roadmap-view. Covers block and inline variants, message
 * display, auto-resume countdown + Cancel, Retry Now button, and disabled prop.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

import { RateLimitBanner } from '@/components/rate-limit-banner';

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderComponent(overrides: {
  message?: string;
  autoResumeAt?: number | null;
  countdown?: string;
  onCancelAutoResume?: () => void;
  onRetry?: () => void;
  disabled?: boolean;
  variant?: 'block' | 'inline';
} = {}) {
  const {
    message = 'Rate limit reached.',
    autoResumeAt = null,
    countdown = '',
    onCancelAutoResume = vi.fn(),
    onRetry = vi.fn(),
    disabled = false,
    variant = 'block',
  } = overrides;

  render(
    <RateLimitBanner
      message={message}
      autoResumeAt={autoResumeAt}
      countdown={countdown}
      onCancelAutoResume={onCancelAutoResume}
      onRetry={onRetry}
      disabled={disabled}
      variant={variant}
    />
  );

  return { onCancelAutoResume, onRetry };
}

/** Get the outermost container div via data-component. */
function getOuterContainer(): HTMLElement {
  return screen.getByTestId('rate-limit-banner');
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('RateLimitBanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Message display ───────────────────────────────────────────────────

  describe('message display', () => {
    it('renders the rate-limit message', () => {
      renderComponent({ message: 'Session limit hit — auto-resuming 2:30' });

      expect(
        screen.getByText('Session limit hit — auto-resuming 2:30')
      ).toBeInTheDocument();
    });

    it('renders the ⏳ icon', () => {
      renderComponent();

      expect(screen.getByText('⏳')).toBeInTheDocument();
    });

    it('uses a fallback message when message is empty', () => {
      renderComponent({ message: '' });

      expect(
        screen.getByText('Rate limit reached. Please wait and try again.')
      ).toBeInTheDocument();
    });
  });

  // ── Retry Now button ──────────────────────────────────────────────────

  describe('Retry Now button', () => {
    it('renders the Retry Now button', () => {
      renderComponent();

      expect(
        screen.getByRole('button', { name: 'Retry Now' })
      ).toBeInTheDocument();
    });

    it('calls onRetry when Retry Now is clicked', () => {
      const { onRetry } = renderComponent();

      fireEvent.click(screen.getByRole('button', { name: 'Retry Now' }));
      expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('disables the Retry Now button when disabled prop is true', () => {
      renderComponent({ disabled: true });

      const btn = screen.getByRole('button', { name: 'Retry Now' });
      expect(btn).toBeDisabled();
    });

    it('enables Retry Now when disabled prop is false (default)', () => {
      renderComponent({ disabled: false });

      const btn = screen.getByRole('button', { name: 'Retry Now' });
      expect(btn).not.toBeDisabled();
    });
  });

  // ── Auto-resume countdown + Cancel ────────────────────────────────────

  describe('auto-resume countdown + Cancel', () => {
    it('shows countdown when autoResumeAt is non-null', () => {
      renderComponent({
        autoResumeAt: 1719000000,
        countdown: '2:30',
        message: 'Session limit hit — auto-resuming 2:30',
      });

      expect(screen.getByText('2:30')).toBeInTheDocument();
    });

    it('shows Cancel button when autoResumeAt is non-null', () => {
      renderComponent({ autoResumeAt: 1719000000, countdown: '2:30' });

      expect(screen.getByText('Cancel')).toBeInTheDocument();
    });

    it('does NOT show Cancel when autoResumeAt is null', () => {
      renderComponent({ autoResumeAt: null, countdown: '' });

      expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
    });

    it('does NOT show countdown when autoResumeAt is null', () => {
      renderComponent({ autoResumeAt: null, countdown: '' });

      expect(screen.getByText('⏳')).toBeInTheDocument();
      expect(screen.queryByText(/\d+:\d+/)).not.toBeInTheDocument();
    });

    it('calls onCancelAutoResume when Cancel is clicked', () => {
      const { onCancelAutoResume } = renderComponent({
        autoResumeAt: 1719000000,
        countdown: '1:00',
      });

      fireEvent.click(screen.getByText('Cancel'));
      expect(onCancelAutoResume).toHaveBeenCalledTimes(1);
    });
  });

  // ── Block variant ─────────────────────────────────────────────────────

  describe('block variant (default)', () => {
    it('renders with card-like styling (rounded-lg, border, p-4)', () => {
      renderComponent({ variant: 'block' });

      const outer = getOuterContainer();
      expect(outer.className).toContain('rounded-lg');
      expect(outer.className).toContain('p-4');
      expect(outer.className).toContain('bg-amber-950/30');
    });

    it('does not have the border-b-only inline styling', () => {
      renderComponent({ variant: 'block' });

      const outer = getOuterContainer();
      expect(outer.className).not.toContain('border-b');
    });
  });

  // ── Inline variant ────────────────────────────────────────────────────

  describe('inline variant', () => {
    it('renders with border-bottom strip styling', () => {
      renderComponent({ variant: 'inline' });

      const outer = getOuterContainer();
      expect(outer.className).toContain('border-b');
      expect(outer.className).toContain('bg-amber-950/60');
    });

    it('does not have the card-like rounded-lg + p-4 styling', () => {
      renderComponent({ variant: 'inline' });

      const outer = getOuterContainer();
      expect(outer.className).not.toContain('rounded-lg');
      expect(outer.className).not.toContain('p-4');
    });

    it('renders the message text in xs size', () => {
      renderComponent({ variant: 'inline', message: 'Test limit' });

      const msg = screen.getByText('Test limit');
      expect(msg.className).toContain('text-xs');
    });
  });

  // ── Both variants ─────────────────────────────────────────────────────

  describe('shared across variants', () => {
    it('contains the Retry Now button in both variants', () => {
      const { unmount } = render(
        <RateLimitBanner
          message="Test"
          autoResumeAt={null}
          countdown=""
          onCancelAutoResume={vi.fn()}
          onRetry={vi.fn()}
          variant="block"
        />
      );
      expect(screen.getByRole('button', { name: 'Retry Now' })).toBeInTheDocument();

      unmount();

      render(
        <RateLimitBanner
          message="Test"
          autoResumeAt={null}
          countdown=""
          onCancelAutoResume={vi.fn()}
          onRetry={vi.fn()}
          variant="inline"
        />
      );
      expect(screen.getByRole('button', { name: 'Retry Now' })).toBeInTheDocument();
    });

    it('always renders the amber icon', () => {
      renderComponent({ variant: 'block' });
      expect(screen.getByText('⏳')).toBeInTheDocument();
    });
  });
});
