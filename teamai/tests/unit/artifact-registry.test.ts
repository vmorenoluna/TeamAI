/**
 * T18 AC: Table-driven test that every artifact filename referenced
 * anywhere in the codebase appears in the artifact registry.
 *
 * Each entry documents WHERE the file is used in source code and
 * WHICH registry export(s) should cover it.
 */
import { describe, it, expect } from 'vitest';
import {
  PHASE_ARTIFACTS,
  CLEANUP_ARTIFACTS,
  REQUIRED_ARTIFACTS,
  REVISION_CLEANUP_EXTRA,
} from '@/lib/orchestrator/artifacts';

// Flatten helpers for easy lookup
function allFilesIn(record: Record<string, string[]>): Set<string> {
  const s = new Set<string>();
  for (const files of Object.values(record)) {
    for (const f of files) s.add(f);
  }
  return s;
}

// ── Registry coverage table ───────────────────────────────────────────────
// Each entry: { file, usedIn, inPhaseArtifacts, inCleanupArtifacts,
//               inRequiredArtifacts, inRevisionCleanup }

interface RegistryExpectation {
  file: string;
  /** Where this file is read/written in source (non-exhaustive hints). */
  usedIn: string[];
  /** Expected to appear in PHASE_ARTIFACTS (cumulative level clearing). */
  inPhaseArtifacts: boolean;
  /** Expected to appear in CLEANUP_ARTIFACTS (per-phase stop cleanup). */
  inCleanupArtifacts: boolean;
  /** Expected to appear in REQUIRED_ARTIFACTS (recovery validation). */
  inRequiredArtifacts: boolean;
  /** Expected to appear in REVISION_CLEANUP_EXTRA (spec revision). */
  inRevisionCleanup: boolean;
}

