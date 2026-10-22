'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useWebSocket } from '@/hooks/use-websocket';
import {
  deliverActionResult,
  pendingOperationIds,
  type ActionResultMessage,
} from '@/lib/background-action-client';
import { getBackgroundActionResult } from '@/app/actions/background';

interface Props {
  projectPath: string | null;
}

interface Failure {
  operationId: string;
  label: string;
  error: string;
}

const POLL_INTERVAL_MS = 15_000;
export const LOST_OPERATION_ERROR =
  "The server lost track of this operation (it may have restarted). Check the task's current state.";

/** Global banner: settles operations this tab tracks and shows failures nobody claimed. */
export function BackgroundActionFailureBanner({ projectPath }: Props) {
  const [failures, setFailures] = useState<Failure[]>([]);
  const [connected, setConnected] = useState(false);
  const [pollTick, setPollTick] = useState(0);
  const pollingRef = useRef(false);

  const handleResult = useCallback((msg: ActionResultMessage) => {
    const claimed = deliverActionResult(msg);
    if (claimed || msg.ok) return;
    setFailures(prev =>
      prev.some(f => f.operationId === msg.operationId)
        ? prev
        : [
            ...prev,
            {
              operationId: msg.operationId,
              label: msg.action ?? 'Background action',
              error: msg.error ?? 'Unknown error',
            },
          ],
    );
  }, []);

  useWebSocket({
    project: projectPath ?? undefined,
    onMessage: useCallback(
      (data: Record<string, unknown>) => {
        if (data.type === 'action-result') handleResult(data as unknown as ActionResultMessage);
      },
      [handleResult],
    ),
    onConnectionChange: useCallback((c: boolean) => {
      setConnected(c);
      if (c) setPollTick(t => t + 1);
    }, []),
  });

  // Recover results missed during a socket gap: on (re)open, then every 15 s while anything is pending.
  useEffect(() => {
    if (!connected) return;
    let cancelled = false;

    const poll = async () => {
      if (pollingRef.current) return;
      pollingRef.current = true;
      try {
        for (const operationId of pendingOperationIds()) {
          try {
            const r = await getBackgroundActionResult(operationId);
            if (cancelled) return;
            if (r.status === 'ok') deliverActionResult({ operationId, ok: true });
            else if (r.status === 'failed') {
              deliverActionResult({ operationId, ok: false, error: r.error ?? 'Unknown error' });
            } else if (r.status === 'unknown') {
              deliverActionResult({ operationId, ok: false, error: LOST_OPERATION_ERROR });
            }
          } catch {
            // transient network error — retry on the next tick
          }
        }
      } finally {
        pollingRef.current = false;
      }
    };

    void poll();
    const interval = setInterval(() => {
      if (pendingOperationIds().length === 0) return;
      void poll();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [connected, pollTick]);

  if (failures.length === 0) return null;

  return (
    <div role="alert" className="fixed bottom-4 right-4 z-50 max-w-md space-y-2">
      {failures.map(f => (
        <div
          key={f.operationId}
          className="flex items-start gap-2 rounded-md border border-red-500/50 bg-red-950/90 px-3 py-2 text-sm text-red-100 shadow-lg"
        >
          <span className="flex-1 break-words">{`${f.label} failed: ${f.error}`}</span>
          <button
            type="button"
            aria-label="Dismiss background action error"
            className="shrink-0 underline"
            onClick={() => setFailures(prev => prev.filter(x => x.operationId !== f.operationId))}
          >
            Dismiss
          </button>
        </div>
      ))}
    </div>
  );
}
