'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { getOrCreateInsightsSession, sendInsightsMessage } from '@/app/actions/insights';
import { useSessionStream } from '@/hooks/use-session-stream';

interface Message {
  role: 'user' | 'assistant';
  content: string;
  streaming?: boolean;
}

function extractText(event: any): string {
  if (event.type !== 'assistant') return '';
  const blocks: any[] = event.message?.content ?? [];
  return blocks
    .filter(b => b.type === 'text')
    .map(b => b.text)
    .join('');
}

export function InsightsChat() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [isPending, startTransition] = useTransition();
  const bottomRef = useRef<HTMLDivElement>(null);
  const streamEvents = useSessionStream(sessionId);

  // Start session on mount
  useEffect(() => {
    getOrCreateInsightsSession().then(setSessionId);
  }, []);

  // Process incoming stream events into messages
  useEffect(() => {
    if (streamEvents.length === 0) return;
    const latest = streamEvents[streamEvents.length - 1];
    const { event } = latest;

    if (event.type === 'assistant') {
      const text = extractText(event);
      if (!text) return;
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

  function handleSend() {
    const text = input.trim();
    if (!text || !sessionId) return;
    setMessages(prev => [...prev, { role: 'user', content: text }]);
    setInput('');
    startTransition(async () => {
      await sendInsightsMessage(sessionId, text);
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="flex flex-col h-full">
      {/* Messages */}
      <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
        {messages.length === 0 && (
          <p className="text-sm text-slate-400 text-center mt-8">
            Ask anything about the codebase.
          </p>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[75%] px-4 py-2.5 rounded-2xl text-sm leading-relaxed whitespace-pre-wrap ${
              msg.role === 'user'
                ? 'bg-slate-800 text-white rounded-br-sm'
                : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-900 dark:text-white rounded-bl-sm'
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
      <div className="shrink-0 border-t border-slate-200 dark:border-slate-700 p-4">
        <div className="flex gap-2">
          <textarea
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={2}
            placeholder={sessionId ? 'Ask about the codebase… (Enter to send)' : 'Connecting…'}
            disabled={!sessionId || isPending}
            className="flex-1 min-w-0 px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-lg bg-white dark:bg-slate-800 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-slate-500 resize-none disabled:opacity-50"
          />
          <button
            onClick={handleSend}
            disabled={!sessionId || !input.trim() || isPending}
            className="px-4 py-2 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-lg hover:bg-slate-700 disabled:opacity-40 transition-colors shrink-0 self-end"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
