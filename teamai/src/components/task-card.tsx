'use client';

import { useState } from 'react';
import Link from 'next/link';
import type { Task } from '@/lib/task-store';

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

export function TaskCard({ task }: { task: Task }) {
  const badge = PHASE_BADGE[task.phase] ?? PHASE_BADGE.backlog;
  const [expanded, setExpanded] = useState(false);
  const longDesc = task.description && task.description.length > DESCRIPTION_LIMIT;
  const displayDesc = task.description
    ? (longDesc && !expanded ? task.description.slice(0, DESCRIPTION_LIMIT) + '…' : task.description)
    : null;

  return (
    <div className="bg-white dark:bg-slate-900 rounded-md p-3 shadow-sm border border-slate-200 dark:border-slate-700 hover:shadow-md hover:border-slate-300 dark:hover:border-slate-600 transition-all">
      <Link href={`/task/${task.id}`} className="block">
        <p className="text-sm font-medium text-slate-900 dark:text-white leading-snug">
          {task.title}
        </p>
      </Link>
      {displayDesc && (
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400 leading-snug">
          {displayDesc}
          {longDesc && (
            <button
              onClick={e => { e.preventDefault(); setExpanded(v => !v); }}
              className="ml-1 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 underline"
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
