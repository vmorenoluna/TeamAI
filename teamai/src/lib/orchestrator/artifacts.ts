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
 */

// ── Artifacts to clear per level (cumulative) ─────────────────────────────
// Used by TaskStore.clearArtifacts(level).  Each level lists every
// file produced at that stage or later, so clearing "spec" wipes
// everything downstream.

export const PHASE_ARTIFACTS: Record<string, string[]> = {
  spec: [
    'spec.md',
    'plan.json',
    'qa_report.json',
    'qa_feedback.md',
    'completion_summary.md',
    'qa_report_before_bounce.json',
    'qa_report_before_failed.json',
    'spec_revision_feedback.md',
    'spec_v1.md',
    'spec_v2.md',
    'spec_v3.md',
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
  spec: ['spec.md', 'plan.json'],
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
];
