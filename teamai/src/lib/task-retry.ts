/**
 * Failed-task retry helpers, shared between the server actions (`retryTask` /
 * `retryTaskWithOptions`) and the role-refinement watcher's Phase-3
 * auto-retry. Moving the pre-restore logic out of the `'use server'` file
 * lets the watcher retry with the exact same semantics as a manual Retry.
 */
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { TaskStore } from './task-store';
import { getResumePhaseForFailedTask } from './task-utils';
import { getOrchestrator } from './orchestrator';
import { error as logError } from './logger';

/**
 * Pre-restore work for a failed task before re-running it.
 *
 * Restores qa_report.json and human_feedback.md from snapshots if deleted,
 * snapshots qa_report.json before re-running, clears completionSummary,
 * and clears output.log for a fresh terminal view on retry.
 */
export function preRestoreFailedTask(taskStore: TaskStore, taskId: string): void {
  const dir = taskStore.getDirById(taskId);

  // ── Restore qa_report.json from snapshot if deleted ──
  const reportPath = join(dir, 'qa_report.json');
  if (!existsSync(reportPath)) {
    for (const snapName of ['qa_report_before_failed.json', 'qa_report_before_bounce.json']) {
      const snapshotPath = join(dir, snapName);
      if (existsSync(snapshotPath)) {
        try {
          const snapshot = readFileSync(snapshotPath, 'utf-8');
          writeFileSync(reportPath, snapshot);
          const logFile = join(dir, 'output.log');
          appendFileSync(logFile, `\n[RETRY] Restored qa_report.json from ${snapName} — file was deleted before retry\n`);
        } catch { /* best-effort */ }
        break; // use the first available snapshot
      }
    }
  }

  // ── Restore human_feedback.md from snapshot if deleted ──
  const humanFeedbackPath = join(dir, 'human_feedback.md');
  const humanFeedbackSnapshotPath = join(dir, 'human_feedback_before_bounce.md');
  if (!existsSync(humanFeedbackPath) && existsSync(humanFeedbackSnapshotPath)) {
    try {
      const snapshot = readFileSync(humanFeedbackSnapshotPath, 'utf-8');
      writeFileSync(humanFeedbackPath, snapshot);
      const logFile = join(dir, 'output.log');
      appendFileSync(logFile, '\n[RETRY] Restored human_feedback.md from human_feedback_before_bounce.md — file was deleted before retry\n');
    } catch { /* best-effort */ }
  }

  // ── Snapshot qa_report.json before re-running so context is preserved ──
  if (existsSync(reportPath)) {
    const snapshotPath = join(dir, 'qa_report_before_failed.json');
    try {
      const reportContent = readFileSync(reportPath, 'utf-8');
      writeFileSync(snapshotPath, reportContent);
    } catch { /* best-effort — don't block retry on snapshot failure */ }
  }

  // Clear completionSummary and failureReason so the failure indicator
  // disappears and a subsequent failure isn't mislabeled with a stale reason
  taskStore.update(taskId, { completionSummary: undefined, failureReason: undefined });

  // Clear output.log for a fresh terminal view on retry
  const outputPath = join(dir, 'output.log');
  try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch { /* best-effort */ }
}

/**
 * Resume a failed task from its last real phase (fire-and-forget), with the
 * same pre-restore semantics as the manual Retry button. No-op when the task
 * is missing or not in `failed`.
 */
export function retryFailedTask(projectRoot: string, taskId: string): void {
  const taskStore = new TaskStore(projectRoot);
  const task = taskStore.getById(taskId);
  if (!task || task.phase !== 'failed') return;

  // Determine the phase the task was in when it failed — read from events.
  let resumePhase = 'qa-review'; // default for failed tasks (most common failure point)
  try {
    resumePhase = getResumePhaseForFailedTask(taskStore.getEvents(taskId), task.failureReason);
  } catch { /* fall back to default */ }

  preRestoreFailedTask(taskStore, taskId);

  // Fire-and-forget — pipeline runs async, phase changes broadcast via WebSocket.
  getOrchestrator(projectRoot).moveTaskToPhase(taskId, resumePhase)
    .catch(err => logError('task-retry', `retryFailedTask ${taskId} failed`, err));
}
