'use client';

/** Shared loading indicator shown before stream events arrive.
 *  Renders a spinning blue ring + a descriptive "Starting {label}…" message. */
export function LoadingSpinner({ label }: { label: string }) {
  return (
    <div className="bg-[#1a1f2e] rounded-lg border border-[#1e293b] p-4 flex items-center gap-3">
      <div className="w-4 h-4 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
      <span className="text-sm text-slate-400">Starting {label}…</span>
    </div>
  );
}
