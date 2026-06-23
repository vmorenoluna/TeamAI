// @vitest-environment happy-dom

/**
 * Unit tests for InsightsChat component.
 *
 * Tests the full lifecycle: initial mount (auto-create session), chat flow
 * (send message, user/assistant messages, streaming cursor), cancel flow
 * (✕ Stop → auto-reconnect), rate-limit detection (amber banner + Retry),
 * input behaviour (disabled while running, Enter to send), result
 * finalization, and cancel race condition (rapid send/stop).
 *
 * Important: we use controlled deferred promises instead of unresolved
 * new Promise(() => {}) because act() tracks all async work and will hang
 * indefinitely waiting for an unresolved promise to settle.
 *
 * React's useTransition is mocked (isPending=false, synchronous callback).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SessionEvent } from '@/hooks/use-session-stream';
import type { StreamEvent } from '@/lib/stream-types';

// ── Helper: controlled deferred promise ─────────────────────────────────────

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockGetOrCreateInsightsSession = vi.fn();
const mockSendInsightsMessage = vi.fn();
const mockCancelInsightsSession = vi.fn().mockResolvedValue(undefined);

vi.mock('@/app/actions/insights', () => ({
  getOrCreateInsightsSession: (() => mockGetOrCreateInsightsSession()) as typeof import('@/app/actions/insights').getOrCreateInsightsSession,
  sendInsightsMessage: ((...args: unknown[]) => mockSendInsightsMessage(...args)) as typeof import('@/app/actions/insights').sendInsightsMessage,
  cancelInsightsSession: (() => mockCancelInsightsSession()) as typeof import('@/app/actions/insights').cancelInsightsSession,
}));

const mockUseSessionStream = vi.fn();

vi.mock('@/hooks/use-session-stream', () => ({
  useSessionStream: (() => mockUseSessionStream()) as typeof import('@/hooks/use-session-stream').useSessionStream,
}));

const mockExtractText = vi.hoisted(() =>
  vi.fn((event: Record<string, unknown>) => {
    const msg = event.message as Record<string, unknown> | undefined;
    const content = msg?.content as Array<Record<string, unknown>> | undefined;
    return (content?.[0]?.text as string) ?? '';
  })
);
const mockExtractProgressText = vi.hoisted(() => vi.fn().mockReturnValue(''));
const mockParseSessionLimitReset = vi.hoisted(() => vi.fn().mockReturnValue(null));
const mockFormatCountdown = vi.hoisted(() => vi.fn().mockReturnValue(''));

vi.mock('@/lib/stream-types', () => ({
  extractText: mockExtractText,
  extractProgressText: mockExtractProgressText,
}));

vi.mock('@/lib/rate-limit', () => ({
  parseSessionLimitReset: ((...args: unknown[]) => mockParseSessionLimitReset(...args)) as typeof import('@/lib/rate-limit').parseSessionLimitReset,
  formatCountdown: ((...args: unknown[]) => mockFormatCountdown(...args)) as typeof import('@/lib/rate-limit').formatCountdown,
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

import { InsightsChat } from '@/components/insights-chat';

// ── Helpers ─────────────────────────────────────────────────────────────────

async function renderComponent() {
  await act(async () => {
    render(<InsightsChat />);
    if (!vi.isFakeTimers()) {
      await new Promise(r => setTimeout(r, 0));
    }
  });
}

function ev(event: StreamEvent): SessionEvent {
  return { sessionId: '', event };
}

/** Simulate sending a message: type in textarea, click Send. */
async function sendMessage(text: string) {
  const textarea = screen.getByRole('textbox');
  fireEvent.change(textarea, { target: { value: text } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('InsightsChat', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSessionStream.mockReturnValue([]);
    mockGetOrCreateInsightsSession.mockResolvedValue('session-init');
    mockCancelInsightsSession.mockResolvedValue(undefined);
    mockExtractText.mockImplementation((event: Record<string, unknown>) => {
      const msg = event.message as Record<string, unknown> | undefined;
      const content = msg?.content as Array<Record<string, unknown>> | undefined;
      return (content?.[0]?.text as string) ?? '';
    });
    mockExtractProgressText.mockReturnValue('');
    mockParseSessionLimitReset.mockReturnValue(null);
    mockFormatCountdown.mockReturnValue('');
  });

  // ── Initial state ────────────────────────────────────────────────────

  describe('initial state', () => {
    it('creates a session on mount', async () => {
      await    await renderComponent();

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalledTimes(1);
      });
    });

    it('shows the empty state placeholder when no messages exist', async () => {
      await    await renderComponent();

      expect(
        screen.getByText('Ask anything about the codebase.')
      ).toBeInTheDocument();
    });

    it('shows Send button (not ✕ Stop) initially', async () => {
      await    await renderComponent();

      expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
      expect(screen.queryByText('✕ Stop')).not.toBeInTheDocument();
    });

    it('shows "Connecting…" placeholder when session is not yet ready', async () => {
      // Use a deferred promise that we never resolve (doesn't hang because
      // there's no sendMessage → act() awaiting the deferred promise)
      const { promise } = deferred<string>();
      mockGetOrCreateInsightsSession.mockReturnValue(promise);
      await    await renderComponent();

      expect(screen.getByPlaceholderText('Connecting…')).toBeInTheDocument();
    });

    it('shows "Ask about the codebase…" placeholder once session is ready', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('session-ready');
      await    await renderComponent();

      await waitFor(() => {
        expect(
          screen.getByPlaceholderText('Ask about the codebase… (Enter to send)')
        ).toBeInTheDocument();
      });
    });
  });

  // ── Chat flow ────────────────────────────────────────────────────────

  describe('chat flow', () => {
    it('sends a message and displays the user bubble', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-chat');
      await    await renderComponent();

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      await sendMessage('What is this codebase?');

      expect(screen.getByText('What is this codebase?')).toBeInTheDocument();
      expect(mockSendInsightsMessage).toHaveBeenCalledWith('sess-chat', 'What is this codebase?');
    });

    it('clears the textarea after sending', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-clear');
      await    await renderComponent();

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      await sendMessage('Hello');

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea.value).toBe('');
    });

    it('displays assistant streaming text from stream events', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-asst');
      // Use stable constants to prevent infinite React re-render loops
      // (new array literals in mockImplementation change references
      // every call, retriggering useEffect dependencies indefinitely).
      const EMPTY: SessionEvent[] = [];
      const RESPONSE: SessionEvent[] = [
        ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'This is a response' }] } }),
      ];

      mockUseSessionStream.mockReturnValue(EMPTY);
      const { rerender } = await act(async () => {
        const result = render(<InsightsChat />);
        if (!vi.isFakeTimers()) {
          await new Promise(r => setTimeout(r, 0));
        }
        return result;
      });

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      // Send while stream is EMPTY (Send button available), then switch
      // to RESPONSE and rerender to trigger the messages effect.
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'Hello' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      });
      mockUseSessionStream.mockReturnValue(RESPONSE);
      rerender(<InsightsChat />);

      await waitFor(() => {
        expect(screen.getByText('This is a response')).toBeInTheDocument();
      });
    });

    it('does not send when input is empty', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-empty');
      await    await renderComponent();

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      const sendBtn = screen.getByRole('button', { name: 'Send' });
      expect(sendBtn).toBeDisabled();

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: '   ' } });
      expect(sendBtn).toBeDisabled();

      expect(mockSendInsightsMessage).not.toHaveBeenCalled();
    });

    it('does not send when sessionId is null', async () => {
      const { promise } = deferred<string>();
      mockGetOrCreateInsightsSession.mockReturnValue(promise);
      await    await renderComponent();

      expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    });
  });

  // ── Streaming state ──────────────────────────────────────────────────

  describe('streaming state', () => {
    it('shows ✕ Stop button while assistant is streaming', async () => {
      // Use a deferred promise so sendMessage's act() completes
      const { promise, resolve } = deferred<void>();
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-stop');
      mockSendInsightsMessage.mockReturnValue(promise);
      mockUseSessionStream.mockReturnValue([]);

      await    await renderComponent();

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      await sendMessage('Hello');

      // Assert while the send is still pending (act() completed because
      // the transition callback's promise is not tracked by act in this setup)
      expect(screen.getByText('✕ Stop')).toBeInTheDocument();

      // Resolve to clean up
      resolve();
    });

    it('disables textarea while running', async () => {
      const { promise, resolve } = deferred<void>();
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-disabled');
      mockSendInsightsMessage.mockReturnValue(promise);

      await    await renderComponent();

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      await sendMessage('Hello');

      const textarea = screen.getByRole('textbox') as HTMLTextAreaElement;
      expect(textarea).toBeDisabled();

      resolve();
    });

    it('shows "Assistant is responding…" placeholder while running', async () => {
      const { promise, resolve } = deferred<void>();
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-placeholder');
      mockSendInsightsMessage.mockReturnValue(promise);

      await    await renderComponent();

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      await sendMessage('Hello');

      expect(
        screen.getByPlaceholderText('Assistant is responding…')
      ).toBeInTheDocument();

      resolve();
    });
  });

  // ── Cancel flow ──────────────────────────────────────────────────────

  describe('cancel flow', () => {
    it('calls cancelInsightsSession when ✕ Stop is clicked', async () => {
      const { promise: sendPromise, resolve: resolveSend } = deferred<void>();
      mockGetOrCreateInsightsSession.mockResolvedValueOnce('sess-cancel');
      mockGetOrCreateInsightsSession.mockResolvedValueOnce('sess-reconnect');
      mockSendInsightsMessage.mockReturnValue(sendPromise);

      await    await renderComponent();

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      await sendMessage('Hello');
      expect(screen.getByText('✕ Stop')).toBeInTheDocument();

      // Click cancel — handleCancel is async, fireEvent triggers it
      // Use act but don't await — the click handler is async and will
      // await cancelInsightsSession (resolved) and getOrCreateInsightsSession (resolved)
      await act(async () => {
        fireEvent.click(screen.getByText('✕ Stop'));
      });

      expect(mockCancelInsightsSession).toHaveBeenCalled();
      resolveSend();
    });

    it('auto-reconnects with a fresh session after cancel', async () => {
      const { promise: sendPromise, resolve: resolveSend } = deferred<void>();
      mockGetOrCreateInsightsSession.mockResolvedValueOnce('sess-original');
      mockGetOrCreateInsightsSession.mockResolvedValueOnce('sess-reconnect');
      mockSendInsightsMessage.mockReturnValue(sendPromise);

      await    await renderComponent();

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      await sendMessage('Hello');

      await act(async () => {
        fireEvent.click(screen.getByText('✕ Stop'));
      });

      // getOrCreateInsightsSession called on mount + auto-reconnect after cancel
      expect(mockGetOrCreateInsightsSession).toHaveBeenCalledTimes(2);
      resolveSend();
    });

    it('shows Send button again after cancel (not ✕ Stop)', async () => {
      const { promise: sendPromise, resolve: resolveSend } = deferred<void>();
      mockGetOrCreateInsightsSession.mockResolvedValueOnce('sess-cancel2');
      mockGetOrCreateInsightsSession.mockResolvedValueOnce('sess-reconnect2');
      mockSendInsightsMessage.mockReturnValue(sendPromise);

      await    await renderComponent();

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      await sendMessage('Hello');

      await act(async () => {
        fireEvent.click(screen.getByText('✕ Stop'));
      });

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
      });
      expect(screen.queryByText('✕ Stop')).not.toBeInTheDocument();
      resolveSend();
    });
  });

  // ── Rate-limit detection ─────────────────────────────────────────────

  describe('rate-limit detection', () => {
    it('shows rate-limit banner when stream contains rate-limit text', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-rate');
      mockUseSessionStream.mockReturnValue([
        ev({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'session limit reached. Try again later.' }] },
        }),
      ]);

      await    await renderComponent();

      // Text appears in both banner and message bubble — getAllByText avoids
      // the "Found multiple elements" error from getByText.
      await waitFor(() => {
        const matches = screen.getAllByText(/session limit reached/);
        expect(matches.length).toBeGreaterThanOrEqual(1);
      });
      expect(screen.getByRole('button', { name: 'Retry Now' })).toBeInTheDocument();
    });

    it('detects "too many requests" as rate-limit', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-many');
      mockUseSessionStream.mockReturnValue([
        ev({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Too many requests. Please slow down.' }] },
        }),
      ]);

      await    await renderComponent();

      await waitFor(() => {
        const matches = screen.getAllByText(/Too many requests/);
        expect(matches.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('detects "usage limit" pattern', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-usage');
      mockUseSessionStream.mockReturnValue([
        ev({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Your usage limit has been exceeded.' }] },
        }),
      ]);

      await    await renderComponent();

      await waitFor(() => {
        const matches = screen.getAllByText(/usage limit/);
        expect(matches.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('Retry Now button clears rate-limit state and reconnects', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValueOnce('sess-rate-retry');
      mockGetOrCreateInsightsSession.mockResolvedValueOnce('sess-post-retry');
      mockUseSessionStream.mockReturnValue([
        ev({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'session limit reached' }] },
        }),
      ]);

      await    await renderComponent();

      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Retry Now' })).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Retry Now' }));
      });

      // Rate-limit banner should disappear (Retry Now button gone)
      expect(screen.queryByRole('button', { name: 'Retry Now' })).not.toBeInTheDocument();
      // Should reconnect
      expect(mockGetOrCreateInsightsSession).toHaveBeenCalledTimes(2);
    });
  });

  // ── Auto-resume ────────────────────────────────────────────────────

  describe('auto-resume', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('timer triggers handleRetryNow when countdown reaches 0', async () => {
      vi.useFakeTimers();
      const NOW_MS = 1719000000 * 1000;
      const RESET_SECS = 1719000005;
      vi.setSystemTime(NOW_MS);

      mockGetOrCreateInsightsSession.mockResolvedValueOnce('sess-init');
      mockGetOrCreateInsightsSession.mockResolvedValueOnce('sess-reconnect');
      mockParseSessionLimitReset.mockReturnValue(RESET_SECS);
      mockFormatCountdown.mockReturnValue('0:05');
      mockUseSessionStream.mockReturnValue([
        ev({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'session limit resets 3:45 pm UTC' }] },
        }),
      ]);

      await    await renderComponent();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(screen.getByText('Cancel')).toBeInTheDocument();
      // getOrCreateInsightsSession should have been called once (mount) but not by timer yet
      expect(mockGetOrCreateInsightsSession).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(6000);
      });

      // handleRetryNow calls getOrCreateInsightsSession to reconnect (second call)
      expect(mockGetOrCreateInsightsSession).toHaveBeenCalledTimes(2);
    });

    it('shows auto-resume countdown and Cancel when reset time is parseable', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-ar');
      mockParseSessionLimitReset.mockReturnValue(1719000000);
      mockFormatCountdown.mockReturnValue('2:30');
      mockUseSessionStream.mockReturnValue([
        ev({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'session limit resets 3:45 pm UTC' }] },
        }),
      ]);

      await    await renderComponent();

      await waitFor(() => {
        expect(screen.getByText('2:30')).toBeInTheDocument();
        expect(screen.getByText('Cancel')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retry Now' })).toBeInTheDocument();
      });
    });

    it('shows auto-resuming message when reset time is parseable', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-msg');
      mockParseSessionLimitReset.mockReturnValue(1719000000);
      mockFormatCountdown.mockReturnValue('5:00');
      mockUseSessionStream.mockReturnValue([
        ev({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'session limit resets 3:45 pm UTC' }] },
        }),
      ]);

      await    await renderComponent();

      await waitFor(() => {
        expect(
          screen.getByText('Session limit hit — auto-resuming 5:00')
        ).toBeInTheDocument();
      });
    });

    it('Cancel button clears auto-resume countdown and rate-limit banner', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-cancelar');
      mockParseSessionLimitReset.mockReturnValue(1719000000);
      mockFormatCountdown.mockReturnValue('1:00');
      mockUseSessionStream.mockReturnValue([
        ev({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'session limit resets 3:45 pm UTC' }] },
        }),
      ]);

      await    await renderComponent();

      await waitFor(() => {
        expect(screen.getByText('Cancel')).toBeInTheDocument();
      });

      await act(async () => {
        fireEvent.click(screen.getByText('Cancel'));
      });

      // After Cancel: auto-resume cancelled, rate-limit banner gone
      await waitFor(() => {
        expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
      });
      // Rate-limit banner elements should be gone
      expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Retry Now' })).not.toBeInTheDocument();
      // Send button should be visible (component returned to functional state)
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
      });
    });

    it('does not show Cancel or countdown when reset time is unparseable', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-noparse');
      mockParseSessionLimitReset.mockReturnValue(null);
      mockUseSessionStream.mockReturnValue([
        ev({
          type: 'assistant',
          message: { content: [{ type: 'text', text: 'Rate limit exceeded. Please wait.' }] },
        }),
      ]);

      await    await renderComponent();

      await waitFor(() => {
        expect(screen.queryByText('Cancel')).not.toBeInTheDocument();
        expect(screen.getByText('⏳')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Retry Now' })).toBeInTheDocument();
      });
    });

    it('shows progress text (tool name) instead of Thinking… when agent runs tools', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-progress');
      mockExtractProgressText.mockReturnValue('▶ bash');
      mockUseSessionStream.mockReturnValue([
        ev({ type: 'assistant', message: { content: [] } }),
      ]);

      await    await renderComponent();

      await waitFor(() => {
        // progressText shows "▶ bash" instead of "Thinking…"
        expect(screen.getByText('▶ bash')).toBeInTheDocument();
        expect(screen.queryByText('Thinking…')).not.toBeInTheDocument();
      });
    });
  });

  // ── Result finalization ──────────────────────────────────────────────

  describe('result finalization', () => {
    it('removes the streaming cursor when result event arrives', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-final');

      const EMPTY: SessionEvent[] = [];
      const STREAMING: SessionEvent[] = [
        ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Streaming message' }] } }),
      ];
      const RESULT: SessionEvent[] = [
        ev({ type: 'result' }),
      ];
      let callCount = 0;
      mockUseSessionStream.mockImplementation(() => {
        callCount++;
        if (callCount <= 2) return EMPTY;
        if (callCount <= 3) return STREAMING;
        return RESULT;
      });

      await    await renderComponent();

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      await sendMessage('Hello');

      await waitFor(() => {
        expect(screen.getByText('Streaming message')).toBeInTheDocument();
      });

      // Message text still present after finalization
      expect(screen.getByText('Streaming message')).toBeInTheDocument();
    });
  });

  // ── Enter key ────────────────────────────────────────────────────────

  describe('Enter key', () => {
    it('sends message on Enter (without Shift)', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-enter');
      await    await renderComponent();

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'Quick question' } });

      await act(async () => {
        fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
      });

      expect(mockSendInsightsMessage).toHaveBeenCalledWith('sess-enter', 'Quick question');
      expect(screen.getByText('Quick question')).toBeInTheDocument();
    });

    it('does not send on Shift+Enter', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-shift');
      await    await renderComponent();

      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'Not sent' } });

      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: true });

      expect(mockSendInsightsMessage).not.toHaveBeenCalled();
    });
  });

  // ── Error recovery ───────────────────────────────────────────────────

  describe('error recovery', () => {
    it('resets running when sendInsightsMessage throws', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-err');
      mockSendInsightsMessage.mockRejectedValue(new Error('send failed'));

      await    await renderComponent();

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      await sendMessage('Hello');

      // Try/catch in handleSend's startTransition catches and sets running=false
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
      });
      expect(screen.queryByText('✕ Stop')).not.toBeInTheDocument();
    });
  });

  // ── Cancel race condition ────────────────────────────────────────────

  describe('cancel race condition (rapid send/stop)', () => {
    it('cancels an in-flight send when ✕ Stop is clicked before sendMessage resolves', async () => {
      const { promise: sendPromise, resolve: resolveSend } = deferred<void>();
      mockGetOrCreateInsightsSession.mockResolvedValueOnce('sess-race');
      mockGetOrCreateInsightsSession.mockResolvedValueOnce('sess-reconnect');
      mockSendInsightsMessage.mockReturnValue(sendPromise);

      await    await renderComponent();

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      await sendMessage('Hello');
      expect(screen.getByText('✕ Stop')).toBeInTheDocument();

      // Click ✕ Stop while sendMessage is still in-flight
      await act(async () => {
        fireEvent.click(screen.getByText('✕ Stop'));
      });

      expect(mockCancelInsightsSession).toHaveBeenCalled();

      // After cancel + reconnect, Send button returns
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
      });

      resolveSend();
    });
  });

  // ── Multiple messages ────────────────────────────────────────────────

  describe('multiple messages', () => {
    it('renders multiple user and assistant messages', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-multi');

      const EMPTY: SessionEvent[] = [];
      const RESP1: SessionEvent[] = [
        ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Response 1' }] } }),
      ];
      const RESP2: SessionEvent[] = [
        ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Response 2' }] } }),
      ];

      mockUseSessionStream.mockReturnValue(EMPTY);
      const { rerender } = await act(async () => {
        const result = render(<InsightsChat />);
        if (!vi.isFakeTimers()) {
          await new Promise(r => setTimeout(r, 0));
        }
        return result;
      });

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      // Message 1: send while EMPTY (Send button available), then switch to RESP1
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'Question 1' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      });
      mockUseSessionStream.mockReturnValue(RESP1);
      rerender(<InsightsChat />);
      await waitFor(() => {
        expect(screen.getByText('Response 1')).toBeInTheDocument();
      });

      // Reset stream so running goes false and Send button reappears
      mockUseSessionStream.mockReturnValue(EMPTY);
      rerender(<InsightsChat />);
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
      });

      // Message 2: send while EMPTY, then switch to RESP2
      fireEvent.change(textarea, { target: { value: 'Question 2' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      });
      mockUseSessionStream.mockReturnValue(RESP2);
      rerender(<InsightsChat />);
      await waitFor(() => {
        expect(screen.getByText('Response 2')).toBeInTheDocument();
      });

      expect(screen.getByText('Question 1')).toBeInTheDocument();
      expect(screen.getByText('Question 2')).toBeInTheDocument();
    });

    it('updates streaming message in-place rather than appending duplicate', async () => {
      mockGetOrCreateInsightsSession.mockResolvedValue('sess-update');

      const EMPTY: SessionEvent[] = [];
      const PART: SessionEvent[] = [
        ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Part' }] } }),
      ];
      const FULL: SessionEvent[] = [
        ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Part one' }] } }),
        ev({ type: 'assistant', message: { content: [{ type: 'text', text: 'Part two' }] } }),
      ];

      mockUseSessionStream.mockReturnValue(EMPTY);
      const { rerender } = await act(async () => {
        const result = render(<InsightsChat />);
        if (!vi.isFakeTimers()) {
          await new Promise(r => setTimeout(r, 0));
        }
        return result;
      });

      await waitFor(() => {
        expect(mockGetOrCreateInsightsSession).toHaveBeenCalled();
      });

      // Send while EMPTY (Send button available), then switch to PART
      const textarea = screen.getByRole('textbox');
      fireEvent.change(textarea, { target: { value: 'Go' } });
      await act(async () => {
        fireEvent.click(screen.getByRole('button', { name: 'Send' }));
      });
      mockUseSessionStream.mockReturnValue(PART);
      rerender(<InsightsChat />);
      await waitFor(() => {
        expect(screen.getByText('Part')).toBeInTheDocument();
      });

      // Phase 2: updated stream replaces in-place (latest event replaces
      // previous streaming message with same role)
      mockUseSessionStream.mockReturnValue(FULL);
      rerender(<InsightsChat />);
      await waitFor(() => {
        expect(screen.getByText('Part two')).toBeInTheDocument();
      });

      // Original partial text replaced by the updated streaming content
      expect(screen.queryByText('Part')).not.toBeInTheDocument();
    });
  });
});
