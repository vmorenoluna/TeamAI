'use server';

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';

export interface McpServerEntry {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  type: 'stdio';
}

export interface McpConfig {
  mcpServers: Record<string, McpServerEntry>;
}

const DEFAULT: McpConfig = { mcpServers: {} };

export async function getMcpConfig(): Promise<McpConfig> {
  const projectPath = await getActiveProjectPath();
  const cfgPath = join(projectPath, '.mcp.json');
  try {
    return JSON.parse(readFileSync(cfgPath, 'utf-8'));
  } catch {
    return DEFAULT;
  }
}

export async function saveMcpConfig(config: McpConfig): Promise<void> {
  const projectPath = await getActiveProjectPath();
  const cfgPath = join(projectPath, '.mcp.json');
  writeFileSync(cfgPath, JSON.stringify(config, null, 2));
  revalidatePath('/settings');
}