const REGISTRY_COVERAGE: RegistryExpectation[] = [
  // ── Core pipeline artifacts ────────────────────────────────────────────
  {
    file: 'spec.md',
    usedIn: [
      'orchestrator.ts (hasSpec check, markTaskDone restore)',
      'phase-runners.ts (runSpec, merge)',
      'actions/tasks.ts (getTaskFull)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: true,
    inRequiredArtifacts: true,
    inRevisionCleanup: false,
  },
  {
    file: 'plan.json',
    usedIn: [
      'orchestrator.ts (hasPlan check, cleanupTaskArtifacts subtask reset)',
      'implement.ts (selectSubtasks, integrateGroup, applySensorGate)',
      'phase-runners.ts (runPlan)',
      'qa-feedback.ts (writeQaFeedback)',
      'actions/tasks.ts (getTaskFull, retryTask)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: true,
    inRequiredArtifacts: true,
    inRevisionCleanup: false,
  },
  {
    file: 'qa_report.json',
    usedIn: [
      'qa-review.ts (runQaReview)',
      'implement.ts (runSubtaskSession, applySensorGate)',
      'review-actions.ts (rejectTask, autoReviseSpec)',
      'qa-feedback.ts (writeQaFeedback, writeCompletionSummary)',
      'helpers.ts (restoreQaReportFromSnapshot)',
      'actions/tasks.ts (retryTask, getTaskFull)',
      'actions/analytics.ts',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: true,
    inRequiredArtifacts: false,
    inRevisionCleanup: false,
  },
  // ── QA feedback artifacts ──────────────────────────────────────────────
  {
    file: 'qa_feedback.md',
    usedIn: [
      'qa-feedback.ts (writeQaFeedback)',
      'implement.ts (QA rework mode prompt build)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: true,
    inRequiredArtifacts: false,
    inRevisionCleanup: true,
  },
  {
    file: 'completion_summary.md',
    usedIn: [
      'qa-feedback.ts (writeCompletionSummary)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: true,
    inRequiredArtifacts: false,
    inRevisionCleanup: true,
  },
  // ── QA snapshot artifacts ──────────────────────────────────────────────
  {
    file: 'qa_report_before_bounce.json',
    usedIn: [
      'qa-review.ts (snapshot before bounce)',
      'helpers.ts (restoreQaReportFromSnapshot)',
      'actions/tasks.ts (retryTask snapshot/restore)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: true,
    inRequiredArtifacts: false,
    inRevisionCleanup: true,
  },
  {
    file: 'qa_report_before_failed.json',
    usedIn: [
      'helpers.ts (restoreQaReportFromSnapshot)',
      'actions/tasks.ts (retryTask snapshot/restore)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: true,
    inRequiredArtifacts: false,
    inRevisionCleanup: true,
  },
  // ── QA report versioned snapshots ───────────────────────────────────────
  {
    file: 'qa_report_v1.json',
    usedIn: [
      'qa-review.ts (runQaReview versioned snapshot)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: false,
  },
  {
    file: 'qa_report_v2.json',
    usedIn: [
      'qa-review.ts (runQaReview versioned snapshot)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: false,
  },
  {
    file: 'qa_report_v3.json',
    usedIn: [
      'qa-review.ts (runQaReview versioned snapshot)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: false,
  },
  {
    file: 'qa_report_v4.json',
    usedIn: [
      'qa-review.ts (runQaReview versioned snapshot)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: false,
  },
  {
    file: 'qa_report_v5.json',
    usedIn: [
      'qa-review.ts (runQaReview versioned snapshot)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: false,
  },
  // ── Spec revision artifacts ────────────────────────────────────────────
  {
    file: 'spec_revision_feedback.md',
    usedIn: [
      'phase-runners.ts (runSpec revision mode)',
      'review-actions.ts (autoReviseSpec)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: false,
  },
  {
    file: 'spec_revision_before.md',
    usedIn: [
      'review-actions.ts (beginSpecRevision pre-revision marker)',
      'phase-runners.ts (runSpec no-op guard baseline)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: false,
  },
  {
    file: 'spec_v1.md',
    usedIn: [
      'phase-runners.ts (runSpec initial snapshot)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: false,
  },
  {
    file: 'spec_v2.md',
    usedIn: [
      'phase-runners.ts (runSpec revision snapshot)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: false,
  },
  {
    file: 'spec_v3.md',
    usedIn: [
      'phase-runners.ts (runSpec revision snapshot)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: false,
  },
  {
    file: 'spec_v4.md',
    usedIn: [
      'phase-runners.ts (runSpec revision snapshot)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: false,
  },
  // ── Human feedback artifacts (revision cleanup only) ────────────────────
  {
    file: 'human_feedback.md',
    usedIn: [
      'review-actions.ts (rejectTask)',
      'implement.ts (hasHumanFeedback check)',
      'actions/tasks.ts (retryTask snapshot)',
    ],
    inPhaseArtifacts: false,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: true,
  },
  {
    file: 'human_feedback_before_bounce.md',
    usedIn: [
      'review-actions.ts (rejectTask snapshot)',
      'helpers.ts (restoreHumanFeedbackFromSnapshot)',
      'actions/tasks.ts (retryTask restore)',
    ],
    inPhaseArtifacts: false,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: true,
  },
  // ── Scoped planner replan preserve-list snapshot ────────────────────────
  {
    file: 'plan_preserve_snapshot.json',
    usedIn: [
      'plan-validation.ts (snapshot/load/clear preserve-list)',
      'phase-runners.ts (runPlan crash recovery)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: true,
  },
];

// ── Infrastructure files intentionally NOT in any artifact registry ───────
// These are runtime/infrastructure files managed outside the phase
// artifact lifecycle. They are listed here to document the intentional
// exclusion and prevent future auditors from flagging them as gaps.
const INFRASTRUCTURE_EXCLUSIONS = new Set([
  'task.json',                // Task definition — managed by TaskStore
  'events.jsonl',             // Phase-change event log — managed by TaskStore
  'output.log',               // Runtime terminal output — managed by cleanupTaskArtifacts
  'session_map.json',         // Live session→role mapping — managed by updateSessionMap
  'subtask_wakeup.json',      // Wakeup trigger — managed by implement.ts
  '.pipeline_state.json',     // Crash-recovery state — managed by pipeline-state.ts
  // sensor_report-st*.json is dynamically named — not a literal
]);

// ── Tests ─────────────────────────────────────────────────────────────────

describe('Artifact registry coverage (T18 AC)', () => {
  const phaseFiles = allFilesIn(PHASE_ARTIFACTS);
  const cleanupFiles = allFilesIn(CLEANUP_ARTIFACTS);
  const requiredFiles = allFilesIn(REQUIRED_ARTIFACTS);
  const revisionExtra = new Set(REVISION_CLEANUP_EXTRA);

  for (const entry of REGISTRY_COVERAGE) {
    it(`${entry.file} is in the expected registries`, () => {
      // PHASE_ARTIFACTS
      if (entry.inPhaseArtifacts) {
        expect(phaseFiles.has(entry.file),
          `${entry.file} must be in PHASE_ARTIFACTS`).toBe(true);
      }

      // CLEANUP_ARTIFACTS
      if (entry.inCleanupArtifacts) {
        expect(cleanupFiles.has(entry.file),
          `${entry.file} must be in CLEANUP_ARTIFACTS`).toBe(true);
      }

      // REQUIRED_ARTIFACTS
      if (entry.inRequiredArtifacts) {
        expect(requiredFiles.has(entry.file),
          `${entry.file} must be in REQUIRED_ARTIFACTS`).toBe(true);
      }

      // REVISION_CLEANUP_EXTRA
      if (entry.inRevisionCleanup) {
        expect(revisionExtra.has(entry.file),
          `${entry.file} must be in REVISION_CLEANUP_EXTRA`).toBe(true);
      }
    });
  }

  it('every PHASE_ARTIFACTS file is accounted for in the coverage table', () => {
    const covered = new Set(REGISTRY_COVERAGE.filter(e => e.inPhaseArtifacts).map(e => e.file));
    for (const f of phaseFiles) {
      expect(covered.has(f),
        `PHASE_ARTIFACTS contains "${f}" which has no coverage table entry — add one`).toBe(true);
    }
  });

  it('every CLEANUP_ARTIFACTS file is accounted for in the coverage table', () => {
    const covered = new Set(REGISTRY_COVERAGE.filter(e => e.inCleanupArtifacts).map(e => e.file));
    for (const f of cleanupFiles) {
      expect(covered.has(f),
        `CLEANUP_ARTIFACTS contains "${f}" which has no coverage table entry — add one`).toBe(true);
    }
  });

  it('every REQUIRED_ARTIFACTS file is accounted for in the coverage table', () => {
    const covered = new Set(REGISTRY_COVERAGE.filter(e => e.inRequiredArtifacts).map(e => e.file));
    for (const f of requiredFiles) {
      expect(covered.has(f),
        `REQUIRED_ARTIFACTS contains "${f}" which has no coverage table entry — add one`).toBe(true);
    }
  });

  it('every REVISION_CLEANUP_EXTRA file is accounted for in the coverage table', () => {
    const covered = new Set(REGISTRY_COVERAGE.filter(e => e.inRevisionCleanup).map(e => e.file));
    for (const f of revisionExtra) {
      expect(covered.has(f),
        `REVISION_CLEANUP_EXTRA contains "${f}" which has no coverage table entry — add one`).toBe(true);
    }
  });

  it('no file appears in both PHASE_ARTIFACTS and infrastructure exclusions', () => {
    for (const f of phaseFiles) {
      expect(INFRASTRUCTURE_EXCLUSIONS.has(f),
        `"${f}" is in PHASE_ARTIFACTS but also listed as infrastructure — remove from exclusions or registry`).toBe(false);
    }
  });

  it('no infrastructure file was accidentally included in a registry', () => {
    const allRegistryFiles = new Set([
      ...phaseFiles,
      ...cleanupFiles,
      ...requiredFiles,
      ...revisionExtra,
    ]);

    // These files ARE allowed in REVISION_CLEANUP_EXTRA (human_feedback
    // snapshots need cleanup during spec revision but aren't phase artifacts).
    const allowedInRevision = new Set(['human_feedback.md', 'human_feedback_before_bounce.md']);

    for (const f of INFRASTRUCTURE_EXCLUSIONS) {
      if (allowedInRevision.has(f)) {
        // Only allowed in REVISION_CLEANUP_EXTRA
        expect(phaseFiles.has(f),
          `"${f}" is infrastructure but found in PHASE_ARTIFACTS`).toBe(false);
        expect(cleanupFiles.has(f),
          `"${f}" is infrastructure but found in CLEANUP_ARTIFACTS`).toBe(false);
        expect(requiredFiles.has(f),
          `"${f}" is infrastructure but found in REQUIRED_ARTIFACTS`).toBe(false);
        // REVISION_CLEANUP_EXTRA is OK — human feedback needs cleanup
        continue;
      }
      expect(allRegistryFiles.has(f),
        `"${f}" is infrastructure but found in an artifact registry`).toBe(false);
    }
  });

  it('PHASE_ARTIFACTS levels are cumulative (higher levels include lower-level files)', () => {
    // spec level clears everything downstream — must include plan + qa files
    const specFiles = new Set(PHASE_ARTIFACTS['spec']);
    const planFiles = new Set(PHASE_ARTIFACTS['plan']);
    const qaFiles = new Set(PHASE_ARTIFACTS['qa']);

    // Every plan-level file must also be in spec (spec clears everything)
    for (const f of planFiles) {
      expect(specFiles.has(f),
        `"${f}" is in PHASE_ARTIFACTS.plan but missing from .spec (spec must clear all downstream files)`).toBe(true);
    }
    // Every qa-level file must also be in spec
    for (const f of qaFiles) {
      expect(specFiles.has(f),
        `"${f}" is in PHASE_ARTIFACTS.qa but missing from .spec (spec must clear all downstream files)`).toBe(true);
    }
  });

  it('PHASE_ARTIFACTS keys match the clearArtifacts level union', () => {
    // clearArtifacts() accepts 'spec' | 'plan' | 'qa'
    const validLevels = ['spec', 'plan', 'qa'];
    for (const key of Object.keys(PHASE_ARTIFACTS)) {
      expect(validLevels.includes(key),
        `PHASE_ARTIFACTS key "${key}" is not a valid clearArtifacts level`).toBe(true);
    }
    for (const level of validLevels) {
      expect(PHASE_ARTIFACTS[level],
        `PHASE_ARTIFACTS is missing the "${level}" level`).toBeDefined();
    }
  });
});
