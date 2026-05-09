'use client';

import { useState, useTransition, useCallback, useRef } from 'react';
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

  // Optimistic phase map — shows the card in the target column immediately after drop
  const [optimisticPhases, setOptimisticPhases] = useState<Map<string, string>>(new Map());
  const optimisticTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Clear optimistic phase when WebSocket confirms the change
  const clearOptimistic = useCallback((taskId: string) => {
    setOptimisticPhases(prev => {
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
    const t = optimisticTimeoutRef.current.get(taskId);
    if (t) { clearTimeout(t); optimisticTimeoutRef.current.delete(taskId); }
  }, []);

  usePhaseSync({
    onPhaseChange: (taskId) => clearOptimistic(taskId),
  });

  const interruptedMap = new Map(interrupted.map(t => [t.taskId, t]));

  // Get the effective phase for a task, considering optimistic updates
  const effectivePhase = useCallback((task: Task): string => {
    return optimisticPhases.get(task.id) ?? task.phase;
  }, [optimisticPhases]);

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
    if (!task || normalizePhase(effectivePhase(task)) === targetPhase) {
      setDraggingTaskId(null);
      setDragOverPhase(null);
      return;
    }

    // Optimistic UI: immediately show the card in the target column
    setOptimisticPhases(prev => {
      const next = new Map(prev);
      next.set(draggingTaskId, targetPhase);
      return next;
    });

    setDraggingTaskId(null);
    setDragOverPhase(null);

    // Clear optimistic phase after 10s if WebSocket hasn't confirmed
    const existing = optimisticTimeoutRef.current.get(draggingTaskId);
    if (existing) clearTimeout(existing);
    optimisticTimeoutRef.current.set(draggingTaskId, setTimeout(() => {
      setOptimisticPhases(prev => {
        const next = new Map(prev);
        next.delete(draggingTaskId);
        return next;
      });
    }, 10000));

    startTransition(async () => {
      await moveTask(draggingTaskId, targetPhase);
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
                const colTasks = tasks.filter(t => normalizePhase(effectivePhase(t)) === col.phase);
                const isDropTarget = draggingTaskId !== null && dragOverPhase === col.phase;
                const isSameColumn = draggingTaskId !== null &&
                  tasks.find(t => t.id === draggingTaskId && normalizePhase(effectivePhase(t)) === col.phase);
                return (
                  <div
                    key={col.phase}
                    className={`flex flex-col w-60 shrink-0 rounded-lg overflow-hidden transition-all duration-150 ${
                      isDropTarget && !isSameColumn
                        ? 'bg-blue-100 dark:bg-blue-900/40 ring-2 ring-blue-400 scale-[1.02]'
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
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full transition-colors ${
                        isDropTarget && !isSameColumn
                          ? 'bg-blue-200 dark:bg-blue-700 text-blue-700 dark:text-blue-200'
                          : 'bg-slate-200 dark:bg-slate-700 text-slate-400'
                      }`}>
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
                          className={`transition-opacity duration-150 ${
                            draggingTaskId === task.id ? 'opacity-40 scale-95' : ''
                          } ${optimisticPhases.has(task.id) ? 'animate-pulse' : ''}`}
                          style={{ cursor: 'grab' }}
                        >
                          <TaskCard
                            task={task}
                            interrupted={interruptedMap.get(task.id)}
                            onSelect={setSelectedTaskId}
                            isMoving={optimisticPhases.has(task.id)}
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
