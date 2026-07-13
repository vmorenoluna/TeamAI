'use client';

import { useState } from 'react';
import { COLUMNS } from './kanban-utils';

interface Props {
  searchQuery: string;
  onSearchChange: (v: string) => void;
  phaseFilter: Set<string>;
  onPhaseFilterChange: (f: Set<string>) => void;
  sourceFilter: string | null;
  onSourceFilterChange: (s: string | null) => void;
  sortBy: 'newest' | 'oldest' | 'az' | 'za';
  onSortChange: (s: 'newest' | 'oldest' | 'az' | 'za') => void;
  hasActiveFilters: boolean;
  onReset: () => void;
}

export function KanbanFilters(props: Props) {
  const {
    searchQuery, onSearchChange,
    phaseFilter, onPhaseFilterChange,
    sourceFilter, onSourceFilterChange,
    sortBy, onSortChange,
    hasActiveFilters, onReset,
  } = props;

  const [showPhase, setShowPhase] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [showSort, setShowSort] = useState(false);

  function closeAll() { setShowPhase(false); setShowSource(false); setShowSort(false); }

  return (
    <>
      {/* Search */}
      <div className="relative flex-1 max-w-[200px]">
        <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
        </svg>
        <input
          type="text"
          placeholder="Search…"
          value={searchQuery}
          onChange={e => onSearchChange(e.target.value)}
          className="w-full pl-8 pr-8 py-1.5 text-xs bg-[#1a1f2e] border border-[#334155] rounded-lg text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
        />
        {searchQuery && (
          <button
            onClick={() => onSearchChange('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-300 text-sm leading-none"
          >
            ×
          </button>
        )}
      </div>

      {/* Phase filter */}
      <div className="relative">
        <button
          onClick={() => { setShowPhase(o => !o); setShowSource(false); setShowSort(false); }}
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
        {showPhase && (
          <div className="absolute z-30 top-full left-0 mt-1 w-44 bg-[#1e2333] rounded-lg border border-[#1e293b] shadow-xl overflow-hidden">
            {COLUMNS.map(col => (
              <label key={col.phase} className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-[#1a1f2e] transition-colors">
                <input
                  type="checkbox"
                  checked={phaseFilter.has(col.phase)}
                  onChange={e => {
                    const next = new Set(phaseFilter);
                    if (e.target.checked) next.add(col.phase); else next.delete(col.phase);
                    onPhaseFilterChange(next);
                  }}
                  className="rounded border-[#334155] bg-[#11131b]"
                />
                <span className="text-xs text-slate-300">{col.label}</span>
              </label>
            ))}
            {phaseFilter.size > 0 && (
              <button
                onClick={() => onPhaseFilterChange(new Set())}
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
          onClick={() => { setShowSource(o => !o); setShowPhase(false); setShowSort(false); }}
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
        {showSource && (
          <div className="absolute z-30 top-full left-0 mt-1 w-44 bg-[#1e2333] rounded-lg border border-[#1e293b] shadow-xl overflow-hidden">
            {[
              { value: null, label: 'All sources' },
              { value: 'ideation', label: 'Ideation' },
              { value: 'competitor-analysis', label: 'Competitor Analysis' },
            ].map(opt => (
              <button
                key={opt.label}
                onClick={() => { onSourceFilterChange(opt.value); setShowSource(false); }}
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
          onClick={() => { setShowSort(o => !o); setShowPhase(false); setShowSource(false); }}
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
        {showSort && (
          <div className="absolute z-30 top-full right-0 mt-1 w-36 bg-[#1e2333] rounded-lg border border-[#1e293b] shadow-xl overflow-hidden">
            {[
              { value: 'newest', label: 'Newest first' },
              { value: 'oldest', label: 'Oldest first' },
              { value: 'az', label: 'A → Z' },
              { value: 'za', label: 'Z → A' },
            ].map(opt => (
              <button
                key={opt.value}
                onClick={() => { onSortChange(opt.value as 'newest' | 'oldest' | 'az' | 'za'); setShowSort(false); }}
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

      {/* Reset */}
      {hasActiveFilters && (
        <button
          onClick={onReset}
          className="text-xs text-slate-500 hover:text-slate-300 transition-colors whitespace-nowrap"
        >
          Reset
        </button>
      )}

      {/* Close dropdowns on outside click */}
      {(showPhase || showSource || showSort) && (
        <div
          className="fixed inset-0 z-20"
          onClick={closeAll}
          onKeyDown={e => { if (e.key === 'Escape') closeAll(); }}
          role="button"
          tabIndex={0}
        />
      )}
    </>
  );
}
