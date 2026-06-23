'use client';

import { useEffect, useRef, useState, useTransition, useMemo, useCallback } from 'react';
import { getOrCreateInsightsSession, sendInsightsMessage, cancelInsightsSession } from '@/app/actions/insights';
import { useSessionStream } from '@/hooks/use-session-stream';
import { extractText } from '@/lib/stream-types';
import { useRateLimitAutoResume } from '@/hooks/use-rate-limit-auto-resume';
import { useStreamProgress } from '@/hooks/use-stream-progress';
import { useStreamingState } from '@/hooks/use-streaming-state';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}


export function InsightsChat() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isPending, startTransition] = useTransition();
  const cancelRequestedRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamEvents = useSessionStream(sessionId);

  // Running state synced from stream events
  const { running, setRunning } = useStreamingState(streamEvents);

  // Start session on mount
  useEffect(() => {
    getOrCreateInsightsSession().then(setSessionId);
  }, []);

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
    startTransition(async () => {
      const newId = await getOrCreateInsightsSession();
      setSessionId(newId);
    });
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
    resetRateLimit();
    startTransition(async () => {
      try {
        await sendInsightsMessage(sessionId, text);
      } catch {
        setRunning(false);
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
    const newId = await getOrCreateInsightsSession();
    setSessionId(newId);
    cancelRequestedRef.current = false;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetRateLimit]);

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
        <div className="shrink-0 bg-amber-950/60 border-b border-amber-800 text-amber-200 px-4 py-2.5 text-xs flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-amber-400 text-lg shrink-0">⏳</span>
            <span className="truncate">
              {rateLimitMessage || 'Rate limit reached. Please wait and try again.'}
            </span>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {autoResumeAt && (
              <>
                <span className="text-xs text-amber-400 font-mono tabular-nums">
                  {countdown}
                </span>
                <button
                  onClick={handleCancelAutoResume}
                  className="px-2 py-1 text-xs font-medium text-slate-400 border border-slate-700 rounded hover:bg-slate-800 transition-colors"
                >
                  Cancel
                </button>
              </>
            )}
            <button
              onClick={() => {
                resetRateLimit();
                setRunning(false);
                setSessionId(null);
                startTransition(async () => {
                  const newId = await getOrCreateInsightsSession();
                  setSessionId(newId);
                });
              }}
              className="shrink-0 px-3 py-1 text-xs font-medium bg-amber-700 hover:bg-amber-600 text-amber-100 rounded transition-colors"
            >
              Retry Now
            </button>
          </div>
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
