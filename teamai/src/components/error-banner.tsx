'use client';

interface Props {
  error: string;
  onDismiss: () => void;
  /** Optional title override (default: "Action failed" / "Operation failed") */
  title?: string;
  /** Whether this is a floating (fixed-position) banner vs inline */
  floating?: boolean;
}

export function ErrorBanner({ error, onDismiss, title, floating = false }: Props) {
  const className = floating
    ? 'fixed top-4 right-4 z-50 max-w-md bg-red-950/90 border border-red-800 rounded-lg shadow-xl shadow-black/40 p-3 flex items-start gap-3'
    : 'shrink-0 mx-6 mt-3 rounded-lg border border-red-800/40 bg-red-950/30 p-3 flex items-start gap-3';

  const titleText = title ?? (floating ? 'Operation failed' : 'Action failed');

  return (
    <div role="alert" className={className}>
      <span className="text-red-400 font-bold shrink-0 mt-0.5">✗</span>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-red-300">{titleText}</p>
        <p className="text-xs text-red-200/90 mt-0.5 break-words">{error}</p>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        title="Dismiss"
        className="shrink-0 text-red-400 hover:text-red-300 text-base leading-none px-1"
      >
        ×
      </button>
    </div>
  );
}
