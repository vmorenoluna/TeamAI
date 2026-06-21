'use server';

import { processManager } from '@/lib/process-manager';
import { getActiveProjectPath } from './projects';
import { getProvidersConfig } from './providers';
import { readdirSync, existsSync } from 'fs';
import { join } from 'path';

declare global {
   
  var __ideationSessions: Map<string, string> | undefined;
}
const sessions: Map<string, string> =
  global.__ideationSessions ?? (global.__ideationSessions = new Map());

export async function startIdeationScan(): Promise<string> {
  const projectPath = await getActiveProjectPath();
  const providersConfig = await getProvidersConfig();
  const explorationModel = providersConfig.exploration?.model || undefined;
  const sessionId = await processManager.createSession({
    taskId: `ideation::${projectPath}`,
    role: 'general',
    cwd: projectPath,
    model: explorationModel,
  });
  sessions.set(projectPath, sessionId);
  processManager.sendMessage(sessionId, '/ideation');
  return sessionId;
}

export async function getIdeationReports(): Promise<{ filename: string; date: string }[]> {
  const projectPath = await getActiveProjectPath();
  const dir = join(projectPath, '.teamai', 'ideation');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => ({ filename: f, date: f.replace('ideation-', '').replace('.json', '') }))
    .sort((a, b) => b.date.localeCompare(a.date));
}

/** Cancel a running ideation scan. */
export async function cancelIdeationScan(): Promise<void> {
  const projectPath = await getActiveProjectPath();
  const sessionId = sessions.get(projectPath);
  if (sessionId) {
    processManager.killSession(sessionId);
    sessions.delete(projectPath);
  }
}
