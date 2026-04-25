'use server';

import { processManager } from '@/lib/process-manager';
import { getActiveProjectPath } from './projects';

export async function createTerminalSession(role: string, model?: string): Promise<string> {
  const projectPath = await getActiveProjectPath();
  return processManager.createTerminalSession({ projectPath, role, model });
}

export async function closeTerminalSession(sessionId: string): Promise<void> {
  processManager.killTerminalSession(sessionId);
}

export async function getActiveTerminals(): Promise<{ id: string; role: string }[]> {
  return processManager.getTerminalSessions().map(s => ({ id: s.id, role: s.role }));
}
