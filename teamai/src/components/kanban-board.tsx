'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { createTask, moveTask } from '@/app/actions/tasks';
import { usePhaseSync } from '@/hooks/use-phase-sync';
import { TaskCard } from './task-card';
import { TaskPanel } from './task-panel';
import type { Task } from '@/lib/task-store';
import type { InterruptedTask } from '@/lib/recovery';

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

interface Props {
  tasks: Task[];
  interrupted: InterruptedTask[];
}

export function KanbanBoard({ tasks, interrupted }: Props) {
  const router = useRouter();
  const [showDialog, setShowDialog] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverPhase, setDragOverPhase] = useState<string | null>(null);
  usePhaseSync();

  const interruptedMap = new Map(interrupted.map(t => [t.taskId, t]));

  function handleCreate(formData: FormData) {
    startTransition(async () => {
      await createTask(formData);
      setShowDialog(false);
      router.refresh();
    });
  }

  function handleDragStart(taskId: string) {
    setDraggingTaskId(taskId);
  }

  function handleDragEnd() {
    setDraggingTaskId(null);
    setDragOverPhase(null);
  }

  function handleDrop(targetPhase: string) {
    if (!draggingTaskId) return;
    const task = tasks.find(t => t.id === draggingTaskId);
    if (!task || normalizePhase(task.phase) === targetPhase) {
      setDraggingTaskId(null);
      setDragOverPhase(null);
      return;
    }
    startTransition(async () => {
      await moveTask(draggingTaskId, targetPhase);
      setDraggingTaskId(null);
      setDragOverPhase(null);
    });
  }

  return (
    <div className="flex flex-col h-full bg-slate-50 dark:bg-slate-950">
      <div className="flex items-center justify-between px-6 py-4 border-b bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-700 shrink-0">
        <h1 className="text-base font-semibold text-slate-900 dark:text-white">Board</h1>
        <button
          onClick={() => setShowDialog(true)}
          className="px-3 py-1.5 text-sm font-medium bg-slate-900 dark:bg-white text-white dark:text-slate-900 rounded-md hover:bg-slate-700 dark:hover:bg-slate-100 transition-colors"
        >
          + New Task
        </button>
      </div>

      {/* Split view: kanban left, task panel right */}
      <div className="flex flex-1 min-h-0">
        {/* Board columns */}
        <div className={`flex flex-col min-h-0 min-w-0 transition-all duration-200 ${selectedTaskId ? 'w-[55%]' : 'flex-1'}`}>
          <div className="flex-1 overflow-x-auto">
            <div className="flex gap-3 p-4 h-full" style={{ minWidth: 'max-content' }}>
              {COLUMNS.map(col => {
                const colTasks = tasks.filter(t => normalizePhase(t.phase) === col.phase);
                const isDropTarget = draggingTaskId !== null && dragOverPhase === col.phase;
                return (
                  <div
                    key={col.phase}
                    className={`flex flex-col w-60 shrink-0 rounded-lg overflow-hidden transition-colors ${
                      isDropTarget
                        ? 'bg-blue-100 dark:bg-blue-900/40 ring-2 ring-blue-400'
                        : 'bg-slate-100 dark:bg-slate-800'
                    }`}
                    onDragOver={e => { e.preventDefault(); setDragOverPhase(col.phase); }}
                    onDragLeave={() => setDragOverPhase(null)}
                    onDrop={() => handleDrop(col.phase)}
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
                        <div
                          key={task.id}
                          draggable
                          onDragStart={() => handleDragStart(task.id)}
                          onDragEnd={handleDragEnd}
                          className={draggingTaskId === task.id ? 'opacity-40' : ''}
                        >
                          <TaskCard
                            task={task}
                            interrupted={interruptedMap.get(task.id)}
                            onSelect={setSelectedTaskId}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>

        {/* Task detail panel */}
        {selectedTaskId && (
          <div className="w-[45%] shrink-0 min-h-0">
            <TaskPanel
              taskId={selectedTaskId}
              onClose={() => setSelectedTaskId(null)}
            />
          </div>
        )}
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
              <div>
                <label className="block text-sm font-medium text-slate-700 dark:text-slate-300 mb-1">
                  Reference images <span className="font-normal text-slate-400">(optional)</span>
                </label>
                <input
                  name="references"
                  type="file"
                  accept="image/*"
                  multiple
                  className="w-full text-sm text-slate-600 dark:text-slate-400 file:mr-3 file:py-1 file:px-3 file:rounded file:border-0 file:text-xs file:font-medium file:bg-slate-100 dark:file:bg-slate-700 file:text-slate-700 dark:file:text-slate-300 hover:file:bg-slate-200"
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
