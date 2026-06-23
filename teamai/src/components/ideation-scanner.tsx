'use client';

import { useState, useEffect, useTransition, useRef } from 'react';
import { startIdeationScan, cancelIdeationScan } from '@/app/actions/ideation';
import { useSessionStream } from '@/hooks/use-session-stream';
import { useRateLimitAutoResume } from '@/hooks/use-rate-limit-auto-resume';
import { useStreamProgress } from '@/hooks/use-stream-progress';

export function IdeationScanner() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();  const cancelRequestedRef = useRef(false);
  const [cancelling, setCancelling] = useState(false);
  const streamEvents = useSessionStream(sessionId);

  // Rate-limit detection + auto-resume
  const {
    rateLimited,
    rateLimitMessage,
    autoResumeAt,
    countdown,
    resetRateLimit,
    handleCancelAutoResume,
  } = useRateLimitAutoResume(streamEvents, handleScan, () => setRunning(false), () => setRunning(false));

  // Accumulate progress text from all stream events
  const fullText = useStreamProgress(streamEvents);

  const done = streamEvents.some(e => e.event.type === 'result');

  // Clear running state when scan completes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (done && sessionId) setRunning(false);
  }, [done, sessionId]);

  function handleScan() {
    cancelRequestedRef.current = false;
    setRunning(true);
    setSessionId(null);
    setError(null);
    resetRateLimit();
    startTransition(async () => {
      try {
        const id = await startIdeationScan();
        if (cancelRequestedRef.current) {
          await cancelIdeationScan().catch(() => {});
          setRunning(false);
          return;
        }
        setSessionId(id);
      } catch (err) {
        setRunning(false);
        setError(`Scan failed: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    });
  }

  async function handleCancel() {
    cancelRequestedRef.current = true;
    setCancelling(true);
    try {
      await cancelIdeationScan();
    } catch { /* best-effort */ }
    setRunning(false);
    setSessionId(null);
    resetRateLimit();
    setCancelling(false);
  }

  return (
    <div className="flex flex-col h-full p-6 gap-4">
      <div className="flex items-center gap-4 flex-wrap">
        <button
          onClick={handleScan}
          disabled={isPending || running}
          className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors"
        >
          {running && !done ? 'Scanning…' : 'Run Scan'}
        </button>

        {running && (
          <button
            onClick={handleCancel}
            disabled={cancelling}
            className="px-3 py-2 text-sm font-medium text-red-400 border border-red-800 rounded-lg hover:bg-red-950/30 disabled:opacity-40 transition-colors"
          >
            {cancelling ? 'Stopping…' : '✕ Stop'}
          </button>
        )}

        {done && <span className="text-xs text-green-400">Scan complete</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>

      {/* Rate-limit indicator */}
      {rateLimited && (
        <div className="bg-amber-950/30 border border-amber-800 rounded-lg p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <span className="text-amber-400 text-lg">⏳</span>
              <span className="text-sm text-amber-300">{rateLimitMessage}</span>
            </div>
            <div className="flex items-center gap-2">
              {autoResumeAt && (
                <>
                  <span className="text-xs text-amber-400 font-mono tabular-nums">
                    {countdown}
                  </span>
                  <button
                    onClick={handleCancelAutoResume}
                    className="px-3 py-2 text-sm font-medium text-slate-400 border border-slate-700 rounded-lg hover:bg-slate-800 transition-colors"
                  >
                    Cancel
                  </button>
                </>
              )}
              <button
                onClick={handleScan}
                disabled={isPending}
                className="px-4 py-2 text-sm font-medium bg-amber-700 text-amber-100 rounded-lg hover:bg-amber-600 disabled:opacity-40 transition-colors"
              >
                Retry Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Full accumulated output while running */}
      {running && !rateLimited && streamEvents.length > 0 && (
        <div className="flex-1 overflow-y-auto bg-[#1a1f2e] rounded-lg border border-[#1e293b] p-4">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Agent Output</span>
            <span className="text-[10px] text-slate-600">{streamEvents.length} event{streamEvents.length !== 1 ? 's' : ''}</span>
          </div>
          {fullText ? (
            <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
              {fullText}
            </pre>
          ) : (
            <p className="text-xs text-slate-500 animate-pulse">Initialising…</p>
          )}
        </div>
      )}

      {/* Show "Running..." indicator when streaming but no events yet */}
      {running && !rateLimited && streamEvents.length === 0 && (
        <div className="bg-[#1a1f2e] rounded-lg border border-[#1e293b] p-4 flex items-center gap-3">
          <div className="w-4 h-4 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
          <span className="text-sm text-slate-400">Starting ideation scan…</span>
        </div>
      )}

      {/* Completed output (scan done, show result) */}
      {done && fullText && !running && (
        <div className="flex-1 overflow-y-auto bg-[#1a1f2e] rounded-lg border border-[#1e293b] p-4">
          <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
            {fullText}
          </pre>
        </div>
      )}

      {!fullText && !running && (
        <p className="text-sm text-slate-400">Click &quot;Run Scan&quot; to analyse the codebase.</p>
      )}
    </div>
  );
}
