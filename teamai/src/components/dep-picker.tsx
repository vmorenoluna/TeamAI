'use client';

import { useState, useRef, useEffect } from 'react';
import Link from 'next/link';
import { PHASE_BADGE, PHASE_LABELS } from '@/constants/phases';
import type { Task } from '@/lib/task-store';

/** Inline task link pill with phase badge — used in dependency/block lists. */
export function TaskPill({ task }: { task: Task }) {
  const badge = PHASE_BADGE[task.phase] ?? PHASE_BADGE.backlog;
  return (
    <Link
      href={`/task/${task.id}`}
      className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-[#1e293b] bg-[#1e2333] hover:bg-[#1a1f2e] transition-colors text-sm"
    >
      <span className="font-medium text-white truncate">{task.title}</span>
      <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${badge}`}>
        {PHASE_LABELS[task.phase] ?? task.phase}
      </span>
    </Link>
  );
}

/** Dropdown picker for dependency/block relationships. */
export function DepPicker({
  label,
  candidates,
  selectedIds,
  onToggle,
}: {
  label: string;
  candidates: Task[];
  selectedIds: string[];
  onToggle: (id: string, checked: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handle(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', handle);
    return () => document.removeEventListener('mousedown', handle);
  }, []);

  const filtered = candidates.filter(t =>
    t.title.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => { setOpen(o => !o); setSearch(''); }}
        className="flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-md border border-[#334155] bg-[#1e2333] text-slate-300 hover:bg-[#1a1f2e] transition-colors"
      >
        + {label}
      </button>

      {open && (
        <div className="absolute z-20 top-full left-0 mt-1.5 w-64 sm:w-72 max-w-[calc(100vw-4rem)] bg-[#1e2333] rounded-lg border border-[#1e293b] shadow-xl overflow-hidden">
          <div className="p-2 border-b border-[#1e293b]">
            <input
              autoFocus
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search tasks…"
              className="w-full px-2.5 py-1.5 text-sm bg-[#11131b] border border-[#334155] rounded text-white focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
            />
          </div>
          <ul className="max-h-64 overflow-y-auto py-1">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-xs text-slate-400">No tasks found.</li>
            )}
            {filtered.map(t => {
              const checked = selectedIds.includes(t.id);
              const badge = PHASE_BADGE[t.phase] ?? PHASE_BADGE.backlog;
              return (
                <li key={t.id}>
                  <label className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-[#1a1f2e] transition-colors">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={e => onToggle(t.id, e.target.checked)}
                      className="rounded border-[#334155] bg-[#11131b]"
                    />
                    <span className="flex-1 text-sm text-slate-200 truncate">{t.title}</span>
                    <span className={`shrink-0 text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded ${badge}`}>
                      {PHASE_LABELS[t.phase] ?? t.phase}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
