'use server';

import { processManager } from '@/lib/process-manager';
import { getActiveProjectPath } from './projects';
import { getProvidersConfig } from './providers';
import { resolveTerminalModel } from '@/lib/providers';

export async function createTerminalSession(role: string): Promise<{ sessionId: string; role: string; model: string }> {
  const projectPath = await getActiveProjectPath();
  const config = await getProvidersConfig();
  const model = resolveTerminalModel(role, config);
  const sessionId = processManager.createTerminalSession({ projectPath, role, model });
  return { sessionId, role, model };
}

export async function closeTerminalSession(sessionId: string): Promise<void> {
  processManager.killTerminalSession(sessionId);
}

export async function getActiveTerminals(): Promise<{ sessionId: string; role: string; model: string }[]> {
  const projectPath = await getActiveProjectPath();
  return processManager.getTerminalSessions()
    .filter(s => s.projectPath === projectPath)
    .map(s => ({
      sessionId: s.id,
      role: s.role,
      model: s.model ?? 'unknown',
    }));
}
