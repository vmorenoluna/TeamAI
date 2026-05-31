'use server';

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';

export interface PipelineConfig {
  maxQaAttempts: number;
  parallelSubtasks: boolean;
}

const DEFAULT_CONFIG: PipelineConfig = {
  maxQaAttempts: 3,
  parallelSubtasks: true,
};

export async function getPipelineConfig(): Promise<PipelineConfig> {
  const projectPath = await getActiveProjectPath();
  const cfgPath = join(projectPath, '.teamai', 'pipeline.json');
  if (!existsSync(cfgPath)) return DEFAULT_CONFIG;
  try {
    return { ...DEFAULT_CONFIG, ...JSON.parse(readFileSync(cfgPath, 'utf-8')) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function savePipelineConfig(config: PipelineConfig): Promise<void> {
  const projectPath = await getActiveProjectPath();
  const cfgPath = join(projectPath, '.teamai', 'pipeline.json');
  writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  revalidatePath('/settings');
}
