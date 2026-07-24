import { existsSync, readFileSync, writeFileSync, unlinkSync, renameSync, statSync, appendFileSync } from 'fs';
import path from 'path';
import { processManager } from '../process-manager';
import type { TaskStore } from '../task-store';
import type { PipelinePhase } from '@/constants/phases';
import type { TaskPipeline } from './types';

/** Rotate output log: keep last ~50KB when log exceeds ~100KB (#6) */
export function rotateOutputLog(logFile: string): void {
  try {
    if (!existsSync(logFile)) return;
    const MAX_SIZE = 100_000;
    const KEEP_SIZE = 50_000;
    const stat = statSync(logFile);
    if (stat.size > MAX_SIZE) {
      const content = readFileSync(logFile, 'utf-8');
      const truncated = content.slice(-KEEP_SIZE);
      writeFileSync(logFile, truncated);
      appendFileSync(logFile, `\n── LOG TRUNCATED (${stat.size} → ${KEEP_SIZE} bytes) ──\n`);
    }
  } catch { /* best-effort */ }
}

/**
 * Persist phase to disk atomically and emit phase-change event.
 * Called when phase work actually starts — NOT before (#5).
 * This ensures a crash before work starts leaves the task at the previous phase.
 */
export function persistAndEmitPhase(pipeline: TaskPipeline, taskStore: TaskStore, projectRoot: string): void {
  taskStore.updatePhase(pipeline.taskId, pipeline.phase);
  processManager.emit('phase-change', { taskId: pipeline.taskId, phase: pipeline.phase, projectRoot });
}

/**
 * Save pipeline state to disk for crash recovery (#7).
 * On resume, restorePipelineState reads this to recover sessionId, mergeStrategy, etc.
 */
export function savePipelineState(pipeline: TaskPipeline): void {
  try {
    const statePath = path.join(pipeline.specPath, '.pipeline_state.json');
    const state = {
      taskId: pipeline.taskId,
      phase: pipeline.phase,
      sessionId: pipeline.sessionId,
      mergeStrategy: pipeline.mergeStrategy,
      qaAttempt: pipeline.qaAttempt,
      deliverableFailCounts: pipeline.deliverableFailCounts,
      wakeupUntil: pipeline.wakeupUntil,
      wakeupSubtaskId: pipeline.wakeupSubtaskId,
      wakeupCommand: pipeline.wakeupCommand,
      wakeupArtifact: pipeline.wakeupArtifact,
      wakeupProgressPath: pipeline.wakeupProgressPath,
      wakeupAttemptCount: pipeline.wakeupAttemptCount,
      persistedCriterionFailCounts: pipeline.persistedCriterionFailCounts,
      branch: pipeline.branch,
      worktreePath: pipeline.worktreePath,
      updatedAt: new Date().toISOString(),
    };
    const tmpPath = statePath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(state, null, 2));
    renameSync(tmpPath, statePath);
  } catch { /* best-effort */ }
}

/**
 * Restore pipeline state from disk after a crash.
 * Returns null if no saved state exists.
 */
export function restorePipelineState(_taskId: string, specPath: string): Partial<TaskPipeline> | null {
  try {
    const statePath = path.join(specPath, '.pipeline_state.json');
    if (!existsSync(statePath)) return null;
    const state = JSON.parse(readFileSync(statePath, 'utf-8'));
    unlinkSync(statePath); // clean up after reading
    return state;
  } catch { return null; }
}

export function pipelineAdvancePhase(
  pipeline: TaskPipeline,
  phase: PipelinePhase,
  taskStore: TaskStore,
  projectRoot: string,
  eventExtra?: Record<string, unknown>,
): void {
  pipeline.phase = phase;
  taskStore.updatePhase(pipeline.taskId, phase);
  processManager.emit('phase-change', { taskId: pipeline.taskId, phase, projectRoot, ...eventExtra });
}
