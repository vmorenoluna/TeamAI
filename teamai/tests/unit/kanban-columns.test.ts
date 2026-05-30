import { describe, it, expect } from 'vitest';

// Replicate normalizePhase from kanban-board.tsx
// Maps task phases to display column phases
function normalizePhase(phase: string): string {
  if (phase === 'spec') return 'analysis';
  if (phase === 'plan') return 'analysis';
  if (phase === 'qa-fix') return 'review';
  if (phase === 'qa-review') return 'review';
  if (phase === 'awaiting-review') return 'review';
  if (phase === 'create-pr') return 'review';
  if (phase === 'pr-open') return 'review';
  if (phase === 'merge') return 'review';
  return phase;
}

// Replicate resolveTargetPhase from kanban-board.tsx
// For merged columns, default to the first sub-phase or preserve existing
function resolveTargetPhase(colPhase: string, currentPhase?: string): string {
  if (colPhase === 'analysis') {
    if (currentPhase === 'spec' || currentPhase === 'plan') return currentPhase;
    return 'spec';
  }
  if (colPhase === 'review') {
    if (currentPhase === 'qa-review' || currentPhase === 'awaiting-review' || currentPhase === 'qa-fix' || currentPhase === 'create-pr' || currentPhase === 'pr-open' || currentPhase === 'merge') return currentPhase;
    return 'qa-review';
  }
  return colPhase;
}

// Replicate COLUMNS from kanban-board.tsx
const COLUMNS = [
  { phase: 'backlog', label: 'Backlog' },
  { phase: 'analysis', label: 'Analysis' },
  { phase: 'implement', label: 'In Progress' },
  { phase: 'review', label: 'Review' },
  { phase: 'failed', label: 'Failed' },
  { phase: 'done', label: 'Done' },
] as const;

// ── COLUMNS structure ────────────────────────────────────────────────────────

describe('Kanban COLUMNS structure', () => {
  it('has 6 columns after merging spec+plan and review+merging', () => {
    expect(COLUMNS).toHaveLength(6);
  });

  it('does not have a separate spec column', () => {
    expect(COLUMNS.find(c => (c.phase as string) === 'spec')).toBeUndefined();
  });

  it('does not have a separate plan column', () => {
    expect(COLUMNS.find(c => (c.phase as string) === 'plan')).toBeUndefined();
  });

  it('does not have a separate merge column', () => {
    expect(COLUMNS.find(c => (c.phase as string) === 'merge')).toBeUndefined();
  });

  it('has analysis column that replaced spec and plan', () => {
    expect(COLUMNS.find(c => c.phase === 'analysis')?.label).toBe('Analysis');
  });

  it('has a single review column that replaced qa-review, awaiting-review, and merging', () => {
    expect(COLUMNS.find(c => c.phase === 'review')?.label).toBe('Review');
  });

  it('retains backlog, implement, failed, and done columns', () => {
    const phases = COLUMNS.map(c => c.phase);
    expect(phases).toContain('backlog');
    expect(phases).toContain('implement');
    expect(phases).toContain('failed');
    expect(phases).toContain('done');
  });
});

// ── normalizePhase ──────────────────────────────────────────────────────────

describe('normalizePhase — spec and plan → analysis', () => {
  it('maps spec to analysis', () => {
    expect(normalizePhase('spec')).toBe('analysis');
  });

  it('maps plan to analysis', () => {
    expect(normalizePhase('plan')).toBe('analysis');
  });
});

describe('normalizePhase — review-related phases → review', () => {
  it('maps qa-review to review', () => {
    expect(normalizePhase('qa-review')).toBe('review');
  });

  it('maps awaiting-review to review', () => {
    expect(normalizePhase('awaiting-review')).toBe('review');
  });

  it('maps qa-fix to review', () => {
    expect(normalizePhase('qa-fix')).toBe('review');
  });

  it('maps create-pr to review (was merge before collapse)', () => {
    expect(normalizePhase('create-pr')).toBe('review');
  });

  it('maps pr-open to review (was merge before collapse)', () => {
    expect(normalizePhase('pr-open')).toBe('review');
  });

  it('maps merge to review (was pass-through before collapse)', () => {
    expect(normalizePhase('merge')).toBe('review');
  });
});

