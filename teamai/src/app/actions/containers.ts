'use server';

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { containerManager, dockerAvailable, _resetDockerAvailableCache, type ContainerState, type ValidationStep, type ValidationStatus } from '@/lib/container-manager';

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
  if (existsSync(cfgPath)) {
    try { return { ...JSON.parse(readFileSync(cfgPath, 'utf-8')), dockerAvailable: dockerAvailable() }; } catch { /* fall through */ }
  }
  return { enabled: dockerAvailable(), dockerAvailable: dockerAvailable() };
}

export async function saveContainerConfig(config: ContainerConfig): Promise<ContainerConfigResult> {
  const projectPath = await getActiveProjectPath();
  const dir = join(projectPath, '.teamai');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'container.json'), JSON.stringify(config, null, 2));
  revalidatePath('/settings');

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
    containerManager.bootstrapContainer(projectPath).catch(err => {
      console.error('[container] Bootstrap failed:', err);
    });

    return needsGeneration
      ? { enabled: config.enabled, dockerAvailable: dockerAvailable(), generated: true, projectType }
      : { enabled: config.enabled, dockerAvailable: dockerAvailable() };
  }

  return { enabled: config.enabled, dockerAvailable: dockerAvailable() };
}

/** Re-run container validation on demand (clears a "container invalid" block once fixed). */
export async function revalidateContainer(): Promise<void> {
  const projectPath = await getActiveProjectPath();
  // Fire-and-forget: progress streams over the container-validation channel.
  containerManager.revalidate(projectPath).catch(err => {
    console.error('[container] Re-validation failed:', err);
  });
}

/** The last persisted validation result for the active project. */
export async function getValidationStatus(): Promise<ValidationStatus> {
  const projectPath = await getActiveProjectPath();
  return containerManager.getValidationStatus(projectPath);
}

export async function getContainerState(): Promise<ContainerState> {
  const projectPath = await getActiveProjectPath();
  return containerManager.getState(projectPath);
}

export async function getValidationSteps(): Promise<ValidationStep[]> {
  const projectPath = await getActiveProjectPath();
  return containerManager.getValidationSteps(projectPath);
}

export async function isDockerAvailable(): Promise<boolean> {
  return dockerAvailable();
}

/** Reset the dockerAvailable cache so the next check probes Docker fresh.
 *  Called from the UI when the user starts Docker after seeing the
 *  container-docker-missing dialog. */
export async function resetDockerAvailability(): Promise<void> {
  _resetDockerAvailableCache();
}
