/**
 * Engine-side agent-session handlers covering every processManager call made by the
 * ideation, roadmap, insights and github actions. The per-project session-id maps stay
 * in the action files.
 */
import { processManager, containerSessionOpts } from '@/lib/process-manager';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (params: any) => Promise<unknown>;

async function create(params: {
  projectPath: string;
  taskId: string;
  role: string;
  cwd: string;
  model?: string;
}): Promise<string> {
  const { projectPath, taskId, role, cwd, model } = params;
  return processManager.createSession({
    taskId,
    role,
    cwd,
    ...(model ? { model } : {}),
    ...containerSessionOpts(projectPath),
  } as Parameters<typeof processManager.createSession>[0]);
}

async function send(params: { sessionId: string; message: string }): Promise<void> {
  processManager.sendMessage(params.sessionId, params.message);
}

async function kill(params: { sessionId: string }): Promise<void> {
  processManager.killSession(params.sessionId);
}

async function get(params: { sessionId: string }): Promise<{ status: string } | null> {
  const session = processManager.getSession(params.sessionId);
  return session ? { status: session.status } : null;
}

export const sessionsHandlers: Record<string, Handler> = {
  'sessions.create': create,
  'sessions.send': send,
  'sessions.kill': kill,
  'sessions.get': get,
};
