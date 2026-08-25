'use client';

/** Shared line-level diff engine + a compact unified renderer.
 *
 * The LCS engine lives here so both SpecDiffView (side-by-side) and the Role
 * Refinement card (unified single column) render the same diffs. */

export interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  line: string;
  lineNum: number;
}

export interface DiffHunk {
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

export function mergeHunks(hunks: DiffHunk[]): DiffHunk[] {
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

/** Flatten paired hunks into a unified (single-column) line list. */
function toUnifiedLines(hunks: DiffHunk[]): { marker: '+' | '-' | ' '; line: string; key: string }[] {
  const out: { marker: '+' | '-' | ' '; line: string; key: string }[] = [];
  hunks.forEach((hunk, hi) => {
    const left = hunk.left.filter(l => l.type !== 'unchanged');
    const right = hunk.right.filter(r => r.type !== 'unchanged');
    const unchanged = hunk.left.filter(l => l.type === 'unchanged');
    // Removals first, then additions, then the unchanged run — matches unified diff.
    for (const l of left) {
      out.push({ marker: '-', line: l.line, key: `h${hi}-l-${l.lineNum}` });
    }
    for (const r of right) {
      out.push({ marker: '+', line: r.line, key: `h${hi}-r-${r.lineNum}` });
    }
    for (const u of unchanged) {
      out.push({ marker: ' ', line: u.line, key: `h${hi}-u-${u.lineNum}` });
    }
  });
  return out;
}

/** Compact single-column diff of `current` vs `proposed`. */
export function UnifiedDiff({ current, proposed }: { current: string; proposed: string }) {
  const lines = toUnifiedLines(computeLineDiff(current, proposed));
  const added = lines.filter(l => l.marker === '+').length;
  const removed = lines.filter(l => l.marker === '-').length;
  return (
    <div data-component="unified-diff" className="rounded-lg border border-[#1e293b] overflow-hidden">
      <div className="flex items-center justify-between px-3 py-1 bg-[#0f1219] border-b border-[#1e293b]">
        <span className="text-[10px] font-medium text-slate-500 uppercase tracking-wider">Diff</span>
        <span className="text-[10px] text-slate-500">
          <span className="text-green-400">+{added}</span>
          {' '}
          <span className="text-red-400">-{removed}</span>
        </span>
      </div>
      <div className="max-h-64 overflow-y-auto">
        {lines.length === 0 ? (
          <div className="px-3 py-2 text-xs text-slate-500">No changes.</div>
        ) : (
          lines.map(l => (
            <div
              key={l.key}
              className={`px-3 py-0.5 text-xs font-mono whitespace-pre-wrap leading-relaxed ${
                l.marker === '+' ? 'bg-green-950/20 text-green-400' :
                l.marker === '-' ? 'bg-red-950/20 text-red-400' :
                'text-slate-400'
              }`}
            >
              <span className="select-none mr-1">{l.marker}</span>
              {l.line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
