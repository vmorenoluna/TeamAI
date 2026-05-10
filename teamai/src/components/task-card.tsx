'use client';

import { useState, useTransition } from 'react';
import type { Task } from '@/lib/task-store';
import type { InterruptedTask } from '@/lib/recovery';
import { resumeTask } from '@/app/actions/recovery';

const PHASE_BADGE: Record<string, string> = {
  backlog:           'bg-slate-200 text-slate-700 dark:bg-slate-600 dark:text-slate-200',
  spec:              'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300',
  plan:              'bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300',
  implement:         'bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300',
  'qa-review':       'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  'qa-fix':          'bg-orange-100 text-orange-700 dark:bg-orange-900 dark:text-orange-300',
  'awaiting-review': 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300',
  merge:             'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  'create-pr':       'bg-teal-100 text-teal-700 dark:bg-teal-900 dark:text-teal-300',
  failed:            'bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300',
  done:              'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300',
};

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
  interrupted?: InterruptedTask;
  onSelect: (id: string) => void;
  isMoving?: boolean;
}

export function TaskCard({ task, interrupted, onSelect, isMoving }: Props) {
  const badge = PHASE_BADGE[task.phase] ?? PHASE_BADGE.backlog;
  const [expanded, setExpanded] = useState(false);
  const [isPending, startTransition] = useTransition();
  const longDesc = task.description && task.description.length > DESCRIPTION_LIMIT;
  const displayDesc = task.description
    ? (longDesc && !expanded ? task.description.slice(0, DESCRIPTION_LIMIT) + '…' : task.description)
    : null;

  function handlePlay(e: React.MouseEvent) {
    e.stopPropagation();
    if (!interrupted) return;
    startTransition(async () => { await resumeTask(interrupted); });
  }

  return (
    <div
      onClick={() => isMoving ? null : onSelect(task.id)}
      className={`relative bg-white dark:bg-slate-900 rounded-md p-3 shadow-sm border transition-all cursor-pointer group ${
        isMoving
          ? 'border-blue-300 dark:border-blue-600 shadow-md pointer-events-none opacity-90'
          : 'border-slate-200 dark:border-slate-700 hover:shadow-md hover:border-slate-300 dark:hover:border-slate-600'
      }`}
    >
      {/* Moving indicator */}
      {isMoving && (
        <div className="absolute top-2 right-2 flex items-center gap-1">
          <div className="w-2 h-2 rounded-full bg-blue-500 animate-ping" />
          <span className="text-[10px] text-blue-500 font-medium">moving</span>
        </div>
      )}
      {/* Play button for interrupted tasks */}
      {interrupted && (
        <button
          onClick={handlePlay}
          disabled={isPending}
          title="Resume pipeline"
          className="absolute top-2 right-2 flex items-center justify-center w-6 h-6 rounded-full bg-green-100 dark:bg-green-900 text-green-700 dark:text-green-300 hover:bg-green-200 dark:hover:bg-green-800 disabled:opacity-50 transition-colors text-[10px] font-bold"
        >
          ▶
        </button>
      )}

      <p className="text-sm font-medium text-slate-900 dark:text-white leading-snug pr-8">
        {task.title}
      </p>

      {displayDesc && (
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-300 leading-snug">
          {displayDesc}
          {longDesc && (
            <button
              onClick={e => { e.stopPropagation(); setExpanded(v => !v); }}
              className="ml-1 text-slate-400 hover:text-slate-600 dark:text-slate-400 dark:hover:text-slate-200"
            >
              {expanded ? 'less' : 'more'}
            </button>
          )}
        </p>
      )}

      <div className="flex items-center justify-between gap-2 mt-2">
        <span className={`text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${badge}`}>
          {task.phase}
        </span>
        <span className="text-[11px] text-slate-400 shrink-0">
          {relativeTime(task.createdAt)}
        </span>
      </div>
    </div>
  );
}
