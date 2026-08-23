/**
 * Review action helpers — extracted from Orchestrator class.
 *
 * Handles human review decisions: approve, reject, and spec revision.
 * All functions use dependency injection — the orchestrator passes its
 * internal state (taskStore, pipelines, etc.) as callbacks.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'fs';
import path from 'path';
import type { PipelinePhase } from '@/constants/phases';
import type { TaskPipeline, MergeStrategy, QaReport } from './types';
import { REVISION_CLEANUP_EXTRA, PHASE_ARTIFACTS } from './artifacts';
import { writeHumanFeedback, targetToResumePhase, type FeedbackTarget } from './human-feedback';
import { logToOutput } from './helpers';
import { TaskNotFoundError, PhaseTransitionError } from './errors';
import { warn } from '../logger';

// ── Dependencies ──────────────────────────────────────────────────────────

export interface ReviewActionsDeps {
  taskStore: {
    getById(taskId: string): { id: string; description: string; phase: string; branch?: string; mergeStrategy?: string } | null | undefined;
    update(taskId: string, fields: Record<string, unknown>): void;
    clearArtifacts(taskId: string, phase: string): void;
  };
  pipelines: Map<string, TaskPipeline>;
  restorePipeline: (taskId: string, requiredPhase: PipelinePhase) => TaskPipeline;
  advancePhase: (pipeline: TaskPipeline, phase: PipelinePhase, eventExtra?: Record<string, unknown>) => void;
  executePhase: (pipeline: TaskPipeline) => Promise<void>;
  savePipelineState: (pipeline: TaskPipeline) => void;
}

// ── Internal helpers ──────────────────────────────────────────────────────

/** Reset all retry counters on the pipeline — used when the spec is revised
 *  or the task is rejected, giving the next attempt a clean failure budget. */
function resetAllCounters(pipeline: TaskPipeline): void {
  pipeline.qaAttempt = 0;
  pipeline.deliverableFailCounts = {};
  pipeline.persistedCriterionFailCounts = {};
  // Wakeup state — counters AND identity fields MUST reset together.
  // Leaving wakeupSubtaskId set would cause incorrect subtask isolation
  // on the next implement pass (ADR 002), and a lingering wakeupUntil
  // would break runTask's lock-release guard in the finally block.
  pipeline.wakeupAttemptCount = 0;
  pipeline.wakeupUntil = undefined;
  pipeline.wakeupSubtaskId = undefined;
  pipeline.wakeupCommand = undefined;
  pipeline.wakeupArtifact = undefined;
  pipeline.wakeupProgressPath = undefined;
}

/**
 * Build spec_revision_feedback.md content from qa_report.json's spec_concerns.
 * Used by both the normal auto-revision path and the bail-out path
 * (when the revision limit is reached and the human restarts from spec).
 */
function buildSpecRevisionFeedback(specPath: string): string {
  const reportPath = path.join(specPath, 'qa_report.json');
  let feedbackContent = '# Spec Revision Feedback\n\n';
  feedbackContent += 'The QA reviewer identified issues with the specification itself ';
  feedbackContent += '(not the implementation). The spec needs to be revised to address these concerns.\n\n';
  if (existsSync(reportPath)) {
    try {
      const report: QaReport = JSON.parse(readFileSync(reportPath, 'utf-8'));
      if (report.spec_concerns && report.spec_concerns.length > 0) {
        for (const sc of report.spec_concerns) {
          feedbackContent += `## ${sc.issue}\n\n`;
          feedbackContent += `**Reasoning:** ${sc.reasoning}\n\n`;
          if (sc.suggested_fix) {
            feedbackContent += `**Suggested fix:** ${sc.suggested_fix}\n\n`;
          }
        }
      }
    } catch { /* best-effort — produce feedback from whatever we can read */ }
  }
  return feedbackContent;
}

// ── Shared routing helpers ─────────────────────────────────────────────────

/** Append a "Change Request" FAIL criterion to qa_report.json so the change
 *  request is part of the audit trail. Shared by rejectTask and routeHumanFeedback. */
