'use server';

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';

export interface PipelineConfig {
  maxQaAttempts: number;
  parallelSubtasks: boolean;
  autoModeMaxParallel: number;
  idleStallMinutes: number;
  toolStallMinutes: number;
  /** Write Task/Task-ID/QA/Phases trailers into merge commits + PR bodies. */
  recordHistoryInGit: boolean;
  /** Include the `Phases:` trailer line (subordinate to recordHistoryInGit). */
  includePhasesTrailer: boolean;
}

const DEFAULT_CONFIG: PipelineConfig = {
  maxQaAttempts: 3,
  parallelSubtasks: true,
  autoModeMaxParallel: 1,
  idleStallMinutes: 15,
  toolStallMinutes: 30,
  recordHistoryInGit: true,
  includePhasesTrailer: true,
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
  // Merge with existing config to preserve orchestrator-only fields
  // (maxDeliverableFails, maxWakeupAttempts, sensors) that the UI doesn't know about.
  const existing = existsSync(cfgPath)
    ? JSON.parse(readFileSync(cfgPath, 'utf-8'))
    : {};
  writeFileSync(cfgPath, JSON.stringify({ ...existing, ...config }, null, 2));
  revalidatePath('/settings');
}
