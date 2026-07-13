/**
 * Review action helpers — extracted from Orchestrator class.
 *
 * Handles human review decisions: approve, reject, and spec revision.
 * All functions use dependency injection — the orchestrator passes its
 * internal state (taskStore, pipelines, etc.) as callbacks.
 */
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from 'fs';
import path from 'path';
import type { PipelinePhase } from '@/constants/phases';
import type { TaskPipeline, MergeStrategy, QaReport } from './types';
import { REVISION_CLEANUP_EXTRA } from './artifacts';
import { TaskNotFoundError, PhaseTransitionError } from './errors';

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
  deps: ReviewActionsDeps,
): Promise<void> {
  const task = deps.taskStore.getById(taskId);
  if (!task) throw new TaskNotFoundError(taskId);
  const phase = task.phase;
  if (phase !== 'awaiting-review' && phase !== 'pr-open') {
    throw new PhaseTransitionError(taskId, phase, 'awaiting-review or pr-open', 'reject');
  }

  const pipeline = deps.pipelines.get(taskId) ?? deps.restorePipeline(taskId, phase);
  const feedbackPath = path.join(pipeline.specPath, 'human_feedback.md');
  writeFileSync(feedbackPath, `# Human Review Feedback\n\n${feedback}\n`);

  // Snapshot: preserve human_feedback before bouncing back to implement
  // The feedback file is deleted after implement completes, so this snapshot
  // ensures the feedback survives repeated bounce cycles.
  try {
    const snapshotPath = path.join(pipeline.specPath, 'human_feedback_before_bounce.md');
    writeFileSync(snapshotPath, readFileSync(feedbackPath, 'utf-8'));
  } catch { /* best-effort */ }

  // Update the QA report so the engineer can see what changes were requested
  const reportPath = path.join(pipeline.specPath, 'qa_report.json');
  if (existsSync(reportPath)) {
    try {
      const report: QaReport = JSON.parse(readFileSync(reportPath, 'utf-8'));
      if (!report.criteria) report.criteria = [];
      report.overall = 'FAIL';
      report.criteria.push({
        name: 'Change Request',
        status: 'FAIL',
        notes: feedback,
      });
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
    } catch { /* best-effort: if qa_report.json is malformed, don't block the rejection */ }
  }

  // Reset all retry counters — rejection gets a clean budget
  resetAllCounters(pipeline);
  deps.advancePhase(pipeline, 'implement');
  await deps.executePhase(pipeline);
}

/**
 * Auto-triggered spec revision when QA finds spec_concerns.
 * Writes revision feedback, snapshots the old spec, clears downstream artifacts,
 * and restarts the pipeline from the spec phase (analyst).
 *
 * Called by reviseSpec (public entry point) and runQaReview (via autoReviseSpec deps).
 */
export async function autoReviseSpec(
  pipeline: TaskPipeline,
  deps: ReviewActionsDeps,
): Promise<void> {
  const specPath = pipeline.specPath;
  const logFile = path.join(specPath, 'output.log');

  // Guard: max 3 spec revisions before falling back to human review.
  // Prevents infinite loops when the analyst produces the same flawed spec.
  pipeline.specRevision++;
  if (pipeline.specRevision > 3) {
    try {
      appendFileSync(logFile, `\n[REFINE] Max spec revisions (3) reached — pausing for human review\n`);
    } catch { /* best-effort */ }
    deps.advancePhase(pipeline, 'awaiting-review');
    return;
  }

  // Write spec_revision_feedback.md from QA report's spec_concerns
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

  // Snapshot the current spec before revision (preserves history)
  const specMdPath = path.join(specPath, 'spec.md');
  if (existsSync(specMdPath)) {
    try {
      writeFileSync(path.join(specPath, `spec_v${pipeline.specRevision}.md`), readFileSync(specMdPath, 'utf-8'));
    } catch { /* best-effort */ }
  }

  // Clear downstream artifacts — plan, QA, and feedback all need regeneration
  // from the revised spec. clearArtifacts('plan') clears plan.json + qa_report.json.
  deps.taskStore.clearArtifacts(pipeline.taskId, 'plan');

  // Also clear additional revision-related files that should not persist
  const extraFiles = REVISION_CLEANUP_EXTRA;
  for (const f of extraFiles) {
    try { const p = path.join(specPath, f); if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
  }

  // Reset all retry counters — fresh spec gets a clean budget
  resetAllCounters(pipeline);
  deps.savePipelineState(pipeline);

  try {
    appendFileSync(logFile, `\n[REFINE] Spec concerns detected — auto-revising spec with analyst (revision ${pipeline.specRevision}/3)\n`);
  } catch { /* best-effort */ }
  deps.advancePhase(pipeline, 'spec');
  await deps.executePhase(pipeline);
}
