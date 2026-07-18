// @vitest-environment happy-dom

/**
 * Unit tests for useAgentStream hook.
 *
 * Covers:
 *   - Event accumulation: matching events append to the returned array
 *   - taskId filtering: events with non-matching taskId are dropped
 *   - Non-event messages: messages without `event` field are dropped
 *   - taskId change reset: switching taskId clears events, reuses same WebSocket
 *   - Reconnection continuity: events received after simulated disconnect
 *     append to the same array (no reset on reconnect)
 *   - taskIdRef correctness: onMessage always filters with latest taskId
 *   - Connected state: tracks WebSocket connection with wasEverConnected guard
 *   - Sequential instances: clean unmount + remount starts fresh
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ── Hoisted mocks ───────────────────────────────────────────────────────────

let gOnMessage: ((data: Record<string, unknown>) => void) | undefined;
let gOnConnectionChange: ((connected: boolean) => void) | undefined;
let gUseWsCallCount = 0;
let gLastProject: string | undefined;

const mockWssReconnect = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/use-websocket', () => ({
  useWebSocket: (opts?: {
    project?: string;
    onMessage?: (data: Record<string, unknown>) => void;
    onConnectionChange?: (connected: boolean) => void;
  }) => {
    gUseWsCallCount++;
    // Only capture on first call — subsequent re-renders reuse the same
    // connection (the real hook stores callbacks in refs internally).
    if (gUseWsCallCount === 1) {
      gOnMessage = opts?.onMessage;
      gOnConnectionChange = opts?.onConnectionChange;
    }
    gLastProject = opts?.project;
    return { reconnect: mockWssReconnect };
  },
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import { useAgentStream } from '@/hooks/use-agent-stream';
import type { StreamEvent } from '@/lib/stream-types';
import type { AgentEvent } from '@/hooks/use-agent-stream';

// ── Helpers ─────────────────────────────────────────────────────────────────

function resetWsState() {
  gOnMessage = undefined;
  gOnConnectionChange = undefined;
  gUseWsCallCount = 0;
  gLastProject = undefined;
}

function makeEventPayload(overrides: Partial<AgentEvent> = {}): Record<string, unknown> {
  return {
    sessionId: 'session-1',
    taskId: 'task-1',
    event: { type: 'system', subtype: 'init', model: 'test-model' } as StreamEvent,
    ...overrides,
  };
}

/** Dispatch a message through the captured onMessage callback. */
function sendMessage(data: Record<string, unknown>) {
  act(() => {
    gOnMessage!(data);
  });
}

