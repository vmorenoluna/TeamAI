/**
 * Review action helpers — extracted from Orchestrator class.
 *
 * Handles human review decisions: approve, reject, and spec revision.
 * All functions use dependency injection — the orchestrator passes its
 * internal state (taskStore, pipelines, etc.) as callbacks.
 */
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from 'fs';
import path from 'path';
import type { PipelinePhase } from '@/constants/phases';
import type { TaskPipeline, MergeStrategy, QaReport } from './types';
import type { FailureReason } from './qa-feedback';
import { REVISION_CLEANUP_EXTRA, PHASE_ARTIFACTS } from './artifacts';
import { writeHumanFeedback, targetToResumePhase, type FeedbackTarget } from './human-feedback';
import { logToOutput } from './helpers';
import { TaskNotFoundError, PhaseTransitionError } from './errors';
import { warn } from '../logger';

// ── Dependencies ──────────────────────────────────────────────────────────

export interface ReviewActionsDeps {
  projectRoot: string;
  taskStore: {
    getById(taskId: string): { id: string; description: string; phase: string; branch?: string; mergeStrategy?: string } | null | undefined;
    update(taskId: string, fields: Record<string, unknown>): void;
    updatePhase(taskId: string, phase: PipelinePhase, eventExtra?: Record<string, unknown>): void;
    clearArtifacts(taskId: string, phase: string): void;
  };
  pipelines: Map<string, TaskPipeline>;
  restorePipeline: (taskId: string, requiredPhase: PipelinePhase) => TaskPipeline;
  advancePhase: (pipeline: TaskPipeline, phase: PipelinePhase, eventExtra?: Record<string, unknown>) => void;
  executePhase: (pipeline: TaskPipeline) => Promise<void>;
  savePipelineState: (pipeline: TaskPipeline) => void;
  writeCompletionSummary: (pipeline: TaskPipeline, reason: FailureReason, detail?: string) => void;
}

// ── Internal helpers ──────────────────────────────────────────────────────

/** Reset all retry counters on the pipeline — used when the spec is revised
 *  or the task is rejected, giving the next attempt a clean failure budget. */
