/**
 * Engine-side terminal handlers, moved from `src/app/actions/terminals.ts` plus the
 * WebSocket-facing write/resize/output calls. The API resolves the model (provider
 * config) and passes it in.
 */
import { processManager } from '@/lib/process-manager';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (params: any) => Promise<unknown>;

async function create(params: { projectPath: string; role: string; model: string }): Promise<string> {
  const { projectPath, role, model } = params;
  return processManager.createTerminalSession({ projectPath, role, model });
}

async function close(params: { sessionId: string }): Promise<void> {
  processManager.killTerminalSession(params.sessionId);
}

async function list(params: { projectPath: string }): Promise<{ sessionId: string; role: string; model: string }[]> {
  return processManager.getTerminalSessions()
    .filter(s => s.projectPath === params.projectPath)
    .map(s => ({
      sessionId: s.id,
      role: s.role,
      model: s.model ?? 'unknown',
    }));
}

async function write(params: { sessionId: string; data: string }): Promise<void> {
  processManager.writeToTerminal(params.sessionId, params.data);
}

async function resize(params: { sessionId: string; cols: number; rows: number }): Promise<void> {
  processManager.resizeTerminal(params.sessionId, params.cols, params.rows);
}

async function getOutput(params: { sessionId: string }): Promise<string> {
  return processManager.getTerminalOutput(params.sessionId);
}

export const terminalsHandlers: Record<string, Handler> = {
  'terminals.create': create,
  'terminals.close': close,
  'terminals.list': list,
  'terminals.write': write,
  'terminals.resize': resize,
  'terminals.getOutput': getOutput,
};
