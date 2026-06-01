'use client';

import { useEffect, useRef, useState } from 'react';

interface Props {
  /** True when WebSocket is open, false otherwise. */
  connected: boolean;
  /** True on initial mount before the first onopen has ever fired. */
  initial?: boolean;
}

/**
 * A small connection status indicator showing a green dot when connected
 * and a pulsing red dot with a status badge when disconnected.
 *
 * State machine:
 *   initial=true  → red dot, "Connecting…"           (first mount)
 *   connected     → green dot, no text
 *   disconnected  → red dot, "Reconnecting…"          (after a close)
 *
 * If the WS never connects within 3s of mount, the initial
 * "Connecting…" label appears so the user has feedback.
 */
export function ConnectionIndicator({ connected, initial = false }: Props) {
  const [initialTimeout, setInitialTimeout] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    // Start a 3s fallback timer — when it fires the initial "Connecting…" text appears
    if (!connected && initial && !initialTimeout) {
      timerRef.current = setTimeout(() => setInitialTimeout(true), 3_000);
    }
    // If the connection succeeds while the timer is pending, cancel it so we
    // never fire `setInitialTimeout(true)` after the dot is already green.
    if (connected && timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [connected, initial, initialTimeout]);

  const showBadge = !connected;
  const isConnecting = initial && !initialTimeout;

  return (
    <div
      className="flex items-center gap-1.5"
      title={
        connected
          ? 'Connected'
          : isConnecting
            ? 'Connecting\u2026'
            : 'Disconnected \u2014 reconnecting\u2026'
      }
    >
      <span
        className={`inline-block w-2.5 h-2.5 rounded-full transition-all duration-300 ${
          connected
            ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]'
            : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)] animate-pulse'
        }`}
      />
      {showBadge && (
        <span className="text-[10px] text-red-400 font-medium whitespace-nowrap">
          {isConnecting ? 'Connecting\u2026' : 'Reconnecting\u2026'}
        </span>
      )}
    </div>
  );
}
