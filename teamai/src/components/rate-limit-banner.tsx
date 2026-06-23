'use client';

/** Rate-limit banner — shared across all components that spawn agent sessions.
 *  Shows a countdown + Cancel button when auto-resume is pending, and a Retry Now
 *  button for immediate retry. Supports 'block' (standalone card) and 'inline'
 *  (border-bottom strip, used in InsightsChat) visual variants. */
export function RateLimitBanner({
  message,
  autoResumeAt,
  countdown,
  onCancelAutoResume,
  onRetry,
  disabled = false,
  variant = 'block',
}: {
  message: string;
  autoResumeAt: number | null;
  countdown: string;
  onCancelAutoResume: () => void;
  onRetry: () => void;
  disabled?: boolean;
  variant?: 'block' | 'inline';
}) {
  const isInline = variant === 'inline';

  return (
    <div
      className={
        isInline
          ? 'shrink-0 bg-amber-950/60 border-b border-amber-800 text-amber-200 px-4 py-2.5 text-xs flex items-center justify-between gap-3'
          : 'shrink-0 bg-amber-950/30 border border-amber-800 rounded-lg p-4'
      }
      data-testid="rate-limit-banner"
    >
      <div className={`flex items-center justify-between gap-4${isInline ? ' w-full' : ''}`}>
        <div className="flex items-center gap-2 min-w-0">
          <span className={`text-amber-400 shrink-0 ${isInline ? 'text-lg' : 'text-lg'}`}>⏳</span>
          <span className={`text-amber-300 ${isInline ? 'truncate text-xs' : 'text-sm'}`}>
            {message || 'Rate limit reached. Please wait and try again.'}
          </span>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {autoResumeAt && (
            <>
              <span className={`text-amber-400 font-mono tabular-nums ${isInline ? 'text-xs' : 'text-xs'}`}>
                {countdown}
              </span>
              <button
                onClick={onCancelAutoResume}
                className={
                  isInline
                    ? 'px-2 py-1 text-xs font-medium text-slate-400 border border-slate-700 rounded hover:bg-slate-800 transition-colors'
                    : 'px-3 py-2 text-sm font-medium text-slate-400 border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors'
                }
              >
                Cancel
              </button>
            </>
          )}
          <button
            onClick={onRetry}
            disabled={disabled}
            className={
              isInline
                ? 'shrink-0 px-3 py-1 text-xs font-medium bg-amber-700 hover:bg-amber-600 text-amber-100 rounded transition-colors'
                : 'px-4 py-2 text-sm font-medium bg-amber-700 text-amber-100 rounded-lg hover:bg-amber-600 disabled:opacity-40 transition-colors'
            }
          >
            Retry Now
          </button>
        </div>
      </div>
    </div>
  );
}
