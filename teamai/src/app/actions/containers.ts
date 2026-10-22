'use server';

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { runInBackground } from '@/lib/background-actions';
import { containerManager, checkDockerAvailable, type ContainerState, type ValidationStep, type ValidationStatus } from '@/lib/container-manager';

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
  const available = await checkDockerAvailable();
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
  const available = await checkDockerAvailable();

  // Enabling containers always (re)validates the setup — generating a
  // devcontainer.json first only when none exists. An invalid setup blocks the
  // pipeline, so a hand-written devcontainer.json must be checked too.
  const devCfgPath = join(projectPath, '.devcontainer', 'devcontainer.json');
  if (config.enabled) {
    const needsGeneration = !existsSync(devCfgPath);
    // Detect project type synchronously so the UI can show it immediately
    let projectType = 'unknown';
    try {
      const { analyzeProject } = await import('@/lib/devcontainer-generator');
      projectType = analyzeProject(projectPath).type;
    } catch { /* ignore */ }

    // Fire-and-forget: (generate +) start + validate in the background
    runInBackground(
      { action: 'container-bootstrap', projectRoot: projectPath, notify: 'failure-only' },
      () => containerManager.bootstrapContainer(projectPath),
    );

    return needsGeneration
      ? { enabled: config.enabled, dockerAvailable: available, generated: true, projectType }
      : { enabled: config.enabled, dockerAvailable: available };
  }

  return { enabled: config.enabled, dockerAvailable: available };
}

/** Re-run container validation on demand (clears a "container invalid" block once fixed). */
export async function revalidateContainer(operationId?: string): Promise<{ operationId: string }> {
  const projectPath = await getActiveProjectPath();
  // Fire-and-forget: progress streams over the container-validation channel.
  const opId = runInBackground(
    { operationId, action: 'container-revalidate', projectRoot: projectPath, notify: 'failure-only' },
    () => containerManager.revalidate(projectPath),
  );
  return { operationId: opId };
}

/** The last persisted validation result for the active project. */
export async function getValidationStatus(): Promise<ValidationStatus> {
  const projectPath = await getActiveProjectPath();
  return containerManager.getValidationStatus(projectPath);
}

export async function getContainerState(): Promise<ContainerState> {
  const projectPath = await getActiveProjectPath();
  return await containerManager.getState(projectPath);
}

export async function getValidationSteps(): Promise<ValidationStep[]> {
  const projectPath = await getActiveProjectPath();
  return containerManager.getValidationSteps(projectPath);
}

export async function isDockerAvailable(): Promise<boolean> {
  return checkDockerAvailable();
}

/** Reset the dockerAvailable cache so the next check probes Docker fresh.
 *  Called from the UI when the user starts Docker after seeing the
 *  container-docker-missing dialog. */
export async function resetDockerAvailability(): Promise<void> {
  await checkDockerAvailable({ force: true });
}
