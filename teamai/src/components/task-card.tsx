'use client';

import { useState, useEffect } from 'react';
import { useServerMutation } from '@/hooks/use-server-mutation';
import { checkTaskWorktree, deleteTaskWorktree, retryTask, stopTask, playTask } from '@/app/actions/tasks';
import type { Task } from '@/lib/task-store';
import { formatActionError } from '@/lib/error-format';
import { PHASE_BADGE, PHASE_LABELS } from '@/constants/phases';

const DESCRIPTION_LIMIT = 80;

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

interface Props {
  task: Task;
  onSelect: (id: string) => void;
  isMoving?: boolean;
}

const EXCLUDED_SPINNER_PHASES = new Set(['backlog', 'failed', 'merge', 'create-pr', 'done']);

export function TaskCard({ task, onSelect, isMoving }: Props) {
  const { run: runRetry, isPending: isRetrying } = useServerMutation();
  const { run: runStop, isPending: isStopping } = useServerMutation();
  const { run: runPlay, isPending: isStarting } = useServerMutation();
  const { run: runWtDelete } = useServerMutation(); // isolated — uses wtDeleting for UI state
  const [expanded, setExpanded] = useState(false);
  const [wtStatus, setWtStatus] = useState<{ exists: boolean; path: string | null }>({ exists: false, path: null });
  const [wtChecking, setWtChecking] = useState(!!task.branch);
  const [wtDeleting, setWtDeleting] = useState(false);

  useEffect(() => {
    if (!task.branch) {
      Promise.resolve().then(() => {
        setWtStatus({ exists: false, path: null });
        setWtChecking(false);
      });
      return;
    }
    checkTaskWorktree(task.id).then(status => {
      setWtStatus(status);
      setWtChecking(false);
    });
  }, [task.id, task.branch, task.phase]);

  async function handleDeleteWorktree(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm('Delete the git worktree for this task? This cannot be undone.')) return;
    setWtDeleting(true);
    runWtDelete(async () => {
      try {
        const result = await deleteTaskWorktree(task.id);
        if (result.success) {
          setWtStatus({ exists: false, path: null });
          return;
        }
        throw new Error(result.error || 'Unknown error'); // skip refresh on failure
      } catch (err) {
        alert(formatActionError('delete worktree', err));
        throw err;
      } finally {
        setWtDeleting(false);
      }
    });
  }

  const showSpinner = !EXCLUDED_SPINNER_PHASES.has(task.phase);
  const isRateLimited = !!task.rateLimitedUntil;
  const longDesc = task.description && task.description.length > DESCRIPTION_LIMIT;
  const displayDesc = task.description
    ? (longDesc && !expanded ? task.description.slice(0, DESCRIPTION_LIMIT) + '…' : task.description)
    : null;

  async function handleRetry(e: React.MouseEvent) {
    e.stopPropagation();
    runRetry(async () => {
      try {
        const result = await retryTask(task.id);
        if (!result.success) throw new Error(result.error || 'Unknown error');
      } catch (err) {
        alert(formatActionError('retry task', err));
        throw err;
      }
    });
  }

  async function handleStop(e: React.MouseEvent) {
    e.stopPropagation();
    runStop(async () => {
      try {
        const result = await stopTask(task.id);
        if (!result.success) throw new Error(result.error || 'Unknown error');
      } catch (err) {
        alert(formatActionError('stop task', err));
        throw err;
      }
    });
  }

  async function handlePlay(e: React.MouseEvent) {
    e.stopPropagation();
    runPlay(async () => {
      try {
        const result = await playTask(task.id);
        if (!result.success) throw new Error(result.error || 'Unknown error');
      } catch (err) {
        alert(formatActionError('start task', err));
        throw err;
      }
    });
  }

  return (
    <div
      data-testid="task-card"
      onClick={() => isMoving ? null : onSelect(task.id)}
      className={`relative bg-[#1e2333] rounded-lg p-3 border transition-all cursor-pointer group ${
        isMoving
          ? 'border-[#2563eb]/60 shadow-lg shadow-blue-500/10 pointer-events-none opacity-90'
          : task.autoProcessed && !task.autoReviewed
            ? 'border-amber-500/50 bg-amber-950/10 shadow-[0_0_8px_rgba(245,158,11,0.08)]'
            : 'border-[#1e293b] hover:border-[#334155]'
      }`}
    >
      {/* Moving indicator */}
      {isMoving && (
        <div className="absolute top-2 right-2 flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-blue-500 animate-ping" />
          <span className="text-[10px] text-blue-500 font-medium">moving</span>
        </div>
      )}
      {/* Auto-processed indicator — shown for auto-done tasks not yet manually reviewed */}
      {task.autoProcessed && !task.autoReviewed && task.phase === 'done' && (
        <div className="absolute top-2 right-2" title="Auto-processed — not yet manually reviewed">
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-400 border border-amber-700/40">
            Auto
          </span>
        </div>
      )}
      {/* Spinning circle indicator — shows for active phases */}
      {showSpinner && !isMoving && !isRateLimited && (
        <div className="absolute top-2 right-2" title="Task in progress" data-testid="spinner-icon">
          <div className="w-3 h-3 rounded-full border-2 border-slate-500 border-t-transparent animate-spin" />
        </div>
      )}
      {/* Hourglass indicator — replaces spinner when API rate-limited */}
      {showSpinner && !isMoving && isRateLimited && (
        <div className="absolute top-2 right-2" title="Rate limited — waiting for API quota" data-testid="hourglass-icon">
          <span className="text-sm text-amber-400">⏳</span>
        </div>
      )}

      <p className="text-sm font-medium text-white leading-snug pr-8">
        {task.title}
      </p>

      {displayDesc && (
        <p className="mt-1 text-xs text-slate-400 leading-snug">
          {displayDesc}
          {longDesc && (
            <button
              onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
              className="ml-1 text-slate-500 hover:text-slate-300"
            >
              {expanded ? 'less' : 'more'}
            </button>
          )}
        </p>
      )}

      <div className="mt-2.5 flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          <p className="text-[11px] text-slate-500">
            {relativeTime(task.createdAt)}
          </p>
          {/* Subtask progress indicator — shows when plan has subtasks */}
          {task.subtaskProgress && task.subtaskProgress.total > 0 && (
            <span
              className="text-[10px] font-medium"
              data-testid="subtask-progress-badge"
              title={`${task.subtaskProgress.completed} / ${task.subtaskProgress.total} subtasks completed`}
              style={{
                color: task.subtaskProgress.completed === task.subtaskProgress.total
                  ? '#22c55e'   // green-500 when all done
                  : task.subtaskProgress.completed > 0
                    ? '#eab308' // yellow-500 partially done
                    : '#64748b' // slate-500 none completed
              }}
            >
              {task.subtaskProgress.completed}/{task.subtaskProgress.total} ✓
            </span>
          )}
          {/* PR link indicator — shows when task has a created PR/MR */}
          {task.prUrl && (
            <a
              href={task.prUrl}
              target="_blank"
              rel="noopener noreferrer"
              onClick={e => e.stopPropagation()}
              title={`Open PR: ${task.prUrl}`}
              data-testid="pr-link-indicator"
              className="text-[10px] font-medium text-emerald-400 hover:text-emerald-300 transition-colors flex items-center gap-1 no-underline"
            >
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
              </svg>
              PR
            </a>
          )}
        </div>

        {/* Worktree info + delete — shows only when a worktree exists for this task */}
        {!wtChecking && wtStatus.exists && wtStatus.path && (
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-[10px] text-slate-600 truncate max-w-[120px]" title={wtStatus.path}>
              {wtStatus.path}
            </span>
            <button
              onClick={handleDeleteWorktree}
              disabled={wtDeleting}
              title={`Delete worktree (${task.branch})`}
              className="shrink-0 text-[11px] text-slate-600 hover:text-red-400 transition-colors disabled:opacity-40"
            >
              {wtDeleting ? '⌛' : '🗑'}
            </button>
          </div>
        )}
      </div>

      {/* Action buttons row */}
      <div className="mt-2 flex items-center justify-between">
        <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${PHASE_BADGE[task.phase] ?? 'bg-slate-800 text-slate-300'}`}>
          {PHASE_LABELS[task.phase] ?? task.phase}
        </span>
        <div className="flex items-center gap-1.5">
          {/* Play button — shown only for backlog tasks */}
          {task.phase === 'backlog' && (
            <button
              onClick={handlePlay}
              disabled={isStarting}
              title="Start task — move to Spec phase"
              className="text-[11px] font-medium px-2 py-1 rounded-md bg-emerald-900/30 text-emerald-400 hover:bg-emerald-800/40 hover:text-emerald-300 transition-colors disabled:opacity-50 flex items-center gap-1"
            >
              {isStarting ? (
                <span className="w-3 h-3 rounded-full border border-emerald-400 border-t-transparent animate-spin" />
              ) : (
                <span>▶</span>
              )}
              Start
            </button>
          )}

          {/* Stop button — shown for active phases (not backlog, failed, done) */}
          {!['backlog', 'failed', 'done'].includes(task.phase) && (
            <button
              onClick={handleStop}
              disabled={isStopping}
              title="Stop task — cancel and move back to Backlog"
              className="text-[11px] font-medium px-2 py-1 rounded-md bg-slate-700/50 text-slate-400 hover:bg-red-900/40 hover:text-red-400 transition-colors disabled:opacity-50 flex items-center gap-1"
            >
              {isStopping ? (
                <span className="w-3 h-3 rounded-full border border-red-400 border-t-transparent animate-spin" />
              ) : (
                <span>■</span>
              )}
              Stop
            </button>
          )}

          {/* Failure indicator — shown only for failed tasks */}
          {task.phase === 'failed' && (
            <span
              data-testid="failure-indicator"
              title="Task failed"
              className="text-[10px] font-medium text-red-400/70"
            >
              ✕
            </span>
          )}

          {/* Retry button — shown only for failed tasks */}
          {task.phase === 'failed' && (
            <button
              onClick={handleRetry}
              disabled={isRetrying}
              title="Retry task — restart pipeline from the phase it failed at"
              data-testid="retry-button"
              className="text-[11px] font-medium px-2 py-1 rounded-md bg-red-900/30 text-red-400 hover:bg-red-800/40 hover:text-red-300 transition-colors disabled:opacity-50 flex items-center gap-1"
            >
              {isRetrying ? (
                <span className="w-3 h-3 rounded-full border border-red-400 border-t-transparent animate-spin" />
              ) : (
                <span>↻</span>
              )}
              Retry
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
