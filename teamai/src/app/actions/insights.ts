'use server';

import { engineCall } from '@/engine/engine-client';
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
    const session = await engineCall<{ status: string } | null>('sessions.get', [{ sessionId: existing }]);
    if (session && session.status === 'running') return existing;
  }
  const sessionId = await engineCall<string>('sessions.create', [{
    projectPath,
    taskId: `insights::${projectPath}`,
    role: 'general',
    cwd: projectPath,
  }]);
  sessions.set(projectPath, sessionId);
  return sessionId;
}

export async function sendInsightsMessage(sessionId: string, message: string): Promise<void> {
  await engineCall('sessions.send', [{ sessionId, message }]);
}

/** Cancel a running insights chat session. */
export async function cancelInsightsSession(): Promise<void> {
  const projectPath = await getActiveProjectPath();
  const sessionId = sessions.get(projectPath);
  if (sessionId) {
    await engineCall('sessions.kill', [{ sessionId }]);
    sessions.delete(projectPath);
  }
}
