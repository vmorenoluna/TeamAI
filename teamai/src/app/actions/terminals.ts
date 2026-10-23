'use server';

import { engineCall } from '@/engine/engine-client';
import { getActiveProjectPath } from './projects';
import { getProvidersConfig } from './providers';
import { resolveTerminalModel } from '@/lib/providers';
import { error as logError } from '@/lib/logger';

const LIST_TIMEOUT_MS = 5000;

export async function createTerminalSession(role: string): Promise<{ sessionId: string; role: string; model: string }> {
  const projectPath = await getActiveProjectPath();
  const config = await getProvidersConfig();
  const model = resolveTerminalModel(role, config);
  const sessionId = await engineCall<string>('terminals.create', [{ projectPath, role, model }]);
  return { sessionId, role, model };
}

export async function closeTerminalSession(sessionId: string): Promise<void> {
  await engineCall<void>('terminals.close', [{ sessionId }]);
}

/** Runs in the root layout, so it must never hang or throw: any engine failure yields []. */
export async function getActiveTerminals(): Promise<{ sessionId: string; role: string; model: string }[]> {
  try {
    const projectPath = await getActiveProjectPath();
    return await engineCall<{ sessionId: string; role: string; model: string }[]>(
      'terminals.list',
      [{ projectPath }],
      { timeoutMs: LIST_TIMEOUT_MS },
    );
  } catch (err) {
    logError('terminals', 'Failed to list active terminals', err);
    return [];
  }
}
