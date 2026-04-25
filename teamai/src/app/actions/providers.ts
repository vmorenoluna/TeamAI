'use server';

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';

export interface ProvidersConfig {
  default: { model: string; provider: string };
  roles: Record<string, { model?: string; provider?: string }>;
}

const DEFAULT: ProvidersConfig = {
  default: { model: 'claude-sonnet-4-6', provider: 'anthropic' },
  roles: {},
};

export async function getProvidersConfig(): Promise<ProvidersConfig> {
  const projectPath = await getActiveProjectPath();
  const cfgPath = join(projectPath, '.teamai', 'providers.json');
  if (!existsSync(cfgPath)) return DEFAULT;
  try {
    return { ...DEFAULT, ...JSON.parse(readFileSync(cfgPath, 'utf-8')) };
  } catch {
    return DEFAULT;
  }
}

export async function saveProvidersConfig(config: ProvidersConfig): Promise<void> {
  const projectPath = await getActiveProjectPath();
  const cfgPath = join(projectPath, '.teamai', 'providers.json');
  writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  revalidatePath('/settings');
}
