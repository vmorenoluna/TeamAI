'use server';

import { engineCall } from '@/engine/engine-client';
import { getActiveProjectPath } from './projects';
import { getProvidersConfig } from './providers';
import { renderCommand } from '@/lib/command-templates';
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
  // Default to Sonnet (not the CLI default) so a mechanical scan never
  // silently runs an expensive model.
  const explorationModel = providersConfig.exploration?.model || providersConfig.default.model;
  // Render before createSession so a template failure spawns nothing.
  const message = renderCommand('ideation', '');
  const sessionId = await engineCall<string>('sessions.create', [{
    projectPath,
    taskId: `ideation::${projectPath}`,
    role: 'general',
    cwd: projectPath,
    model: explorationModel,
  }]);
  sessions.set(projectPath, sessionId);
  await engineCall('sessions.send', [{ sessionId, message: message }]);
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
    await engineCall('sessions.kill', [{ sessionId }]);
    sessions.delete(projectPath);
  }
}
