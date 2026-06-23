export const COLUMNS = [
  { phase: 'backlog', label: 'Backlog' },
  { phase: 'analysis', label: 'Analysis' },
  { phase: 'implement', label: 'In Progress' },
  { phase: 'review', label: 'Review' },
  { phase: 'failed', label: 'Failed' },
  { phase: 'done', label: 'Done' },
] as const;

/** Normalize phases that share a column */
export function normalizePhase(phase: string): string {
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

/**
 * Resolve a column phase back to a real task phase for moveTask.
 * For merged columns, default to the first sub-phase or preserve existing.
 */
export function resolveTargetPhase(colPhase: string, currentPhase?: string): string {
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

export const TEMPLATES = [
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
