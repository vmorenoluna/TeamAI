'use client';

import { useState, useEffect, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { checkTaskWorktree, deleteTaskWorktree, retryTask } from '@/app/actions/tasks';
import type { Task } from '@/lib/task-store';

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
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [wtStatus, setWtStatus] = useState<{ exists: boolean; path: string | null }>({ exists: false, path: null });
  const [wtChecking, setWtChecking] = useState(true);
  const [wtDeleting, setWtDeleting] = useState(false);
  const [isRetrying, startRetryTransition] = useTransition();

  useEffect(() => {
    if (!task.branch) {
      setWtChecking(false);
      return;
    }
    checkTaskWorktree(task.id).then(status => {
      setWtStatus(status);
      setWtChecking(false);
    });
  }, [task.id, task.branch]);

  async function handleDeleteWorktree(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm('Delete the git worktree for this task? This cannot be undone.')) return;
    setWtDeleting(true);
    const result = await deleteTaskWorktree(task.id);
    if (result.success) {
      setWtStatus({ exists: false, path: null });
      router.refresh();
    } else {
      alert(`Failed to delete worktree: ${result.error}`);
    }
    setWtDeleting(false);
  }

  const showSpinner = !EXCLUDED_SPINNER_PHASES.has(task.phase);
  const isRateLimited = !!task.rateLimitedUntil;
  const longDesc = task.description && task.description.length > DESCRIPTION_LIMIT;
  const displayDesc = task.description
    ? (longDesc && !expanded ? task.description.slice(0, DESCRIPTION_LIMIT) + '…' : task.description)
    : null;

  async function handleRetry(e: React.MouseEvent) {
    e.stopPropagation();
    startRetryTransition(async () => {
      const result = await retryTask(task.id);
      if (result.success) {
        router.refresh();
      } else {
        alert(`Failed to retry task: ${result.error}`);
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
      {/* Failure indicator — shown when task has a completion summary (failed tasks) */}
      {task.completionSummary && task.phase === 'failed' && (
        <div className="absolute top-2 left-2 flex items-center gap-1" title="Task failed — click for details" data-testid="failure-indicator">
          <span className="text-xs text-red-400">✕</span>
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

      <div className="mt-2 flex items-center justify-between">
        <div className="flex items-center gap-2">
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
        </div>

        {/* Worktree info + delete — shows only when a worktree exists for this task */}
        {!wtChecking && wtStatus.exists && wtStatus.path && (
          <div className="flex items-center gap-1.5 min-w-0">
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

      {/* Retry button — shown only for failed tasks */}
      {task.phase === 'failed' && (
        <div className="mt-2 flex justify-end">
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
        </div>
      )}
    </div>
  );
}
