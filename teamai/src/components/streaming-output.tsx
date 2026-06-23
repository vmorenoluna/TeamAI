'use client';

/** Shared streaming output display showing agent progress.
 *  Used by github-import, ideation-scanner, and roadmap-view (×2).
 *  Renders a header row with "Agent Output" label + event count, followed
 *  by the accumulated progress text (or an "Initialising…" pulse when empty). */
export function StreamingOutput({
  text,
  eventCount,
  className = '',
}: {
  text: string;
  eventCount: number;
  /** Additional classes for the outer container (e.g. "max-h-80", "min-h-[100px]") */
  className?: string;
}) {
  return (
    <div className={`flex-1 overflow-y-auto bg-[#1a1f2e] rounded-lg border border-[#1e293b] p-4 ${className}`}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Agent Output</span>
        <span className="text-[10px] text-slate-600">
          {eventCount} event{eventCount !== 1 ? 's' : ''}
        </span>
      </div>
      {text ? (
        <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
          {text}
        </pre>
      ) : (
        <p className="text-xs text-slate-500 animate-pulse">Initialising…</p>
      )}
    </div>
  );
}
