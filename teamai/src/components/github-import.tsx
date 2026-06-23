'use client';

import { useState, useTransition, useEffect, useRef, useMemo, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import {
  startIssueList,
  parseIssuesFromText,
  saveIssuesToFile,
  importIssues,
  getActiveIssueSession,
  cancelGithubIssueListing,
} from '@/app/actions/github';
import { useSessionStream } from '@/hooks/use-session-stream';
import { extractText, extractProgressText } from '@/lib/stream-types';
import { parseSessionLimitReset, formatCountdown } from '@/lib/rate-limit';
import type { GitHubIssue } from '@/app/actions/github';

export function GitHubImport() {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [issues, setIssues] = useState<GitHubIssue[]>([]);
  const [selectedNumbers, setSelectedNumbers] = useState<Set<number>>(new Set());
  const [importing, setImporting] = useState(false);
  const [importedCount, setImportedCount] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rateLimited, setRateLimited] = useState(false);
  const [rateLimitMessage, setRateLimitMessage] = useState('');
  const [autoResumeAt, setAutoResumeAt] = useState<number | null>(null);
  const [countdown, setCountdown] = useState('');
  const parsedRef = useRef(false);
  const cancelRequestedRef = useRef(false);
  const streamEvents = useSessionStream(sessionId);

  // Compute whether the agent is currently streaming from stream events
  const isStreaming = useMemo(() => {
    if (streamEvents.length === 0) return false;
    const lastType = streamEvents[streamEvents.length - 1].event.type;
    return lastType === 'assistant';
  }, [streamEvents]);

  // Sync running state from stream events
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRunning(isStreaming);
  }, [isStreaming]);

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

  // ── Auto-resume countdown ───────────────────────────────────────────────
  useEffect(() => {
    if (autoResumeAt === null) return;
    const timer = setInterval(() => {
      const remaining = autoResumeAt - Math.floor(Date.now() / 1000);
      if (remaining <= 0) {
        clearInterval(timer);
        setAutoResumeAt(null);
        setCountdown('');
        handleListIssues();
      } else {
        setCountdown(formatCountdown(autoResumeAt));
        setRateLimitMessage(`Session limit hit — auto-resuming ${formatCountdown(autoResumeAt)}`);
      }
    }, 1000);
    return () => clearInterval(timer);
   
  }, [autoResumeAt]);

  // Cancel auto-resume
  function handleCancelAutoResume() {
    setAutoResumeAt(null);
    setCountdown('');
    setRateLimited(false);
    setRateLimitMessage('');
  }

  // Accumulate streaming text for display using extractProgressText for tool visibility
  useEffect(() => {
    if (!running || !sessionId) return;
    let text = '';
    for (const e of streamEvents) {
      const t = extractProgressText(e.event);
      if (t) text += (text ? '\n' : '') + t;
    }
    if (text) {
      startTransition(() => {
        setStreamText(text);
      });
    }
  }, [streamEvents, running, sessionId]);

  const done = streamEvents.some(e => e.event.type === 'result');

  // When the session completes, parse JSON directly from streamEvents
  // (avoids stale state issue — streamText is async, streamEvents is synchronous here)
  useEffect(() => {
    if (!done || !sessionId || parsedRef.current) return;
    if (cancelRequestedRef.current) return;
    parsedRef.current = true;

    const sid = sessionId;

    // Build full text from all events synchronously
    let fullText = '';
    for (const e of streamEvents) {
      fullText += extractText(e.event);
    }

    // Defer state updates to avoid ESLint react-hooks/set-state-in-effect
    queueMicrotask(() => {
      setRunning(false);
      const parsed = parseIssuesFromText(fullText);
      setIssues(parsed);
      if (parsed.length > 0) {
        saveIssuesToFile(sid, parsed).catch(() => {});
      }
    });
  }, [done, sessionId, streamEvents]);

  // On mount, check for reconnection (existing session or cached file)
  useEffect(() => {
    if (running) return;
    startTransition(async () => {
      try {
        const existingSession = await getActiveIssueSession();
        if (existingSession) {
          setSessionId(existingSession);
          setRunning(true);
          return;
        }
      } catch {
        // no active session
      }
      // No active session — check cache
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function handleListIssues() {
    cancelRequestedRef.current = false;
    parsedRef.current = false;
    setRunning(true);
    setStreamText('');
    setIssues([]);
    setSelectedNumbers(new Set());
    setImportedCount(0);
    setError(null);
    setRateLimited(false);
    setRateLimitMessage('');
    setAutoResumeAt(null);
    setCountdown('');
    startTransition(async () => {
      try {
        const id = await startIssueList();
        if (!cancelRequestedRef.current) setSessionId(id);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to start issue listing');
        setRunning(false);
      }
    });
  }

  const handleCancel = useCallback(async () => {
    cancelRequestedRef.current = true;
    try {
      await cancelGithubIssueListing();
    } catch { /* best-effort */ }
    setRunning(false);
    setSessionId(null);
    setRateLimited(false);
    setRateLimitMessage('');
    setAutoResumeAt(null);
    setCountdown('');
  }, []);

  const handleRetryNow = useCallback(() => {
    setRateLimited(false);
    setRateLimitMessage('');
    setRunning(false);
    setSessionId(null);
    setAutoResumeAt(null);
    setCountdown('');
    handleListIssues();
  }, []);

  function toggleIssue(number: number) {
    setSelectedNumbers(prev => {
      const next = new Set(prev);
      if (next.has(number)) next.delete(number);
      else next.add(number);
      return next;
    });
  }

  function toggleAll() {
    if (selectedNumbers.size === issues.length) {
      setSelectedNumbers(new Set());
    } else {
      setSelectedNumbers(new Set(issues.map(i => i.number)));
    }
  }

  function handleImportSelected() {
    const toImport = issues.filter(i => selectedNumbers.has(i.number));
    if (toImport.length === 0) return;
    setImporting(true);
    setError(null);
    startTransition(async () => {
      try {
        const result = await importIssues(toImport);
        setImportedCount(result.taskIds.length);
        setSelectedNumbers(new Set());
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to import issues');
      } finally {
        setImporting(false);
      }
    });
  }

  const showNoMcp = done && issues.length === 0;

  return (
    <div className="flex flex-col h-full p-6 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-white">GitHub Issues</h1>
          <p className="text-sm text-slate-400 mt-1">
            Import open GitHub issues as kanban tasks. Requires the GitHub MCP server to be configured.
          </p>
        </div>
      </div>

      {/* Rate-limit banner */}
      {rateLimited && (
        <div className="shrink-0 bg-amber-950/30 border border-amber-800 rounded-lg p-4">
          <div className="flex items-center justify-between gap-4">
            <div className="flex items-center gap-2 min-w-0">
              <span className="text-amber-400 text-lg shrink-0">⏳</span>
              <span className="text-sm text-amber-300">{rateLimitMessage || 'Rate limit reached. Please wait and try again.'}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
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
                onClick={handleRetryNow}
                className="px-4 py-2 text-sm font-medium bg-amber-700 text-amber-100 rounded-lg hover:bg-amber-600 transition-colors"
              >
                Retry Now
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Actions bar */}
      <div className="flex items-center gap-3">
        {running && !done ? (
          <button
            onClick={handleCancel}
            className="px-4 py-2 text-sm font-medium bg-red-800 text-red-100 rounded-lg hover:bg-red-700 transition-colors flex items-center gap-2"
          >
            ✕ Stop
          </button>
        ) : (
          <button
            onClick={handleListIssues}
            disabled={isPending}
            className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors flex items-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
            </svg>
            List Open Issues
          </button>
        )}

        {done && issues.length > 0 && (
          <>
            <div className="w-px h-5 bg-[#334155]" />
            <button
              onClick={toggleAll}
              className="px-3 py-1.5 text-xs border border-[#334155] rounded-lg bg-[#1a1f2e] text-slate-300 hover:text-white hover:border-[#475569] transition-colors"
            >
              {selectedNumbers.size === issues.length ? 'Deselect All' : 'Select All'}
            </button>
            <button
              onClick={handleImportSelected}
              disabled={selectedNumbers.size === 0 || importing}
              className="px-4 py-2 text-sm font-medium bg-green-700 text-white rounded-lg hover:bg-green-600 disabled:opacity-40 transition-colors flex items-center gap-2"
            >
              {importing ? 'Importing…' : `Import Selected (${selectedNumbers.size})`}
            </button>
          </>
        )}

        {importedCount > 0 && (
          <span className="text-xs text-green-400">
            {importedCount} issue{importedCount !== 1 ? 's' : ''} imported
          </span>
        )}

        {error && (
          <span className="text-xs text-red-400">{error}</span>
        )}
      </div>

      {/* Error state: no GitHub MCP configured */}
      {showNoMcp && (
        <div className="bg-[#1e2333] rounded-lg border border-[#1e293b] p-6 text-center">
          <p className="text-sm text-slate-400">
            No issues found. The GitHub MCP server may not be configured.
          </p>
          <p className="text-xs text-slate-500 mt-2">
            Run{' '}
            <code className="px-1 py-0.5 bg-[#11131b] rounded text-slate-300">
              claude mcp add github -- npx -y @modelcontextprotocol/server-github
            </code>
            {' '}in your project directory and set the{' '}
            <code className="px-1 py-0.5 bg-[#11131b] rounded text-slate-300">GITHUB_PERSONAL_ACCESS_TOKEN</code>
            {' '}environment variable.
          </p>
        </div>
      )}

      {/* Empty state when done but no issues file found */}
      {done && issues.length === 0 && !streamText && (
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-slate-400">No open issues found.</p>
        </div>
      )}

      {/* Streaming output — show full accumulated text while running */}
      {running && !rateLimited && !done && streamEvents.length > 0 && (
        <div className="flex-1 overflow-y-auto bg-[#1a1f2e] rounded-lg border border-[#1e293b] p-4 min-h-[100px]">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-500">Agent Output</span>
            <span className="text-[10px] text-slate-600">{streamEvents.length} event{streamEvents.length !== 1 ? 's' : ''}</span>
          </div>
          {streamText ? (
            <pre className="text-xs text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">
              {streamText}
            </pre>
          ) : (
            <p className="text-xs text-slate-500 animate-pulse">Initialising…</p>
          )}
        </div>
      )}

      {/* Show "Running..." indicator when streaming but no events yet */}
      {running && !rateLimited && !done && streamEvents.length === 0 && (
        <div className="bg-[#1a1f2e] rounded-lg border border-[#1e293b] p-4 flex items-center gap-3">
          <div className="w-4 h-4 rounded-full border-2 border-blue-400 border-t-transparent animate-spin" />
          <span className="text-sm text-slate-400">Starting issue listing…</span>
        </div>
      )}

      {/* Issue list */}
      {done && issues.length > 0 && (
        <div className="flex-1 overflow-y-auto space-y-2">
          <div className="text-xs text-slate-500 mb-2">
            {issues.length} open issue{issues.length !== 1 ? 's' : ''} found
          </div>
          {issues.map(issue => (
            <div
              key={issue.number}
              onClick={() => toggleIssue(issue.number)}
              className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-all ${
                selectedNumbers.has(issue.number)
                  ? 'bg-[#2563eb]/10 border-[#2563eb]/40'
                  : 'bg-[#1e2333] border-[#1e293b] hover:border-[#334155]'
              }`}
            >
              <input
                type="checkbox"
                checked={selectedNumbers.has(issue.number)}
                onChange={() => toggleIssue(issue.number)}
                onClick={e => e.stopPropagation()}
                className="mt-0.5 rounded border-[#334155] bg-[#11131b]"
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-slate-500 font-mono shrink-0">#{issue.number}</span>
                  <span className="text-sm text-white font-medium truncate">{issue.title}</span>
                </div>
                {issue.body && (
                  <p className="text-xs text-slate-400 mt-1 line-clamp-2">{issue.body}</p>
                )}
                {issue.labels.length > 0 && (
                  <div className="flex gap-1.5 mt-1.5 flex-wrap">
                    {issue.labels.map(label => (
                      <span
                        key={label}
                        className="px-1.5 py-0.5 text-[10px] font-medium bg-[#1a1f2e] text-slate-400 rounded border border-[#334155]"
                      >
                        {label}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              <a
                href={issue.html_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={e => e.stopPropagation()}
                className="shrink-0 text-slate-500 hover:text-slate-300 transition-colors"
                title="Open on GitHub"
              >
                <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                  <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                </svg>
              </a>
            </div>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!running && !done && issues.length === 0 && !error && (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <svg className="w-12 h-12 mx-auto text-slate-600 mb-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
            </svg>
            <p className="text-sm text-slate-400">Click &quot;List Open Issues&quot; to fetch GitHub issues.</p>
          </div>
        </div>
      )}
    </div>
  );
}
