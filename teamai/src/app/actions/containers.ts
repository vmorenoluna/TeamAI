'use server';

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { containerManager, type ContainerState } from '@/lib/container-manager';

export interface ContainerConfig {
  enabled: boolean;
}

const DEFAULT: ContainerConfig = { enabled: false };

export async function getContainerConfig(): Promise<ContainerConfig> {
  const projectPath = await getActiveProjectPath();
  const cfgPath = join(projectPath, '.teamai', 'container.json');
  if (!existsSync(cfgPath)) return DEFAULT;
  try { return { ...DEFAULT, ...JSON.parse(readFileSync(cfgPath, 'utf-8')) }; } catch { return DEFAULT; }
}

export async function saveContainerConfig(config: ContainerConfig): Promise<void> {
  const projectPath = await getActiveProjectPath();
  const dir = join(projectPath, '.teamai');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'container.json'), JSON.stringify(config, null, 2));
  revalidatePath('/settings');
}

export async function getContainerState(): Promise<ContainerState> {
  const projectPath = await getActiveProjectPath();
  return containerManager.getState(projectPath);
}
