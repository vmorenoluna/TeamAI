'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { createTask, moveTask, bulkDeleteTasks, retryTaskWithOptions } from '@/app/actions/tasks';
import { loadMoreDoneHistory, rescanDoneHistory } from '@/app/actions/history';
import { useServerMutation } from '@/hooks/use-server-mutation';
import { usePhaseSync } from '@/hooks/use-phase-sync';
import { TaskCard } from './task-card';
import { ConnectionIndicator } from './connection-indicator';
import { ErrorBanner } from './error-banner';
import { TaskModal } from './task-modal';
import { DoneHistoryCard, DoneHistoryModal } from './done-history';
import type { DoneTicketFromHistory } from '@/lib/history-scanner';
import { NewTaskDialog } from './new-task-dialog';
import { KanbanFilters } from './kanban-filters';
import { COLUMNS, normalizePhase, resolveTargetPhase, TEMPLATES } from './kanban-utils';
import { RetryPhaseDialog, type DialogPhaseOption } from './retry-phase-dialog';
import { formatActionError } from '@/lib/error-format';
import { NO_RESUME_PHASES } from '@/constants/phases';
import type { Task } from '@/lib/task-store';

interface Props {
  tasks: Task[];
  projectPath: string;
  /** History-reconstructed DONE tickets (§3f) — empty when recordHistoryInGit is off. */
  doneHistory?: DoneTicketFromHistory[];
  /** Whether more Source B (merged-PR) pages may be available (scroll pagination). */
  doneHistoryHasMore?: boolean;
}

// ── Phase options per kanban column ────────────────────────────────────────

const ANALYSIS_PHASE_OPTIONS: DialogPhaseOption[] = [
  { phase: 'spec', label: 'Spec' },
  { phase: 'plan', label: 'Plan' },
];

const IMPLEMENT_PHASE_OPTIONS: DialogPhaseOption[] = [
  { phase: 'implement', label: 'Implement' },
];

const REVIEW_PHASE_OPTIONS: DialogPhaseOption[] = [
  { phase: 'qa-review', label: 'QA Review' },
];

function getPhaseOptionsForColumn(colPhase: string): DialogPhaseOption[] | null {
  if (colPhase === 'analysis') return ANALYSIS_PHASE_OPTIONS;
  if (colPhase === 'implement') return IMPLEMENT_PHASE_OPTIONS;
  if (colPhase === 'review') return REVIEW_PHASE_OPTIONS;
  return null; // backlog / failed / done — no dialog
}

function isArtifactClearingTarget(targetPhase: string): boolean {
  return !NO_RESUME_PHASES.has(targetPhase);
}

/**
 * Topological sort for the backlog column.
 *
 * If task B depends on task A (A is in B's dependencies array), and both
 * are still in backlog, then A must appear above B — blocked tasks stack
 * below their blockers. Ties (neither depends on the other) break by
 * creation timestamp, oldest first.
 *
 * Uses Kahn's algorithm with a priority queue keyed by createdAt so the
 * tie-breaker is built into the queue ordering, not applied as a post-pass.
 */
function topoSortBacklog(tasks: Task[]): Task[] {
  if (tasks.length <= 1) return tasks;

  const idSet = new Set(tasks.map(t => t.id));

  // Build adjacency list: depId → [dependentIds ...]
  // ("blocker" → tasks that depend on it)
  const adj = new Map<string, string[]>();
  const inDegree = new Map<string, number>();
  for (const t of tasks) {
    adj.set(t.id, []);
    inDegree.set(t.id, 0);
  }
  for (const t of tasks) {
    if (!t.dependencies) continue;
    for (const depId of t.dependencies) {
      // Only consider dependencies still in the backlog. If the dep is
      // already done/in progress, it's not a blocking concern for ordering.
      if (!idSet.has(depId)) continue;
      const existing = adj.get(depId);
      if (existing) existing.push(t.id);
      inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
    }
  }

  // Priority queue: tasks with in-degree 0, ordered by createdAt (oldest first)
  const queue: Task[] = [];
  const taskById = new Map(tasks.map(t => [t.id, t]));
  for (const t of tasks) {
    if (inDegree.get(t.id) === 0) queue.push(t);
  }
  queue.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const result: Task[] = [];
  while (queue.length > 0) {
    const t = queue.shift()!;
    result.push(t);
    for (const depId of adj.get(t.id) ?? []) {
      const deg = (inDegree.get(depId) ?? 1) - 1;
      inDegree.set(depId, deg);
      if (deg === 0) {
        const next = taskById.get(depId);
        if (next) {
          // Insert sorted by createdAt to maintain priority order
          let i = 0;
          while (i < queue.length && queue[i].createdAt < next.createdAt) i++;
          queue.splice(i, 0, next);
        }
      }
    }
  }

  // Cycle guard: any tasks left unvisited (circular deps) append at end
  for (const t of tasks) {
    if (!result.includes(t)) result.push(t);
  }

  return result;
}

