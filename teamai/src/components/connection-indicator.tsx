'use client';

interface Props {
  connected: boolean;
}

/**
 * A small connection status indicator showing a green dot when connected
 * and a pulsing red dot with "Reconnecting…" badge when disconnected.
 */
export function ConnectionIndicator({ connected }: Props) {
  return (
    <div
      className="flex items-center gap-1.5"
      title={connected ? 'Connected' : 'Disconnected — reconnecting\u2026'}
    >
      <span
        className={`inline-block w-2.5 h-2.5 rounded-full transition-all duration-300 ${
          connected
            ? 'bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]'
            : 'bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.6)] animate-pulse'
        }`}
      />
      {!connected && (
        <span className="text-[10px] text-red-400 font-medium whitespace-nowrap">
          Reconnecting…
        </span>
      )}
    </div>
  );
}
