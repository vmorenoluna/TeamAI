'use server';

import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { getPipelineConfig } from './pipeline';
import { setAutoModeState } from '@/lib/auto-mode';
import { TaskStore } from '@/lib/task-store';
import { processManager } from '@/lib/process-manager';
import { markAutoReviewed as markAutoReviewedRecord } from '@/lib/auto-review-store';

export async function toggleAutoMode(enabled: boolean): Promise<void> {
  const projectPath = await getActiveProjectPath();
  const config = await getPipelineConfig();
  setAutoModeState(projectPath, enabled, config.autoModeMaxParallel);
  revalidatePath('/');
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