export function KanbanBoard({ tasks, projectPath, doneHistory = [], doneHistoryHasMore = false }: Props) {
  const { run, isPending } = useServerMutation();
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  // History tickets whose local folder was deleted — opened via the
  // read-only DoneHistoryModal (spec fetched on open, never preloaded).
  const [selectedHistorySlug, setSelectedHistorySlug] = useState<string | null>(null);
  // §3f scroll-driven Source B pagination + manual rescan state.
  const [historyPage, setHistoryPage] = useState(1);
  const [historyPages, setHistoryPages] = useState<DoneTicketFromHistory[][]>([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyHasMore, setHistoryHasMore] = useState(doneHistoryHasMore);
  const [rescanning, setRescanning] = useState(false);
  const doneColScrollRef = useRef<HTMLDivElement | null>(null);
  const scrollFetchRef = useRef(false); // gate: only one fetch in flight per scroll event
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

  // Pending drag-and-drop that needs the retry-phase confirmation dialog
  const [pendingDrop, setPendingDrop] = useState<{
    taskId: string;
    task: Task;
    targetPhase: string;
    colPhase: string;
  } | null>(null);

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

  // History-modal Escape handling (DoneHistoryModal also handles its own,
  // but this keeps the board's overlay guard in sync).
  useEffect(() => {
    if (!selectedHistorySlug) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setSelectedHistorySlug(null);
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [selectedHistorySlug]);

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

  // §3f: server page-1 history merged with locally loaded pages (scroll
  // pagination accumulates pages client-side; deduped by slug).
  const mergedHistory = (() => {
    const bySlug = new Map<string, DoneTicketFromHistory>();
    for (const t of doneHistory) bySlug.set(t.slug, t);
    for (const page of historyPages) {
      for (const t of page) if (!bySlug.has(t.slug)) bySlug.set(t.slug, t);
    }
    return [...bySlug.values()];
  })();

  // §3f scroll-driven Source B pagination: near the bottom of the DONE
  // column, fetch the next merged-PR page and accumulate it client-side.
  const handleDoneColumnScroll = useCallback(
    (e: React.UIEvent<HTMLDivElement>) => {
      if (scrollFetchRef.current) return; // one fetch per scroll-at-bottom
      const el = e.currentTarget;
      if (el.scrollTop + el.clientHeight < el.scrollHeight - 120) return;
      if (historyLoading) return;
      scrollFetchRef.current = true;
      setHistoryLoading(true);
      loadMoreDoneHistory(historyPage)
        .then(res => {
          if (res.tickets.length > 0) {
            setHistoryPages(prev => [...prev, res.tickets]);
            setHistoryPage(p => p + 1);
          }
          setHistoryHasMore(res.hasMore);
        })
        .catch(err => {
          setError(
            err instanceof Error
              ? `Failed to load more DONE history: ${err.message}`
              : 'Failed to load more DONE history',
          );
        })
        .finally(() => { setHistoryLoading(false); scrollFetchRef.current = false; });
    },
    [historyLoading, historyPage],
  );

  // §3f manual rescan escape hatch (force-pushes, manual git surgery).
  const handleRescanHistory = useCallback(() => {
    setRescanning(true);
    rescanDoneHistory()
      .then(() => {
        // The fresh scan arrives via router.refresh() in the server action's
        // revalidation; drop stale locally accumulated pages.
        setHistoryPages([]);
        setHistoryPage(1);
      })
      .catch(() => {
        // Best-effort escape hatch — keep current view on failure.
      })
      .finally(() => setRescanning(false));
  }, []);

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

  // ── Drop handler: show dialog for artifact-clearing phases, move instantly otherwise ──

  function handleDrop(colPhase: string) {
    if (!draggingTaskId) return;
    const task = tasks.find(t => t.id === draggingTaskId);
    if (!task || normalizePhase(effectivePhase(task)) === colPhase) {
      setDraggingTaskId(null);
      setDragOverPhase(null);
      return;
    }

    const actualPhase = resolveTargetPhase(colPhase, task.phase);

    // Drops to backlog / done / failed don't clear artifacts — proceed instantly.
    if (!isArtifactClearingTarget(actualPhase)) {
      executeDropMove(draggingTaskId, task, actualPhase, colPhase);
      return;
    }

    // Artifact-clearing target — show the confirmation dialog instead of
    // applying the optimistic update immediately.  Cancel keeps the card
    // in its original column untouched.
    setDraggingTaskId(null);
    setDragOverPhase(null);
    setPendingDrop({
      taskId: draggingTaskId,
      task,
      targetPhase: actualPhase,
      colPhase,
    });
  }

  /** Execute the actual move (optimistic UI + server call). */
  function executeDropMove(taskId: string, task: Task, actualPhase: string, colPhase: string) {
    const previousPhase = task.phase;
    undoStackRef.current.push({ taskId, previousPhase, taskTitle: task.title });
    if (undoStackRef.current.length > 20) undoStackRef.current.shift();
    showToast(`Moved "${task.title}" to ${colPhase}`, { taskId, previousPhase, taskTitle: task.title });

    setOptimisticPhases(prev => {
      const next = new Map(prev);
      next.set(taskId, colPhase);
      return next;
    });

    const existing = optimisticTimeoutRef.current.get(taskId);
    if (existing) clearTimeout(existing);
    optimisticTimeoutRef.current.set(taskId, setTimeout(() => {
      setOptimisticPhases(prev => {
        const next = new Map(prev);
        next.delete(taskId);
        return next;
      });
    }, 10000));

    run(async () => {
      try {
        await moveTask(taskId, actualPhase);
      } catch (err) {
        clearOptimistic(taskId);
        undoStackRef.current = undoStackRef.current.filter(a => a.taskId !== taskId);
        setError(formatActionError('move task', err));
        throw err;
      }
    });
  }

  /** Called when the user confirms the retry-phase dialog for a drop. */
  async function handleDropDialogConfirm(phase: string, resetBudget: boolean) {
    if (!pendingDrop) return;
    const { taskId, task, colPhase } = pendingDrop;
    setPendingDrop(null);

    const previousPhase = task.phase;
    undoStackRef.current.push({ taskId, previousPhase, taskTitle: task.title });
    if (undoStackRef.current.length > 20) undoStackRef.current.shift();
    showToast(`Moved "${task.title}" to ${colPhase}`, { taskId, previousPhase, taskTitle: task.title });

    setOptimisticPhases(prev => {
      const next = new Map(prev);
      next.set(taskId, colPhase);
      return next;
    });

    const existing = optimisticTimeoutRef.current.get(taskId);
    if (existing) clearTimeout(existing);
    optimisticTimeoutRef.current.set(taskId, setTimeout(() => {
      setOptimisticPhases(prev => {
        const next = new Map(prev);
        next.delete(taskId);
        return next;
      });
    }, 10000));

    run(async () => {
      try {
        await retryTaskWithOptions(taskId, phase, resetBudget);
      } catch (err) {
        clearOptimistic(taskId);
        undoStackRef.current = undoStackRef.current.filter(a => a.taskId !== taskId);
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

  // ── Compute dialog phase options for a pending drop ──
  const dropDialogPhases = pendingDrop
    ? getPhaseOptionsForColumn(pendingDrop.colPhase)
    : null;

  // Budget default: checked for spec/plan (already cleared in moveTaskToPhase),
  // unchecked for implement/qa-review (preserve circuit-breaker semantics).
  const dropBudgetDefault = pendingDrop
    ? (pendingDrop.targetPhase === 'spec' || pendingDrop.targetPhase === 'plan')
    : false;

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
      <div className={`flex-1 min-h-0 relative ${selectedTaskId || selectedHistorySlug ? 'overflow-hidden' : ''}`}>
        <div className={`h-full overflow-x-auto ${selectedTaskId || selectedHistorySlug ? 'pointer-events-none select-none' : ''}`}>
          <div className="flex gap-3 p-4 h-full" style={{ minWidth: 'max-content' }}>
            {(() => {
              const filtered = processedTasks();
              return COLUMNS.map(col => {
              let colTasks = filtered.filter(t => normalizePhase(effectivePhase(t)) === col.phase);
              // Done column: always sort by updatedAt descending — most recently
              // completed tasks at the top. Other columns respect the global sort.
              if (col.phase === 'done') {
                colTasks = [...colTasks].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
              }
              // §3f: history-reconstructed DONE tickets — tasks whose local
              // folder was deleted on completion, rebuilt from git/PR history.
              // Rendered below the disk tasks (fresh completions first),
              // filtered by the same search box.
              const historyTickets = col.phase === 'done'
                ? mergedHistory.filter(t =>
                    !searchQuery.trim() ||
                    t.title.toLowerCase().includes(searchQuery.toLowerCase().trim()) ||
                    t.slug.toLowerCase().includes(searchQuery.toLowerCase().trim()))
                : [];
              // Backlog column: topological sort by dependency order, breaking
              // ties by creation time (oldest first). If task B depends on A,
              // A stacks above B — only when both are still in backlog.
              if (col.phase === 'backlog') {
                colTasks = topoSortBacklog(colTasks);
              }
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
                    {col.phase === 'done' ? (
                      <div className="flex items-center gap-1.5">
                        {doneHistoryHasMore || historyHasMore ? (
                          <button
                            onClick={handleRescanHistory}
                            disabled={rescanning}
                            title="Rescan git/PR history (force-pushes, manual git surgery)"
                            className="text-[10px] text-slate-500 hover:text-blue-300 transition-colors disabled:opacity-50"
                          >
                            {rescanning ? 'Rescanning…' : 'Rescan'}
                          </button>
                        ) : null}
                        <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full transition-colors ${
                          isDropTarget && !isSameColumn ? 'bg-[#2563eb]/20 text-blue-300' : 'bg-[#1e293b] text-slate-500'
                        }`}>
                          {colTasks.length + historyTickets.length}
                        </span>
                      </div>
                    ) : (
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded-full transition-colors ${
                        isDropTarget && !isSameColumn ? 'bg-[#2563eb]/20 text-blue-300' : 'bg-[#1e293b] text-slate-500'
                      }`}>
                        {colTasks.length + historyTickets.length}
                      </span>
                    )}
                  </div>
                  <div
                    className="flex-1 overflow-y-auto p-2 space-y-2"
                    ref={col.phase === 'done' ? doneColScrollRef : undefined}
                    onScroll={col.phase === 'done' ? handleDoneColumnScroll : undefined}
                  >
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
                    {historyTickets.map(ticket => (
                      <DoneHistoryCard
                        key={`history-${ticket.slug}`}
                        ticket={ticket}
                        onSelect={setSelectedHistorySlug}
                      />
                    ))}
                    {col.phase === 'done' && historyLoading && (
                      <div className="text-center text-[10px] text-slate-500 py-1">Loading more…</div>
                    )}
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

        {/* §3f: read-only detail for history-reconstructed DONE tickets */}
        {selectedHistorySlug && (
          <DoneHistoryModal slug={selectedHistorySlug} onClose={() => setSelectedHistorySlug(null)} />
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

      {/* Drop-target retry-phase dialog */}
      {pendingDrop && dropDialogPhases && (
        <RetryPhaseDialog
          taskTitle={pendingDrop.task.title}
          phases={dropDialogPhases}
          defaultPhase={pendingDrop.targetPhase}
          budgetDefault={dropBudgetDefault}
          onCancel={() => setPendingDrop(null)}
          onConfirm={handleDropDialogConfirm}
        />
      )}
    </div>
  );
}
