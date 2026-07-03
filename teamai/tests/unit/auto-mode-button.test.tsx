// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AutoModeButton } from '@/components/auto-mode-button';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockRouterRefresh = vi.fn();

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    refresh: mockRouterRefresh,
    push: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

const mockToggleAutoMode = vi.fn();

vi.mock('@/app/actions/auto-mode', () => ({
  toggleAutoMode: (...args: unknown[]) => mockToggleAutoMode(...args),
}));

// Mock useTransition so startTransition runs callbacks synchronously.
// In happy-dom, React 18's startTransition never flips isPending back to
// false after the async callback completes, preventing subsequent clicks
// and making the DOM permanently show disabled buttons. Running callbacks
// synchronously avoids this while keeping isPending behavior correct.
vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react');
  return {
    ...actual,
    useTransition: () => {
      const [isPending, setIsPending] = actual.useState(false);
      function startTransition(cb: () => void) {
        setIsPending(true);
        try {
          const result = cb();
          if (result != null && typeof (result as Promise<unknown>).then === 'function') {
            (result as Promise<unknown>).finally(() => setIsPending(false));
          } else {
            setIsPending(false);
          }
        } catch {
          setIsPending(false);
        }
      }
      return [isPending, startTransition] as [boolean, (cb: () => void) => void];
    },
  };
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('AutoModeButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockToggleAutoMode.mockResolvedValue(undefined);
  });

  // ── No project selected ─────────────────────────────────────────────

  describe('no project selected', () => {
    it('shows disabled button when activeProjectPath is null', () => {
      render(<AutoModeButton activeProjectPath={null} initialEnabled={false} />);

      const button = screen.getByRole('button');
      expect(button).toBeDisabled();
      expect(button).toHaveAttribute('title', 'No project selected');
    });

    it('renders button immediately (no loading state)', () => {
      render(<AutoModeButton activeProjectPath={null} initialEnabled={false} />);

      expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('does NOT call toggleAutoMode when clicked with no project', () => {
      render(<AutoModeButton activeProjectPath={null} initialEnabled={false} />);

      const button = screen.getByRole('button');
      fireEvent.click(button);

      // The button is disabled, so the click handler should not fire
      expect(mockToggleAutoMode).not.toHaveBeenCalled();
    });
  });

  // ── Initial enabled from server state ───────────────────────────

  describe('initial state from server', () => {
    it('shows as enabled when initialEnabled is true', () => {
      render(<AutoModeButton initialEnabled={true} />);

      const button = screen.getByRole('button');
      expect(button).toHaveTextContent('Auto');
      expect(button).toHaveTextContent('■');
      expect(button.querySelector('.animate-pulse')).toBeInTheDocument();
      expect(button.querySelector('.bg-emerald-400')).toBeInTheDocument();
      expect(screen.getByTitle('Stop Auto mode')).toBeInTheDocument();
    });

    it('shows as disabled when initialEnabled is false', () => {
      render(<AutoModeButton initialEnabled={false} />);

      const button = screen.getByRole('button');
      expect(button).toHaveTextContent('▶');
      expect(button).toHaveTextContent('Auto');
      expect(screen.getByTitle('Start Auto mode')).toBeInTheDocument();
    });
  });

  // ── Disabled state UI ───────────────────────────────────────────────

  describe('disabled state UI', () => {
    it('shows play icon (▶) and "Auto" label when disabled', () => {
      render(<AutoModeButton initialEnabled={false} />);

      const button = screen.getByRole('button');
      expect(button).toHaveTextContent('▶');
      expect(button).toHaveTextContent('Auto');
    });

    it('shows correct title attribute when disabled', () => {
      render(<AutoModeButton initialEnabled={false} />);

      expect(screen.getByTitle('Start Auto mode')).toBeInTheDocument();
    });

    it('uses slate border styling when disabled', () => {
      render(<AutoModeButton initialEnabled={false} />);

      const button = screen.getByRole('button');
      expect(button.className).toContain('border-[#334155]');
    });
  });

  // ── Enabled state UI ────────────────────────────────────────────────

  describe('enabled state UI', () => {
    it('shows pulsing green dot and stop icon (■) when enabled', () => {
      render(<AutoModeButton initialEnabled={true} />);

      const button = screen.getByRole('button');
      expect(button).toHaveTextContent('Auto');
      expect(button).toHaveTextContent('■');
      expect(button.querySelector('.animate-pulse')).toBeInTheDocument();
      expect(button.querySelector('.bg-emerald-400')).toBeInTheDocument();
    });

    it('shows correct title attribute when enabled', () => {
      render(<AutoModeButton initialEnabled={true} />);

      expect(screen.getByTitle('Stop Auto mode')).toBeInTheDocument();
    });

    it('uses emerald border and glow styling when enabled', () => {
      render(<AutoModeButton initialEnabled={true} />);

      const button = screen.getByRole('button');
      expect(button.className).toContain('border-emerald-700/60');
      expect(button.className).toContain('bg-emerald-950/40');
      expect(button.className).toContain('text-emerald-400');
    });
  });

  // ── Toggle behavior ─────────────────────────────────────────────────

  describe('toggle behavior', () => {
    it('calls toggleAutoMode(true) when clicked from disabled state', async () => {
      render(<AutoModeButton initialEnabled={false} />);

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(mockToggleAutoMode).toHaveBeenCalledWith(true);
      });
    });

    it('calls toggleAutoMode(false) when clicked from enabled state', async () => {
      render(<AutoModeButton initialEnabled={true} />);

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(mockToggleAutoMode).toHaveBeenCalledWith(false);
      });
    });

    it('refreshes the router after successful toggle', async () => {
      mockToggleAutoMode.mockResolvedValue(undefined);
      mockRouterRefresh.mockClear();

      render(<AutoModeButton initialEnabled={false} />);

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ── Optimistic update ────────────────────────────────────────────────

  describe('optimistic update', () => {
    it('updates UI to enabled immediately on click, before server responds', async () => {
      mockToggleAutoMode.mockImplementation(() => new Promise(() => {}));

      render(<AutoModeButton initialEnabled={false} />);

      // Initially disabled
      expect(screen.getByTitle('Start Auto mode')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button'));

      // Optimistically shows enabled state (synchronous setEnabled fires before transition)
      await waitFor(() => {
        expect(screen.getByTitle('Stop Auto mode')).toBeInTheDocument();
      });
      expect(screen.getByRole('button').querySelector('.animate-pulse')).toBeInTheDocument();
    });

    it('updates UI to disabled immediately when toggling off', async () => {
      mockToggleAutoMode.mockImplementation(() => new Promise(() => {}));

      render(<AutoModeButton initialEnabled={true} />);

      // Initially enabled
      expect(screen.getByTitle('Stop Auto mode')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button'));

      // Optimistically shows disabled state (synchronous setEnabled fires before transition)
      await waitFor(() => {
        expect(screen.getByTitle('Start Auto mode')).toBeInTheDocument();
      });
    });
  });

  // ── Error handling ──────────────────────────────────────────────────

  describe('error handling', () => {
    it('reverts optimistic update when toggleAutoMode fails', async () => {
      mockToggleAutoMode.mockRejectedValue(new Error('Server error'));

      render(<AutoModeButton initialEnabled={false} />);

      fireEvent.click(screen.getByRole('button'));

      // Should revert to disabled state (the original state)
      await waitFor(() => {
        expect(screen.getByTitle('Start Auto mode')).toBeInTheDocument();
      });
    });

    it('shows error message when toggleAutoMode fails', async () => {
      mockToggleAutoMode.mockRejectedValue(new Error('Server error'));

      render(<AutoModeButton initialEnabled={false} />);

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByText('Server error')).toBeInTheDocument();
      });
    });

    it('shows fallback error message when error is not an Error instance', async () => {
      mockToggleAutoMode.mockRejectedValue('some string error');

      render(<AutoModeButton initialEnabled={false} />);

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByText('Failed to toggle auto mode')).toBeInTheDocument();
      });
    });

    it('clears error message when toggling again', async () => {
      // First toggle fails
      mockToggleAutoMode.mockRejectedValueOnce(new Error('First error'));

      render(<AutoModeButton initialEnabled={false} />);

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByText('First error')).toBeInTheDocument();
      });

      // Second toggle succeeds — error should be cleared from the DOM
      mockToggleAutoMode.mockResolvedValue(undefined);

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.queryByText('First error')).not.toBeInTheDocument();
      });
    });
  });

  // ── Button disabled during pending ───────────────────────────────────

  describe('disabled during pending transition', () => {
    it('disables the button while toggle is in progress', async () => {
      mockToggleAutoMode.mockImplementation(() => new Promise(() => {}));

      render(<AutoModeButton initialEnabled={false} />);

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('button')).toBeDisabled();
      });
    });

    it('re-enables the button after toggle completes', async () => {
      mockToggleAutoMode.mockResolvedValue(undefined);

      render(<AutoModeButton initialEnabled={false} />);

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('button')).not.toBeDisabled();
      });
    });
  });

  // ── Survives router.refresh() ─────────────────────────────────────

  describe('survives router.refresh()', () => {
    it('retains enabled state after unmount and remount (simulating router.refresh)', () => {
      // When router.refresh() fires, the layout re-renders, which unmounts
      // and remounts AutoModeButton. The initialEnabled prop from the server
      // must restore the enabled state correctly.

      const { unmount } = render(<AutoModeButton initialEnabled={true} />);

      // Initially enabled
      expect(screen.getByTitle('Stop Auto mode')).toBeInTheDocument();
      expect(screen.getByRole('button').querySelector('.animate-pulse')).toBeInTheDocument();

      // Simulate router.refresh() — unmount and remount with same props
      unmount();
      render(<AutoModeButton initialEnabled={true} />);

      // Should still be enabled after remount — state comes from the server prop,
      // not from a volatile async fetch
      expect(screen.getByTitle('Stop Auto mode')).toBeInTheDocument();
      expect(screen.getByRole('button').querySelector('.animate-pulse')).toBeInTheDocument();
    });

    it('retains disabled state after unmount and remount', () => {
      const { unmount } = render(<AutoModeButton initialEnabled={false} />);

      // Initially disabled
      expect(screen.getByTitle('Start Auto mode')).toBeInTheDocument();

      // Simulate router.refresh()
      unmount();
      render(<AutoModeButton initialEnabled={false} />);

      // Should still be disabled after remount
      expect(screen.getByTitle('Start Auto mode')).toBeInTheDocument();
    });
  });
});
