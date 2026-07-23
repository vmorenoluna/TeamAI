// @vitest-environment happy-dom

/**
 * Unit tests for useWebSocket's reconnection logic.
 *
 * Regression coverage for the bug where a dropped connection that outlived
 * `maxReconnectAttempts` (exponential backoff, ~90s worst case) gave up
 * permanently — the terminal tab's "Reconnecting…" banner kept showing
 * while no further reconnect attempts were ever made, requiring a manual
 * page reload to recover. Reconnection must now continue indefinitely at
 * the flat max-delay interval once the backoff schedule is exhausted.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useWebSocket } from '@/hooks/use-websocket';

// ── Mock browser WebSocket ──────────────────────────────────────────────────

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  url: string;
  private listeners: Record<string, Array<() => void>> = { open: [], close: [] };

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ??= []).push(cb);
  }

  removeEventListener(type: string, cb: () => void) {
    this.listeners[type] = (this.listeners[type] ?? []).filter(f => f !== cb);
  }

  close() {
    if (this.readyState === MockWebSocket.CLOSED) return;
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
    this.listeners.close.forEach(f => f());
  }

  // ── test helpers ──
  simulateOpen() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
    this.listeners.open.forEach(f => f());
  }

  simulateClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
    this.listeners.close.forEach(f => f());
  }

  simulateMessage(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
}

describe('useWebSocket reconnection', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    // @ts-expect-error — test double for the browser WebSocket global
    global.WebSocket = MockWebSocket;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('opens a connection to the default /ws URL on mount', () => {
    renderHook(() => useWebSocket());
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(MockWebSocket.instances[0].url).toContain('/ws');
  });

  it('reports connected=true once the socket opens', () => {
    const onConnectionChange = vi.fn();
    renderHook(() => useWebSocket({ onConnectionChange }));
    MockWebSocket.instances[0].simulateOpen();
    expect(onConnectionChange).toHaveBeenCalledWith(true);
  });

  it('reports connected=false and schedules a reconnect on close', async () => {
    const onConnectionChange = vi.fn();
    renderHook(() => useWebSocket({
      onConnectionChange, baseReconnectDelayMs: 10, maxReconnectDelayMs: 50,
    }));

    MockWebSocket.instances[0].simulateOpen();
    MockWebSocket.instances[0].simulateClose();
    expect(onConnectionChange).toHaveBeenCalledWith(false);

    await vi.advanceTimersByTimeAsync(200);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  it('never permanently gives up — keeps retrying past maxReconnectAttempts at the flat max delay', async () => {
    // Old behavior: after `maxReconnectAttempts` (3 here) failed retries,
    // scheduleReconnect returned early and no further attempts were ever
    // made — the equivalent of a browser tab open across a dev-server
    // restart or container reprovision that outlasts ~90s never recovering
    // without a manual reload.
    renderHook(() => useWebSocket({
      baseReconnectDelayMs: 10,
      maxReconnectDelayMs: 50,
      maxReconnectAttempts: 3,
    }));

    // Fail every new socket immediately, well past the old cap of 3 retries.
    for (let i = 0; i < 10; i++) {
      const latest = MockWebSocket.instances[MockWebSocket.instances.length - 1];
      latest.simulateClose();
      // Comfortably covers the capped max delay (<=50ms) plus jitter margin.
      await vi.advanceTimersByTimeAsync(200);
    }

    // Old code would have stopped at 1 (initial) + 3 (retries) = 4 instances.
    expect(MockWebSocket.instances.length).toBeGreaterThan(4);
  });

  it('resets the backoff counter after a successful reconnect', async () => {
    renderHook(() => useWebSocket({
      baseReconnectDelayMs: 10,
      maxReconnectDelayMs: 50,
      maxReconnectAttempts: 2,
    }));

    MockWebSocket.instances[0].simulateClose();
    await vi.advanceTimersByTimeAsync(200);
    expect(MockWebSocket.instances).toHaveLength(2);

    MockWebSocket.instances[1].simulateClose();
    await vi.advanceTimersByTimeAsync(200);
    expect(MockWebSocket.instances).toHaveLength(3);

    // Successful open resets reconnectAttempt to 0
    MockWebSocket.instances[2].simulateOpen();

    // A subsequent failure schedules another retry from a clean slate —
    // proves the counter didn't keep climbing indefinitely.
    MockWebSocket.instances[2].simulateClose();
    await vi.advanceTimersByTimeAsync(200);
    expect(MockWebSocket.instances).toHaveLength(4);
  });

  it('stops scheduling reconnects after unmount', async () => {
    const { unmount } = renderHook(() => useWebSocket({
      baseReconnectDelayMs: 10, maxReconnectDelayMs: 50,
    }));
    MockWebSocket.instances[0].simulateOpen();
    const initialCount = MockWebSocket.instances.length;

    unmount();
    MockWebSocket.instances[0].simulateClose();
    await vi.advanceTimersByTimeAsync(5000);

    expect(MockWebSocket.instances.length).toBe(initialCount);
  });

  it('delivers parsed messages via onMessage', () => {
    const onMessage = vi.fn();
    renderHook(() => useWebSocket({ onMessage }));
    MockWebSocket.instances[0].simulateMessage({ type: 'phase-change', taskId: 't1' });
    expect(onMessage).toHaveBeenCalledWith({ type: 'phase-change', taskId: 't1' });
  });
});
