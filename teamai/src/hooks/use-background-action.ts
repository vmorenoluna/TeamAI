import { useCallback, useEffect, useRef, useState } from 'react';
import { trackOperation, untrackOperation, type TrackedResult } from '@/lib/background-action-client';

/** What a background-capable server action returns: the operation id, or an immediate failure. */
export type BackgroundActionStart =
  | { success: true; operationId: string }
  | { success: false; error?: string };

export type BackgroundActionOutcome = TrackedResult;

export function useBackgroundAction() {
  const [pendingCount, setPendingCount] = useState(0);
  const idsRef = useRef<Set<string>>(new Set());
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    const ids = idsRef.current;
    return () => {
      mountedRef.current = false;
      for (const id of ids) untrackOperation(id);
      ids.clear();
    };
  }, []);

  const start = useCallback(
    async (action: (operationId: string) => Promise<BackgroundActionStart>): Promise<BackgroundActionOutcome> => {
      // Track BEFORE calling the action: the result can arrive before the HTTP response.
      const operationId = crypto.randomUUID();
      const tracked = trackOperation(operationId);
      idsRef.current.add(operationId);
      setPendingCount(c => c + 1);
      const finish = () => {
        idsRef.current.delete(operationId);
        if (mountedRef.current) setPendingCount(c => Math.max(0, c - 1));
      };
      try {
        const started = await action(operationId);
        if (!started.success) {
          untrackOperation(operationId);
          finish();
          return { ok: false, error: started.error ?? 'Action failed' };
        }
        const result = await tracked;
        finish();
        return result;
      } catch (err) {
        untrackOperation(operationId);
        finish();
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
    [],
  );

  return { start, isPending: pendingCount > 0 };
}
