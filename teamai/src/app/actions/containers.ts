'use server';

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { engineCall } from '@/engine/engine-client';
import type { ContainerState, ValidationStep, ValidationStatus } from '@/lib/container-manager';

export interface ContainerConfig {
  enabled: boolean;
}

export interface ContainerConfigResult extends ContainerConfig {
  dockerAvailable: boolean;
  /** Whether a devcontainer.json was auto-generated during this save */
  generated?: boolean;
  /** Detected project type (e.g. "node", "python") */
  projectType?: string;
}

export async function getContainerConfig(): Promise<ContainerConfigResult> {
  const projectPath = await getActiveProjectPath();
  const cfgPath = join(projectPath, '.teamai', 'container.json');
  // Renders the settings page: an unreachable engine reads as "Docker unavailable", not an error.
  const available = await engineCall<boolean>('containers.isDockerAvailable', [{}], { timeoutMs: 5000 }).catch(() => false);
  if (existsSync(cfgPath)) {
    try { return { ...JSON.parse(readFileSync(cfgPath, 'utf-8')), dockerAvailable: available }; } catch { /* fall through */ }
  }
  return { enabled: available, dockerAvailable: available };
}

export async function saveContainerConfig(config: ContainerConfig): Promise<ContainerConfigResult> {
  const projectPath = await getActiveProjectPath();
  const dir = join(projectPath, '.teamai');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'container.json'), JSON.stringify(config, null, 2));
  revalidatePath('/settings');
  // Bootstrap (generate + start + validate) runs in the engine process.
  return engineCall<ContainerConfigResult>('containers.saveContainerConfig', [{ projectPath, enabled: config.enabled }]);
}

/** Re-run container validation on demand (clears a "container invalid" block once fixed). */
export async function revalidateContainer(operationId?: string): Promise<{ operationId: string }> {
  const projectPath = await getActiveProjectPath();
  return engineCall<{ operationId: string }>('containers.revalidateContainer', [{ projectPath, operationId }]);
}

/** The last persisted validation result for the active project. */
export async function getValidationStatus(): Promise<ValidationStatus> {
  const projectPath = await getActiveProjectPath();
  return engineCall<ValidationStatus>('containers.getValidationStatus', [{ projectPath }]);
}

export async function getContainerState(): Promise<ContainerState> {
  const projectPath = await getActiveProjectPath();
  return engineCall<ContainerState>('containers.getContainerState', [{ projectPath }]);
}

export async function getValidationSteps(): Promise<ValidationStep[]> {
  const projectPath = await getActiveProjectPath();
  return engineCall<ValidationStep[]>('containers.getValidationSteps', [{ projectPath }]);
}

export async function isDockerAvailable(): Promise<boolean> {
  return engineCall<boolean>('containers.isDockerAvailable', [{}]);
}

/** Reset the dockerAvailable cache so the next check probes Docker fresh.
 *  Called from the UI when the user starts Docker after seeing the
 *  container-docker-missing dialog. */
export async function resetDockerAvailability(): Promise<void> {
  await engineCall<void>('containers.resetDockerAvailability', [{}]);
}
