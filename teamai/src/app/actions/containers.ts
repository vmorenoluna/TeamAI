'use server';

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { containerManager, dockerAvailable, type ContainerState, type ValidationStep } from '@/lib/container-manager';

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

  // When enabling containers and no devcontainer.json exists, bootstrap one asynchronously
  const devCfgPath = join(projectPath, '.devcontainer', 'devcontainer.json');
  if (config.enabled && !existsSync(devCfgPath)) {
    // Detect project type synchronously so the UI can show it immediately
    let projectType = 'unknown';
    try {
      const { analyzeProject } = await import('@/lib/devcontainer-generator');
      projectType = analyzeProject(projectPath).type;
    } catch { /* ignore */ }

    // Fire-and-forget: generate + start + validate in the background
    containerManager.bootstrapContainer(projectPath).catch(err => {
      console.error('[container] Bootstrap failed:', err);
    });

    return { enabled: config.enabled, dockerAvailable: dockerAvailable(), generated: true, projectType };
  }

  return { enabled: config.enabled, dockerAvailable: dockerAvailable() };
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