describe('normalizePhase — pass-through phases', () => {
  it('passes backlog through unchanged', () => {
    expect(normalizePhase('backlog')).toBe('backlog');
  });

  it('passes implement through unchanged', () => {
    expect(normalizePhase('implement')).toBe('implement');
  });

  it('passes failed through unchanged', () => {
    expect(normalizePhase('failed')).toBe('failed');
  });

  it('passes done through unchanged', () => {
    expect(normalizePhase('done')).toBe('done');
  });

  it('passes unknown phases through unchanged', () => {
    expect(normalizePhase('unknown-phase')).toBe('unknown-phase');
  });
});

// ── resolveTargetPhase ──────────────────────────────────────────────────────

describe('resolveTargetPhase — analysis column', () => {
  it('preserves spec when already in spec', () => {
    expect(resolveTargetPhase('analysis', 'spec')).toBe('spec');
  });

  it('preserves plan when already in plan', () => {
    expect(resolveTargetPhase('analysis', 'plan')).toBe('plan');
  });

  it('defaults to spec when no current phase', () => {
    expect(resolveTargetPhase('analysis')).toBe('spec');
  });

  it('defaults to spec for unrelated current phase', () => {
    expect(resolveTargetPhase('analysis', 'implement')).toBe('spec');
  });
});

describe('resolveTargetPhase — review column', () => {
  it('preserves qa-review when already in qa-review', () => {
    expect(resolveTargetPhase('review', 'qa-review')).toBe('qa-review');
  });

  it('preserves awaiting-review when already in awaiting-review', () => {
    expect(resolveTargetPhase('review', 'awaiting-review')).toBe('awaiting-review');
  });

  it('preserves qa-fix when already in qa-fix', () => {
    expect(resolveTargetPhase('review', 'qa-fix')).toBe('qa-fix');
  });

  it('preserves create-pr when already in create-pr', () => {
    expect(resolveTargetPhase('review', 'create-pr')).toBe('create-pr');
  });

  it('preserves pr-open when already in pr-open', () => {
    expect(resolveTargetPhase('review', 'pr-open')).toBe('pr-open');
  });

  it('preserves merge when already in merge', () => {
    expect(resolveTargetPhase('review', 'merge')).toBe('merge');
  });

  it('defaults to qa-review when no current phase', () => {
    expect(resolveTargetPhase('review')).toBe('qa-review');
  });

  it('defaults to qa-review for unrelated current phase', () => {
    expect(resolveTargetPhase('review', 'implement')).toBe('qa-review');
  });
});

describe('resolveTargetPhase — non-merged columns', () => {
  it('passes backlog through unchanged', () => {
    expect(resolveTargetPhase('backlog')).toBe('backlog');
    expect(resolveTargetPhase('backlog', 'spec')).toBe('backlog');
  });

  it('passes implement through unchanged', () => {
    expect(resolveTargetPhase('implement')).toBe('implement');
  });

  it('passes failed through unchanged', () => {
    expect(resolveTargetPhase('failed')).toBe('failed');
  });

  it('passes done through unchanged', () => {
    expect(resolveTargetPhase('done')).toBe('done');
  });
});

// ── Integration: normalize + resolve round-trip ─────────────────────────────

describe('normalizePhase + resolveTargetPhase round-trip', () => {
  it('spec → analysis → spec (round-trip preserves)', () => {
    const normalized = normalizePhase('spec');
    const resolved = resolveTargetPhase(normalized, 'spec');
    expect(resolved).toBe('spec');
  });

  it('plan → analysis → plan (round-trip preserves)', () => {
    const normalized = normalizePhase('plan');
    const resolved = resolveTargetPhase(normalized, 'plan');
    expect(resolved).toBe('plan');
  });

  it('qa-review → review → qa-review (round-trip preserves)', () => {
    const normalized = normalizePhase('qa-review');
    const resolved = resolveTargetPhase(normalized, 'qa-review');
    expect(resolved).toBe('qa-review');
  });

  it('create-pr → review → create-pr (round-trip preserves)', () => {
    const normalized = normalizePhase('create-pr');
    const resolved = resolveTargetPhase(normalized, 'create-pr');
    expect(resolved).toBe('create-pr');
  });

  it('merge → review → merge (round-trip preserves)', () => {
    const normalized = normalizePhase('merge');
    const resolved = resolveTargetPhase(normalized, 'merge');
    expect(resolved).toBe('merge');
  });

  it('implement → implement → implement (pass-through round-trip)', () => {
    const normalized = normalizePhase('implement');
    const resolved = resolveTargetPhase(normalized, 'implement');
    expect(resolved).toBe('implement');
  });
});
