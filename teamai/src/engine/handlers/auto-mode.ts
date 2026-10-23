/**
 * Engine-side auto-mode handlers, moved from `src/app/actions/auto-mode.ts`. They take
 * `projectPath` explicitly and never call `revalidatePath` — the action wrapper does.
 */
import { setAutoModeState } from '@/lib/auto-mode';
import { TaskStore } from '@/lib/task-store';
import { processManager } from '@/lib/process-manager';
import { markAutoReviewed as markAutoReviewedRecord } from '@/lib/auto-review-store';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (params: any) => Promise<unknown>;

async function toggle(params: { projectPath: string; enabled: boolean; maxParallel: number }): Promise<void> {
  setAutoModeState(params.projectPath, params.enabled, params.maxParallel);
}

async function markReviewed(params: { projectPath: string; taskId: string }): Promise<void> {
  const { projectPath, taskId } = params;
  if (!taskId?.trim()) {
    throw new Error('Invalid taskId: must be a non-empty string');
  }

  const taskStore = new TaskStore(projectPath);
  const task = await taskStore.getByIdAsync(taskId);
  if (!task) {
    // Completed tasks have had their workspace deleted. Their DONE card is
    // reconstructed from git history, so acknowledge it in the durable
    // project-level metadata instead of requiring task.json to exist.
    const record = markAutoReviewedRecord(projectPath, taskId);
    if (!record) {
      throw new Error(`Task ${taskId} not found`);
    }
    return;
  }
  taskStore.update(taskId, { autoReviewed: true });

  // Emit a phase-change event so connected WebSocket clients can update the
  // amber auto-processed border in real-time without waiting for revalidation.
  processManager.emit('phase-change', {
    taskId,
    phase: task.phase,
    projectRoot: projectPath,
  });
}

export const autoModeHandlers: Record<string, Handler> = {
  'autoMode.toggle': toggle,
  'autoMode.markReviewed': markReviewed,
};
