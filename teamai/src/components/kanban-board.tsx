'use client';

import { useState, useTransition, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createTask, moveTask } from '@/app/actions/tasks';
import { usePhaseSync } from '@/hooks/use-phase-sync';
import { TaskCard } from './task-card';
import { TaskPanel } from './task-panel';
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

interface Props {
  tasks: Task[];
}

export function KanbanBoard({ tasks }: Props) {
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

  // Close the task window on Escape key
  useEffect(() => {
    if (!selectedTaskId) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedTaskId(null);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedTaskId]);

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
    <div className="flex flex-col h-full bg-[#11131b]">
      <div className="flex items-center justify-between px-6 py-4 border-b bg-[#11131b] border-[#1e293b] shrink-0">
        <h1 className="text-xl font-bold text-white">Board</h1>
        <button
          onClick={() => setShowDialog(true)}
          className="px-3 py-1.5 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] transition-colors"
        >
          + New Task
        </button>
      </div>

      {/* Board columns — always full width */}
      <div className={`flex-1 min-h-0 relative ${selectedTaskId ? 'overflow-hidden' : ''}`}>
        <div className={`h-full overflow-x-auto ${selectedTaskId ? 'pointer-events-none select-none' : ''}`}>
          <div className="flex gap-3 p-4 h-full" style={{ minWidth: 'max-content' }}>
            {COLUMNS.map(col => {
              const colTasks = tasks.filter(t => normalizePhase(effectivePhase(t)) === col.phase);
              const isDropTarget = draggingTaskId !== null && dragOverPhase === col.phase;
              const isSameColumn = draggingTaskId !== null &&
                tasks.find(t => t.id === draggingTaskId && normalizePhase(effectivePhase(t)) === col.phase);
              return (
                <div
                  key={col.phase}
                  className={`flex flex-col w-60 shrink-0 rounded-lg overflow-hidden transition-all duration-200 ${
                    isDropTarget && !isSameColumn
                      ? 'bg-blue-900/20 ring-2 ring-[#2563eb] scale-[1.02]'
                      : 'bg-[#1a1f2e]'
                  }`}
                  onDragOver={e => { e.preventDefault(); setDragOverPhase(col.phase); }}
                  onDragLeave={() => setDragOverPhase(null)}
                  onDrop={() => handleDrop(col.phase)}
                >
                  <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#1e293b]">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      {col.label}
                    </span>
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full transition-colors ${
                      isDropTarget && !isSameColumn
                        ? 'bg-[#2563eb]/20 text-blue-300'
                        : 'bg-[#1e293b] text-slate-500'
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

        {/* Floating task window overlay */}
        {selectedTaskId && (
          <div className="absolute inset-0 z-40 flex items-center justify-center p-6">
            {/* Backdrop */}
            <div
              className="absolute inset-0 bg-black/40 backdrop-blur-sm"
              onClick={() => setSelectedTaskId(null)}
            />
            {/* Window */}
            <div
              className="relative w-[800px] h-[650px] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] bg-[#11131b] overflow-hidden flex flex-col animate-modal-in"
              onClick={e => e.stopPropagation()}
            >
              <TaskPanel
                taskId={selectedTaskId}
                onClose={() => setSelectedTaskId(null)}
              />
            </div>
          </div>
        )}
      </div>

      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setShowDialog(false)}
          />
          <div className="relative bg-[#1e2333] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] p-6 w-full max-w-md mx-4">
            <h2 className="text-base font-semibold text-white mb-4">
              New Task
            </h2>
            <form action={handleCreate} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">
                  Title
                </label>
                <input
                  name="title"
                  required
                  placeholder="Add dark mode toggle"
                  className="w-full px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] placeholder-slate-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">
                  Description
                </label>
                <textarea
                  name="description"
                  rows={4}
                  placeholder="Describe what needs to be done..."
                  className="w-full px-3 py-2 text-sm border border-[#334155] rounded-lg bg-[#11131b] text-white focus:outline-none focus:ring-2 focus:ring-[#2563eb] placeholder-slate-500 resize-none"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">
                  Reference images <span className="font-normal text-slate-500">(optional)</span>
                </label>
                <input
                  name="references"
                  type="file"
                  accept="image/*"
                  multiple
                  className="w-full text-sm text-slate-400 file:mr-3 file:py-1 file:px-3 file:rounded-lg file:border-0 file:text-xs file:font-medium file:bg-[#1a1f2e] file:text-slate-300 hover:file:bg-[#1e293b]"
                />
              </div>
              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowDialog(false)}
                  className="px-4 py-2 text-sm text-slate-400 hover:text-white transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isPending}
                  className="px-4 py-2 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] transition-colors disabled:opacity-50"
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
