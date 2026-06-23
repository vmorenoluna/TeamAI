'use server';

import { processManager } from '@/lib/process-manager';
import { getActiveProjectPath } from './projects';

// Global sessions: projectPath → sessionId (shared across module contexts)
declare global {
   
  var __insightsSessions: Map<string, string> | undefined;
}
const sessions: Map<string, string> =
  global.__insightsSessions ?? (global.__insightsSessions = new Map());

export async function getOrCreateInsightsSession(): Promise<string> {
  const projectPath = await getActiveProjectPath();
  const existing = sessions.get(projectPath);
  if (existing) {
    const session = processManager.getSession(existing);
    if (session && session.status === 'running') return existing;
  }
  const sessionId = await processManager.createSession({
    taskId: `insights::${projectPath}`,
    role: 'general',
    cwd: projectPath,
    projectRoot: projectPath,
    permissionMode: 'bypassPermissions',
  });
  sessions.set(projectPath, sessionId);
  return sessionId;
}

export async function sendInsightsMessage(sessionId: string, message: string): Promise<void> {
  processManager.sendMessage(sessionId, message);
}

/** Cancel a running insights chat session. */
export async function cancelInsightsSession(): Promise<void> {
  const projectPath = await getActiveProjectPath();
  const sessionId = sessions.get(projectPath);
  if (sessionId) {
    processManager.killSession(sessionId);
    sessions.delete(projectPath);
  }
}
