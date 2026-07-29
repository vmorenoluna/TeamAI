'use client';

import { useState, useEffect } from 'react';

// ── Line-level diff for spec comparison ──────────────────────────────────

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  line: string;
  lineNum: number;
}

interface DiffHunk {
  left: DiffLine[];
  right: DiffLine[];
}

/** Compute a simple LCS-based line diff returning paired hunks for side-by-side display. */
export function computeLineDiff(oldText: string, newText: string): DiffHunk[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const m = oldLines.length, n = newLines.length;

  // LCS table
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = oldLines[i - 1] === newLines[j - 1]
        ? dp[i - 1][j - 1] + 1
        : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }

  // Backtrack to produce aligned diff hunks
  const hunks: DiffHunk[] = [];
  let oi = m, ni = n;
  while (oi > 0 || ni > 0) {
    if (oi > 0 && ni > 0 && oldLines[oi - 1] === newLines[ni - 1]) {
      hunks.unshift({
        left: [{ type: 'unchanged', line: oldLines[oi - 1], lineNum: oi }],
        right: [{ type: 'unchanged', line: newLines[ni - 1], lineNum: ni }],
      });
      oi--; ni--;
    } else if (ni > 0 && (oi === 0 || dp[oi][ni - 1] >= dp[oi - 1][ni])) {
      hunks.unshift({
        left: [{ type: 'removed', line: '', lineNum: 0 }],
        right: [{ type: 'added', line: newLines[ni - 1], lineNum: ni }],
      });
      ni--;
    } else {
      hunks.unshift({
        left: [{ type: 'removed', line: oldLines[oi - 1], lineNum: oi }],
        right: [{ type: 'added', line: '', lineNum: 0 }],
      });
      oi--;
    }
  }

  // Merge adjacent pairs where possible
  return mergeHunks(hunks);
}

function mergeHunks(hunks: DiffHunk[]): DiffHunk[] {
  const merged: DiffHunk[] = [];
  for (const h of hunks) {
    const last = merged[merged.length - 1];
    if (last && last.left.every(l => l.type === 'unchanged') && h.left.every(l => l.type === 'unchanged')) {
      // Same type of hunk — merge
      last.left.push(...h.left);
      last.right.push(...h.right);
    } else {
      merged.push(h);
    }
  }
  return merged;
}

// ── SpecDiffView — side-by-side version comparison ─────────────────────────

function getVersionOptions(specVersions: Record<string, string>): string[] {
  return ['current', ...Object.keys(specVersions).sort()];
}

export function SpecDiffView({
  spec,
  specVersions,
  leftVersion,
  rightVersion,
  onSetLeft,
  onSetRight,
}: {
  spec: string;
  specVersions: Record<string, string>;
  leftVersion: string | null;
  rightVersion: string | null;
  onSetLeft: (v: string | null) => void;
  onSetRight: (v: string | null) => void;
}) {
  // Auto-select defaults on first render: current vs v1 or v1 vs v2
  const [initialized, setInitialized] = useState(false);
  useEffect(() => {
    if (initialized) return;
    const available = getVersionOptions(specVersions).filter(v => v === 'current' ? spec : specVersions[v]);
    if (available.length >= 2 && leftVersion === null && rightVersion === null) {
      onSetLeft(available[available.length - 2]);
      onSetRight(available[available.length - 1]);
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setInitialized(true);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialized, leftVersion, rightVersion, spec, specVersions]);

  const leftKey = leftVersion ?? getVersionOptions(specVersions).find(v => v === 'current' ? spec : specVersions[v]) ?? 'current';
  const rightKey = rightVersion ?? getVersionOptions(specVersions).find(v => v === 'current' ? spec : specVersions[v]) ?? 'v1';
  const leftText = leftKey === 'current' ? spec : (specVersions[leftKey] ?? '');
  const rightText = rightKey === 'current' ? spec : (specVersions[rightKey] ?? '');

  const hunks = computeLineDiff(leftText, rightText);

  function renderSelector(value: string | null, onChange: (v: string | null) => void, side: 'left' | 'right') {
    const currentLabel = side === 'left' ? 'current (left)' : 'current (right)';
    return (
      <div className="flex items-center gap-1">
        <label className="text-[10px] text-slate-500 uppercase tracking-wider">{side}</label>
        <select
          value={value ?? ''}
          onChange={e => onChange(e.target.value || null)}
          data-component={`compare-${side}-select`}
          className="text-[11px] font-medium px-2 py-1 rounded-md border border-[#334155] bg-[#1a1f2e] text-slate-300 focus:outline-none focus:ring-1 focus:ring-[#2563eb]"
        >
          {getVersionOptions(specVersions).filter(v => v === 'current' ? spec : specVersions[v]).map(v => (
            <option key={v} value={v}>
              {v === 'current' ? currentLabel : v}
            </option>
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
          {leftKey === 'current' ? 'current' : leftKey}
        </div>
        {/* Sticky right header */}
        <div className="sticky top-0 z-10 px-3 py-1.5 bg-[#1a1f2e] border-b border-l border-[#1e293b] text-[10px] font-medium text-slate-400 uppercase tracking-wider">
          {rightKey === 'current' ? 'current' : rightKey}
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
