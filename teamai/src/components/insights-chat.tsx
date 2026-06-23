'use client';

import { useEffect, useRef, useState, useTransition, useMemo, useCallback } from 'react';
import { getOrCreateInsightsSession, sendInsightsMessage, cancelInsightsSession } from '@/app/actions/insights';
import { useSessionStream } from '@/hooks/use-session-stream';
import { extractText, extractProgressText } from '@/lib/stream-types';
import { parseSessionLimitReset, formatCountdown } from '@/lib/rate-limit';

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
  const [running, setRunning] = useState(false);
  const [rateLimited, setRateLimited] = useState(false);
  const [rateLimitMessage, setRateLimitMessage] = useState('');
  const [autoResumeAt, setAutoResumeAt] = useState<number | null>(null);
  const [countdown, setCountdown] = useState('');
  const cancelRequestedRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamEvents = useSessionStream(sessionId);

  // Start session on mount
  useEffect(() => {
    getOrCreateInsightsSession().then(setSessionId);
  }, []);

  // Compute progress indicator text (tool names, status) while the agent works
  const progressText = useMemo(() => {
    if (streamEvents.length === 0) return '';
    const lines: string[] = [];
    for (const e of streamEvents) {
      const t = extractProgressText(e.event);
      if (t) lines.push(t);
    }
    return lines[lines.length - 1] ?? '';
  }, [streamEvents]);

  // Compute whether assistant is currently streaming from stream events
  const isStreaming = useMemo(() => {
    if (streamEvents.length === 0) return false;
    const lastType = streamEvents[streamEvents.length - 1].event.type;
    // Streaming if the last event is an assistant response (not yet finalised)
    return lastType === 'assistant';
  }, [streamEvents]);

  // Sync running state from stream events
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRunning(isStreaming);
  }, [isStreaming]);

  // Must be declared before auto-resume useEffect that references it
  const handleRetryNow = useCallback(() => {
    setRateLimited(false);
    setRateLimitMessage('');
    setRunning(false);
    setSessionId(null);
    setAutoResumeAt(null);
    setCountdown('');
    startTransition(async () => {
      const newId = await getOrCreateInsightsSession();
      setSessionId(newId);
    });
  }, []);

  // ── Auto-resume countdown ───────────────────────────────────────────────
  useEffect(() => {
    if (autoResumeAt === null) return;
    const timer = setInterval(() => {
      const remaining = autoResumeAt - Math.floor(Date.now() / 1000);
      if (remaining <= 0) {
        clearInterval(timer);
        setAutoResumeAt(null);
        setCountdown('');
        handleRetryNow();
      } else {
        setCountdown(formatCountdown(autoResumeAt));
        setRateLimitMessage(`Session limit hit — auto-resuming ${formatCountdown(autoResumeAt)}`);
      }
    }, 1000);
    return () => clearInterval(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoResumeAt]);

  // Cancel auto-resume
  function handleCancelAutoResume() {
    setAutoResumeAt(null);
    setCountdown('');
    setRateLimited(false);
    setRateLimitMessage('');
  }

  // Detect rate-limit in stream events
  useEffect(() => {
    for (const e of streamEvents) {
      const text = extractText(e.event);
      if (
        text &&
        /(session.?limit|rate.?limit|too many requests|usage.?limit)/i.test(text)
      ) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setRateLimited(true);
        setRunning(false);
        const resetsAt = parseSessionLimitReset(text);
        if (resetsAt) {
          setAutoResumeAt(resetsAt);
          setCountdown(formatCountdown(resetsAt));
          setRateLimitMessage(`Session limit hit — auto-resuming ${formatCountdown(resetsAt)}`);
        } else {
          const match = text.match(/resets\s+(\d+:\d+\s*[ap]m)/i);
          setRateLimitMessage(match ? `Session limit hit — resets ${match[1]} UTC` : text.slice(0, 200));
        }
        return;
      }
    }
  }, [streamEvents]);

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
    setRateLimited(false);
    setRateLimitMessage('');
    setAutoResumeAt(null);
    setCountdown('');
    startTransition(async () => {
      try {
        await sendInsightsMessage(sessionId, text);
      } catch {
        setRunning(false);
      }
    });
  }, [input, sessionId, startTransition]);

  const handleCancel = useCallback(async () => {
    cancelRequestedRef.current = true;
    try {
      await cancelInsightsSession();
    } catch { /* best-effort */ }
    setRunning(false);
    setSessionId(null);
    setRateLimited(false);
    setRateLimitMessage('');
    setAutoResumeAt(null);
    setCountdown('');
    // Auto-reconnect: get a fresh session for follow-up messages
    const newId = await getOrCreateInsightsSession();
    setSessionId(newId);
    cancelRequestedRef.current = false;
  }, []);

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
              onClick={handleRetryNow}
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
