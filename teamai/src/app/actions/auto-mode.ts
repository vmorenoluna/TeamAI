'use server';

import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { getPipelineConfig } from './pipeline';
import { getAutoModeState, setAutoModeState } from '@/lib/auto-mode';
import { TaskStore } from '@/lib/task-store';

export async function getAutoModeStateAction(): Promise<{
  enabled: boolean;
  maxParallel: number;
  activeCount: number;
  trackedCount: number;
}> {
  const projectPath = await getActiveProjectPath();
  return getAutoModeState(projectPath);
}

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
  taskStore.update(taskId, { autoReviewed: true });
  revalidatePath('/');
  revalidatePath(`/task/${taskId}`);
}
