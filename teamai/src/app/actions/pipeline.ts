'use server';

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { resolveRoundsCap } from '@/lib/orchestrator/progress-budget';

export interface PipelineConfig {
  /** Consecutive no-progress QA rounds tolerated before failing (resets on progress). */
  maxQaAttempts: number;
  /** Never-resetting hard cap on QA rounds; always >= maxQaAttempts. */
  maxQaRounds: number;
  parallelSubtasks: boolean;
  autoModeMaxParallel: number;
  idleStallMinutes: number;
  toolStallMinutes: number;
  /** Single cap governing every retry-and-give-up circuit breaker inside
   *  the implement phase: a subtask's declared deliverable still missing
   *  after its session ends, a wakeup-pending subtask's background job
   *  never producing its artifact, or a full implement pass ending with
   *  any subtask still incomplete. All bypass QA entirely and fail the
   *  task once exceeded, rather than pushing to an expensive QA review
   *  that would only confirm what plan.json already shows. */
  maxImplementRetries: number;
  /** Write Task/Task-ID/QA/Phases trailers into merge commits + PR bodies. */
  recordHistoryInGit: boolean;
  /** Include the `Phases:` trailer line (subordinate to recordHistoryInGit). */
  includePhasesTrailer: boolean;
}

const DEFAULT_CONFIG: PipelineConfig = {
  maxQaAttempts: 3,
  maxQaRounds: 9,
  parallelSubtasks: true,
  autoModeMaxParallel: 1,
  idleStallMinutes: 15,
  toolStallMinutes: 30,
  maxImplementRetries: 3,
  recordHistoryInGit: true,
  includePhasesTrailer: true,
};

export async function getPipelineConfig(): Promise<PipelineConfig> {
  const projectPath = await getActiveProjectPath();
  const cfgPath = join(projectPath, '.teamai', 'pipeline.json');
  if (!existsSync(cfgPath)) return DEFAULT_CONFIG;
  try {
    const raw = JSON.parse(readFileSync(cfgPath, 'utf-8'));
    const merged = { ...DEFAULT_CONFIG, ...raw };
    // Derive explicitly: a file with maxQaAttempts but no maxQaRounds must not
    // inherit the default 9 (it would be wrong for any maxQaAttempts != 3).
    const { value: maxQaRounds } = resolveRoundsCap(raw.maxQaRounds, merged.maxQaAttempts);
    return { ...merged, maxQaRounds };
  } catch {
    return DEFAULT_CONFIG;
  }
}

export async function savePipelineConfig(config: PipelineConfig): Promise<void> {
  const { maxQaAttempts, maxQaRounds } = config;
  if (!Number.isInteger(maxQaRounds) || maxQaRounds < maxQaAttempts) {
    throw new Error(`Max QA rounds (${maxQaRounds}) must be at least Max QA attempts (${maxQaAttempts})`);
  }
  const projectPath = await getActiveProjectPath();
  const cfgPath = join(projectPath, '.teamai', 'pipeline.json');
  // Merge with existing config to preserve orchestrator-only fields
  // (sensors, maxStallRecoveries, autoMergeMethod) that the UI doesn't know about.
  const existing = existsSync(cfgPath)
    ? JSON.parse(readFileSync(cfgPath, 'utf-8'))
    : {};
  writeFileSync(cfgPath, JSON.stringify({ ...existing, ...config }, null, 2));
  revalidatePath('/settings');
}
