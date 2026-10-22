// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, renderHook, fireEvent } from '@testing-library/react';

const getResult = vi.hoisted(() => vi.fn());
vi.mock('@/app/actions/background', () => ({ getBackgroundActionResult: getResult }));

let gOnMessage: ((d: Record<string, unknown>) => void) | undefined;
let gOnConn: ((c: boolean) => void) | undefined;
vi.mock('@/hooks/use-websocket', () => ({
  useWebSocket: (opts?: {
    onMessage?: (d: Record<string, unknown>) => void;
    onConnectionChange?: (c: boolean) => void;
  }) => {
    gOnMessage = opts?.onMessage;
    gOnConn = opts?.onConnectionChange;
    return { reconnect: vi.fn() };
  },
}));

import { pendingOperationIds, trackOperation, untrackOperation, deliverActionResult } from '@/lib/background-action-client';
import { useBackgroundAction } from '@/hooks/use-background-action';
import { BackgroundActionFailureBanner, LOST_OPERATION_ERROR } from '@/components/background-action-failure-banner';

beforeEach(() => {
  getResult.mockReset();
  for (const id of pendingOperationIds()) untrackOperation(id);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('AC13: tracked operations settle from action-result', () => {
  it('resolves a tracked failure even when the result arrives before the action returns', async () => {
    const { result } = renderHook(() => useBackgroundAction());
    let outcome: unknown;
    await act(async () => {
      outcome = await result.current.start(async id => {
        // result beats the HTTP response
        expect(deliverActionResult({ operationId: id, ok: false, error: 'worktree busy' })).toBe(true);
        return { success: true, operationId: id };
      });
    });
    expect(outcome).toEqual({ ok: false, error: 'worktree busy' });
    expect(result.current.isPending).toBe(false);
  });

  it('returns ok:false immediately when the action throws or reports success:false', async () => {
    const { result } = renderHook(() => useBackgroundAction());
    let a: unknown, b: unknown;
    await act(async () => {
      a = await result.current.start(async () => {
        throw new Error('network');
      });
      b = await result.current.start(async () => ({ success: false, error: 'nope' }));
    });
    expect(a).toEqual({ ok: false, error: 'network' });
    expect(b).toEqual({ ok: false, error: 'nope' });
    expect(pendingOperationIds()).toEqual([]);
  });

  it('deliverActionResult is idempotent and false for unknown ids; unmount untracks', async () => {
    const p = trackOperation('x');
    expect(deliverActionResult({ operationId: 'x', ok: true })).toBe(true);
    expect(deliverActionResult({ operationId: 'x', ok: true })).toBe(true);
    await expect(p).resolves.toEqual({ ok: true });
    expect(deliverActionResult({ operationId: 'never', ok: true })).toBe(false);

    const { result, unmount } = renderHook(() => useBackgroundAction());
    void act(() => {
      void result.current.start(async id => ({ success: true, operationId: id }));
    });
    await act(async () => {});
    expect(pendingOperationIds().length).toBe(1);
    unmount();
    expect(pendingOperationIds()).toEqual([]);
  });
});

describe('AC14: unclaimed failures show in the banner', () => {
  it('renders the alert and dismisses it; ignores unclaimed successes and claimed failures', () => {
    render(<BackgroundActionFailureBanner projectPath="/p" />);
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => gOnMessage!({ type: 'action-result', operationId: 'a', action: 'delete-worktree', ok: true }));
    expect(screen.queryByRole('alert')).toBeNull();

    void trackOperation('claimed');
    act(() => gOnMessage!({ type: 'action-result', operationId: 'claimed', action: 'retry', ok: false, error: 'x' }));
    expect(screen.queryByRole('alert')).toBeNull();

    act(() => gOnMessage!({ type: 'action-result', operationId: 'b', action: 'delete-worktree', ok: false, error: 'EBUSY' }));
    expect(screen.getByRole('alert').textContent).toContain('delete-worktree failed: EBUSY');

    fireEvent.click(screen.getByLabelText('Dismiss background action error'));
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('AC15: polling recovers missed results', () => {
  it('settles pending operations on socket open and on the 15 s interval', async () => {
    vi.useFakeTimers();
    render(<BackgroundActionFailureBanner projectPath="/p" />);
    const okP = trackOperation('ok-op');
    const failP = trackOperation('fail-op');
    const lostP = trackOperation('lost-op');
    const waitP = trackOperation('wait-op');
    getResult.mockImplementation(async (id: string) => {
      if (id === 'ok-op') return { status: 'ok' };
      if (id === 'fail-op') return { status: 'failed', error: 'bad' };
      if (id === 'lost-op') return { status: 'unknown' };
      return { status: 'pending' };
    });

    await act(async () => gOnConn!(true));
    await expect(okP).resolves.toEqual({ ok: true });
    await expect(failP).resolves.toEqual({ ok: false, error: 'bad' });
    await expect(lostP).resolves.toEqual({ ok: false, error: LOST_OPERATION_ERROR });
    expect(pendingOperationIds()).toEqual(['wait-op']);

    getResult.mockClear();
    getResult.mockResolvedValue({ status: 'ok' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(getResult).toHaveBeenCalledWith('wait-op');
    await expect(waitP).resolves.toEqual({ ok: true });

    getResult.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(getResult).not.toHaveBeenCalled();
  });
});
