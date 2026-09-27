'use client';

import { useState, useEffect } from 'react';
import { useServerMutation } from '@/hooks/use-server-mutation';
import { checkTaskWorktree, deleteTaskWorktree, retryTaskWithOptions, stopTask, pauseTask, resumeTask, playTask } from '@/app/actions/tasks';
import type { Task } from '@/lib/task-store';
import { formatActionError } from '@/lib/error-format';
import { PHASE_BADGE, PHASE_LABELS } from '@/constants/phases';
import { RetryPhaseDialog, type DialogPhaseOption } from './retry-phase-dialog';

// ── Phase options for the Retry button (full list) ──
// Default phase is 'implement' — the most common failure point is qa-review,
// which maps to implement-level artifact clearing (keep spec+plan, clear QA).
// This is a reasonable default since getResumePhaseForFailedTask() requires
// events.jsonl (server-side) and can't be computed client-side.
const RETRY_PHASE_OPTIONS: DialogPhaseOption[] = [
  { phase: 'spec', label: 'Spec' },
  { phase: 'plan', label: 'Plan' },
  { phase: 'implement', label: 'Implement' },
];

const DESCRIPTION_LIMIT = 80;

// Reason-aware tooltip for the failure indicator — distinguishes "ran out of
// QA-attempt budget on a genuine code defect" from "QA never reached a
// PASS/FAIL verdict before its own attempt budget ran out" (no defect found,
// QA simply didn't finish) from "ran out of spec-revision budget without QA
// ever passing" (the latter usually means the approach itself needs a
// redesign) from "an implement-phase retry cap was exceeded before QA ever
// ran" from "the coder session crashed outside any cap" from "a spec/plan/
// qa-review session's background wakeup cycle never produced its artifact".
// 'unknown' covers legacy failed tasks written before failureReason existed.
const FAILURE_REASON_TOOLTIP: Record<'qa-attempts-exhausted' | 'qa-incomplete' | 'spec-revision-exhausted' | 'implement-failure' | 'session-crashed' | 'wakeup-exhausted' | 'unknown', string> = {
  'qa-attempts-exhausted': 'Task failed — QA attempt budget exhausted',
  'qa-incomplete': 'Task failed — QA never finished its review (no defect found)',
  'spec-revision-exhausted': 'Task failed — spec revision budget exhausted (QA never passed)',
  'implement-failure': 'Task failed — implement-phase retry cap exceeded before QA ran',
  'session-crashed': 'Task failed — coder session crashed unexpectedly',
  'wakeup-exhausted': 'Task failed — a background job’s wakeup attempt budget was exhausted',
  unknown: 'Task failed',
};

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
  const { run: runPause, isPending: isPausing } = useServerMutation();
  const { run: runResume, isPending: isResuming } = useServerMutation();
  const { run: runPlay, isPending: isStarting } = useServerMutation();
  const { run: runWtDelete } = useServerMutation(); // isolated — uses wtDeleting for UI state
  const [expanded, setExpanded] = useState(false);
  const [wtStatus, setWtStatus] = useState<{ exists: boolean; path: string | null }>({ exists: false, path: null });
  const [wtChecking, setWtChecking] = useState(!!task.branch);
  const [wtDeleting, setWtDeleting] = useState(false);
  const [showRetryDialog, setShowRetryDialog] = useState(false);

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

  // A task can land on 'awaiting-review' either via a genuine QA pass (ready
  // to pick a merge strategy) or a failure park (spec phase produced no
  // spec.md/spec_summary.md, a no-op revision, a rolled-back approval) — see
  // task-utils.ts's getAwaitingReviewReason. Only the latter carries a
  // reason, so it's the signal for the "needs attention" indicator.
  const needsAttention = task.phase === 'awaiting-review' && !!task.awaitingReviewReason;
  const showSpinner = !EXCLUDED_SPINNER_PHASES.has(task.phase) && !task.isPaused && !task.rateLimitedUntil && !needsAttention;
  const isRateLimited = !!task.rateLimitedUntil;
  const longDesc = task.description && task.description.length > DESCRIPTION_LIMIT;
  const displayDesc = task.description
    ? (longDesc && !expanded ? task.description.slice(0, DESCRIPTION_LIMIT) + '…' : task.description)
    : null;

  function handleRetry(e: React.MouseEvent) {
    e.stopPropagation();
    setShowRetryDialog(true);
  }

  async function handleRetryConfirm(phase: string) {
    setShowRetryDialog(false);
    runRetry(async () => {
      try {
        const result = await retryTaskWithOptions(task.id, phase);
        if (!result.success) throw new Error(result.error || 'Unknown error');
      } catch (err) {
        alert(formatActionError('retry task', err));
        throw err;
      }
    });
  }

  async function handlePause(e: React.MouseEvent) {
    e.stopPropagation();
    runPause(async () => {
      try {
        const result = await pauseTask(task.id);
        if (!result.success) throw new Error(result.error || 'Unknown error');
      } catch (err) {
        alert(formatActionError('pause task', err));
        throw err;
      }
    });
  }

  async function handleResume(e: React.MouseEvent) {
    e.stopPropagation();
    runResume(async () => {
      try {
        const result = await resumeTask(task.id);
        if (!result.success) throw new Error(result.error || 'Unknown error');
      } catch (err) {
        alert(formatActionError('resume task', err));
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
    <>
    <div
      data-component="task-card"
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
      {/* Needs-attention indicator — awaiting-review parked by a failure
          (not a genuine QA pass), e.g. the spec phase producing no
          spec.md/spec_summary.md. Auto mode also refuses to auto-approve
          this state — see auto-mode.ts's _autoApprove. Icon-only (like the
          spinner/hourglass indicators it shares this corner with) with the
          full reason in the title tooltip — a text label here ("Needs
          attention") is wider than the pr-8 gutter reserved for this
          corner and overlaps the title/description below it. */}
      {needsAttention && !isMoving && (
        <div
          className="absolute top-2 right-2 w-4 h-4 rounded-full bg-red-950/60 border border-red-700/50 flex items-center justify-center"
          title={`Needs attention — ${task.awaitingReviewReason}`}
          data-component="needs-attention-badge"
        >
          <span className="text-[10px] leading-none text-red-400">⚠</span>
        </div>
      )}
      {/* Spinning circle indicator — shows for active phases */}
      {showSpinner && !isMoving && !isRateLimited && (
        <div className="absolute top-2 right-2" title="Task in progress" data-component="spinner-icon">
          <div className="w-3 h-3 rounded-full border-2 border-slate-500 border-t-transparent animate-spin" />
        </div>
      )}
      {/* Paused indicator */}
      {task.isPaused && (
        <div className="absolute top-2 right-2" title="Task paused — click Resume to continue">
          <span className="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-900/40 text-slate-400 border border-slate-700/40">
            ⏸ Paused
          </span>
        </div>
      )}
      {/* Hourglass indicator — only when rate-limited and NOT paused */}
      {!task.isPaused && isRateLimited && !EXCLUDED_SPINNER_PHASES.has(task.phase) && !isMoving && (
        <div className="absolute top-2 right-2" title="Rate limited — waiting for API quota" data-component="hourglass-icon">
          <span className="text-sm text-amber-400">⏳</span>
        </div>
      )}

      <p className="text-sm font-medium text-white leading-snug pr-8 break-words">
        {task.title}
      </p>

      {displayDesc && (
        <p className="mt-1 text-xs text-slate-400 leading-snug break-words">
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
              data-component="subtask-progress-badge"
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
              data-component="pr-link-indicator"
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

          {/* Pause button — shown for active non-terminal phases when NOT paused */}
          {!['backlog', 'failed', 'done'].includes(task.phase) && !task.isPaused && (
            <button
              onClick={handlePause}
              disabled={isPausing}
              title="Pause task — kill the session but stay in current phase"
              className="text-[11px] font-medium px-2 py-1 rounded-md bg-slate-700/50 text-slate-400 hover:bg-amber-900/40 hover:text-amber-400 transition-colors disabled:opacity-50 flex items-center gap-1"
            >
              {isPausing ? (
                <span className="w-3 h-3 rounded-full border border-amber-400 border-t-transparent animate-spin" />
              ) : (
                <span>⏸</span>
              )}
              Pause
            </button>
          )}

          {/* Resume button — shown when task is paused */}
          {task.isPaused && (
            <button
              onClick={handleResume}
              disabled={isResuming}
              title="Resume task — restart from current phase"
              className="text-[11px] font-medium px-2 py-1 rounded-md bg-emerald-900/30 text-emerald-400 hover:bg-emerald-800/40 hover:text-emerald-300 transition-colors disabled:opacity-50 flex items-center gap-1"
            >
              {isResuming ? (
                <span className="w-3 h-3 rounded-full border border-emerald-400 border-t-transparent animate-spin" />
              ) : (
                <span>▶</span>
              )}
              Resume
            </button>
          )}

          {/* Stop button — shown for active phases (always available alongside Pause) */}
          {!['backlog', 'failed', 'done'].includes(task.phase) && (
            <button
              onClick={handleStop}
              disabled={isStopping}
              title="Stop task — cancel, clean up artifacts, and move back to Backlog"
              className="text-[11px] font-medium px-1.5 py-1 rounded-md text-slate-600 hover:text-red-400 transition-colors disabled:opacity-40"
            >
              {isStopping ? (
                <span className="w-2.5 h-2.5 rounded-full border border-red-400 border-t-transparent animate-spin" />
              ) : (
                <span>✕</span>
              )}
            </button>
          )}

          {/* Failure indicator — shown only for failed tasks */}
          {task.phase === 'failed' && (
            <span
              data-component="failure-indicator"
              title={FAILURE_REASON_TOOLTIP[task.failureReason ?? 'unknown']}
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
              data-component="retry-button"
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

    {/* Retry-phase dialog */}
    {showRetryDialog && (
      <RetryPhaseDialog
        taskTitle={task.title}
        phases={RETRY_PHASE_OPTIONS}
        defaultPhase="implement"
        onCancel={() => setShowRetryDialog(false)}
        onConfirm={handleRetryConfirm}
      />
    )}
    </>
  );
}
