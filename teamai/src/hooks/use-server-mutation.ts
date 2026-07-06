'use client';

import { useTransition, useCallback } from 'react';
import { useRouter } from 'next/navigation';

/**
 * Standardized hook for calling server actions that mutate state.
 *
 * Wraps the common pattern found across all client components:
 *   const [isPending, startTransition] = useTransition();
 *   const router = useRouter();
 *   startTransition(async () => { await action(); router.refresh(); });
 *
 * Usage:
 *   const { run, mutate, isPending } = useServerMutation();
 *   run(async () => { await deleteTask(id); });
 *   mutate(deleteTask, id); // convenience, same as above
 *
 * The router.refresh() call is intentional — while server actions already call
 * revalidatePath() to invalidate the Next.js Data Cache, the client needs
 * router.refresh() to trigger an immediate re-fetch of the current route's
 * React Server Component payload. Without it, state changes only appear on
 * the next navigation.
 *
 * Errors are silently swallowed inside startTransition — callers handle
 * failures through their own state (setError, etc.). If the action throws,
 * router.refresh() is skipped (no point refreshing on failure).
 *
 * ### When NOT to use this hook
 *
 * Use plain `useTransition` instead when the async operation only updates
 * local component state and does NOT need a server cache refresh:
 * - Async operations that show an inline success indicator (e.g. "Saved!")
 * - Data fetching that populates a dropdown, directory listing, or search result
 * - Streaming / WebSocket sessions where UI updates arrive via events rather
 *   than cache invalidation
 *
 * In those cases, `useServerMutation` would trigger an unnecessary
 * `router.refresh()` that could wipe local UI state or cause a flicker.
 */
export function useServerMutation() {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  /** Run an async action, then refresh the router. Errors are silently caught. */
  const run = useCallback((action: () => Promise<unknown>): void => {
    startTransition(async () => {
      try {
        await action();
        router.refresh();
      } catch (err) {
        // Caller handles errors via their own state; skip refresh on failure.
        // Log the error so silent "the button does nothing" failures surface
        // in DevTools/Electron console instead of vanishing.
        console.error('[useServerMutation] action threw:', err);
      }
    });
  }, [startTransition, router]);

  /**
   * Convenience: call a server action with args, then refresh.
   * Errors are silently caught.
   */
  const mutate = useCallback(<Args extends unknown[]>(
    action: (...args: Args) => Promise<unknown>,
    ...args: Args
  ): void => {
    startTransition(async () => {
      try {
        await action(...args);
        router.refresh();
      } catch (err) {
        // Log the error so silent "the button does nothing" failures surface
        // in DevTools/Electron console instead of vanishing.
        console.error('[useServerMutation] action threw:', err);
      }
    });
  }, [startTransition, router]);

  return { run, mutate, isPending };
}
