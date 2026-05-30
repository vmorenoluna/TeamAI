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
