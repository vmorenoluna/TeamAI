'use client';

import { useTransition, useCallback } from 'react';

/**
 * Standardized hook for calling server actions that mutate state.
 *
 * Wraps the common pattern found across all client components:
 *   const [isPending, startTransition] = useTransition();
 *   startTransition(async () => { await action(); });
 *
 * Usage:
 *   const { run, mutate, isPending } = useServerMutation();
 *   run(async () => { await deleteTask(id); });
 *   mutate(deleteTask, id); // convenience, same as above
 *
 * The hook does NOT call router.refresh(). A server action that calls
 * revalidatePath() delivers the refreshed RSC tree in its own response, so a
 * second client-side refresh would only re-fetch the same tree. Therefore an
 * action used via this hook MUST call revalidatePath/revalidateRoot itself.
 *
 * Errors are caught inside startTransition and logged — callers handle
 * failures through their own state (setError, etc.).
 *
 * ### When NOT to use this hook
 *
 * Use plain `useTransition` instead when the async operation only updates
 * local component state and does NOT need a server cache revalidation:
 * - Async operations that show an inline success indicator (e.g. "Saved!")
 * - Data fetching that populates a dropdown, directory listing, or search result
 * - Streaming / WebSocket sessions where UI updates arrive via events rather
 *   than cache invalidation
 */
export function useServerMutation() {
  const [isPending, startTransition] = useTransition();

  /** Run an async action inside a transition. Errors are caught and logged. */
  const run = useCallback((action: () => Promise<unknown>): void => {
    startTransition(async () => {
      try {
        await action();
      } catch (err) {
        // Caller handles errors via their own state. Log the error so silent "the button does nothing" failures surface
        // in DevTools/Electron console instead of vanishing.
        console.error('[useServerMutation] action threw:', err);
      }
    });
  }, [startTransition]);

  /**
   * Convenience: call a server action with args inside a transition.
   * Errors are caught and logged.
   */
  const mutate = useCallback(<Args extends unknown[]>(
    action: (...args: Args) => Promise<unknown>,
    ...args: Args
  ): void => {
    startTransition(async () => {
      try {
        await action(...args);
      } catch (err) {
        // Log the error so silent "the button does nothing" failures surface
        // in DevTools/Electron console instead of vanishing.
        console.error('[useServerMutation] action threw:', err);
      }
    });
  }, [startTransition]);

  return { run, mutate, isPending };
}
