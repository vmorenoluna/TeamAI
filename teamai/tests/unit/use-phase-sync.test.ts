// @vitest-environment happy-dom

/**
 * Unit tests for usePhaseSync hook.
 *
 * Tests WebSocket message handling: phase-change events dispatch the
 * onPhaseChange callback + router.refresh(), subtask-progress events
 * either dispatch onSubtaskProgress (targeted update, no refresh) or
 * fall back to router.refresh(), other message types are ignored,
 * connection change forwarding, reconnect passthrough, and edge cases
 * (no opts, missing callbacks, ref stability).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

const mockRouterRefresh = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

/**
 * The useWebSocket mock captures onMessage / onConnectionChange only on the
 * FIRST call (simulating a real WebSocket that subscribes once).  Later
 * re-renders that pass new callbacks should NOT update the captured
 * references — the hook's own ref-based plumbing is what routes events to
 * the latest callback.  Tests that need to simulate callback replacement
 * can explicitly call `setOnMessage` / `setOnConnectionChange`.
 */
let gOnMessage: ((data: Record<string, unknown>) => void) | undefined;
let gOnConnectionChange: ((connected: boolean) => void) | undefined;
const mockWssReconnect = vi.hoisted(() => vi.fn());
let gUseWsCallCount = 0;

vi.mock('@/hooks/use-websocket', () => ({
  useWebSocket: (opts?: {
    onMessage?: (data: Record<string, unknown>) => void;
    onConnectionChange?: (connected: boolean) => void;
  }) => {
    gUseWsCallCount++;
    // Only capture on first call — subsequent re-renders don't re-subscribe
    if (gUseWsCallCount === 1) {
      gOnMessage = opts?.onMessage;
      gOnConnectionChange = opts?.onConnectionChange;
    }
    return { reconnect: mockWssReconnect };
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { usePhaseSync } from '@/hooks/use-phase-sync';

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Create a phase-change payload matching the server's wire format. */
function phaseChangePayload(taskId: string, phase: string): Record<string, unknown> {
  return { type: 'phase-change', taskId, phase };
}

/** Reset the module-level state between tests. */
function resetWsCallbacks() {
  gOnMessage = undefined;
  gOnConnectionChange = undefined;
  gUseWsCallCount = 0;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('usePhaseSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWsCallbacks();
    mockRouterRefresh.mockClear();
    mockWssReconnect.mockClear();
  });

  // ── Phase change handling ────────────────────────────────────────────

  describe('phase-change event', () => {
    it('calls onPhaseChange callback with taskId and phase', () => {
      const onPhaseChange = vi.fn();
      renderHook(() => usePhaseSync({ onPhaseChange }));

      expect(gOnMessage).toBeDefined();
      act(() => {
        gOnMessage!(phaseChangePayload('task-42', 'implement'));
      });

      expect(onPhaseChange).toHaveBeenCalledWith('task-42', 'implement');
    });

    it('calls router.refresh after a phase-change', () => {
      renderHook(() => usePhaseSync());

      act(() => {
        gOnMessage!(phaseChangePayload('task-1', 'done'));
      });

      expect(mockRouterRefresh).toHaveBeenCalledOnce();
    });

    it('handles multiple phase-change events in sequence', () => {
      const onPhaseChange = vi.fn();
      renderHook(() => usePhaseSync({ onPhaseChange }));

      act(() => {
        gOnMessage!(phaseChangePayload('t1', 'spec'));
        gOnMessage!(phaseChangePayload('t2', 'plan'));
        gOnMessage!(phaseChangePayload('t1', 'implement'));
      });

      expect(onPhaseChange).toHaveBeenCalledTimes(3);
      expect(onPhaseChange).toHaveBeenNthCalledWith(1, 't1', 'spec');
      expect(onPhaseChange).toHaveBeenNthCalledWith(2, 't2', 'plan');
      expect(onPhaseChange).toHaveBeenNthCalledWith(3, 't1', 'implement');
      expect(mockRouterRefresh).toHaveBeenCalledTimes(3);
    });

    it('can update onPhaseChange callback between renders', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      const { rerender } = renderHook(
        ({ cb }: { cb: (taskId: string, phase: string) => void }) =>
          usePhaseSync({ onPhaseChange: cb }),
        { initialProps: { cb: cb1 } }
      );

      // First event uses cb1
      act(() => {
        gOnMessage!(phaseChangePayload('task-a', 'backlog'));
      });
      expect(cb1).toHaveBeenCalledWith('task-a', 'backlog');
      expect(cb2).not.toHaveBeenCalled();

      // Rerender with cb2 — gOnMessage is the same stable useCallback,
      // but onPhaseChangeRef.current now points to cb2, so the next event
      // routes through the ref to the latest callback.
      rerender({ cb: cb2 });

      act(() => {
        gOnMessage!(phaseChangePayload('task-b', 'spec'));
      });
      expect(cb1).toHaveBeenCalledTimes(1); // not called again
      expect(cb2).toHaveBeenCalledWith('task-b', 'spec');
    });
  });

  // ── Subtask progress event ──────────────────────────────────────────

  describe('subtask-progress event', () => {
    function subtaskProgressPayload(taskId: string, completed: number, total: number): Record<string, unknown> {
      return { type: 'subtask-progress', taskId, completed, total };
    }

    // ── Fallback: no onSubtaskProgress callback → router.refresh() ──

    it('falls back to router.refresh when onSubtaskProgress is not provided', () => {
      renderHook(() => usePhaseSync());

      act(() => {
        gOnMessage!(subtaskProgressPayload('task-1', 3, 7));
      });

      expect(mockRouterRefresh).toHaveBeenCalledOnce();
    });

    it('does NOT call onPhaseChange for subtask-progress (it is not a phase change)', () => {
      const onPhaseChange = vi.fn();
      renderHook(() => usePhaseSync({ onPhaseChange }));

      act(() => {
        gOnMessage!(subtaskProgressPayload('task-5', 2, 4));
      });

      expect(onPhaseChange).not.toHaveBeenCalled();
      expect(mockRouterRefresh).toHaveBeenCalledOnce();
    });

    it('handles multiple subtask-progress events in sequence (fallback)', () => {
      renderHook(() => usePhaseSync());

      act(() => {
        gOnMessage!(subtaskProgressPayload('t1', 1, 5));
        gOnMessage!(subtaskProgressPayload('t1', 2, 5));
        gOnMessage!(subtaskProgressPayload('t1', 3, 5));
        gOnMessage!(subtaskProgressPayload('t2', 4, 4));
      });

      expect(mockRouterRefresh).toHaveBeenCalledTimes(4);
    });

    it('works alongside phase-change events independently (fallback)', () => {
      const onPhaseChange = vi.fn();
      renderHook(() => usePhaseSync({ onPhaseChange }));

      act(() => {
        gOnMessage!(subtaskProgressPayload('task-a', 1, 3));
        gOnMessage!(phaseChangePayload('task-a', 'qa-review'));
        gOnMessage!(subtaskProgressPayload('task-b', 2, 2));
      });

      expect(onPhaseChange).toHaveBeenCalledOnce();
      expect(onPhaseChange).toHaveBeenCalledWith('task-a', 'qa-review');
      expect(mockRouterRefresh).toHaveBeenCalledTimes(3);
    });

    it('falls back when called with no options', () => {
      const { result } = renderHook(() => usePhaseSync());
      expect(result.current.reconnect).toBeDefined();

      act(() => {
        gOnMessage!(subtaskProgressPayload('task-nocb', 5, 10));
      });

      expect(mockRouterRefresh).toHaveBeenCalledOnce();
    });

    it('falls back on subtask-progress with zero total (edge case)', () => {
      renderHook(() => usePhaseSync());

      act(() => {
        gOnMessage!(subtaskProgressPayload('task-empty', 0, 0));
      });

      expect(mockRouterRefresh).toHaveBeenCalledOnce();
    });

    // ── Targeted update: onSubtaskProgress callback provided ──

    it('calls onSubtaskProgress callback with taskId, completed, and total', () => {
      const onSubtaskProgress = vi.fn();
      renderHook(() => usePhaseSync({ onSubtaskProgress }));

      expect(gOnMessage).toBeDefined();
      act(() => {
        gOnMessage!(subtaskProgressPayload('task-42', 3, 5));
      });

      expect(onSubtaskProgress).toHaveBeenCalledWith('task-42', 3, 5);
    });

    it('skips router.refresh when onSubtaskProgress is provided (targeted update)', () => {
      const onSubtaskProgress = vi.fn();
      renderHook(() => usePhaseSync({ onSubtaskProgress }));

      act(() => {
        gOnMessage!(subtaskProgressPayload('task-tgt', 2, 4));
      });

      expect(onSubtaskProgress).toHaveBeenCalledWith('task-tgt', 2, 4);
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('handles multiple subtask-progress events when callback is provided', () => {
      const onSubtaskProgress = vi.fn();
      renderHook(() => usePhaseSync({ onSubtaskProgress }));

      act(() => {
        gOnMessage!(subtaskProgressPayload('t', 1, 3));
        gOnMessage!(subtaskProgressPayload('t', 2, 3));
        gOnMessage!(subtaskProgressPayload('t', 3, 3));
      });

      expect(onSubtaskProgress).toHaveBeenCalledTimes(3);
      expect(onSubtaskProgress).toHaveBeenNthCalledWith(1, 't', 1, 3);
      expect(onSubtaskProgress).toHaveBeenNthCalledWith(2, 't', 2, 3);
      expect(onSubtaskProgress).toHaveBeenNthCalledWith(3, 't', 3, 3);
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('can update onSubtaskProgress callback between renders', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      const { rerender } = renderHook(
        ({ cb }: { cb: (taskId: string, completed: number, total: number) => void }) =>
          usePhaseSync({ onSubtaskProgress: cb }),
        { initialProps: { cb: cb1 } }
      );

      act(() => {
        gOnMessage!(subtaskProgressPayload('task-x', 1, 2));
      });
      expect(cb1).toHaveBeenCalledWith('task-x', 1, 2);
      expect(cb2).not.toHaveBeenCalled();

      rerender({ cb: cb2 });

      act(() => {
        gOnMessage!(subtaskProgressPayload('task-y', 2, 2));
      });
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledWith('task-y', 2, 2);
    });

    it('works alongside phase-change when both callbacks provided', () => {
      const onPhaseChange = vi.fn();
      const onSubtaskProgress = vi.fn();
      renderHook(() => usePhaseSync({ onPhaseChange, onSubtaskProgress }));

      act(() => {
        gOnMessage!(subtaskProgressPayload('task-mix', 1, 3));
        gOnMessage!(phaseChangePayload('task-mix', 'qa-review'));
        gOnMessage!(subtaskProgressPayload('task-mix', 2, 3));
      });

      expect(onSubtaskProgress).toHaveBeenCalledTimes(2);
      expect(onSubtaskProgress).toHaveBeenNthCalledWith(1, 'task-mix', 1, 3);
      expect(onSubtaskProgress).toHaveBeenNthCalledWith(2, 'task-mix', 2, 3);
      expect(onPhaseChange).toHaveBeenCalledOnce();
      expect(onPhaseChange).toHaveBeenCalledWith('task-mix', 'qa-review');
      // phase-change still triggers refresh, subtask-progress does not
      expect(mockRouterRefresh).toHaveBeenCalledOnce();
    });
  });

  // ── Non-phase-change messages ────────────────────────────────────────

  describe('non-phase-change messages', () => {
    it('does not call onPhaseChange for messages without type phase-change', () => {
      const onPhaseChange = vi.fn();
      renderHook(() => usePhaseSync({ onPhaseChange }));

      act(() => {
        gOnMessage!({ type: 'result', taskId: 'x', content: 'done' });
        gOnMessage!({ type: 'assistant', message: 'hello' });
        gOnMessage!({});
        gOnMessage!({ type: 'connection-status', connected: true });
      });

      expect(onPhaseChange).not.toHaveBeenCalled();
    });

    it('does not call router.refresh for non-phase-change messages', () => {
      renderHook(() => usePhaseSync());

      act(() => {
        gOnMessage!({ type: 'result' });
        gOnMessage!({ type: 'system', text: 'hello' });
      });

      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('ignores messages where type is undefined', () => {
      const onPhaseChange = vi.fn();
      renderHook(() => usePhaseSync({ onPhaseChange }));

      // `data.type === 'phase-change'` evaluates to `undefined === 'phase-change'` → false
      act(() => {
        gOnMessage!({ type: undefined });
      });

      // Should not throw, and onPhaseChange should not be called
      expect(onPhaseChange).not.toHaveBeenCalled();
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });
  });

  // ── Connection change forwarding ─────────────────────────────────────

  describe('onConnectionChange forwarding', () => {
    it('calls onConnectionChange with true when WebSocket connects', () => {
      const onConnectionChange = vi.fn();
      renderHook(() => usePhaseSync({ onConnectionChange }));

      expect(gOnConnectionChange).toBeDefined();
      act(() => {
        gOnConnectionChange!(true);
      });

      expect(onConnectionChange).toHaveBeenCalledWith(true);
    });

    it('calls onConnectionChange with false when WebSocket disconnects', () => {
      const onConnectionChange = vi.fn();
      renderHook(() => usePhaseSync({ onConnectionChange }));

      act(() => {
        gOnConnectionChange!(false);
      });

      expect(onConnectionChange).toHaveBeenCalledWith(false);
    });

    it('can update onConnectionChange callback between renders', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();

      const { rerender } = renderHook(
        ({ cb }: { cb: (connected: boolean) => void }) =>
          usePhaseSync({ onConnectionChange: cb }),
        { initialProps: { cb: cb1 } }
      );

      act(() => {
        gOnConnectionChange!(true);
      });
      expect(cb1).toHaveBeenCalledWith(true);
      expect(cb2).not.toHaveBeenCalled();

      // gOnConnectionChange is a stable useCallback with []; ref routes to cb2
      rerender({ cb: cb2 });

      act(() => {
        gOnConnectionChange!(false);
      });
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledWith(false);
    });

    it('handles both phase-change and connection-change callbacks independently', () => {
      const onPhaseChange = vi.fn();
      const onConnectionChange = vi.fn();
      renderHook(() => usePhaseSync({ onPhaseChange, onConnectionChange }));

      act(() => {
        gOnConnectionChange!(true);
        gOnMessage!(phaseChangePayload('task-x', 'qa-review'));
        gOnConnectionChange!(false);
        gOnMessage!(phaseChangePayload('task-y', 'merge'));
      });

      expect(onConnectionChange).toHaveBeenCalledTimes(2);
      expect(onConnectionChange).toHaveBeenNthCalledWith(1, true);
      expect(onConnectionChange).toHaveBeenNthCalledWith(2, false);
      expect(onPhaseChange).toHaveBeenCalledTimes(2);
      expect(onPhaseChange).toHaveBeenNthCalledWith(1, 'task-x', 'qa-review');
      expect(onPhaseChange).toHaveBeenNthCalledWith(2, 'task-y', 'merge');
    });
  });

  // ── Return value ─────────────────────────────────────────────────────

  describe('return value', () => {
    it('returns { reconnect } from useWebSocket', () => {
      const { result } = renderHook(() => usePhaseSync());
      expect(result.current).toEqual({ reconnect: expect.any(Function) });
    });

    it('reconnect calls the underlying useWebSocket reconnect', () => {
      const { result } = renderHook(() => usePhaseSync());

      act(() => {
        result.current.reconnect();
      });

      expect(mockWssReconnect).toHaveBeenCalledOnce();
    });
  });

  // ── Edge cases ───────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('works when called with no options', () => {
      const { result } = renderHook(() => usePhaseSync());

      // Should not throw
      expect(result.current.reconnect).toBeDefined();

      // Phase-change should still trigger router.refresh even without callback
      act(() => {
        gOnMessage!(phaseChangePayload('task-nocb', 'done'));
      });
      expect(mockRouterRefresh).toHaveBeenCalledOnce();
    });

    it('works when called with undefined opts', () => {
      const { result } = renderHook(() => usePhaseSync(undefined));

      expect(result.current.reconnect).toBeDefined();

      // Should not throw on message
      act(() => {
        gOnMessage!(phaseChangePayload('task-undef', 'backlog'));
      });
      expect(mockRouterRefresh).toHaveBeenCalledOnce();
    });

    it('does not throw when onPhaseChange is not provided', () => {
      const { result } = renderHook(() => usePhaseSync({}));

      expect(result.current.reconnect).toBeDefined();

      act(() => {
        gOnMessage!(phaseChangePayload('task-null', 'implement'));
      });
      // router.refresh still called because it's unconditional
      expect(mockRouterRefresh).toHaveBeenCalledOnce();
    });

    it('does not throw when onConnectionChange is not provided', () => {
      const onPhaseChange = vi.fn();
      renderHook(() => usePhaseSync({ onPhaseChange }));

      expect(gOnConnectionChange).toBeDefined();

      // Should not throw when connection state changes
      act(() => {
        gOnConnectionChange!(true);
      });
      expect(onPhaseChange).not.toHaveBeenCalled(); // message not sent
    });

    it('routes events to the latest callback via refs even after re-renders', () => {
      const callbacks: string[] = [];
      // Each render creates a fresh closure; the mock only captured the first.
      // The hook's ref (onPhaseChangeRef.current updated every render) should
      // route the event to the latest closure.
      const { rerender } = renderHook(
        ({ tag }: { tag: string }) =>
          usePhaseSync({
            onPhaseChange: (taskId, phase) => {
              callbacks.push(`${tag}:${taskId}:${phase}`);
            },
          }),
        { initialProps: { tag: 'v1' } }
      );

      // Re-render with a new tag — a new closure, but ref points to it
      rerender({ tag: 'v2' });
      rerender({ tag: 'v3' });

      act(() => {
        gOnMessage!(phaseChangePayload('t', 'done'));
      });

      // The ref-based plumbing routes to v3's closure
      expect(callbacks).toEqual(['v3:t:done']);
    });
  });
});
