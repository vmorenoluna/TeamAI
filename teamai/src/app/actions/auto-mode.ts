'use server';

import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { getPipelineConfig } from './pipeline';
import { setAutoModeState } from '@/lib/auto-mode';
import { TaskStore } from '@/lib/task-store';
import { processManager } from '@/lib/process-manager';

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
    throw new Error(`Task ${taskId} not found`);
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
