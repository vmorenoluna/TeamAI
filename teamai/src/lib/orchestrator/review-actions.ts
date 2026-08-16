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
 * Write spec_revision_feedback.md from qa_report.json's spec_concerns.
 * Used by both the normal auto-revision path and the bail-out path
 * (when the revision limit is reached and the human restarts from spec).
 */
function writeSpecRevisionFeedback(specPath: string): void {
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
  writeFileSync(path.join(specPath, 'spec_revision_feedback.md'), feedbackContent);
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
    deps.advancePhase(pipeline, 'awaiting-review');
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
  deps: ReviewActionsDeps,
): Promise<void> {
  const task = deps.taskStore.getById(taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  const phase = task.phase;
  if (phase !== 'awaiting-review' && phase !== 'pr-open') {
    throw new PhaseTransitionError(taskId, phase, 'awaiting-review or pr-open', 'reject');
  }

  const pipeline = deps.pipelines.get(taskId) ?? deps.restorePipeline(taskId, phase);
  await routeHumanFeedback(pipeline, deps, { target, message: feedback });
}

/**
 * Route a reviewer's comment to a specific agent. Shared by every reject path.
 * Writes the feedback (with target), records the change request, trims only
 * what the target must regenerate, then resumes at the target's phase.
 */
export async function routeHumanFeedback(
  pipeline: TaskPipeline,
  deps: ReviewActionsDeps,
  feedback: { target: FeedbackTarget; message: string },
): Promise<void> {
  writeHumanFeedback(pipeline.specPath, feedback.target, feedback.message);
  snapshotHumanFeedback(pipeline.specPath, pipeline.taskId);
  // The "Change Request" audit entry lives in qa_report.json. That file is
  // preserved only for the coder target — trimArtifactsForTarget deletes it for
  // analyst/planner/qa-reviewer, so recording it there would be a throwaway
  // write. Scope the recording to the one target whose report actually survives.
  if (feedback.target === 'coder') {
    recordChangeRequest(pipeline.specPath, feedback.message, pipeline.taskId);
  }
  resetAllCounters(pipeline);
  trimArtifactsForTarget(pipeline.specPath, feedback.target);

  // Directing the analyst means "revise the existing spec", not "regenerate it
  // from scratch". Route it into runSpecPhase's REVISION mode (which preserves
  // valid parts of the spec) rather than the fresh /spec path that would
  // overwrite the spec the team already wrote. Mirror autoReviseSpec's
  // bookkeeping so the no-op guard and version archive have a correct baseline.
  if (feedback.target === 'analyst') {
    const specMdPath = path.join(pipeline.specPath, 'spec.md');
    if (existsSync(specMdPath)) {
      writeFileSync(
        path.join(pipeline.specPath, 'spec_revision_feedback.md'),
        `# Spec Revision Feedback\n\nThe human reviewer directed the analyst to revise the spec:\n\n${feedback.message.trim()}\n`,
      );
      pipeline.specRevision += 1;
      writeFileSync(
        path.join(pipeline.specPath, `spec_v${pipeline.specRevision}.md`),
        readFileSync(specMdPath, 'utf-8'),
      );
      deps.savePipelineState(pipeline);
    }
  }

  const next = targetToResumePhase(feedback.target);
  deps.advancePhase(pipeline, next);
  await deps.executePhase(pipeline);
}

/**
 * Auto-triggered spec revision when QA finds spec_concerns.
 * Writes revision feedback, snapshots the old spec, clears downstream artifacts,
 * and restarts the pipeline from the spec phase (analyst).
 *
 * Called by reviseSpec (UI path, human explicitly clicked "Revise Spec")
 * and runQaReview (QA path, auto-detected spec_concerns).
 *
 * When the revision limit is reached:
 * - QA path (humanTriggered=false): parks in awaiting-review so the human
 *   can safely edit spec.md without an agent writing concurrently.
 * - UI path (humanTriggered=true): the human has explicitly chosen to
 *   restart — bypass the limit and proceed with revision.
 */
export async function autoReviseSpec(
  pipeline: TaskPipeline,
  deps: ReviewActionsDeps,
  opts?: { humanTriggered?: boolean },
): Promise<void> {
  const specPath = pipeline.specPath;

  // Guard: max 3 auto-revisions. The QA path parks in awaiting-review
  // so the human can safely edit spec.md; the UI path (Revise Spec button)
  // bypasses the limit because the human has explicitly chosen to restart.
  // Historical QA reports (qa_report_v{N}.json) are preserved — they are
  // tied to specific spec versions and serve as a permanent audit trail.
  pipeline.specRevision++;
  if (pipeline.specRevision > 4) {
    // Write revision feedback so the analyst runs in revision mode
    writeSpecRevisionFeedback(specPath);

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

    if (opts?.humanTriggered) {
      // UI path: human explicitly chose to restart — proceed with revision
      try {
        logToOutput(specPath, `\n[REFINE] Human-triggered spec revision (revision ${pipeline.specRevision - 1}) — restarting from spec with analyst\n`);
      } catch { /* best-effort */ }
      deps.advancePhase(pipeline, 'spec');
      await deps.executePhase(pipeline);
    } else {
      // QA path: park in awaiting-review so the human can edit the spec
      // without an agent writing concurrently
      try {
        logToOutput(specPath, `\n[REFINE] Max auto-revisions (3) reached — pausing for human-guided revision\n`);
      } catch { /* best-effort */ }
      deps.advancePhase(pipeline, 'awaiting-review');
    }
    return;
  }

  // Write spec_revision_feedback.md from QA report's spec_concerns
  writeSpecRevisionFeedback(specPath);

  // Snapshot the current spec before revision (preserves history)
  const specMdPath = path.join(specPath, 'spec.md');
  if (existsSync(specMdPath)) {
    try {
      writeFileSync(path.join(specPath, `spec_v${pipeline.specRevision}.md`), readFileSync(specMdPath, 'utf-8'));
    } catch (err) {
      // A failed snapshot loses the pre-revision spec history (specRevision
      // is already incremented). Surface it.
      warn('review', `Failed to snapshot spec v${pipeline.specRevision} for ${pipeline.taskId}`, err);
    }
  }

  // Preserve plan.json and all code commits (no blind cleanup): the planner
  // re-plans in place, keeping completed subtasks still valid under the
  // revised spec. Only QA artifacts and stale human feedback are cleared.
  trimArtifactsForTarget(specPath, 'analyst');
  for (const f of REVISION_CLEANUP_EXTRA) {
    try { const p = path.join(specPath, f); if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
  }

  // Reset all retry counters — fresh spec gets a clean budget
  resetAllCounters(pipeline);
  deps.savePipelineState(pipeline);

  try {
    logToOutput(specPath, `\n[REFINE] Spec concerns detected — auto-revising spec with analyst (revision ${pipeline.specRevision - 1}/3)\n`);
  } catch { /* best-effort */ }
  deps.advancePhase(pipeline, 'spec');
  await deps.executePhase(pipeline);
}
