// @vitest-environment happy-dom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ── Mocks ──────────────────────────────────────────────────────────────

const mockRouterRefresh = vi.hoisted(() => vi.fn());

vi.mock('next/navigation', () => ({
  useRouter: () => ({ refresh: mockRouterRefresh }),
}));

// Make useTransition synchronous so we can observe isPending transitions.
// In happy-dom, React 18's real useTransition never flips isPending back to
// false after async callbacks complete.
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

// ── Import after mocks ─────────────────────────────────────────────────

import { useServerMutation } from '@/hooks/use-server-mutation';

// ── Tests ─────────────────────────────────────────────────────────────

describe('useServerMutation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRouterRefresh.mockClear();
  });

  // ── Returned shape ──────────────────────────────────────────────────

  it('returns { run, mutate, isPending }', () => {
    const { result } = renderHook(() => useServerMutation());
    expect(result.current).toHaveProperty('run');
    expect(result.current).toHaveProperty('mutate');
    expect(result.current).toHaveProperty('isPending');
    expect(typeof result.current.run).toBe('function');
    expect(typeof result.current.mutate).toBe('function');
    expect(typeof result.current.isPending).toBe('boolean');
  });

  it('isPending starts as false', () => {
    const { result } = renderHook(() => useServerMutation());
    expect(result.current.isPending).toBe(false);
  });

  it('run() returns void, not a promise', () => {
    const { result } = renderHook(() => useServerMutation());
    expect(result.current.run(vi.fn())).toBeUndefined();
  });

  it('mutate() returns void, not a promise', () => {
    const { result } = renderHook(() => useServerMutation());
    expect(result.current.mutate(vi.fn())).toBeUndefined();
  });

  // ── run() ───────────────────────────────────────────────────────────

  describe('run()', () => {
    it('calls the action and refreshes the router on success', async () => {
      const action = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useServerMutation());

      await act(async () => {
        result.current.run(action);
      });

      expect(action).toHaveBeenCalledOnce();
      expect(mockRouterRefresh).toHaveBeenCalledOnce();
    });

    it('isPending resets to false after execution completes', async () => {
      // Note: isPending cannot be observed as true inside the callback because
      // React batches state updates — setIsPending(true) schedules a re-render
      // that hasn't flushed yet when the synchronous callback runs. The key
      // behavior is that isPending returns to false after everything completes.
      const action = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useServerMutation());

      await act(async () => {
        result.current.run(action);
      });

      expect(action).toHaveBeenCalledOnce();
      expect(mockRouterRefresh).toHaveBeenCalledOnce();
      expect(result.current.isPending).toBe(false);
    });

    it('can run multiple actions sequentially', async () => {
      const action1 = vi.fn().mockResolvedValue(undefined);
      const action2 = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useServerMutation());

      await act(async () => {
        result.current.run(action1);
      });
      await act(async () => {
        result.current.run(action2);
      });

      expect(action1).toHaveBeenCalledOnce();
      expect(action2).toHaveBeenCalledOnce();
      expect(mockRouterRefresh).toHaveBeenCalledTimes(2);
    });
  });

  // ── run() error handling ────────────────────────────────────────────

  describe('run() error handling', () => {
    it('does NOT call router.refresh when action throws', async () => {
      const action = vi.fn().mockRejectedValue(new Error('fail'));
      const { result } = renderHook(() => useServerMutation());

      await act(async () => {
        result.current.run(action);
      });

      expect(action).toHaveBeenCalledOnce();
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('silently swallows the error (no throw)', async () => {
      const action = vi.fn().mockRejectedValue(new Error('fail'));
      const { result } = renderHook(() => useServerMutation());

      // Should not throw
      await act(async () => {
        result.current.run(action);
      });

      expect(result.current.isPending).toBe(false);
    });

    it('isPending resets to false even when action throws', async () => {
      const action = vi.fn().mockRejectedValue(new Error('fail'));
      const { result } = renderHook(() => useServerMutation());

      await act(async () => {
        result.current.run(action);
      });

      expect(result.current.isPending).toBe(false);
    });
  });

  // ── mutate() ────────────────────────────────────────────────────────

  describe('mutate()', () => {
    it('calls the action with args and refreshes the router on success', async () => {
      const action = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useServerMutation());

      await act(async () => {
        result.current.mutate(action, 'arg1', 42);
      });

      expect(action).toHaveBeenCalledWith('arg1', 42);
      expect(mockRouterRefresh).toHaveBeenCalledOnce();
    });

    it('works with no extra args', async () => {
      const action = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useServerMutation());

      await act(async () => {
        result.current.mutate(action);
      });

      expect(action).toHaveBeenCalledWith();
      expect(mockRouterRefresh).toHaveBeenCalledOnce();
    });

    it('works with complex arg types', async () => {
      const action = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useServerMutation());

      const obj = { key: 'value', nested: [1, 2] };
      await act(async () => {
        result.current.mutate(action, 'str', true, obj);
      });

      expect(action).toHaveBeenCalledWith('str', true, obj);
      expect(mockRouterRefresh).toHaveBeenCalledOnce();
    });
  });

  // ── mutate() error handling ─────────────────────────────────────────

  describe('mutate() error handling', () => {
    it('does NOT call router.refresh when action throws', async () => {
      const action = vi.fn().mockRejectedValue(new Error('fail'));
      const { result } = renderHook(() => useServerMutation());

      await act(async () => {
        result.current.mutate(action, 'arg');
      });

      expect(action).toHaveBeenCalledWith('arg');
      expect(mockRouterRefresh).not.toHaveBeenCalled();
    });

    it('silently swallows the error', async () => {
      const action = vi.fn().mockRejectedValue(new Error('fail'));
      const { result } = renderHook(() => useServerMutation());

      await act(async () => {
        result.current.mutate(action, 'arg');
      });

      expect(result.current.isPending).toBe(false);
    });
  });

  // ── run vs mutate parity ────────────────────────────────────────────

  describe('run() and mutate() equivalence', () => {
    it('mutate(action, ...args) is equivalent to run(() => action(...args))', async () => {
      const action = vi.fn().mockResolvedValue(undefined);
      const { result } = renderHook(() => useServerMutation());

      await act(async () => {
        result.current.mutate(action, 1, 'two');
      });
      expect(action).toHaveBeenCalledWith(1, 'two');
      expect(mockRouterRefresh).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();

      await act(async () => {
        result.current.run(() => action(1, 'two'));
      });
      expect(action).toHaveBeenCalledWith(1, 'two');
      expect(mockRouterRefresh).toHaveBeenCalledTimes(1);
    });
  });

  // ── isPending isolation ──────────────────────────────────────────────

  describe('isPending isolation', () => {
    it('each hook instance has its own isPending', () => {
      const { result: r1 } = renderHook(() => useServerMutation());
      const { result: r2 } = renderHook(() => useServerMutation());

      expect(r1.current.isPending).toBe(false);
      expect(r2.current.isPending).toBe(false);
    });
  });
});