function recordChangeRequest(specPath: string, message: string, context: string): void {
  const reportPath = path.join(specPath, 'qa_report.json');
  if (!existsSync(reportPath)) return;
  try {
    const report: QaReport = JSON.parse(readFileSync(reportPath, 'utf-8'));
    if (!report.criteria) report.criteria = [];
    report.overall = 'FAIL';
    report.criteria.push({
      name: 'Change Request',
      status: 'FAIL',
      notes: message,
    });
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch (err) {
    // The rejection proceeds either way, but a failed patch (or a malformed
    // report) means the change request never reaches the engineer's report.
    warn('review', `Failed to record change request in qa_report.json for ${context}`, err);
  }
}

/** Snapshot human_feedback.md so it survives the implement-phase cleanup
 *  (which deletes the primary file after rework completes). Shared by every
 *  reject path. */
function snapshotHumanFeedback(specPath: string, context: string): void {
  const feedbackPath = path.join(specPath, 'human_feedback.md');
  const snapshotPath = path.join(specPath, 'human_feedback_before_bounce.md');
  try {
    writeFileSync(snapshotPath, readFileSync(feedbackPath, 'utf-8'));
  } catch (err) {
    // Defensive snapshot — a failure only means nothing to restore from
    // later, but surface it so a silently-missing snapshot is diagnosable.
    warn('review', `Failed to snapshot human feedback for ${context}`, err);
  }
}

/** QA-level artifacts that must be regenerated by the next QA pass. */
const QA_REGENERATION_ARTIFACTS: readonly string[] = PHASE_ARTIFACTS.qa;

/**
 * Trim only the artifacts the target agent must regenerate, preserving
 * spec.md, plan.json, and all code commits (requirement: no blind cleanup).
 *
 * - coder: nothing — implementation re-runs against the existing spec/plan.
 * - analyst/planner/qa-reviewer: clear the QA-level artifacts only.
 */
export function trimArtifactsForTarget(specPath: string, target: FeedbackTarget): void {
  if (target === 'coder') return;
  for (const f of QA_REGENERATION_ARTIFACTS) {
    try {
      const p = path.join(specPath, f);
      if (existsSync(p)) unlinkSync(p);
    } catch { /* best-effort */ }
  }
}

/**
 * Begin a spec revision: write the feedback that flips runSpecPhase into
 * REVISION mode, snapshot the pre-revision spec, trim only what the analyst
 * must regenerate, reset counters, and restart from the spec phase.
 *
 * The caller is responsible for incrementing `pipeline.specRevision` first so
 * the no-op guard and version archive use the new number.
 *
 * Shared by autoReviseSpec (QA-driven) and routeHumanFeedback's analyst target
 * (human-driven), which differ only in the feedback content and whether stale
 * human-feedback files are cleared (the human path keeps human_feedback.md so
 * the analyst sees the directive).
 */
async function beginSpecRevision(
  pipeline: TaskPipeline,
  deps: ReviewActionsDeps,
  feedbackContent: string,
  opts: { clearStaleFeedback: boolean },
): Promise<void> {
  const specPath = pipeline.specPath;

  // Feedback first (flips runSpecPhase into REVISION mode), then the spec
  // snapshot — order matters for the snapshot-failure warn contract.
  writeFileSync(path.join(specPath, 'spec_revision_feedback.md'), feedbackContent);

  const specMdPath = path.join(specPath, 'spec.md');
  if (existsSync(specMdPath)) {
    try {
      // Snapshot the pre-revision spec to a dedicated marker file (NOT
      // spec_v{N}.md). runSpecPhase uses this as the no-op guard's "before"
      // baseline, and spec_v{N}.md is only written once the revision actually
      // completes — so an in-flight revision doesn't surface as a finished
      // version in the spec comparison UI.
      writeFileSync(path.join(specPath, 'spec_revision_before.md'), readFileSync(specMdPath, 'utf-8'));
    } catch (err) {
      warn('review', `Failed to snapshot pre-revision spec for ${pipeline.taskId}`, err);
    }
  }

  // Preserve plan.json and all code commits (no blind cleanup): the planner
  // re-plans in place, keeping completed subtasks still valid under the
  // revised spec. Only QA artifacts (and, for the QA path, stale human
  // feedback) are cleared.
  trimArtifactsForTarget(specPath, 'analyst');
  if (opts.clearStaleFeedback) {
    for (const f of REVISION_CLEANUP_EXTRA) {
      try { const p = path.join(specPath, f); if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
    }
  }

  resetAllCounters(pipeline);
  deps.savePipelineState(pipeline);
  deps.advancePhase(pipeline, 'spec');
  await deps.executePhase(pipeline);
}

// ── Public functions ──────────────────────────────────────────────────────

/**
 * Approve a task that is awaiting review. Sets the merge strategy
 * (local-merge or pull-request) and advances to the chosen phase.
 * On failure, rolls back to awaiting-review and re-throws.
 */
export async function approveTask(
  taskId: string,
  strategy: MergeStrategy,
  deps: ReviewActionsDeps,
): Promise<void> {
  const task = deps.taskStore.getById(taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  const phase = task.phase;
  if (phase !== 'awaiting-review') {
    throw new PhaseTransitionError(taskId, phase, 'awaiting-review', 'approve');
  }
  const pipeline = deps.pipelines.get(taskId) ?? deps.restorePipeline(taskId, 'awaiting-review');
  pipeline.mergeStrategy = strategy;
  deps.taskStore.update(taskId, { mergeStrategy: strategy });
  const next = strategy === 'local-merge' ? 'merge' : 'create-pr';
  deps.advancePhase(pipeline, next);
  try {
    await deps.executePhase(pipeline);
  } catch (err) {
    // Capture error details for the audit trail and rollback event.
    const errMsg = err instanceof Error ? err.message : String(err);
    const eventExtra: Record<string, unknown> = {
      approvalError: errMsg,
      fromPhase: next,
    };
    // Preserve structured error code if present (e.g. AUTH, PUSH, CONFLICT).
    const errCode = (err instanceof Error && 'code' in err) ? (err as Error & { code?: string }).code : undefined;
    if (errCode) eventExtra.errorCode = errCode;

    // Log to output.log so the reason is visible alongside phase output
    // (matches the top-level task runner's catch-block pattern).
    logToOutput(pipeline.specPath, `\n[ERROR] Approval failed (${next}): ${errMsg}\n`);

    // Roll back to awaiting-review with error details in the phase-change event.
    deps.advancePhase(pipeline, 'awaiting-review', eventExtra);
    throw err;
  }
}

/**
 * Reject a task that is awaiting review or has an open PR.
 * Writes human_feedback.md, snapshots it for bounce-cycle survival,
 * updates the QA report with the rejection reason, resets qaAttempt,
 * and bounces back to the implement phase.
 */
export async function rejectTask(
  taskId: string,
  feedback: string,
  target: FeedbackTarget,
  subtaskIds: number[] | undefined,
  deps: ReviewActionsDeps,
): Promise<void> {
  const task = deps.taskStore.getById(taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  const phase = task.phase;
  if (phase !== 'awaiting-review' && phase !== 'pr-open') {
    throw new PhaseTransitionError(taskId, phase, 'awaiting-review or pr-open', 'reject');
  }

  const pipeline = deps.pipelines.get(taskId) ?? deps.restorePipeline(taskId, phase);
  await routeHumanFeedback(pipeline, deps, { target, message: feedback, subtaskIds });
}

/**
 * Route a reviewer's comment to a specific agent. Shared by every reject path.
 * Writes the feedback (with target), records the change request, trims only
 * what the target must regenerate, then resumes at the target's phase.
 */
export async function routeHumanFeedback(
  pipeline: TaskPipeline,
  deps: ReviewActionsDeps,
  feedback: { target: FeedbackTarget; message: string; subtaskIds?: number[] },
): Promise<void> {
  writeHumanFeedback(pipeline.specPath, feedback.target, feedback.message, feedback.subtaskIds);
  snapshotHumanFeedback(pipeline.specPath, pipeline.taskId);
  // The "Change Request" audit entry lives in qa_report.json. That file is
  // preserved only for the coder target — trimArtifactsForTarget deletes it for
  // analyst/planner/qa-reviewer, so recording it there would be a throwaway
  // write. Scope the recording to the one target whose report actually survives.
  if (feedback.target === 'coder') {
    recordChangeRequest(pipeline.specPath, feedback.message, pipeline.taskId);
  }

  // Directing the analyst means "revise the existing spec", not "regenerate it
  // from scratch". Route it into runSpecPhase's REVISION mode (which preserves
  // valid parts of the spec) rather than the fresh /spec path that would
  // overwrite the spec the team already wrote. Mirrors autoReviseSpec's
  // bookkeeping via the shared beginSpecRevision helper.
  if (feedback.target === 'analyst') {
    const specMdPath = path.join(pipeline.specPath, 'spec.md');
    if (existsSync(specMdPath)) {
      pipeline.specRevision += 1;
      await beginSpecRevision(
        pipeline,
        deps,
        `# Spec Revision Feedback\n\nThe human reviewer directed the analyst to revise the spec:\n\n${feedback.message.trim()}\n`,
        { clearStaleFeedback: false },
      );
      return;
    }
  }

  resetAllCounters(pipeline);
  trimArtifactsForTarget(pipeline.specPath, feedback.target);

  const next = targetToResumePhase(feedback.target);
  deps.advancePhase(pipeline, next);
  await deps.executePhase(pipeline);
}

/**
 * Auto-triggered spec revision when QA finds spec_concerns.
 * Writes revision feedback, snapshots the old spec, clears downstream artifacts,
 * and restarts the pipeline from the spec phase (analyst).
 *
 * Called by runQaReview (QA path, auto-detected spec_concerns). Human-driven
 * spec revision goes through routeHumanFeedback's analyst target instead
 * (see beginSpecRevision).
 *
 * When the revision limit is reached, the pipeline parks in awaiting-review so
 * the human can safely edit spec.md without an agent writing concurrently.
 */
export async function autoReviseSpec(
  pipeline: TaskPipeline,
  deps: ReviewActionsDeps,
): Promise<void> {
  const specPath = pipeline.specPath;

  // Guard: max 3 auto-revisions. At the limit, park in awaiting-review so the
  // human can safely edit spec.md. Historical QA reports (qa_report_v{N}.json)
  // are preserved — they are tied to specific spec versions and serve as a
  // permanent audit trail.
  pipeline.specRevision++;
  if (pipeline.specRevision > 4) {
    // Write revision feedback so the analyst runs in revision mode
    writeFileSync(path.join(specPath, 'spec_revision_feedback.md'), buildSpecRevisionFeedback(specPath));

    // Preserve plan.json and code (no blind cleanup) — the planner re-plans in
    // place. Clear only QA artifacts and stale human feedback (historical
    // qa_report_v{N}.json and spec_v{N}.md are permanent audit records).
    trimArtifactsForTarget(specPath, 'analyst');
    for (const f of REVISION_CLEANUP_EXTRA) {
      try { const p = path.join(specPath, f); if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
    }

    // Reset counters — fresh spec gets a clean budget
    resetAllCounters(pipeline);
    deps.savePipelineState(pipeline);

    // Park in awaiting-review so the human can edit the spec without an agent
    // writing concurrently.
    try {
      logToOutput(specPath, `\n[REFINE] Max auto-revisions (3) reached — pausing for human-guided revision\n`);
    } catch { /* best-effort */ }
    deps.advancePhase(pipeline, 'awaiting-review');
    return;
  }

  // Write spec_revision_feedback.md from QA report's spec_concerns, snapshot the
  // pre-revision spec, trim QA artifacts + stale human feedback, reset counters,
  // and restart from the spec phase.
  await beginSpecRevision(pipeline, deps, buildSpecRevisionFeedback(specPath), { clearStaleFeedback: true });

  try {
    logToOutput(specPath, `\n[REFINE] Spec concerns detected — auto-revising spec with analyst (revision ${pipeline.specRevision - 1}/3)\n`);
  } catch { /* best-effort */ }
}
