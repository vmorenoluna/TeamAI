'use client';

import { useState, useTransition, useCallback, useRef, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { createTask, moveTask, bulkDeleteTasks } from '@/app/actions/tasks';
import { usePhaseSync } from '@/hooks/use-phase-sync';
import { TaskCard } from './task-card';
import { TaskPanel } from './task-panel';
import type { Task } from '@/lib/task-store';

const COLUMNS = [
  { phase: 'backlog', label: 'Backlog' },
  { phase: 'spec', label: 'Spec' },
  { phase: 'plan', label: 'Planning' },
  { phase: 'implement', label: 'In Progress' },
  { phase: 'qa-review', label: 'QA Review' },
  { phase: 'awaiting-review', label: 'Awaiting Review' },
  { phase: 'merge', label: 'Merging' },
  { phase: 'failed', label: 'Failed' },
  { phase: 'done', label: 'Done' },
] as const;

// Normalize phases that share a column
function normalizePhase(phase: string): string {
  if (phase === 'qa-fix') return 'qa-review';
  if (phase === 'create-pr') return 'merge';
  if (phase === 'pr-open') return 'merge';
  return phase;
}

const TEMPLATES = [
  {
    name: 'Bug Fix',
    icon: '🐛',
    titlePrefix: 'Fix: ',
    descriptionTemplate: '## Current Behavior\n\n\n## Expected Behavior\n\n\n## Steps to Reproduce\n1. \n2. \n3. ',
  },
  {
    name: 'Feature Request',
    icon: '✨',
    titlePrefix: 'Feat: ',
    descriptionTemplate: '## User Story\nAs a , I want  so that .\n\n## Acceptance Criteria\n- [ ] \n- [ ] ',
  },
  {
    name: 'Refactor',
    icon: '🔧',
    titlePrefix: 'Refactor: ',
    descriptionTemplate: '## Motivation\n\n\n## Proposed Changes\n- \n- \n\n## Affected Files\n- ',
  },
  {
    name: 'Documentation',
    icon: '📝',
    titlePrefix: 'Docs: ',
    descriptionTemplate: '## What needs documenting\n\n\n## Audience\n\n\n## Outline\n- \n- ',
  },
] as const;

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

  // Search, filter, and sort state
  const [searchQuery, setSearchQuery] = useState('');
  const [phaseFilter, setPhaseFilter] = useState<Set<string>>(new Set());
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [sortBy, setSortBy] = useState<'newest' | 'oldest' | 'az' | 'za'>('newest');
  const [showPhaseDropdown, setShowPhaseDropdown] = useState(false);
  const [showSourceDropdown, setShowSourceDropdown] = useState(false);
  const [showSortDropdown, setShowSortDropdown] = useState(false);

  // New Task dialog template state
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);

  // Bulk selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);

  // Undo state
  interface UndoAction { taskId: string; previousPhase: string; taskTitle: string; }
  const undoStackRef = useRef<UndoAction[]>([]);
  const [toast, setToast] = useState<{ text: string; undoAction?: UndoAction } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

  // Filter and sort tasks
  const processedTasks = useCallback((): Task[] => {
    let result = [...tasks];

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase().trim();
      result = result.filter(t =>
        t.title.toLowerCase().includes(q) ||
        (t.description && t.description.toLowerCase().includes(q))
      );
    }

    // Phase filter
    if (phaseFilter.size > 0) {
      result = result.filter(t => phaseFilter.has(normalizePhase(effectivePhase(t))));
    }

    // Source filter
    if (sourceFilter) {
      result = result.filter(t => t.source === sourceFilter);
    }

    // Sort
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

  function selectTemplate(name: string) {
    const t = TEMPLATES.find(t => t.name === name);
    if (t) {
      setNewTitle(t.titlePrefix);
      setNewDesc(t.descriptionTemplate);
      setSelectedTemplate(name);
    }
  }

  function clearTemplate() {
    setNewTitle('');
    setNewDesc('');
    setSelectedTemplate(null);
  }

  // Bulk selection handlers
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
    startTransition(async () => {
      for (const id of selectedIds) {
        await moveTask(id, targetPhase);
      }
      clearSelection();
      router.refresh();
    });
  }

  function handleBulkDelete() {
    if (!confirm(`Delete ${selectedIds.size} task(s)? This cannot be undone.`)) return;
    startTransition(async () => {
      await bulkDeleteTasks([...selectedIds]);
      clearSelection();
      router.refresh();
    });
  }

  // Undo helpers
  const showToast = useCallback((text: string, undoAction?: UndoAction) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ text, undoAction });
    toastTimerRef.current = setTimeout(() => setToast(null), 5000);
  }, []);

  const handleUndo = useCallback(() => {
    const action = undoStackRef.current.pop();
    if (!action) return;
    startTransition(async () => {
      await moveTask(action.taskId, action.previousPhase);
      showToast(`Undone: moved "${action.taskTitle}" back to ${action.previousPhase}`);
      router.refresh();
    });
  }, [showToast, router]);

  // Ctrl+Z listener — stable ref pattern avoids re-attaching on every keystroke
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
    startTransition(async () => {
      await createTask(formData);
      setShowDialog(false);
      clearTemplate();
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

    const previousPhase = normalizePhase(effectivePhase(task));
    // Push to undo stack
    undoStackRef.current.push({
      taskId: draggingTaskId,
      previousPhase,
      taskTitle: task.title,
    });
    if (undoStackRef.current.length > 20) undoStackRef.current.shift();
    showToast(`Moved "${task.title}" to ${targetPhase}`, { taskId: draggingTaskId, previousPhase, taskTitle: task.title });

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

      {/* Filter toolbar */}
      <div className="flex items-center gap-3 px-6 py-2.5 border-b bg-[#0f1119] border-[#1e293b] shrink-0">
        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder="Search tasks…"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            className="w-full pl-8 pr-8 py-1.5 text-xs bg-[#1a1f2e] border border-[#334155] rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
          />
          {searchQuery && (
            <button
              onClick={() => { setSearchQuery(''); }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-sm leading-none"
            >
              ×
            </button>
          )}
        </div>

        {/* Phase filter */}
        <div className="relative">
          <button
            onClick={() => { setShowPhaseDropdown(o => !o); setShowSourceDropdown(false); setShowSortDropdown(false); }}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
              phaseFilter.size > 0
                ? 'border-[#2563eb]/60 bg-[#2563eb]/10 text-blue-300'
                : 'border-[#334155] bg-[#1a1f2e] text-slate-400 hover:text-slate-300'
            }`}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
            Phase
            {phaseFilter.size > 0 && (
              <span className="bg-[#2563eb] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">{phaseFilter.size}</span>
            )}
          </button>
          {showPhaseDropdown && (
            <div className="absolute z-30 top-full left-0 mt-1 w-44 bg-[#1e2333] rounded-lg border border-[#1e293b] shadow-xl overflow-hidden">
              {COLUMNS.map(col => (
                <label key={col.phase} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[#1a1f2e] transition-colors">
                  <input
                    type="checkbox"
                    checked={phaseFilter.has(col.phase)}
                    onChange={e => {
                      setPhaseFilter(prev => {
                        const next = new Set(prev);
                        if (e.target.checked) next.add(col.phase);
                        else next.delete(col.phase);
                        return next;
                      });
                    }}
                    className="rounded border-[#334155] bg-[#11131b]"
                  />
                  <span className="text-xs text-slate-300">{col.label}</span>
                </label>
              ))}
              {phaseFilter.size > 0 && (
                <button
                  onClick={() => setPhaseFilter(new Set())}
                  className="w-full px-3 py-1.5 text-xs text-slate-400 hover:text-white border-t border-[#1e293b] transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          )}
        </div>

        {/* Source filter */}
        <div className="relative">
          <button
            onClick={() => { setShowSourceDropdown(o => !o); setShowPhaseDropdown(false); setShowSortDropdown(false); }}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
              sourceFilter
                ? 'border-[#2563eb]/60 bg-[#2563eb]/10 text-blue-300'
                : 'border-[#334155] bg-[#1a1f2e] text-slate-400 hover:text-slate-300'
            }`}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
            </svg>
            Source
            {sourceFilter && (
              <span className="bg-[#2563eb] text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full leading-none">1</span>
            )}
          </button>
          {showSourceDropdown && (
            <div className="absolute z-30 top-full left-0 mt-1 w-44 bg-[#1e2333] rounded-lg border border-[#1e293b] shadow-xl overflow-hidden">
              {[
                { value: null, label: 'All sources' },
                { value: 'ideation', label: 'Ideation' },
                { value: 'competitor-analysis', label: 'Competitor Analysis' },
              ].map(opt => (
                <button
                  key={opt.label}
                  onClick={() => { setSourceFilter(opt.value); setShowSourceDropdown(false); }}
                  className={`w-full text-left px-3 py-2 text-xs hover:bg-[#1a1f2e] transition-colors ${
                    sourceFilter === opt.value ? 'text-blue-300 bg-[#1a1f2e]' : 'text-slate-300'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Sort */}
        <div className="relative">
          <button
            onClick={() => { setShowSortDropdown(o => !o); setShowPhaseDropdown(false); setShowSourceDropdown(false); }}
            className={`flex items-center gap-1.5 px-2.5 py-1.5 text-xs rounded-lg border transition-colors ${
              sortBy !== 'newest'
                ? 'border-[#2563eb]/60 bg-[#2563eb]/10 text-blue-300'
                : 'border-[#334155] bg-[#1a1f2e] text-slate-400 hover:text-slate-300'
            }`}
          >
            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h13M3 8h9m-9 4h6m4 0l4-4m0 0l4 4m-4-4v12" />
            </svg>
            Sort
          </button>
          {showSortDropdown && (
            <div className="absolute z-30 top-full right-0 mt-1 w-36 bg-[#1e2333] rounded-lg border border-[#1e293b] shadow-xl overflow-hidden">
              {[
                { value: 'newest', label: 'Newest first' },
                { value: 'oldest', label: 'Oldest first' },
                { value: 'az', label: 'A → Z' },
                { value: 'za', label: 'Z → A' },
              ].map(opt => (
                <button
                  key={opt.value}
                  onClick={() => { setSortBy(opt.value as 'newest' | 'oldest' | 'az' | 'za'); setShowSortDropdown(false); }}
                  className={`w-full text-left px-3 py-2 text-xs hover:bg-[#1a1f2e] transition-colors ${
                    sortBy === opt.value ? 'text-blue-300 bg-[#1a1f2e]' : 'text-slate-300'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Clear all */}
        {hasActiveFilters && (
          <button
            onClick={() => {
              setSearchQuery('');
              setPhaseFilter(new Set());
              setSourceFilter(null);
              setSortBy('newest');
            }}
            className="text-xs text-slate-500 hover:text-slate-300 transition-colors whitespace-nowrap"
          >
            Reset
          </button>
        )}
      </div>

      {/* Close dropdowns on outside click */}
      { (showPhaseDropdown || showSourceDropdown || showSortDropdown) && (
        <div
          className="fixed inset-0 z-20"
          onClick={() => { setShowPhaseDropdown(false); setShowSourceDropdown(false); setShowSortDropdown(false); }}
          onKeyDown={e => { if (e.key === 'Escape') { setShowPhaseDropdown(false); setShowSourceDropdown(false); setShowSortDropdown(false); } }}
          role="button"
          tabIndex={0}
        />
      )}

      {/* Bulk action bar */}
      {selectedIds.size > 0 && (
        <div className="flex items-center gap-3 px-6 py-2 bg-[#2563eb]/10 border-b border-[#2563eb]/30 shrink-0">
          <span className="text-xs text-blue-300 font-medium">{selectedIds.size} selected</span>
          <button
            onClick={clearSelection}
            className="text-xs text-slate-400 hover:text-white transition-colors"
          >
            Deselect
          </button>
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
          <button
            onClick={handleBulkDelete}
            className="text-xs text-red-400 hover:text-red-300 transition-colors"
          >
            Delete selected
          </button>
        </div>
      )}

      {/* Board columns — always full width */}
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
                    {colTasks.map((task) => {
                      const globalIdx = filteredTaskList().findIndex(t => t.id === task.id);
                      const isSelected = selectedIds.has(task.id);
                      return (
                      <div
                        key={task.id}
                        draggable
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
                        <TaskCard
                          task={task}
                          onSelect={() => {}}
                          isMoving={optimisticPhases.has(task.id)}
                        />
                      </div>
                      );
                    })}
                  </div>
                </div>
              );
            })})()}
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

      {/* Undo toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 flex items-center gap-3 px-4 py-2.5 bg-[#1e2333] border border-[#334155] rounded-lg shadow-xl shadow-black/40 animate-toast-in">
          <span className="text-xs text-slate-300">{toast.text}</span>
          {toast.undoAction && (
            <button
              onClick={handleUndo}
              className="text-xs font-medium text-blue-400 hover:text-blue-300 transition-colors"
            >
              Undo
            </button>
          )}
          <button
            onClick={() => setToast(null)}
            className="text-slate-500 hover:text-slate-300 text-sm leading-none"
          >
            ×
          </button>
        </div>
      )}

      {showDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => { setShowDialog(false); clearTemplate(); }}
          />
          <div className="relative bg-[#1e2333] rounded-xl shadow-2xl shadow-black/40 border border-[#1e293b] p-6 w-full max-w-md mx-4">
            <h2 className="text-base font-semibold text-white mb-4">
              New Task
            </h2>
            <form action={handleCreate} className="space-y-4">
              {/* Template selector */}
              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">
                  Template <span className="font-normal text-slate-500">(optional)</span>
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {TEMPLATES.map(t => (
                    <button
                      key={t.name}
                      type="button"
                      onClick={() => selectTemplate(t.name)}
                      className={`flex items-center gap-2 px-3 py-2 text-xs rounded-lg border transition-all ${
                        selectedTemplate === t.name
                          ? 'border-[#2563eb] bg-[#2563eb]/10 text-blue-300'
                          : 'border-[#334155] bg-[#1a1f2e] text-slate-400 hover:text-slate-300 hover:border-[#475569]'
                      }`}
                    >
                      <span className="text-sm">{t.icon}</span>
                      {t.name}
                    </button>
                  ))}
                </div>
                {selectedTemplate && (
                  <button
                    type="button"
                    onClick={clearTemplate}
                    className="mt-2 text-xs text-slate-500 hover:text-slate-300 transition-colors"
                  >
                    Clear template
                  </button>
                )}
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-1">
                  Title
                </label>
                <input
                  name="title"
                  required
                  placeholder="Add dark mode toggle"
                  value={newTitle}
                  onChange={e => setNewTitle(e.target.value)}
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
                  value={newDesc}
                  onChange={e => setNewDesc(e.target.value)}
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
                  onClick={() => { setShowDialog(false); clearTemplate(); }}
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
