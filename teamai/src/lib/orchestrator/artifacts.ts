/**
 * Single artifact registry — the canonical definition of which files
 * belong to each pipeline phase.
 *
 * Before this module, artifact file lists were duplicated across four
 * places (TaskStore.clearArtifacts, Orchestrator.cleanupTaskArtifacts,
 * review-actions extraFiles, and recovery.ts phaseRequirements).
 * Adding a new artifact file meant updating 3-4 diverging lists.
 *
 * Now every artifact-aware piece of code derives its behaviour from
 * the constants exported here.
 *
 * ## How to use
 *
 * - **Clearing artifacts when (re)starting a phase:**
 *   `PHASE_ARTIFACTS[level]` returns ALL files at that level and
 *   below.  Used by `TaskStore.clearArtifacts()`.
 *
 * - **Stopping a task mid-pipeline:**
 *   `CLEANUP_ARTIFACTS[phase]` returns the files to delete for the
 *   current phase.  Used by `Orchestrator.cleanupTaskArtifacts()`.
 *
 * - **Verifying that required artifacts exist:**
 *   `REQUIRED_ARTIFACTS[phase]` lists prerequisite files that MUST
 *   be present for the phase to be valid.  Used by
 *   `recovery.reconcileTaskArtifacts()`.
 *
 * - **Spec-revision cleanup extras:**
 *   `REVISION_CLEANUP_EXTRA` lists human-feedback / QA files that
 *   must be removed when the spec is revised.  Used by
 *   `review-actions.autoReviseSpec()`.
 *
 * - **Revision-snapshot numbering ceiling:**
 *   `MAX_REVISION_SNAPSHOTS` bounds every place that enumerates
 *   `spec_v{N}.md` / `qa_report_v{N}.json` by number — the disk-scan
 *   fallbacks in `orchestrator.ts` and the version merge in
 *   `getTaskFull` (tasks.ts) — so a revision past v4 never silently
 *   falls outside what gets scanned, cleared, or displayed.
 */

// ── Revision-snapshot upper bound ──────────────────────────────────────────
// Shared ceiling for anything that enumerates spec_v{N}.md / qa_report_v{N}.json
// by number: the on-disk fallback scans in orchestrator.ts
// (_restoreSpecRevision / _restoreQaRevision), the spec-version merge in
// getTaskFull (tasks.ts), and the PHASE_ARTIFACTS['spec'] list below.
// autoReviseSpec caps QA-driven revisions at 3 (spec) / maxQaAttempts (QA),
// but routeHumanFeedback's human-driven "Request Changes → Analyst" path is
// uncapped — a human can keep revising past v4, so every one of the above
// must scan/clear far enough that a revision never silently falls outside
// the tracked range. 20 is generous headroom for that uncapped path.
export const MAX_REVISION_SNAPSHOTS = 20;

// ── Artifacts to clear per level (cumulative) ─────────────────────────────
// Used by TaskStore.clearArtifacts(level).  Each level lists every
// file produced at that stage or later, so clearing "spec" wipes
// everything downstream.

export const PHASE_ARTIFACTS: Record<string, string[]> = {
  spec: [
    'spec.md',
    'spec_summary.md',
    'plan.json',
    'qa_report.json',
    'qa_feedback.md',
    'completion_summary.md',
    'qa_report_before_bounce.json',
    'qa_report_before_failed.json',
    'spec_revision_feedback.md',
    'spec_revision_before.md',
    ...Array.from({ length: MAX_REVISION_SNAPSHOTS }, (_, i) => `spec_v${i + 1}.md`),
    ...Array.from({ length: MAX_REVISION_SNAPSHOTS }, (_, i) => `qa_report_v${i + 1}.json`),
    'plan_preserve_snapshot.json',
  ],
  plan: [
    'plan.json',
    'qa_report.json',
    'qa_feedback.md',
    'completion_summary.md',
    'qa_report_before_bounce.json',
    'qa_report_before_failed.json',
  ],
  qa: [
    'qa_report.json',
    'qa_feedback.md',
    'completion_summary.md',
    'qa_report_before_bounce.json',
    'qa_report_before_failed.json',
  ],
};

// ── Per-phase cleanup when stopping a task ────────────────────────────────
// Used by Orchestrator.cleanupTaskArtifacts(phase).  Only the files
// belonging to the *current* and *subsequent* phases are listed; the
// orchestrator iterates from `currentPhase` forward through the
// pipeline order.

export const CLEANUP_ARTIFACTS: Record<string, string[]> = {
  spec: ['spec.md', 'spec_summary.md', 'plan.json'],
  plan: ['plan.json'],
  implement: [],
  'qa-review': [
    'qa_report.json',
    'qa_feedback.md',
    'completion_summary.md',
    'qa_report_before_bounce.json',
    'qa_report_before_failed.json',
  ],
  merge: [],
};

// ── Required artifacts per phase ──────────────────────────────────────────
// Used by recovery.reconcileTaskArtifacts().  If any required file is
// missing, the task is reported as an artifact inconsistency.

export const REQUIRED_ARTIFACTS: Record<string, string[]> = {
  plan: ['spec.md'],
  implement: ['spec.md', 'plan.json'],
  'qa-review': ['spec.md', 'plan.json'],
  merge: ['spec.md', 'plan.json'],
  'create-pr': ['spec.md', 'plan.json'],
};

// ── Extra files to clean during spec revision ─────────────────────────────
// Used by review-actions.autoReviseSpec().  These are human-feedback
// and stale-QA files that must not persist when the spec is rewritten
// from scratch.

export const REVISION_CLEANUP_EXTRA: string[] = [
  'qa_feedback.md',
  'completion_summary.md',
  'human_feedback.md',
  'human_feedback_before_bounce.md',
  'qa_report_before_bounce.json',
  'qa_report_before_failed.json',
  'plan_preserve_snapshot.json',
];

// ── Phase descriptions for the retry-phase dialog ─────────────────────────
// The list of phases comes from this module (single source of truth).
// The human-readable descriptions mirror PHASE_ARTIFACTS semantics:
//   - spec: PHASE_ARTIFACTS['spec'] clears everything downstream
//   - plan: PHASE_ARTIFACTS['plan'] clears plan + QA files (spec survives)
//   - implement: PHASE_ARTIFACTS['qa'] clears only QA files

export interface PhaseClearDescription {
  phase: string;
  label: string;
}

/** Return the list of phases the retry-phase dialog can offer. */
export function getPhaseClearDescriptions(): PhaseClearDescription[] {
  return [
    { phase: 'spec', label: 'Spec' },
    { phase: 'plan', label: 'Plan' },
    { phase: 'implement', label: 'Implement' },
  ] satisfies PhaseClearDescription[];
}

/**
 * Get a human-readable description of what gets cleared when resuming
 * at a particular phase level.
 *
 * The descriptions mirror PHASE_ARTIFACTS semantics so the copy won't
 * drift from the actual behaviour: spec clears everything downstream,
 * plan clears plan-level + QA files, implement clears only QA files.
 */
export function getPhaseClearDescription(phase: string): string {
  switch (phase) {
    case 'spec':
      return (
        'Regenerate the spec from scratch. The implementation plan, QA history, ' +
        'and all downstream artifacts will be discarded.'
      );
    case 'plan':
      return (
        'Keep the existing spec, regenerate the implementation plan from scratch. ' +
        'QA history will be discarded.'
      );
    case 'implement':
      return (
        'Keep the existing spec and plan — only QA history is cleared. ' +
        'Re-runs implementation followed by QA review.'
      );
    default:
      return 'Artifacts will be cleared according to the pipeline phase.';
  }
}
