'use client';

import { useState, useEffect, useTransition, useRef } from 'react';
import { startIdeationScan, cancelIdeationScan } from '@/app/actions/ideation';
import { useSessionStream } from '@/hooks/use-session-stream';
import { useRateLimitAutoResume } from '@/hooks/use-rate-limit-auto-resume';
import { useStreamProgress } from '@/hooks/use-stream-progress';
import { RateLimitBanner } from './rate-limit-banner';
import { StreamingOutput } from './streaming-output';
import { LoadingSpinner } from './loading-spinner';

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
  } = useRateLimitAutoResume(streamEvents, handleScan, () => setRunning(false));

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
        <RateLimitBanner
          message={rateLimitMessage}
          autoResumeAt={autoResumeAt}
          countdown={countdown}
          onCancelAutoResume={handleCancelAutoResume}
          onRetry={handleScan}
          disabled={isPending}
        />
      )}

      {/* Full accumulated output while running */}
      {running && !rateLimited && streamEvents.length > 0 && (
        <StreamingOutput text={fullText} eventCount={streamEvents.length} />
      )}

      {/* Show "Running..." indicator when streaming but no events yet */}
      {running && !rateLimited && streamEvents.length === 0 && (
        <LoadingSpinner label="ideation scan" />
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
