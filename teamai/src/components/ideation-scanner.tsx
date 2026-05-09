'use client';

import { useState, useTransition } from 'react';
import { startIdeationScan } from '@/app/actions/ideation';
import { useSessionStream } from '@/hooks/use-session-stream';

function extractText(event: any): string {
  if (event.type !== 'assistant') return '';
  return (event.message?.content ?? [])
    .filter((b: any) => b.type === 'text')
    .map((b: any) => b.text)
    .join('');
}

export function IdeationScanner() {
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [output, setOutput] = useState('');
  const [isPending, startTransition] = useTransition();
  const streamEvents = useSessionStream(sessionId);

  // Accumulate output from stream events
  const latestText = (() => {
    for (let i = streamEvents.length - 1; i >= 0; i--) {
      const t = extractText(streamEvents[i].event);
      if (t) return t;
    }
    return output;
  })();

  const done = streamEvents.some(e => e.event.type === 'result');

  function handleScan() {
    setRunning(true);
    setOutput('');
    startTransition(async () => {
      const id = await startIdeationScan();
      setSessionId(id);
    });
  }

  return (
    <div className="flex flex-col h-full p-6 gap-4">
      <div className="flex items-center gap-4">
        <button
          onClick={handleScan}
          disabled={isPending || (running && !done)}
          className="px-4 py-2 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-md hover:bg-slate-700 disabled:opacity-40 transition-colors"
        >
          {running && !done ? 'Scanning…' : 'Run Scan'}
        </button>
        {done && <span className="text-xs text-green-600 dark:text-green-400">Scan complete</span>}
      </div>

      {latestText && (
        <div className="flex-1 overflow-y-auto bg-slate-50 dark:bg-slate-900 rounded-lg border border-slate-200 dark:border-slate-700 p-4">
          <pre className="text-xs text-slate-700 dark:text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
            {latestText}
          </pre>
        </div>
      )}

      {!latestText && !running && (
        <p className="text-sm text-slate-400">Click "Run Scan" to analyse the codebase.</p>
      )}
    </div>
  );
}
