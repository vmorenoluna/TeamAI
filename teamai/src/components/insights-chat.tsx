'use client';

import { useEffect, useRef, useState, useTransition, useMemo, useCallback } from 'react';
import { getOrCreateInsightsSession, sendInsightsMessage, cancelInsightsSession } from '@/app/actions/insights';
import { useSessionStream } from '@/hooks/use-session-stream';
import { extractText } from '@/lib/stream-types';
import { formatActionError } from '@/lib/error-format';
import { useRateLimitAutoResume } from '@/hooks/use-rate-limit-auto-resume';
import { useStreamProgress } from '@/hooks/use-stream-progress';
import { useStreamingState } from '@/hooks/use-streaming-state';
import { RateLimitBanner } from './rate-limit-banner';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}


export function InsightsChat() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  // Regression-fix contract: surfaces Server Action failures (raw-throw path)
  // from mount, handleSend, reconnect (cancel + retry + auto-resume).
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const cancelRequestedRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamEvents = useSessionStream(sessionId);

  // Running state synced from stream events
  const { running, setRunning } = useStreamingState(streamEvents);

  /**
   * Shared reconnect helper: calls getOrCreateInsightsSession, sets sessionId,
   * and surfaces any rejection in the role='alert' banner with a consistent
   * `Failed to <label>: <msg>` template. Used by mount, handleCancel,
   * useRateLimitAutoResume auto-resume, and rate-limit banner onRetry.
   */
  const reconnect = useCallback(async (label: string) => {
    try {
      const newId = await getOrCreateInsightsSession();
      setSessionId(newId);
    } catch (err) {
      setError(formatActionError(label, err));
    }
  }, []);

  // Start session on mount
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    reconnect('start chat session');
  }, [reconnect]);

  const {
    rateLimited,
    rateLimitMessage,
    autoResumeAt,
    countdown,
    resetRateLimit,
    handleCancelAutoResume,
  } = useRateLimitAutoResume(streamEvents, () => {
    setRunning(false);
    setSessionId(null);
    startTransition(() => { reconnect('resume chat session'); });
  }, () => setRunning(false));

  // Compute progress indicator text (last tool/status line while the agent works)
  const fullProgressText = useStreamProgress(streamEvents);
  const progressText = useMemo(() => {
    if (!fullProgressText) return '';
    return fullProgressText.split('\n').pop() ?? '';
  }, [fullProgressText]);

  // Process incoming stream events into messages
  useEffect(() => {
    if (streamEvents.length === 0) return;
    const latest = streamEvents[streamEvents.length - 1];
    const { event } = latest;

    if (event.type === 'assistant') {
      const text = extractText(event);
      if (!text) return;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant' && last.streaming) {
          return [...prev.slice(0, -1), { role: 'assistant', content: text, streaming: true }];
        }
        return [...prev, { role: 'assistant', content: text, streaming: true }];
      });
    } else if (event.type === 'result') {
      // Finalise the last assistant message
       
      setMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'assistant') {
          return [...prev.slice(0, -1), { ...last, streaming: false }];
        }
        return prev;
      });
    }
  }, [streamEvents]);

  // Auto-scroll to bottom
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || !sessionId) return;
    cancelRequestedRef.current = false;
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    setRunning(true);
    setError(null);
    resetRateLimit();
    startTransition(async () => {
      try {
        await sendInsightsMessage(sessionId, text);
      } catch (err) {
        setRunning(false);
        setError(formatActionError('send message', err));
      }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input, sessionId, startTransition, resetRateLimit]);

  const handleCancel = useCallback(async () => {
    cancelRequestedRef.current = true;
    try {
      await cancelInsightsSession();
    } catch { /* best-effort */ }
    setRunning(false);
    setSessionId(null);
    resetRateLimit();
    // Auto-reconnect: get a fresh session for follow-up messages
    await reconnect('reconnect after cancel');
    cancelRequestedRef.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetRateLimit, reconnect]);

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Rate-limit banner */}
      {rateLimited && (
        <RateLimitBanner
          message={rateLimitMessage}
          autoResumeAt={autoResumeAt}
          countdown={countdown}
          onCancelAutoResume={handleCancelAutoResume}
          onRetry={() => {
            resetRateLimit();
            setRunning(false);
            setSessionId(null);
            setError(null);
            startTransition(() => { reconnect('retry chat session'); });
          }}
          variant="inline"
        />
      )}

      {/* Error banner — surfaces Server Action throws from mount, send, reconnect. */}
      {error && (
        <div
          role="alert"
          className="mx-4 mt-2 p-2.5 bg-red-900/30 border border-red-800/50 rounded-lg flex items-start justify-between gap-2"
        >
          <p className="text-xs text-red-300 flex-1">{error}</p>
          <button
            onClick={() => setError(null)}
            aria-label="Dismiss error"
            className="text-red-500 hover:text-red-300 text-sm leading-none transition-colors"
          >
            ✕
          </button>
        </div>
      )}

      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && !running && (
          <p className="text-sm text-slate-400 text-center mt-8">
            Ask anything about the codebase.
          </p>
        )}
        {messages.length === 0 && running && (
          <p className="text-sm text-slate-400 text-center mt-8">
            {progressText ? (
              <span className="animate-pulse">{progressText}</span>
            ) : (
              <span className="animate-pulse">Thinking…</span>
            )}
          </p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
              msg.role === 'user'
                ? 'bg-[#2563eb] text-white rounded-br-sm'
                : 'bg-[#1e2333] border border-[#1e293b] text-slate-200 rounded-bl-sm'
            }`}>
              {msg.content}
              {msg.streaming && (
                <span className="inline-block w-1.5 h-3.5 ml-0.5 bg-current opacity-75 animate-pulse" />
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 border-t border-[#1e293b] p-4">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder={sessionId ? (running ? 'Assistant is responding…' : 'Ask about the codebase… (Enter to send)') : 'Connecting…'}
            disabled={!sessionId || isPending || running}
                        className="flex-1 min-w-0 px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] resize-none disabled:opacity-50 placeholder-slate-500"
          />
          {running ? (
            <button
              onClick={handleCancel}
                            className="px-4 py-2 text-sm font-medium bg-red-800 text-red-100 rounded-lg hover:bg-red-700 transition-colors shrink-0 self-end"
            >
              ✕ Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!sessionId || !input.trim() || isPending}
                            className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors shrink-0 self-end"
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