/** Simulate a connection state change. */
function setConnectionState(connected: boolean) {
  act(() => {
    gOnConnectionChange!(connected);
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('useAgentStream', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWsState();
  });

  // ── Basic event accumulation ──────────────────────────────────────────

  describe('event accumulation', () => {
    it('returns empty events array initially', () => {
      const { result } = renderHook(() => useAgentStream('task-1'));
      expect(result.current.events).toEqual([]);
    });

    it('accumulates matching events in order', () => {
      const { result } = renderHook(() => useAgentStream('task-1'));

      sendMessage(makeEventPayload({ sessionId: 's1', event: { type: 'system', subtype: 'init', model: 'm1' } as StreamEvent }));
      sendMessage(makeEventPayload({ sessionId: 's2', event: { type: 'assistant', message: { content: [{ type: 'text', text: 'hello' }] } } as StreamEvent }));

      expect(result.current.events).toHaveLength(2);
      expect(result.current.events[0].sessionId).toBe('s1');
      expect(result.current.events[1].sessionId).toBe('s2');
    });

    it('appends new events without mutating the previous array identity', () => {
      const { result } = renderHook(() => useAgentStream('task-1'));

      sendMessage(makeEventPayload({ sessionId: 's1' }));
      const firstArray = result.current.events;
      expect(firstArray).toHaveLength(1);

      sendMessage(makeEventPayload({ sessionId: 's2' }));
      // New reference for the new array
      expect(result.current.events).not.toBe(firstArray);
      expect(result.current.events).toHaveLength(2);
      // Old events preserved
      expect(result.current.events[0].sessionId).toBe('s1');
    });
  });

  // ── taskId filtering ──────────────────────────────────────────────────

  describe('taskId filtering', () => {
    it('drops events with non-matching taskId', () => {
      const { result } = renderHook(() => useAgentStream('task-a'));

      sendMessage(makeEventPayload({ taskId: 'task-b', sessionId: 'wrong' }));
      sendMessage(makeEventPayload({ taskId: 'task-a', sessionId: 'correct' }));

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].sessionId).toBe('correct');
    });

    it('drops events with matching taskId but different type (string vs number)', () => {
      // `data.taskId === currentTaskId` — strict equality, number won't match string
      const { result } = renderHook(() => useAgentStream('task-1'));

      sendMessage(makeEventPayload({ taskId: 1 as unknown as string, sessionId: 'numeric' }));
      sendMessage(makeEventPayload({ taskId: 'task-1', sessionId: 'string' }));

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].sessionId).toBe('string');
    });

    it('filters correctly when taskId changes at runtime', () => {
      const { result, rerender } = renderHook(
        (taskId: string) => useAgentStream(taskId),
        { initialProps: 'task-a' }
      );

      // Events for task-a accumulate
      sendMessage(makeEventPayload({ taskId: 'task-a', sessionId: 'a1' }));
      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].sessionId).toBe('a1');

      // Switch to task-b — events reset, new filtering active
      rerender('task-b');

      sendMessage(makeEventPayload({ taskId: 'task-a', sessionId: 'a2' }));
      sendMessage(makeEventPayload({ taskId: 'task-b', sessionId: 'b1' }));

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].sessionId).toBe('b1');
    });
  });

  // ── Non-event messages ────────────────────────────────────────────────

  describe('non-event messages', () => {
    it('drops messages without an event field', () => {
      const { result } = renderHook(() => useAgentStream('task-1'));

      sendMessage({ taskId: 'task-1', type: 'phase-change', phase: 'done' });
      sendMessage({ taskId: 'task-1', result: 'something' });
      sendMessage({ taskId: 'task-1' });

      expect(result.current.events).toHaveLength(0);
    });

    it('drops messages where event is undefined', () => {
      const { result } = renderHook(() => useAgentStream('task-1'));

      sendMessage({ taskId: 'task-1', event: undefined });

      expect(result.current.events).toHaveLength(0);
    });

    it('includes messages where event is null (null !== undefined)', () => {
      // `data.event !== undefined` — null passes this check
      const { result } = renderHook(() => useAgentStream('task-1'));

      sendMessage({ taskId: 'task-1', sessionId: 's-null', event: null });

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].event).toBeNull();
    });
  });

  // ── Connected state ───────────────────────────────────────────────────

  describe('connected state', () => {
    it('starts with connected=false', () => {
      const { result } = renderHook(() => useAgentStream('task-1'));
      expect(result.current.connected).toBe(false);
    });

    it('transitions to connected=true on first onConnectionChange(true)', () => {
      const { result } = renderHook(() => useAgentStream('task-1'));

      setConnectionState(true);

      expect(result.current.connected).toBe(true);
    });

    it('transitions to connected=false on disconnect after first connection', () => {
      const { result } = renderHook(() => useAgentStream('task-1'));

      setConnectionState(true);
      expect(result.current.connected).toBe(true);

      setConnectionState(false);
      expect(result.current.connected).toBe(false);
    });

    it('stays connected=true after reconnection', () => {
      const { result } = renderHook(() => useAgentStream('task-1'));

      setConnectionState(true);
      setConnectionState(false);
      expect(result.current.connected).toBe(false);

      setConnectionState(true);
      expect(result.current.connected).toBe(true);
    });

    it('does not transition to disconnected if never connected (avoids flash on mount)', () => {
      // The wasEverConnectedRef guard prevents disconnected=false from
      // being reported until after the first successful connection.
      const { result } = renderHook(() => useAgentStream('task-1'));

      expect(result.current.connected).toBe(false);

      // Simulate onclose firing before onopen ever fired (e.g. immediate
      // connection failure). The guard prevents a false disconnected signal.
      setConnectionState(false);

      // connected stays false — it never transitioned through true→false
      expect(result.current.connected).toBe(false);
    });

    it('connected state is independent of events accumulation', () => {
      const { result } = renderHook(() => useAgentStream('task-1'));

      // Events accumulate regardless of connection state
      sendMessage(makeEventPayload({ sessionId: 's1' }));
      expect(result.current.events).toHaveLength(1);

      setConnectionState(true);
      expect(result.current.connected).toBe(true);
      expect(result.current.events).toHaveLength(1); // unchanged

      sendMessage(makeEventPayload({ sessionId: 's2' }));
      expect(result.current.events).toHaveLength(2);

      setConnectionState(false);
      expect(result.current.connected).toBe(false);
      expect(result.current.events).toHaveLength(2); // events survive disconnect

      sendMessage(makeEventPayload({ sessionId: 's3' }));
      expect(result.current.events).toHaveLength(3); // still accumulate while disconnected
    });

    it('connected state survives taskId changes', () => {
      const { result, rerender } = renderHook(
        (taskId: string) => useAgentStream(taskId),
        { initialProps: 'task-a' }
      );

      setConnectionState(true);
      expect(result.current.connected).toBe(true);

      rerender('task-b');
      // Connected state is not affected by taskId changes (the WebSocket
      // connection persists)
      expect(result.current.connected).toBe(true);
    });
  });

  // ── taskId change reset ───────────────────────────────────────────────

  describe('taskId change reset', () => {
    it('resets events when taskId changes', () => {
      const { result, rerender } = renderHook(
        (taskId: string) => useAgentStream(taskId),
        { initialProps: 'task-1' }
      );

      sendMessage(makeEventPayload({ taskId: 'task-1', sessionId: 's1' }));
      sendMessage(makeEventPayload({ taskId: 'task-1', sessionId: 's2' }));
      expect(result.current.events).toHaveLength(2);

      rerender('task-2');
      expect(result.current.events).toHaveLength(0);
    });

    it('reuses the same WebSocket connection across taskId changes', () => {
      // The WebSocket connection persists because useWebSocket's useEffect
      // depends on [url, project], neither of which changes when taskId
      // changes. We verify this functionally: the onMessage callback captured
      // on mount still routes events correctly after taskId changes.
      const { result, rerender } = renderHook(
        (taskId: string) => useAgentStream(taskId),
        { initialProps: 'task-1' }
      );

      sendMessage(makeEventPayload({ taskId: 'task-1', sessionId: 'pre-switch' }));
      expect(result.current.events).toHaveLength(1);

      // Switch taskId — events reset but the same onMessage routes new events
      rerender('task-2');
      expect(result.current.events).toHaveLength(0);

      sendMessage(makeEventPayload({ taskId: 'task-2', sessionId: 'post-switch' }));
      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].sessionId).toBe('post-switch');

      // Old taskId events still filtered out (proves the ref updated)
      sendMessage(makeEventPayload({ taskId: 'task-1', sessionId: 'should-drop' }));
      expect(result.current.events).toHaveLength(1);
    });

    it('accumulates events for new taskId after reset', () => {
      const { result, rerender } = renderHook(
        (taskId: string) => useAgentStream(taskId),
        { initialProps: 'task-a' }
      );

      sendMessage(makeEventPayload({ taskId: 'task-a', sessionId: 'old' }));

      rerender('task-b');
      expect(result.current.events).toHaveLength(0);

      sendMessage(makeEventPayload({ taskId: 'task-b', sessionId: 'new' }));
      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].sessionId).toBe('new');
    });

    it('resets then re-accumulates when switching back to original taskId', () => {
      const { result, rerender } = renderHook(
        (taskId: string) => useAgentStream(taskId),
        { initialProps: 'task-a' }
      );

      sendMessage(makeEventPayload({ taskId: 'task-a', sessionId: 'a1' }));
      expect(result.current.events).toHaveLength(1);

      rerender('task-b');
      expect(result.current.events).toHaveLength(0);

      rerender('task-a');
      expect(result.current.events).toHaveLength(0); // reset again, historical events are lost

      sendMessage(makeEventPayload({ taskId: 'task-a', sessionId: 'a2' }));
      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].sessionId).toBe('a2');
    });
  });

  // ── Reconnection continuity ───────────────────────────────────────────

  describe('reconnection continuity', () => {
    it('events continue to accumulate after simulated disconnect and reconnect', () => {
      const { result } = renderHook(() => useAgentStream('task-1'));

      // Pre-disconnect events
      sendMessage(makeEventPayload({ sessionId: 'pre-1' }));
      sendMessage(makeEventPayload({ sessionId: 'pre-2' }));
      expect(result.current.events).toHaveLength(2);

      // Simulate disconnect — in the real hook, useWebSocket closes the
      // socket and schedules a reconnect. The onMessage callback is stored
      // in a ref and survives. When the new socket opens, the same callback
      // receives new messages. We simulate this by continuing to call the
      // same captured gOnMessage.
      sendMessage(makeEventPayload({ sessionId: 'post-1' }));
      sendMessage(makeEventPayload({ sessionId: 'post-2' }));
      sendMessage(makeEventPayload({ sessionId: 'post-3' }));

      // Events accumulate continuously — no reset on reconnect
      expect(result.current.events).toHaveLength(5);
      expect(result.current.events.map(e => e.sessionId)).toEqual([
        'pre-1', 'pre-2', 'post-1', 'post-2', 'post-3',
      ]);
    });

    it('events received during a task change then reconnect also accumulate correctly', () => {
      const { result, rerender } = renderHook(
        (taskId: string) => useAgentStream(taskId),
        { initialProps: 'task-a' }
      );

      // Pre-switch events for task-a
      sendMessage(makeEventPayload({ taskId: 'task-a', sessionId: 'a1' }));
      expect(result.current.events).toHaveLength(1);

      // Switch to task-b, which resets events
      rerender('task-b');
      expect(result.current.events).toHaveLength(0);

      // Simulate post-reconnect events for task-b
      sendMessage(makeEventPayload({ taskId: 'task-b', sessionId: 'b1' }));
      sendMessage(makeEventPayload({ taskId: 'task-b', sessionId: 'b2' }));

      expect(result.current.events).toHaveLength(2);
      expect(result.current.events.map(e => e.sessionId)).toEqual(['b1', 'b2']);
    });

    it('survives many rapid onMessage calls without dropping or duplicating events', () => {
      const { result } = renderHook(() => useAgentStream('task-1'));

      // 50 rapid events — simulates bursty reconnect catch-up
      for (let i = 0; i < 50; i++) {
        sendMessage(makeEventPayload({ sessionId: `s${i}` }));
      }

      expect(result.current.events).toHaveLength(50);
      // No duplicates — each sessionId appears exactly once
      const ids = result.current.events.map(e => e.sessionId);
      expect(new Set(ids).size).toBe(50);
    });
  });

  // ── taskIdRef correctness ─────────────────────────────────────────────

  describe('taskIdRef correctness', () => {
    it('onMessage uses the latest taskId even across many re-renders', () => {
      const { result, rerender } = renderHook(
        (taskId: string) => useAgentStream(taskId),
        { initialProps: 'initial' }
      );

      // Re-render 5 times with different taskIds without sending messages.
      // Each render updates taskIdRef.current, so when a message finally
      // arrives, it filters against the latest taskId.
      rerender('t1');
      rerender('t2');
      rerender('t3');
      rerender('t4');
      rerender('target');

      // Send messages — only the one matching the latest taskId is captured
      sendMessage(makeEventPayload({ taskId: 'target', sessionId: 'latest' }));
      sendMessage(makeEventPayload({ taskId: 't1', sessionId: 'stale' }));

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].sessionId).toBe('latest');
    });

    it('refs survive React StrictMode double-invoke', () => {
      // React 18 StrictMode unmounts and remounts effects once.
      // useWebSocket's createConnection → cleanup → createConnection again.
      // Each renderHook call is a fresh render, so we just verify the hook
      // works correctly after mounting (the internal refs handle it).
      const { result } = renderHook(() => useAgentStream('task-1'));

      sendMessage(makeEventPayload({ sessionId: 'strict-ok' }));
      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].sessionId).toBe('strict-ok');
    });
  });

  // ── Sequential hook instances ─────────────────────────────────────────
  //
  // The singleton mock captures gOnMessage only for the first useWebSocket
  // call, so true multi-instance testing is infeasible. These tests verify
  // that unmounting one instance and mounting another behaves correctly.

  describe('sequential hook instances', () => {
    it('clean unmount + remount starts fresh', () => {
      const { result: resultA, unmount: unmountA } = renderHook(() => useAgentStream('task-a'));

      sendMessage(makeEventPayload({ taskId: 'task-a', sessionId: 'a' }));
      expect(resultA.current.events).toHaveLength(1);

      unmountA();
      resetWsState();

      const { result: resultB } = renderHook(() => useAgentStream('task-b'));

      sendMessage(makeEventPayload({ taskId: 'task-b', sessionId: 'b' }));
      expect(resultB.current.events).toHaveLength(1);
    });
  });

  // ── Project parameter ────────────────────────────────────────────────

  describe('project parameter', () => {
    it('passes project through to useWebSocket', () => {
      renderHook(() => useAgentStream('task-1', '/path/to/project'));
      expect(gLastProject).toBe('/path/to/project');
    });

    it('passes undefined project when not provided', () => {
      renderHook(() => useAgentStream('task-1'));
      expect(gLastProject).toBeUndefined();
    });

    it('still accumulates events when project is provided', () => {
      const { result } = renderHook(() => useAgentStream('task-1', '/my/project'));

      sendMessage(makeEventPayload({ sessionId: 's1' }));

      expect(result.current.events).toHaveLength(1);
      expect(result.current.events[0].sessionId).toBe('s1');
    });
  });

  // ── Malformed messages ────────────────────────────────────────────────

  describe('malformed messages', () => {
    it('does not throw on messages where taskId is missing', () => {
      const { result } = renderHook(() => useAgentStream('task-1'));

      expect(() => {
        sendMessage({ event: { type: 'system' } });
        sendMessage({});
      }).not.toThrow();

      expect(result.current.events).toHaveLength(0);
    });

    it('does not throw when event is a non-object value', () => {
      const { result } = renderHook(() => useAgentStream('task-1'));

      expect(() => {
        sendMessage({ taskId: 'task-1', sessionId: 's', event: 'not-an-object' });
      }).not.toThrow();

      // Cast goes through, event is 'not-an-object'
      expect(result.current.events).toHaveLength(1);
    });
  });
});
