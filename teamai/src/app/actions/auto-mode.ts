'use server';

import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { getPipelineConfig } from './pipeline';
import { engineCall } from '@/engine/engine-client';

/**
 * @param expectedProjectPath The project the caller's button displays. When given,
 * the toggle is refused if the active project differs, so a stale UI can never
 * start or stop auto mode on a project other than the one it shows.
 */
export async function toggleAutoMode(enabled: boolean, expectedProjectPath?: string): Promise<void> {
  const projectPath = await getActiveProjectPath();
  if (expectedProjectPath !== undefined && expectedProjectPath !== projectPath) {
    throw new Error('Active project changed — refresh the page and try again');
  }
  const config = await getPipelineConfig();
  await engineCall<void>('autoMode.toggle', [{ projectPath, enabled, maxParallel: config.autoModeMaxParallel }]);
  revalidatePath('/');
}

export async function markAutoReviewed(taskId: string): Promise<void> {
  if (!taskId?.trim()) {
    throw new Error('Invalid taskId: must be a non-empty string');
  }

  const projectPath = await getActiveProjectPath();
  await engineCall<void>('autoMode.markReviewed', [{ projectPath, taskId }]);
  revalidatePath('/');
  revalidatePath(`/task/${taskId}`);
}
