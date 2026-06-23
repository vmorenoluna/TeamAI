'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  convertToTask,
  deleteRoadmapItem,
  convertMultipleToTasks,
  getLinkedTaskStatuses,
  type ConvertMultipleInput,
  type RoadmapItem,
  type RoadmapReport,
} from '@/app/actions/roadmap';
import { usePhaseSync } from '@/hooks/use-phase-sync';
import { RoadmapCard, PHASE_LABELS } from './roadmap-card';


// ── Phased kanban view ───────────────────────────────────────────────────────

export function PhasedKanban({
  report,
  filename,
  onRefresh,
  onSelectTask,
  onOpenRoadmapItem,
}: {
  report: RoadmapReport;
  filename: string;
  onRefresh: () => void;
  onSelectTask: (taskId: string) => void;
  onOpenRoadmapItem: (item: RoadmapItem, phaseKey: string, itemIndex: number) => void;
}) {
  const phases = report.phases;
  const [linkedStatuses, setLinkedStatuses] = useState<
    Record<string, { phase: string; title: string } | null>
  >({});
  const [convertingKey, setConvertingKey] = useState<string | null>(null);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [errorKey, setErrorKey] = useState<string | null>(null);
  const [expandedKey, setExpandedKey] = useState<string | null>(null);
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());
  const [isBulkConverting, setIsBulkConverting] = useState(false);
  const [bulkError, setBulkError] = useState(false);

  // Toggle selection of a single item
  function toggleSelect(phaseKey: string, itemIndex: number) {
    const key = `${phaseKey}:${itemIndex}`;
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Toggle all items in a phase
  function toggleSelectAll(phaseKey: string) {
    const phaseItems = phases[phaseKey];
    if (!phaseItems) return;
    // Don't select already-linked items
    const selectable = phaseItems
      .map((item, i) => ({ item, key: `${phaseKey}:${i}` }))
      .filter(({ item }) => !item.linkedTaskId);
    const allSelected = selectable.every(({ key }) => selectedItems.has(key));
    setSelectedItems(prev => {
      const next = new Set(prev);
      if (allSelected) {
        selectable.forEach(({ key }) => next.delete(key));
      } else {
        selectable.forEach(({ key }) => next.add(key));
      }
      return next;
    });
  }

  // Check if all selectable items in a phase are selected
  function isPhaseAllSelected(phaseKey: string): boolean {
    const phaseItems = phases[phaseKey];
    if (!phaseItems || phaseItems.length === 0) return false;
    const selectable = phaseItems.filter(item => !item.linkedTaskId);
    if (selectable.length === 0) return false;
    return selectable.every((_, i) => {
      const idx = phaseItems.indexOf(selectable[i]);
      return selectedItems.has(`${phaseKey}:${idx}`);
    });
  }

  // Bulk convert selected items to tasks
  async function handleBulkConvert() {
    if (selectedItems.size === 0) return;
    setIsBulkConverting(true);
    setBulkError(false);
    const itemList: ConvertMultipleInput[] = [];
    selectedItems.forEach(key => {
      const [phaseKey, idxStr] = key.split(':');
      itemList.push({ phaseKey, itemIndex: parseInt(idxStr, 10) });
    });
    try {
      await convertMultipleToTasks(filename, itemList);
      setSelectedItems(new Set());
      onRefresh();
    } catch {
      setBulkError(true);
    } finally {
      setIsBulkConverting(false);
    }
  }

  // Collect all linked task IDs
  const allLinkedIds = useMemo(() => {
    const ids: string[] = [];
    for (const pk of ['now', 'next', 'later', 'icebox'] as const) {
      for (const item of phases[pk]) {
        if (item.linkedTaskId) ids.push(item.linkedTaskId);
      }
    }
    return ids;
  }, [phases]);

  // Fetch statuses for all linked items on mount / when report changes
  useEffect(() => {
    if (allLinkedIds.length === 0) return;
    let cancelled = false;
    getLinkedTaskStatuses(allLinkedIds)
      .then(result => {
        if (!cancelled) setLinkedStatuses(prev => ({ ...prev, ...result }));
      })
      .catch(() => { /* network error — statuses will load on next render */ });
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allLinkedIds.join(',')]);

  // Real-time sync: update linked status when a kanban task phase changes
  usePhaseSync({
    onPhaseChange: (taskId, phase) => {
      if (allLinkedIds.includes(taskId)) {
        setLinkedStatuses(prev => {
          const existing = prev[taskId];
          if (!existing) return prev;
          return { ...prev, [taskId]: { ...existing, phase } };
        });
      }
    },
  });

  async function handleConvert(phaseKey: string, itemIndex: number) {
    const key = `${phaseKey}:${itemIndex}`;
    setExpandedKey(null);
    setErrorKey(null);
    setConvertingKey(key);
    try {
      await convertToTask(filename, itemIndex, phaseKey);
      onRefresh();
    } catch {
      setErrorKey(key);
    } finally {
      setConvertingKey(null);
    }
  }

  async function handleDelete(phaseKey: string, itemIndex: number) {
    if (!window.confirm('Remove this item from the roadmap?')) return;
    const key = `${phaseKey}:${itemIndex}`;
    setExpandedKey(null);
    setErrorKey(null);
    setDeletingKey(key);
    try {
      await deleteRoadmapItem(filename, itemIndex, phaseKey);
      onRefresh();
    } catch {
      setErrorKey(key);
    } finally {
      setDeletingKey(null);
    }
  }



  // Clear individual error after 5s
  useEffect(() => {
    if (!errorKey) return;
    const t = setTimeout(() => setErrorKey(null), 5000);
    return () => clearTimeout(t);
  }, [errorKey]);

  // Clear bulk error after 5s
  useEffect(() => {
    if (!bulkError) return;
    const t = setTimeout(() => setBulkError(false), 5000);
    return () => clearTimeout(t);
  }, [bulkError]);

  return (
    <div className="space-y-2">
      {report.executive_summary && (          <p className="text-sm text-slate-400 leading-relaxed">
            {report.executive_summary}
          </p>
      )}

      {report.competitor_analysis_run && (
        <p className="text-xs text-amber-400">
          Competitor analysis was run for this roadmap.
          {report.competitors && report.competitors.length > 0 && (
            <> Competitors: {report.competitors.join(', ')}</>
          )}
        </p>
      )}

      {/* Bulk actions bar */}
      {selectedItems.size > 0 && (
        <div className="flex items-center gap-3 px-3 py-2 bg-[#1e2333] rounded-lg border border-[#2563eb]">
          <span className="text-xs text-slate-300">
            {selectedItems.size} item{selectedItems.size !== 1 ? 's' : ''} selected
          </span>
          <button
            onClick={handleBulkConvert}
            disabled={isBulkConverting}
            className="px-3 py-1 text-xs font-medium bg-[#2563eb] text-white rounded hover:bg-[#1d4ed8] disabled:opacity-40 transition-colors"
          >
            {isBulkConverting ? 'Converting…' : 'Convert Selected'}
          </button>
          <button
            onClick={() => setSelectedItems(new Set())}
            className="px-2 py-1 text-xs text-slate-400 hover:text-slate-300 transition-colors"
          >
            Clear
          </button>
          {bulkError && (
            <span className="text-xs text-red-400">Conversion failed. Try again.</span>
          )}
        </div>
      )}

      {/* Horizontal kanban columns */}
      <div className="overflow-x-auto">
        <div className="flex gap-3 pt-3" style={{ minWidth: 'max-content' }}>
          {(['now', 'next', 'later', 'icebox'] as const).map(phaseKey => (
            <div
              key={phaseKey}
              className="flex flex-col w-72 shrink-0 rounded-lg bg-[#1a1f2e] overflow-hidden"
            >
              {/* Column header */}
              <div className="flex items-center justify-between px-3 py-2.5 border-b border-[#1e293b]">
                <div className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={isPhaseAllSelected(phaseKey)}
                    onChange={() => toggleSelectAll(phaseKey)}
                    className="w-3.5 h-3.5 rounded border-[#334155] bg-[#0f1320] text-[#2563eb] focus:ring-[#2563eb] focus:ring-1 cursor-pointer"
                    title={isPhaseAllSelected(phaseKey) ? 'Deselect all' : 'Select all'}
                  />
                  <span className="text-xs font-semibold uppercase tracking-wider text-slate-300">
                    {PHASE_LABELS[phaseKey]}
                  </span>
                </div>
                <span className="text-xs font-medium px-1.5 py-0.5 rounded-full bg-[#1e293b] text-slate-500">
                  {phases[phaseKey].length}
                </span>
              </div>

              {/* Column cards */}
              <div className="flex-1 overflow-y-auto p-2 space-y-2 min-h-[120px]">
                {phases[phaseKey].length === 0 ? (
                  <p className="text-xs text-slate-400 italic text-center py-4">
                    No items
                  </p>
                ) : (
                  phases[phaseKey].map((item, i) => {
                    const cardKey = `${phaseKey}:${i}`;
                    return (
                      <div className="relative" key={cardKey}>
                      <RoadmapCard
                        item={item}
                        linkedStatus={item.linkedTaskId ? linkedStatuses[item.linkedTaskId] : undefined}
                        onConvert={() => handleConvert(phaseKey, i)}
                        onDelete={() => handleDelete(phaseKey, i)}
                        isConverting={convertingKey === cardKey}
                        isDeleting={deletingKey === cardKey}
                        hasError={errorKey === cardKey}
                        isExpanded={expandedKey === cardKey}
                        onToggle={() => setExpandedKey(prev => prev === cardKey ? null : cardKey)}
                        isSelected={selectedItems.has(cardKey)}
                        onToggleSelect={() => toggleSelect(phaseKey, i)}
                        onSelectTask={onSelectTask}
                        onOpenDetail={(item) => onOpenRoadmapItem(item, phaseKey, i)}
                      />
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
