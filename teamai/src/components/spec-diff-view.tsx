'use client';

import { useState, useEffect } from 'react';

// Line-level diff engine shared with the Role Refinement card.
export { computeLineDiff, mergeHunks, type DiffLine, type DiffHunk } from './unified-diff';
import { computeLineDiff } from './unified-diff';

// ── SpecDiffView — side-by-side version comparison ─────────────────────────

function getVersionOptions(specVersions: Record<string, string>): string[] {
  // Sort numerically by revision so v10 follows v9 (not v1). Falls back to
  // lexicographic for keys that don't match the `vN` shape.
  return Object.keys(specVersions).sort((a, b) => {
    const na = parseInt(a.replace(/^v/, ''), 10);
    const nb = parseInt(b.replace(/^v/, ''), 10);
    if (!Number.isNaN(na) && !Number.isNaN(nb)) return na - nb;
    return a.localeCompare(b);
  });
}

export function SpecDiffView({
  specVersions,
  leftVersion,
  rightVersion,
  onSetLeft,
  onSetRight,
}: {
  specVersions: Record<string, string>;
  leftVersion: string | null;
  rightVersion: string | null;
  onSetLeft: (v: string | null) => void;
  onSetRight: (v: string | null) => void;
}) {
  // Auto-select defaults on first render: the two most recent versions.
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (initialized) return;
    const available = getVersionOptions(specVersions);
    if (available.length >= 2 && leftVersion === null && rightVersion === null) {
      onSetLeft(available[available.length - 2]);
      onSetRight(available[available.length - 1]);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInitialized(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, leftVersion, rightVersion, specVersions]);

  const options = getVersionOptions(specVersions);
  const leftKey = leftVersion ?? options[options.length - 2] ?? options[0] ?? '';
  const rightKey = rightVersion ?? options[options.length - 1] ?? options[0] ?? '';
  const leftText = specVersions[leftKey] ?? '';
  const rightText = specVersions[rightKey] ?? '';

  const hunks = computeLineDiff(leftText, rightText);

  function renderSelector(value: string | null, onChange: (v: string | null) => void, side: 'left' | 'right') {
    return (
      <div className="flex items-center gap-1">
        <label className="text-[10px] text-slate-500 uppercase tracking-wider">{side}</label>
        <select
          value={value ?? ''}
          onChange={e => onChange(e.target.value || null)}
          data-component={`compare-${side}-select`}
          className="text-[11px] font-medium px-2 py-1 rounded-md border border-[#334155] bg-[#1a1f2e] text-slate-300 focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
        >
          {getVersionOptions(specVersions).map(v => (
            <option key={v} value={v}>{v}</option>
          ))}
        </select>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Selector row */}
      <div className="flex items-center gap-4">
        {renderSelector(leftVersion, onSetLeft, 'left')}
        <span className="text-xs text-slate-500">vs</span>
        {renderSelector(rightVersion, onSetRight, 'right')}
      </div>

      {/* Single grid with sticky headers — avoids scrollbar column-misalignment */}
      <div className="grid grid-cols-2 gap-0 border border-[#1e293b] rounded-lg overflow-hidden overflow-y-auto max-h-[min(400px,50vh)]">
        {/* Sticky left header */}
        <div className="sticky top-0 z-10 px-3 py-1.5 bg-[#1a1f2e] border-b border-[#1e293b] text-[10px] font-medium text-slate-400 uppercase tracking-wider">
          {leftKey}
        </div>
        {/* Sticky right header */}
        <div className="sticky top-0 z-10 px-3 py-1.5 bg-[#1a1f2e] border-b border-l border-[#1e293b] text-[10px] font-medium text-slate-400 uppercase tracking-wider">
          {rightKey}
        </div>
        {hunks.map((hunk, hi) => {
          // Determine hunk type for background
          const hasRemoved = hunk.left.some(l => l.type === 'removed');
          const hasAdded = hunk.right.some(r => r.type === 'added');
          const leftBg = hasRemoved && !hasAdded ? 'bg-red-950/20' : '';
          const rightBg = hasAdded && !hasRemoved ? 'bg-green-950/20' : '';

          return (
            <div key={hi} className="contents">
              {/* Left cell */}
              <div className={`px-3 py-0.5 text-xs font-mono whitespace-pre-wrap leading-relaxed ${leftBg}`} data-component={`diff-left-${hi}`}>
                {hunk.left.map((dl, di) => (
                  <div key={di} className={
                    dl.type === 'removed'
                      ? 'text-red-400 line-through'
                      : 'text-slate-400'
                  }>
                    {dl.type === 'removed' ? `- ${dl.line}` : `  ${dl.line}`}
                  </div>
                ))}
              </div>
              {/* Right cell */}
              <div className={`px-3 py-0.5 text-xs font-mono whitespace-pre-wrap leading-relaxed border-l border-[#1e293b] ${rightBg}`} data-component={`diff-right-${hi}`}>
                {hunk.right.map((dl, di) => (
                  <div key={di} className={
                    dl.type === 'added'
                      ? 'text-green-400'
                      : 'text-slate-400'
                  }>
                    {dl.type === 'added' ? `+ ${dl.line}` : `  ${dl.line}`}
                  </div>
                ))}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
