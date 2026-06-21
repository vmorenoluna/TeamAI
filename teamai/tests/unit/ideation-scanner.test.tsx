// @vitest-environment happy-dom

/**
 * Unit tests for IdeationScanner component.
 *
 * Tests the button states (idle/scanning/complete/error), error display
 * and clearance on retry, and that the try/catch fix properly unsets
 * running when startIdeationScan() rejects.
 *
 * React's useTransition is mocked to return isPending=false with a
 * synchronous startTransition wrapper.  This isolates the component's
 * own state logic (running, done, error) from React's scheduler and
 * avoids the happy-dom limitation where clicking a disabled element
 * does not invoke its onClick handler.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SessionEvent } from '@/hooks/use-session-stream';
import type { StreamEvent } from '@/lib/stream-types';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockStartIdeationScan = vi.fn();
const mockCancelIdeationScan = vi.fn();

vi.mock('@/app/actions/ideation', () => ({
  startIdeationScan: (() => mockStartIdeationScan()) as typeof import('@/app/actions/ideation').startIdeationScan,
  cancelIdeationScan: (() => mockCancelIdeationScan()) as typeof import('@/app/actions/ideation').cancelIdeationScan,
}));

const mockUseSessionStream = vi.fn();

vi.mock('@/hooks/use-session-stream', () => ({
  useSessionStream: (() => mockUseSessionStream()) as typeof import('@/hooks/use-session-stream').useSessionStream,
}));

vi.mock('@/lib/stream-types', () => ({
  extractText: vi.fn((event: Record<string, unknown>) => {
    const msg = event.message as Record<string, unknown> | undefined;
    const content = msg?.content as Array<Record<string, unknown>> | undefined;
    return (content?.[0]?.text as string) ?? '';
  }),
}));

const mockStartTransition = vi.hoisted(() => vi.fn((cb: () => void) => cb()));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  return {
    ...actual,
    useTransition: () => [false, mockStartTransition],
  };
});

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { IdeationScanner } from '@/components/ideation-scanner';

// ── Helpers ─────────────────────────────────────────────────────────────────

function renderComponent() {
  render(<IdeationScanner />);
}

/** Create a type-safe SessionEvent for the mock stream. */
function ev(event: StreamEvent): SessionEvent {
  return { sessionId: '', event };
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('IdeationScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSessionStream.mockReturnValue([]);
  });

  // ── Initial state ────────────────────────────────────────────────────

  describe('initial state', () => {
    it('renders the Run Scan button', () => {
      renderComponent();
      expect(screen.getByRole('button', { name: 'Run Scan' })).toBeInTheDocument();
    });

    it('shows the idle message when no scan has been run', () => {
      renderComponent();
      expect(screen.getByText('Click "Run Scan" to analyse the codebase.')).toBeInTheDocument();
    });

    it('does not show error or complete badges initially', () => {
      renderComponent();
      expect(screen.queryByText('Scan complete')).not.toBeInTheDocument();
      expect(screen.queryByText(/Scan failed/)).not.toBeInTheDocument();
    });
  });

  // ── Scanning state ───────────────────────────────────────────────────

  describe('scanning state', () => {
    it('shows Scanning… and disables button while scan is running', async () => {
      mockStartIdeationScan.mockReturnValue(new Promise(() => {}));

      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));
      });

      const button = screen.getByRole('button', { name: 'Scanning…' });
      expect(button).toBeInTheDocument();
      expect(button).toBeDisabled(); // running && !done disables it
    });

    it('hides the idle message while scanning', async () => {
      mockStartIdeationScan.mockReturnValue(new Promise(() => {}));

      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));
      });

      expect(screen.queryByText('Click "Run Scan" to analyse the codebase.')).not.toBeInTheDocument();
    });
  });

  // ── Error state ──────────────────────────────────────────────────────

  describe('error state', () => {
    it('displays error message when startIdeationScan rejects', async () => {
      mockStartIdeationScan.mockRejectedValue(new Error('process unavailable'));

      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));
      });

      await waitFor(() => {
        expect(screen.getByText('Scan failed: process unavailable')).toBeInTheDocument();
      });
    });

    it('re-enables the button after an error', async () => {
      mockStartIdeationScan.mockRejectedValue(new Error('err'));

      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));
      });

      await waitFor(() => {
        const button = screen.getByRole('button', { name: 'Run Scan' });
        expect(button).toBeInTheDocument();
        expect(button).not.toBeDisabled();
      });
    });

    it('uses fallback message when rejection is not an Error instance', async () => {
      mockStartIdeationScan.mockRejectedValue('some string error');

      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));
      });

      await waitFor(() => {
        expect(screen.getByText('Scan failed: unknown error')).toBeInTheDocument();
      });
    });

    it('clears error when Run Scan is clicked again', async () => {
      mockStartIdeationScan
        .mockRejectedValueOnce(new Error('first error'))
        .mockReturnValueOnce(new Promise(() => {}));

      renderComponent();

      // First click: triggers error
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));
      });
      await waitFor(() => {
        expect(screen.getByText('Scan failed: first error')).toBeInTheDocument();
      });

      // Confirm button is re-enabled before retry click
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Run Scan' })).not.toBeDisabled();
      });

      // Second click: handleScan runs → setError(null), setRunning(true)
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));
      });

      expect(screen.queryByText('Scan failed: first error')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Scanning…' })).toBeInTheDocument();
      expect(mockStartIdeationScan).toHaveBeenCalledTimes(2);
    });
  });

  // ── Complete state ───────────────────────────────────────────────────

  describe('complete state', () => {
    it('shows Scan complete badge when stream includes a result event', () => {
      mockUseSessionStream.mockReturnValue([ev({ type: 'result' })]);

      renderComponent();

      expect(screen.getByText('Scan complete')).toBeInTheDocument();
    });

    it('shows Run Scan button (enabled) when scan is complete', () => {
      mockUseSessionStream.mockReturnValue([ev({ type: 'result' })]);

      renderComponent();

      const button = screen.getByRole('button', { name: 'Run Scan' });
      expect(button).toBeInTheDocument();
      expect(button).not.toBeDisabled();
    });

    it('shows streaming output when text is available', async () => {
      mockStartIdeationScan.mockResolvedValue('sess-out');
      mockUseSessionStream.mockReturnValue([
        ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Sample output' }] } }),
      ]);

      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));
      });

      expect(screen.getByText('Sample output')).toBeInTheDocument();
    });
  });

  // ── Button behavior ──────────────────────────────────────────────────

  describe('button behavior', () => {
    it('calls startIdeationScan when clicked', async () => {
      mockStartIdeationScan.mockResolvedValue('session-1');

      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));
      });

      expect(mockStartIdeationScan).toHaveBeenCalledTimes(1);
    });

    it('sets button to Run Scan after a successful scan completes', async () => {
      mockStartIdeationScan.mockResolvedValue('session-ok');
      mockUseSessionStream.mockReturnValue([ev({ type: 'result' })]);

      renderComponent();

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));
      });

      expect(screen.getByRole('button', { name: 'Run Scan' })).toBeInTheDocument();
    });
  });

  // ── Cancel race condition (rapid start/stop) ─────────────────────────

  describe('cancel race condition', () => {
    it('cancels an in-flight scan when Stop is clicked before start completes', async () => {
      let resolveStart!: (value: string) => void;
      const deferredStart = new Promise<string>(resolve => { resolveStart = resolve; });
      mockStartIdeationScan.mockReturnValue(deferredStart);

      renderComponent();

      // Click "Run Scan" — triggers handleScan
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Run Scan' }));
      });

      // Verify running state: "Scanning…" button + "✕ Stop" button
      expect(screen.getByRole('button', { name: 'Scanning…' })).toBeInTheDocument();
      expect(screen.getByText('✕ Stop')).toBeInTheDocument();

      // Click "✕ Stop" while start is still in-flight
      // (mockCancelIdeationScan resolves immediately so React batches cancelling
      //  toggles; "Stopping…" won't visibly render, but the call count proves the flow)
      await act(async () => {
        fireEvent.click(screen.getByText('✕ Stop'));
      });

      // Cancel was called (best-effort — may not find session yet since start hasn't resolved)
      expect(mockCancelIdeationScan).toHaveBeenCalled();

      // Now resolve the deferred start — the transition callback will check cancelRequestedRef
      await act(async () => {
        resolveStart('sess-ideation-race');
        // Wait for the promise chain to settle (microtask queue drains before macrotask)
        await new Promise(r => setTimeout(r, 0));
      });

      // After transition resolves and sees cancel was requested, it auto-cancels.
      // cancelIdeationScan should have been called a second time (post-resolution)
      expect(mockCancelIdeationScan).toHaveBeenCalledTimes(2);

      // Button should return to "Run Scan" (running = false)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Run Scan' })).toBeInTheDocument();
      });

      // The Stop button should be gone
      expect(screen.queryByText('✕ Stop')).not.toBeInTheDocument();
    });
  });
});