function resetAllCounters(pipeline: TaskPipeline, preserveQaHistory = false): void {
  pipeline.qaAttempt = 0;
  pipeline.deliverableFailCounts = {};
  pipeline.stallRecoveryCounts = {};
  pipeline.incompleteImplementPassCount = 0;
  if (!preserveQaHistory) {
    pipeline.persistedCriterionFailCounts = {};
    pipeline.persistedAdditionalIssueCounts = {};
    pipeline.qaRoundCount = 0;
  }
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
 * (when the revision limit is reached and the human restarts from spec),
 * and by moveTaskToPhase's retry-to-spec path (orchestrator.ts) so a manual
 * retry with spec_concerns on record gets the exact same feedback content
 * a QA-driven bounce would have produced.
 */
export function buildSpecRevisionFeedback(specPath: string): string {
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
export function trimArtifactsForTarget(
  specPath: string,
  target: FeedbackTarget,
  options?: { preserve?: readonly string[] },
): void {
  if (target === 'coder') return;
  const preserved = new Set(options?.preserve ?? []);
  for (const f of QA_REGENERATION_ARTIFACTS) {
    if (preserved.has(f)) continue;
    try {
      const p = path.join(specPath, f);
      if (existsSync(p)) unlinkSync(p);
    } catch { /* best-effort */ }
  }
}

/**
 * Prepare spec.md for a revision on disk: write the feedback that flips
 * runSpecPhase into REVISION mode, snapshot the pre-revision spec, delete
 * the stale summary, and trim only what the analyst must regenerate.
 *
 * Pure filesystem side effects — no pipeline/session state — so it can run
 * both against a live in-memory pipeline (beginSpecRevision below) and
 * against a task with no pipeline currently running (moveTaskToPhase's
 * retry-to-spec path in orchestrator.ts, which builds a fresh pipeline via
 * runTask only after these artifacts are already in place).
 *
 * `newSpecRevision` is the revision number this call is producing (the spec
 * is archived as `spec_v{newSpecRevision - 1}.md`) — callers pass either
 * `pipeline.specRevision` after incrementing it, or the equivalent value
 * recovered from disk (Orchestrator._restoreSpecRevision).
 */
export function prepareSpecRevisionArtifacts(
  specPath: string,
  newSpecRevision: number,
  feedbackContent: string,
  opts: { clearStaleFeedback: boolean },
): void {
  // Feedback first (flips runSpecPhase into REVISION mode), then the spec
  // rename — order matters for the baseline-failure warn contract.
  writeFileSync(path.join(specPath, 'spec_revision_feedback.md'), feedbackContent);

  // Rename (not copy) the pre-revision spec to the previous version number:
  // the renamed file doubles as (a) the version-history entry the UI renders
  // and (b) runSpecPhase's no-op guard baseline. The analyst writes the
  // revised spec to spec.md, which the versions UI surfaces live as
  // v{specRevision} — so a completed revision never needs a post-hoc archive
  // copy (the old spec_revision_before.md marker scheme is retired).
  const specMdPath = path.join(specPath, 'spec.md');
  if (existsSync(specMdPath)) {
    try {
      renameSync(specMdPath, path.join(specPath, `spec_v${newSpecRevision - 1}.md`));
    } catch (err) {
      // Losing the baseline would make the no-op guard silently pass on every
      // future attempt — surface it, but don't block the pipeline.
      warn('review', `Failed to snapshot pre-revision spec at ${specPath}`, err);
    }
  }

  // spec_summary.md is not versioned like spec.md (no spec_summary_v{N}.md
  // history) — it's just regenerated in place by the revision-mode analyst
  // as its final step. Delete the pre-revision copy now rather than leaving
  // it for the analyst to overwrite: if that session fails before reaching
  // its final step, buildPRBody must see the summary as absent (and omit
  // the section) rather than serve a summary describing the now-archived,
  // no-longer-current spec.
  try { unlinkSync(path.join(specPath, 'spec_summary.md')); } catch { /* best-effort */ }

  // Preserve plan.json and all code commits (no blind cleanup): the planner
  // re-plans in place, keeping completed subtasks still valid under the
  // revised spec. Only QA artifacts (and, for the QA path, stale human
  // feedback) are cleared.
  trimArtifactsForTarget(specPath, 'analyst', {
    preserve: ['qa_report_before_bounce.json'],
  });
  if (opts.clearStaleFeedback) {
    for (const f of REVISION_CLEANUP_EXTRA) {
      if (f === 'qa_report_before_bounce.json') continue;
      try { const p = path.join(specPath, f); if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
    }
  }
}

/**
 * Begin a spec revision on a live pipeline: prepare the on-disk artifacts,
 * reset counters, and restart from the spec phase.
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
  prepareSpecRevisionArtifacts(pipeline.specPath, pipeline.specRevision, feedbackContent, opts);

  // A spec revision restarts the per-revision attempt counter, but QA
  // history must survive so repeated code defects remain visible/escalated
  // and the task still consumes the global maxQaAttempts budget.
  resetAllCounters(pipeline, true);
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
      awaitingReviewReason: errMsg,
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
 *
 * Also accepts `failed` tasks — a task can reach `failed` with a QA-attempt
 * or spec-revision budget exhausted rather than a clean PASS, and reject is
 * the primary recovery action for that case (e.g. redirecting feedback to
 * the analyst for a spec-revision-exhausted task, whose problem is usually
 * the approach itself rather than an implementation bug).
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
  if (phase !== 'awaiting-review' && phase !== 'pr-open' && phase !== 'failed') {
    throw new PhaseTransitionError(taskId, phase, 'awaiting-review, pr-open, or failed', 'reject');
  }

  const pipeline = deps.pipelines.get(taskId) ?? deps.restorePipeline(taskId, phase);
  await routeHumanFeedback(pipeline, deps, { target, message: feedback, subtaskIds });
}

/**
 * Route a reviewer's comment to a specific agent. Shared by every reject path.
 * Writes the feedback (with target), records the change request, trims only
 * what the target must regenerate, then resumes at the target's phase.
 *
 * Does NOT persist the resolved phase up front — deps.advancePhase below
 * (reached synchronously, no I/O-bound await precedes it in the common
 * path) is the sole authoritative writer of the task's in-progress phase,
 * so a crash mid-function leaves the task at its true last-known phase
 * instead of one with no session evidence behind it (see pipeline-state.ts's
 * persistAndEmitPhase doc comment).
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
    // qa_report.json itself is also preserved (unlike a normal in-flight
    // revision, this task has no next QA round to regenerate it — deleting
    // it here would leave the task's QA tab empty for the human reviewing
    // why it failed).
    trimArtifactsForTarget(specPath, 'analyst', {
      preserve: ['qa_report_before_bounce.json', 'qa_report.json'],
    });
    for (const f of REVISION_CLEANUP_EXTRA) {
      if (f === 'qa_report_before_bounce.json') continue;
      try { const p = path.join(specPath, f); if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
    }

    // Capture the true historical counters (qaRoundCount, specRevision) into
    // the completion summary before resetAllCounters zeroes them below —
    // this summary is a record of what just happened, not a preview of the
    // next attempt's fresh budget.
    deps.writeCompletionSummary(pipeline, 'spec-revision-exhausted');

    // Reset counters — a future retry (after a human edits the spec, or
    // redirects feedback to the analyst) gets a clean budget.
    resetAllCounters(pipeline);
    deps.savePipelineState(pipeline);

    // The spec-revision budget was exhausted without QA ever passing — this
    // usually means the approach itself needs a redesign, not another
    // automated attempt. Mark the task failed (with failureReason recorded
    // above) rather than awaiting-review, which is otherwise indistinguishable
    // from a genuine QA PASS in the UI. A human can still reject this task
    // (rejectTask now accepts the 'failed' phase) to route feedback to the
    // analyst, or retry it directly.
    try {
      logToOutput(specPath, `\n[REFINE] Max auto-revisions (3) reached — spec revision budget exhausted, marking task failed for human review\n`);
    } catch { /* best-effort */ }
    deps.advancePhase(pipeline, 'failed');
    return;
  }

  // Log the decision BEFORE beginSpecRevision, not after: beginSpecRevision
  // ends with `await deps.executePhase(pipeline)`, and each phase runner in
  // turn ends by awaiting the next one — so this call doesn't return until
  // the entire spec→plan→implement→qa-review cycle it kicks off has already
  // run to completion. Logging after the await would print this line only
  // once that whole cycle (and possibly the *next* QA round's own log lines)
  // has already landed in output.log, making it look like a stale/duplicate
  // event instead of the decision that triggered everything after it.
  try {
    logToOutput(specPath, `\n[REFINE] Spec concerns detected — auto-revising spec with analyst (revision ${pipeline.specRevision - 1}/3)\n`);
  } catch { /* best-effort */ }

  // Write spec_revision_feedback.md from QA report's spec_concerns, snapshot the
  // pre-revision spec, trim QA artifacts + stale human feedback, reset counters,
  // and restart from the spec phase.
  await beginSpecRevision(pipeline, deps, buildSpecRevisionFeedback(specPath), { clearStaleFeedback: true });
}
