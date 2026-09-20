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
  getPhaseClearDescription,
} from '@/lib/orchestrator/artifacts';

// Flatten helpers for easy lookup
function allFilesIn(record: Record<string, string[]>): Set<string> {
  const s = new Set<string>();
  for (const files of Object.values(record)) {
    for (const f of files) s.add(f);
  }
  return s;
}

// spec_v{N}.md / qa_report_v{N}.json are numbered families generated
// programmatically up to MAX_REVISION_SNAPSHOTS (artifacts.ts) — the
// registry documents each family with ONE entry using '{N}' as a
// placeholder rather than one entry per revision number. This collapses
// an actual numbered filename to its family template (e.g.
// 'spec_v12.md' -> 'spec_v{N}.md') so it can be looked up against that
// single entry; non-numbered filenames pass through unchanged.
const NUMBERED_FAMILY_RE = /^(.*_v)\d+(\.\w+)$/;
function toFamilyTemplate(file: string): string {
  const m = file.match(NUMBERED_FAMILY_RE);
  return m ? `${m[1]}{N}${m[2]}` : file;
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
    file: 'spec_summary.md',
    usedIn: [
      'artifact-commit.ts (readSpecSummary)',
      'phase-runners.ts (runCreatePR — embedded in the PR body via buildPRBody)',
      'review-actions.ts (beginSpecRevision — deleted unconditionally alongside the spec.md rename, so a revision never serves a stale summary describing the archived spec)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: true,
    inRequiredArtifacts: false,
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
  // One family entry for qa_report_v1.json .. qa_report_v{MAX_REVISION_SNAPSHOTS}.json
  // — PHASE_ARTIFACTS generates all of them programmatically (artifacts.ts),
  // and routeHumanFeedback's human-driven analyst path is uncapped, so the
  // registry must cover the whole numbered range, not just the first few.
  {
    file: 'qa_report_v{N}.json',
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
      'RETIRED (rename-at-revision scheme) — beginSpecRevision renames spec.md to spec_v{R-1}.md instead of writing this marker',
      'phase-runners.ts (runSpec no-op guard baseline)',
    ],
    inPhaseArtifacts: true,
    inCleanupArtifacts: false,
    inRequiredArtifacts: false,
    inRevisionCleanup: false,
  },
  // One family entry for spec_v1.md .. spec_v{MAX_REVISION_SNAPSHOTS}.md —
  // see the qa_report_v{N}.json note above for why this isn't one entry
  // per revision number.
  {
    file: 'spec_v{N}.md',
    usedIn: [
      'review-actions.ts (beginSpecRevision renames the live spec.md here at each revision)',
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
  it('describes each retry phase according to current clearing behavior', () => {
    const specRevision = getPhaseClearDescription('spec', { hasSpecConcerns: true, hasSpec: true });
    expect(specRevision).toContain('saved as a version');
    expect(specRevision).toContain('implementation plan and existing code will be preserved');
    expect(specRevision).toContain('QA artifacts are regenerated');
    expect(specRevision).not.toContain('—');

    const specRegeneration = getPhaseClearDescription('spec', { hasSpecConcerns: false, hasSpec: false });
    expect(specRegeneration).toContain('Regenerate the spec from scratch');
    expect(specRegeneration).toContain('implementation plan, QA history, and all downstream artifacts');
    expect(specRegeneration).not.toContain('—');

    const specUnknown = getPhaseClearDescription('spec');
    expect(specUnknown).toContain('If QA identified spec concerns');
    expect(specUnknown).toContain('Otherwise, the spec and downstream artifacts will be regenerated');
    expect(specUnknown).not.toContain('—');

    const plan = getPhaseClearDescription('plan');
    expect(plan).toContain('Keep the existing spec');
    expect(plan).toContain('regenerate the implementation plan from scratch');
    expect(plan).toContain('QA history will be discarded');
    expect(plan).not.toContain('—');

    const implement = getPhaseClearDescription('implement');
    expect(implement).toContain('Keep the existing spec and plan');
    expect(implement).toContain('Only QA history is cleared');
    expect(implement).toContain('Re-runs implementation followed by QA review');
    expect(implement).not.toContain('—');
  });

  const phaseFiles = allFilesIn(PHASE_ARTIFACTS);
  const cleanupFiles = allFilesIn(CLEANUP_ARTIFACTS);
  const requiredFiles = allFilesIn(REQUIRED_ARTIFACTS);
  const revisionExtra = new Set(REVISION_CLEANUP_EXTRA);

  for (const entry of REGISTRY_COVERAGE) {
    it(`${entry.file} is in the expected registries`, () => {
      // A '{N}' entry is a family template — it has no literal file of that
      // exact name, so check that at least one actual numbered file maps
      // back to this template instead of an exact-name lookup.
      const inSet = (set: Set<string>) => entry.file.includes('{N}')
        ? Array.from(set).some(f => toFamilyTemplate(f) === entry.file)
        : set.has(entry.file);

      // PHASE_ARTIFACTS
      if (entry.inPhaseArtifacts) {
        expect(inSet(phaseFiles),
          `${entry.file} must be in PHASE_ARTIFACTS`).toBe(true);
      }

      // CLEANUP_ARTIFACTS
      if (entry.inCleanupArtifacts) {
        expect(inSet(cleanupFiles),
          `${entry.file} must be in CLEANUP_ARTIFACTS`).toBe(true);
      }

      // REQUIRED_ARTIFACTS
      if (entry.inRequiredArtifacts) {
        expect(inSet(requiredFiles),
          `${entry.file} must be in REQUIRED_ARTIFACTS`).toBe(true);
      }

      // REVISION_CLEANUP_EXTRA
      if (entry.inRevisionCleanup) {
        expect(inSet(revisionExtra),
          `${entry.file} must be in REVISION_CLEANUP_EXTRA`).toBe(true);
      }
    });
  }

  it('every PHASE_ARTIFACTS file is accounted for in the coverage table', () => {
    const covered = new Set(REGISTRY_COVERAGE.filter(e => e.inPhaseArtifacts).map(e => e.file));
    for (const f of phaseFiles) {
      expect(covered.has(toFamilyTemplate(f)),
        `PHASE_ARTIFACTS contains "${f}" which has no coverage table entry — add one`).toBe(true);
    }
  });

  it('every CLEANUP_ARTIFACTS file is accounted for in the coverage table', () => {
    const covered = new Set(REGISTRY_COVERAGE.filter(e => e.inCleanupArtifacts).map(e => e.file));
    for (const f of cleanupFiles) {
      expect(covered.has(toFamilyTemplate(f)),
        `CLEANUP_ARTIFACTS contains "${f}" which has no coverage table entry — add one`).toBe(true);
    }
  });

  it('every REQUIRED_ARTIFACTS file is accounted for in the coverage table', () => {
    const covered = new Set(REGISTRY_COVERAGE.filter(e => e.inRequiredArtifacts).map(e => e.file));
    for (const f of requiredFiles) {
      expect(covered.has(toFamilyTemplate(f)),
        `REQUIRED_ARTIFACTS contains "${f}" which has no coverage table entry — add one`).toBe(true);
    }
  });

  it('every REVISION_CLEANUP_EXTRA file is accounted for in the coverage table', () => {
    const covered = new Set(REGISTRY_COVERAGE.filter(e => e.inRevisionCleanup).map(e => e.file));
    for (const f of revisionExtra) {
      expect(covered.has(toFamilyTemplate(f)),
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
