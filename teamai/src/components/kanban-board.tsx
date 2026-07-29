'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { createTask, moveTask, bulkDeleteTasks } from '@/app/actions/tasks';
import { useServerMutation } from '@/hooks/use-server-mutation';
import { usePhaseSync } from '@/hooks/use-phase-sync';
import { TaskCard } from './task-card';
import { ConnectionIndicator } from './connection-indicator';
import { ErrorBanner } from './error-banner';
import { TaskModal } from './task-modal';
import { NewTaskDialog } from './new-task-dialog';
import { KanbanFilters } from './kanban-filters';
import { COLUMNS, normalizePhase, resolveTargetPhase, TEMPLATES } from './kanban-utils';
import { formatActionError } from '@/lib/error-format';
import type { Task } from '@/lib/task-store';

interface Props {
  tasks: Task[];
  projectPath: string;
}

export function KanbanBoard({ tasks, projectPath }: Props) {
  const { run, isPending } = useServerMutation();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [draggingTaskId, setDraggingTaskId] = useState<string | null>(null);
  const [dragOverPhase, setDragOverPhase] = useState<string | null>(null);

  const [optimisticPhases, setOptimisticPhases] = useState<Map<string, string>>(new Map());
  const optimisticTimeoutRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // Live subtask progress counters — patched client-side from WebSocket events
  // so the counter updates without a full page refresh during implement.
  const [localSubtaskProgress, setLocalSubtaskProgress] = useState<
    Map<string, { completed: number; total: number }>
  >(new Map());

  const [searchQuery, setSearchQuery] = useState('');
  const [phaseFilter, setPhaseFilter] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'az' | 'za'>('newest');
  const [showDialog, setShowDialog] = useState(false);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [wsStatus, setWsStatus] = useState<'connecting' | 'connected' | 'disconnected'>('connecting');

  interface UndoAction { taskId: string; previousPhase: string; taskTitle: string; }
  const undoStackRef = useRef<UndoAction[]>([]);
  const [toast, setToast] = useState<{ text: string; undoAction?: UndoAction } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOptimistic = useCallback((taskId: string) => {
    setOptimisticPhases(prev => {
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
    const t = optimisticTimeoutRef.current.get(taskId);
    if (t) { clearTimeout(t); optimisticTimeoutRef.current.delete(taskId); }
    // Also clear the local subtask progress — the next router.refresh()
    // triggered by the phase change will bring fresh server data.
    setLocalSubtaskProgress(prev => {
      const next = new Map(prev);
      next.delete(taskId);
      return next;
    });
  }, []);

  usePhaseSync({
    project: projectPath,
    onPhaseChange: (taskId) => clearOptimistic(taskId),
    onSubtaskProgress: (taskId, completed, total) => {
      setLocalSubtaskProgress(prev => {
        const next = new Map(prev);
        next.set(taskId, { completed, total });
        return next;
      });
    },
    onConnectionChange: (connected) => setWsStatus(connected ? 'connected' : 'disconnected'),
  });

  useEffect(() => {
    if (!selectedTaskId) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedTaskId(null);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedTaskId]);

  const effectivePhase = useCallback((task: Task): string => {
    return optimisticPhases.get(task.id) ?? task.phase;
  }, [optimisticPhases]);

  const processedTasks = useCallback((): Task[] => {
    let result = [...tasks];
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q))
      );
    }
    if (phaseFilter.size > 0) {
      result = result.filter(t => phaseFilter.has(normalizePhase(effectivePhase(t))));
    }
    if (sourceFilter) {
      result = result.filter(t => t.source === sourceFilter);
    }
    result.sort((a, b) => {
      switch (sortBy) {
        case 'newest': return b.createdAt.localeCompare(a.createdAt);
        case 'oldest': return a.createdAt.localeCompare(b.createdAt);
        case 'az': return a.title.toLowerCase().localeCompare(b.title.toLowerCase());
        case 'za': return b.title.toLowerCase().localeCompare(a.title.toLowerCase());
        default: return 0;
      }
    });
    return result;
  }, [tasks, searchQuery, phaseFilter, sourceFilter, sortBy, effectivePhase]);

  const hasActiveFilters = searchQuery.trim() !== '' || phaseFilter.size > 0 || sourceFilter !== null || sortBy !== 'newest';

  const filteredTaskList = useCallback(() => processedTasks(), [processedTasks]);

  function handleCardClick(taskId: string, index: number, e: React.MouseEvent) {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      setSelectedIds(prev => {
        const next = new Set(prev);
        if (next.has(taskId)) next.delete(taskId); else next.add(taskId);
        return next;
      });
      setLastClickedIndex(index);
    } else if (e.shiftKey && lastClickedIndex !== null) {
      e.preventDefault();
      const filtered = filteredTaskList();
      const start = Math.min(lastClickedIndex, index);
      const end = Math.max(lastClickedIndex, index);
      const rangeIds = filtered.slice(start, end + 1).map(t => t.id);
      setSelectedIds(new Set(rangeIds));
    } else {
      setSelectedTaskId(taskId);
      setSelectedIds(new Set());
      setLastClickedIndex(null);
    }
  }

  function clearSelection() {
    setSelectedIds(new Set());
    setLastClickedIndex(null);
  }

  function handleBulkMove(targetPhase: string) {
    setError(null);
    run(async () => {
      try {
        for (const id of selectedIds) {
          const task = tasks.find(t => t.id === id);
          const actualPhase = resolveTargetPhase(targetPhase, task?.phase);
          await moveTask(id, actualPhase);
        }
        clearSelection();
      } catch (err) {
        setError(formatActionError('move tasks', err));
        throw err;
      }
    });
  }

  function handleBulkDelete() {
    if (!confirm(`Delete ${selectedIds.size} task(s)? This cannot be undone.`)) return;
    setError(null);
    run(async () => {
      try {
        await bulkDeleteTasks([...selectedIds]);
        clearSelection();
      } catch (err) {
        setError(formatActionError('delete tasks', err));
        throw err;
      }
    });
  }

  const showToast = useCallback((text: string, undoAction?: UndoAction) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ text, undoAction });
    toastTimerRef.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const handleUndo = useCallback(() => {
    const action = undoStackRef.current.pop();
    if (!action) return;
    setError(null);
    run(async () => {
      try {
        await moveTask(action.taskId, action.previousPhase);
        showToast(`Undone: moved "${action.taskTitle}" back to ${action.previousPhase}`);
      } catch (err) {
        setError(formatActionError('undo move', err));
        throw err;
      }
    });
  }, [showToast, run]);

  const toastUndoRef = useRef(toast?.undoAction);
  useEffect(() => { toastUndoRef.current = toast?.undoAction; }, [toast?.undoAction]);
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === 'z' && !e.shiftKey) {
        if (undoStackRef.current.length > 0 && toastUndoRef.current) {
          e.preventDefault();
          handleUndo();
        }
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [handleUndo]);

  function handleCreate(formData: FormData) {
    setError(null);
    run(async () => {
      try {
        await createTask(formData);
        setShowDialog(false);
      } catch (err) {
        setError(formatActionError('create task', err));
        throw err;
      }
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

    const previousPhase = task.phase;
    undoStackRef.current.push({ taskId: draggingTaskId, previousPhase, taskTitle: task.title });
    if (undoStackRef.current.length > 20) undoStackRef.current.shift();
    showToast(`Moved "${task.title}" to ${targetPhase}`, { taskId: draggingTaskId, previousPhase, taskTitle: task.title });

    setOptimisticPhases(prev => {
      const next = new Map(prev);
      next.set(draggingTaskId, targetPhase);
      return next;
    });

    setDraggingTaskId(null);
    setDragOverPhase(null);

    const existing = optimisticTimeoutRef.current.get(draggingTaskId);
    if (existing) clearTimeout(existing);
    optimisticTimeoutRef.current.set(draggingTaskId, setTimeout(() => {
      setOptimisticPhases(prev => {
        const next = new Map(prev);
        next.delete(draggingTaskId);
        return next;
      });
    }, 10000));

    const actualPhase = resolveTargetPhase(targetPhase, task.phase);
    run(async () => {
      try {
        await moveTask(draggingTaskId, actualPhase);
      } catch (err) {
        clearOptimistic(draggingTaskId);
        undoStackRef.current = undoStackRef.current.filter(a => a.taskId !== draggingTaskId);
        setError(formatActionError('move task', err));
        throw err;
      }
    });
  }

  function handleResetFilters() {
    setSearchQuery('');
    setPhaseFilter(new Set());
    setSourceFilter(null);
    setSortBy('newest');
  }

  return (
    <div className="flex flex-col h-full bg-[#11131b]" data-component="kanban-board">
      {/* Unified header row */}
      <div className="flex items-center flex-wrap gap-3 px-6 py-3 border-b bg-[#11131b] border-[#1e293b] shrink-0">
        <div className="flex items-center gap-2 shrink-0">
          <ConnectionIndicator connected={wsStatus === 'connected'} initial={wsStatus === 'connecting'} />
          <h1 className="text-lg font-bold text-white">Board</h1>
        </div>

        <KanbanFilters
          searchQuery={searchQuery}
          onSearchChange={setSearchQuery}
          phaseFilter={phaseFilter}
          onPhaseFilterChange={setPhaseFilter}
          sourceFilter={sourceFilter}
          onSourceFilterChange={setSourceFilter}
          sortBy={sortBy}
          onSortChange={setSortBy}
          hasActiveFilters={hasActiveFilters}
          onReset={handleResetFilters}
        />

        <button
          onClick={() => setShowDialog(true)}
          className="px-3 py-1.5 text-sm font-medium bg-[#2563eb] text-white rounded-lg hover:bg-[#1d4ed8] transition-colors shrink-0"
        >
          + New Task
        </button>
      </div>

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-6 py-2 bg-[#2563eb]/10 border-b border-[#2563eb]/30 shrink-0">
          <span className="text-xs text-blue-300 font-medium">{selectedIds.size} selected</span>
          <button onClick={clearSelection} className="text-xs text-slate-400 hover:text-white transition-colors">Deselect</button>
          <div className="w-px h-4 bg-[#334155]" />
          <span className="text-xs text-slate-400">Move to:</span>
          <select
            onChange={e => { if (e.target.value) handleBulkMove(e.target.value); e.target.value = ''; }}
            className="text-xs border border-[#334155] rounded px-2 py-1 bg-[#1a1f2e] text-slate-300 focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
            defaultValue=""
          >
            <option value="" disabled>Select phase…</option>
            {COLUMNS.map(col => (
              <option key={col.phase} value={col.phase}>{col.label}</option>
            ))}
          </select>
          <div className="w-px h-4 bg-[#334155]" />
          <button onClick={handleBulkDelete} className="text-xs text-red-400 hover:text-red-300 transition-colors">
            Delete selected
          </button>
        </div>
      )}

      {/* Board columns */}
      <div className={`flex-1 min-h-0 relative ${selectedTaskId ? 'overflow-hidden' : ''}`}>
        <div className={`h-full overflow-x-auto ${selectedTaskId ? 'pointer-events-none select-none' : ''}`}>
          <div className="flex gap-3 p-4 h-full" style={{ minWidth: 'max-content' }}>
            {(() => {
              const filtered = processedTasks();
              return COLUMNS.map(col => {
              const colTasks = filtered.filter(t => normalizePhase(effectivePhase(t)) === col.phase);
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
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">{col.label}</span>
                    <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full transition-colors ${
                      isDropTarget && !isSameColumn ? 'bg-[#2563eb]/20 text-blue-300' : 'bg-[#1e293b] text-slate-500'
                    }`}>
                      {colTasks.length}
                    </span>
                  </div>
                  <div className="flex-1 overflow-y-auto p-2 space-y-2">
                    {colTasks.map((task) => {
                      const globalIdx = filteredTaskList().findIndex(t => t.id === task.id);
                      const isSelected = selectedIds.has(task.id);
                      // Merge live subtask progress from WebSocket events into the
                      // server-provided task data so the counter updates without a full
                      // page refresh.  Falls back to the server value when not overridden.
                      const localProgress = localSubtaskProgress.get(task.id);
                      const displayTask = localProgress
                        ? { ...task, subtaskProgress: localProgress }
                        : task;
                      return (
                      <div
                        key={task.id}
                        draggable
                        data-card-id={task.id}
                        onDragStart={() => handleDragStart(task.id)}
                        onDragEnd={handleDragEnd}
                        onClick={e => handleCardClick(task.id, globalIdx, e)}
                        className={`relative transition-opacity duration-150 ${
                          draggingTaskId === task.id ? 'opacity-40 scale-95' : ''
                        } ${optimisticPhases.has(task.id) ? 'animate-pulse' : ''}
                        ${isSelected ? 'ring-2 ring-[#2563eb] rounded-lg' : ''}`}
                        style={{ cursor: 'grab' }}
                      >
                        {isSelected && (
                          <div className="absolute top-1 right-1 z-10 w-4 h-4 bg-[#2563eb] rounded-full flex items-center justify-center">
                            <span className="text-white text-[10px] font-bold">✓</span>
                          </div>
                        )}
                        <TaskCard task={displayTask} onSelect={() => {}} isMoving={optimisticPhases.has(task.id)} />
                      </div>
                      );
                    })}
                  </div>
                </div>
              );
            })})()}
          </div>
        </div>

        {/* Task modal */}
        {selectedTaskId && (
          <TaskModal taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} projectPath={projectPath} />
        )}
      </div>

      {/* Error banner */}
      {error && <ErrorBanner error={error} onDismiss={() => setError(null)} floating />}

      {/* Undo toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 bg-[#1e2333] border border-[#334155] rounded-lg shadow-xl shadow-black/40 animate-toast-in">
          <span className="text-xs text-slate-300">{toast.text}</span>
          {toast.undoAction && (
            <button onClick={handleUndo} className="text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors">
              Undo
            </button>
          )}
          <button onClick={() => setToast(null)} className="text-slate-500 hover:text-slate-300 text-sm leading-none">×</button>
        </div>
      )}

      {showDialog && (
        <NewTaskDialog
          templates={TEMPLATES}
          isPending={isPending}
          onClose={() => setShowDialog(false)}
          onSubmit={handleCreate}
        />
      )}
    </div>
  );
}
