/** Ordered pipeline phases with label and border color for workflow diagrams */
export const PIPELINE_PHASES: { phase: string; label: string; color: string }[] = [
  { phase: 'backlog', label: 'Backlog', color: 'border-slate-500 bg-slate-500/10' },
  { phase: 'spec', label: 'Spec', color: 'border-indigo-500 bg-indigo-500/10' },
  { phase: 'plan', label: 'Plan', color: 'border-violet-500 bg-violet-500/10' },
  { phase: 'implement', label: 'Implement', color: 'border-amber-500 bg-amber-500/10' },
  { phase: 'qa-review', label: 'QA Review', color: 'border-orange-500 bg-orange-500/10' },
  { phase: 'awaiting-review', label: 'Awaiting Review', color: 'border-yellow-500 bg-yellow-500/10' },
  { phase: 'merge', label: 'Merge', color: 'border-teal-500 bg-teal-500/10' },
  { phase: 'create-pr', label: 'Create PR', color: 'border-cyan-500 bg-cyan-500/10' },
  { phase: 'pr-open', label: 'PR Open', color: 'border-emerald-500 bg-emerald-500/10' },
  { phase: 'failed', label: 'Failed', color: 'border-red-500 bg-red-500/10' },
  { phase: 'done', label: 'Done', color: 'border-green-500 bg-green-500/10' },
];

/** Union type of all pipeline phase identifiers */
export type PipelinePhase = typeof PIPELINE_PHASES[number]['phase'];

/** Tailwind CSS classes for roadmap priority badge styling */
export const PRIORITY_COLORS: Record<string, string> = {
  P0: 'bg-red-900/30 text-red-400',
  P1: 'bg-orange-900/30 text-orange-400',
  P2: 'bg-amber-900/30 text-amber-400',
  P3: 'bg-slate-800 text-slate-400',
};

/** Tailwind CSS classes for phase badge styling */
export const PHASE_BADGE: Record<string, string> = {
  backlog:           'bg-slate-800 text-slate-300',
  spec:              'bg-blue-900/40 text-blue-300',
  plan:              'bg-indigo-900/40 text-indigo-300',
  implement:         'bg-amber-900/40 text-amber-300',
  'qa-review':       'bg-orange-900/40 text-orange-300',
  'awaiting-review': 'bg-purple-900/40 text-purple-300',
  merge:             'bg-teal-900/40 text-teal-300',
  'create-pr':       'bg-teal-900/40 text-teal-300',
  'pr-open':         'bg-sky-900/40 text-sky-300',
  failed:            'bg-red-900/40 text-red-300',
  done:              'bg-green-900/40 text-green-300',
};

/** Human-readable labels for each phase */
export const PHASE_LABELS: Record<string, string> = {
  backlog:           'Backlog',
  spec:              'Spec',
  plan:              'Plan',
  implement:         'In Progress',
  'qa-review':       'QA Review',
  'awaiting-review': 'Awaiting Review',
  merge:             'Merging',
  'create-pr':       'Creating PR',
  'pr-open':         'PR Open',
  failed:            'Failed',
  done:              'Done',
};

// ── Phase category sets ────────────────────────────────────────────────────
// Single source of truth: add new phases here and all consumers pick them up.

/** Phases where no pipeline is running (terminal states). */
export const TERMINAL_PHASES = new Set(['backlog', 'done', 'failed']);

/** Phases where pipeline work is paused (waiting for human or external system). */
export const PAUSED_PHASES = new Set(['awaiting-review', 'pr-open', 'create-pr']);

/** Phases where a rate-limited task should NOT auto-resume. */
export const NO_RESUME_PHASES = new Set(['backlog', 'done', 'failed', 'awaiting-review', 'pr-open']);

/** Phases actively running pipeline sessions (used by crash-recovery sweep). */
export const IN_PROGRESS_PHASES = new Set(['spec', 'plan', 'implement', 'qa-review', 'merge', 'create-pr']);

/** Phases where stopping the task (moving to backlog) is not allowed. */
export const NO_STOP_PHASES = new Set(['backlog', 'done', 'failed']);

/** Phases where restarting the current phase is allowed. */
export const RESTARTABLE_PHASES = new Set(['spec', 'plan', 'implement', 'qa-review']);

/** Hex colors for each phase (used in stacked bar charts / phase distribution diagrams) */
export const PHASE_COLORS: Record<string, string> = {
  backlog:           '#475569',
  spec:              '#3b82f6',
  plan:              '#6366f1',
  implement:         '#f59e0b',
  'qa-review':       '#f97316',
  'awaiting-review': '#a855f7',
  merge:             '#14b8a6',
  'create-pr':       '#14b8a6',
  'pr-open':         '#38bdf8',
  failed:            '#ef4444',
  done:              '#22c55e',
};
