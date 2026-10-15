'use server';

import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { getPipelineConfig } from './pipeline';
import { setAutoModeState, retryAutoMerge as retryAutoMergeForTask } from '@/lib/auto-mode';
import { TaskStore } from '@/lib/task-store';
import { processManager } from '@/lib/process-manager';
import { markAutoReviewed as markAutoReviewedRecord } from '@/lib/auto-review-store';

export async function toggleAutoMode(enabled: boolean): Promise<void> {
  const projectPath = await getActiveProjectPath();
  const config = await getPipelineConfig();
  setAutoModeState(projectPath, enabled, config.autoModeMaxParallel);
  revalidatePath('/');
}

/** Restart auto-merge for a pr-open task whose poller gave up. */
export async function retryAutoMerge(taskId: string): Promise<{ success: boolean; error?: string }> {
  if (!taskId?.trim()) return { success: false, error: 'Invalid taskId' };
  try {
    retryAutoMergeForTask(await getActiveProjectPath(), taskId);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  revalidatePath('/');
  revalidatePath(`/task/${taskId}`);
  return { success: true };
}

export async function markAutoReviewed(taskId: string): Promise<void> {
  if (!taskId?.trim()) {
    throw new Error('Invalid taskId: must be a non-empty string');
  }

  const projectPath = await getActiveProjectPath();
  const taskStore = new TaskStore(projectPath);
  const task = taskStore.getById(taskId);
  if (!task) {
    // Completed tasks have had their workspace deleted. Their DONE card is
    // reconstructed from git history, so acknowledge it in the durable
    // project-level metadata instead of requiring task.json to exist.
    const record = markAutoReviewedRecord(projectPath, taskId);
    if (!record) {
      throw new Error(`Task ${taskId} not found`);
    }
    revalidatePath('/');
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

  revalidatePath('/');
  revalidatePath(`/task/${taskId}`);
}
