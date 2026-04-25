'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createTask } from '@/app/actions/tasks';
import { TaskCard } from './task-card';
import type { Task } from '@/lib/task-store';

const COLUMNS = [
  { phase: 'backlog', label: 'Backlog' },
  { phase: 'spec', label: 'Spec' },
  { phase: 'plan', label: 'Planning' },
  { phase: 'implement', label: 'In Progress' },
  { phase: 'qa-review', label: 'QA' },
  { phase: 'awaiting-review', label: 'Review' },
  { phase: 'merge', label: 'Merging' },
  { phase: 'failed', label: 'Failed' },
  { phase: 'done', label: 'Done' },
] as const;

// Normalize phases that share a column
function normalizePhase(phase: string): string {
  if (phase === 'qa-fix') return 'qa-review';
  if (phase === 'create-pr') return 'merge';
  return phase;
}

export function KanbanBoard({ tasks }: { tasks: Task[] }) {
  const router = useRouter();
  const [showDialog, setShowDialog] = useState(false);
  const [isPending, startTransition] = useTransition();

  function handleCreate(formData: FormData) {
    startTransition(async () => {
      await createTask(formData);
      setShowDialog(false);
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 shrink-0">
        <h1 className="text-base font-semibold text-slate-900 dark:text-white">Board</h1>
        <button
          onClick={() => setShowDialog(true)}
          className="px-3 py-1.5 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-md hover:bg-slate-700 dark:hover:bg-slate-100 transition-colors"
        >
          + New Task
        </button>
      </div>

      <div className="flex-1 overflow-x-auto">
        <div className="flex gap-3 p-4 h-full" style={{ minWidth: 'max-content' }}>
          {COLUMNS.map(col => {
            const colTasks = tasks.filter(t => normalizePhase(t.phase) === col.phase);
            return (
              <div
                key={col.phase}
                className="flex flex-col w-60 shrink-0 bg-slate-100 dark:bg-slate-800 rounded-lg overflow-hidden"
              >
                <div className="flex items-center justify-between px-3 py-2.5 border-b border-slate-200 dark:border-slate-700">
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-600 dark:text-slate-300">
                    {col.label}
                  </span>
                  <span className="text-xs font-medium text-slate-400 bg-slate-200 dark:bg-slate-700 px-1.5 py-0.5 rounded-full">
                    {colTasks.length}
                  </span>
                </div>
                <div className="flex-1 overflow-y-auto p-2 space-y-2">
                  {colTasks.map(task => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setShowDialog(false)}
          />
          <div className="relative bg-white dark:bg-slate-800 rounded-lg shadow-xl p-6 w-full max-w-md mx-4">
            <h2 className="text-base font-semibold text-slate-900 dark:text-white mb-4">
              New Task
            </h2>
            <form action={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Title
                </label>
                <input
                  name="title"
                  required
                  placeholder="Add dark mode toggle"
                  className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-slate-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Description
                </label>
                <textarea
                  name="description"
                  rows={4}
                  placeholder="Describe what needs to be done..."
                  className="w-full px-3 py-2 text-sm border border-slate-300 dark:border-slate-600 rounded-md bg-white dark:bg-slate-700 text-slate-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-slate-500 resize-none"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowDialog(false)}
                  className="px-4 py-2 text-sm text-slate-600 dark:text-slate-300 hover:text-slate-900 dark:hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="px-4 py-2 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-md hover:bg-slate-700 dark:hover:bg-slate-100 transition-colors disabled:opacity-50"
                >
                  {isPending ? 'Creating...' : 'Create Task'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
