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

const mockGetAutoModeStateAction = vi.fn();
const mockToggleAutoMode = vi.fn();

vi.mock('@/app/actions/auto-mode', () => ({
  getAutoModeStateAction: (...args: unknown[]) => mockGetAutoModeStateAction(...args),
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
    // Default: auto mode disabled, resolves immediately
    mockGetAutoModeStateAction.mockResolvedValue({
      enabled: false,
      maxParallel: 2,
      activeCount: 0,
      trackedCount: 0,
    });
    mockToggleAutoMode.mockResolvedValue(undefined);
  });

  // ── Loading state ───────────────────────────────────────────────────

  describe('loading state', () => {
    it('shows "Loading…" while initial state is being fetched', () => {
      // Never-resolving promise keeps loading state alive
      mockGetAutoModeStateAction.mockImplementation(() => new Promise(() => {}));

      render(<AutoModeButton />);

      expect(screen.getByText('Loading…')).toBeInTheDocument();
    });

    it('does NOT show the toggle button while loading', () => {
      mockGetAutoModeStateAction.mockImplementation(() => new Promise(() => {}));

      render(<AutoModeButton />);

      expect(screen.queryByRole('button')).not.toBeInTheDocument();
    });

    it('hides loading text and renders button once state resolves', async () => {
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: false,
        maxParallel: 2,
        activeCount: 0,
        trackedCount: 0,
      });

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      expect(screen.getByRole('button')).toBeInTheDocument();
    });

    it('hides loading text even when fetch fails (graceful degradation)', async () => {
      mockGetAutoModeStateAction.mockRejectedValue(new Error('failed'));

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      // After fetch failure, the button still renders (in disabled state)
      expect(screen.getByRole('button')).toBeInTheDocument();
      expect(screen.getByTitle('Start Auto mode')).toBeInTheDocument();
    });
  });

  // ── Disabled state UI ───────────────────────────────────────────────

  describe('disabled state UI', () => {
    it('shows play icon (▶) and "Auto" label when disabled', async () => {
      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      // The button contains "▶" and "Auto"
      const button = screen.getByRole('button');
      expect(button).toHaveTextContent('▶');
      expect(button).toHaveTextContent('Auto');
    });

    it('shows correct title attribute when disabled', async () => {
      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      expect(screen.getByTitle('Start Auto mode')).toBeInTheDocument();
    });

    it('uses slate border styling when disabled', async () => {
      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      const button = screen.getByRole('button');
      expect(button.className).toContain('border-[#334155]');
    });
  });

  // ── Enabled state UI ────────────────────────────────────────────────

  describe('enabled state UI', () => {
    it('shows pulsing green dot and stop icon (■) when enabled', async () => {
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: true,
        maxParallel: 2,
        activeCount: 1,
        trackedCount: 1,
      });

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      const button = screen.getByRole('button');
      expect(button).toHaveTextContent('Auto');
      expect(button).toHaveTextContent('■');
      // Pulsing green dot
      expect(button.querySelector('.animate-pulse')).toBeInTheDocument();
      expect(button.querySelector('.bg-emerald-400')).toBeInTheDocument();
    });

    it('shows correct title attribute when enabled', async () => {
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: true,
        maxParallel: 2,
        activeCount: 1,
        trackedCount: 1,
      });

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      expect(screen.getByTitle('Stop Auto mode')).toBeInTheDocument();
    });

    it('uses emerald border and glow styling when enabled', async () => {
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: true,
        maxParallel: 2,
        activeCount: 1,
        trackedCount: 1,
      });

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      const button = screen.getByRole('button');
      expect(button.className).toContain('border-emerald-700/60');
      expect(button.className).toContain('bg-emerald-950/40');
      expect(button.className).toContain('text-emerald-400');
    });
  });

  // ── Toggle behavior ─────────────────────────────────────────────────

  describe('toggle behavior', () => {
    it('calls toggleAutoMode(true) when clicked from disabled state', async () => {
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: false,
        maxParallel: 2,
        activeCount: 0,
        trackedCount: 0,
      });

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(mockToggleAutoMode).toHaveBeenCalledWith(true);
      });
    });

    it('calls toggleAutoMode(false) when clicked from enabled state', async () => {
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: true,
        maxParallel: 2,
        activeCount: 1,
        trackedCount: 1,
      });

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(mockToggleAutoMode).toHaveBeenCalledWith(false);
      });
    });

    it('refreshes the router after successful toggle', async () => {
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: false,
        maxParallel: 2,
        activeCount: 0,
        trackedCount: 0,
      });
      mockToggleAutoMode.mockResolvedValue(undefined);
      mockRouterRefresh.mockClear();

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
      });
    });
  });

  // ── Optimistic update ────────────────────────────────────────────────

  describe('optimistic update', () => {
    it('updates UI to enabled immediately on click, before server responds', async () => {
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: false,
        maxParallel: 2,
        activeCount: 0,
        trackedCount: 0,
      });

      // Keep the toggle pending so we can observe optimistic state
      mockToggleAutoMode.mockImplementation(() => new Promise(() => {}));

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

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
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: true,
        maxParallel: 2,
        activeCount: 1,
        trackedCount: 1,
      });

      mockToggleAutoMode.mockImplementation(() => new Promise(() => {}));

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

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
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: false,
        maxParallel: 2,
        activeCount: 0,
        trackedCount: 0,
      });

      mockToggleAutoMode.mockRejectedValue(new Error('Server error'));

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button'));

      // Should revert to disabled state (the original state)
      await waitFor(() => {
        expect(screen.getByTitle('Start Auto mode')).toBeInTheDocument();
      });
    });

    it('shows error message when toggleAutoMode fails', async () => {
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: false,
        maxParallel: 2,
        activeCount: 0,
        trackedCount: 0,
      });

      mockToggleAutoMode.mockRejectedValue(new Error('Server error'));

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByText('Server error')).toBeInTheDocument();
      });
    });

    it('shows fallback error message when error is not an Error instance', async () => {
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: false,
        maxParallel: 2,
        activeCount: 0,
        trackedCount: 0,
      });

      mockToggleAutoMode.mockRejectedValue('some string error');

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByText('Failed to toggle auto mode')).toBeInTheDocument();
      });
    });

    it('clears error message when toggling again', async () => {
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: false,
        maxParallel: 2,
        activeCount: 0,
        trackedCount: 0,
      });

      // First toggle fails
      mockToggleAutoMode.mockRejectedValueOnce(new Error('First error'));

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

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
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: false,
        maxParallel: 2,
        activeCount: 0,
        trackedCount: 0,
      });

      // Keep the toggle pending
      mockToggleAutoMode.mockImplementation(() => new Promise(() => {}));

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('button')).toBeDisabled();
      });
    });

    it('re-enables the button after toggle completes', async () => {
      mockGetAutoModeStateAction.mockResolvedValue({
        enabled: false,
        maxParallel: 2,
        activeCount: 0,
        trackedCount: 0,
      });

      mockToggleAutoMode.mockResolvedValue(undefined);

      render(<AutoModeButton />);

      await waitFor(() => {
        expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button'));

      await waitFor(() => {
        expect(screen.getByRole('button')).not.toBeDisabled();
      });
    });
  });
});
