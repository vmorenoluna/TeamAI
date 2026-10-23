/**
 * WebSocket relay for the API server: turns engine events (re-emitted on
 * appEvents by the engine host) into the JSON messages browsers receive, and
 * forwards terminal messages from browsers to the engine over IPC. Imports only
 * the IPC client and message builders, never an engine-owned module.
 */
import type { EventEmitter } from 'events';
import { buildActionResultMessage, type ActionResultEvent } from '../lib/action-result-message';
import { error as logError } from '../lib/logger';
import { engineCall, engineNotify } from './engine-client';

const WS_OPEN = 1;

/** The slice of a ws client the relay needs. */
export interface RelayClient {
  readyState: number;
  projectRoot?: string;
  send(data: string): void;
}

interface ProjectScoped {
  projectRoot?: string;
}

/** Only send to clients that match the event's project, or have no project set (backwards compat). */
export function broadcastToProject(clients: Iterable<RelayClient>, event: ProjectScoped, msg: string): void {
  const eventProject = typeof event.projectRoot === 'string' ? event.projectRoot : undefined;
  for (const client of clients) {
    if (client.readyState !== WS_OPEN) continue;
    if (!client.projectRoot || !eventProject || client.projectRoot === eventProject) {
      client.send(msg);
    }
  }
}

interface AgentPayload extends ProjectScoped {
  sessionId: string;
  taskId?: string;
  event: Record<string, unknown>;
}

/**
 * Subscribes ONLY to appEvents. Returns a function that removes every listener.
 * `getClients` is called per event so it always sees the current client set.
 */
export function attachWsRelay(appEvents: EventEmitter, getClients: () => Iterable<RelayClient>): () => void {
  const broadcast = (data: ProjectScoped, msg: string) => broadcastToProject(getClients(), data, msg);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subscriptions: Array<[string, (...args: any[]) => void]> = [];
  const on = <T>(name: string, handler: (data: T) => void) => {
    appEvents.on(name, handler);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    subscriptions.push([name, handler as (...args: any[]) => void]);
  };

  // Agent event streaming — filtered to the client's project
  const agent = ({ sessionId, taskId, projectRoot, event }: AgentPayload) =>
    broadcast({ projectRoot }, JSON.stringify({ sessionId, taskId, event }));
  on('agent-event', agent);
  on('agent-error', agent);

  // PTY terminal data streaming — every client, no project filter
  on('terminal-data', ({ sessionId, data }: { sessionId: string; data: string }) => {
    const msg = JSON.stringify({ type: 'terminal', sessionId, data });
    for (const client of getClients()) {
      if (client.readyState === WS_OPEN) client.send(msg);
    }
  });

  on('phase-change', (data: { taskId: string; phase: string; projectRoot?: string; prUrl?: string; platform?: string }) =>
    broadcast(data, JSON.stringify({ type: 'phase-change', taskId: data.taskId, phase: data.phase, prUrl: data.prUrl, platform: data.platform })));

  // Outcome of a server action that returned before its work finished
  on('action-result', (data: ActionResultEvent) => broadcast(data, buildActionResultMessage(data)));

  on('refinement-update', (data: { taskId: string; projectRoot?: string }) =>
    broadcast(data, JSON.stringify({ type: 'refinement-update', taskId: data.taskId })));

  // Generic task mutations: carries only the taskId, consumers re-fetch
  on('task-updated', (data: { taskId: string; projectRoot?: string }) =>
    broadcast(data, JSON.stringify({ type: 'task-updated', taskId: data.taskId })));

  on('subtask-progress', (data: { taskId: string; completed: number; total: number; projectRoot?: string }) =>
    broadcast(data, JSON.stringify({ type: 'subtask-progress', taskId: data.taskId, completed: data.completed, total: data.total })));

  on('container-state', (data: { projectRoot: string; state: string }) =>
    broadcast(data, JSON.stringify({ type: 'container-state', projectRoot: data.projectRoot, state: data.state })));

  on('container-log', (data: { projectRoot: string; message: string }) =>
    broadcast(data, JSON.stringify({ type: 'container-log', projectRoot: data.projectRoot, message: data.message })));

  on('container-validation', (data: { projectRoot: string; step: unknown }) =>
    broadcast(data, JSON.stringify({ type: 'container-validation', projectRoot: data.projectRoot, step: data.step })));

  on('container-docker-missing', (data: { projectRoot: string }) =>
    broadcast(data, JSON.stringify({ type: 'container-docker-missing', projectRoot: data.projectRoot })));

  on('container-validation-failed', (data: { projectRoot: string; message: string }) =>
    broadcast(data, JSON.stringify({ type: 'container-validation-failed', projectRoot: data.projectRoot, message: data.message })));

  return () => {
    for (const [name, handler] of subscriptions) appEvents.off(name, handler);
    subscriptions.length = 0;
  };
}

export const TERMINAL_ATTACH_TIMEOUT_MS = 5000;

/**
 * Handles one raw client message: terminal input and resize go to the engine
 * as notifications; attach replays buffered output to `ws` when there is any.
 */
export async function handleClientMessage(ws: RelayClient, raw: string): Promise<void> {
  try {
    const parsed = JSON.parse(raw);
    if (parsed.type === 'terminal-attach') {
      const output = await engineCall<unknown>('terminals.getOutput', [{ sessionId: parsed.sessionId }], { timeoutMs: TERMINAL_ATTACH_TIMEOUT_MS });
      if (typeof output === 'string' && output.length > 0 && ws.readyState === WS_OPEN) {
        ws.send(JSON.stringify({ type: 'terminal', sessionId: parsed.sessionId, data: output }));
      }
    } else if (parsed.type === 'terminal-input') {
      engineNotify('terminals.write', [{ sessionId: parsed.sessionId, data: parsed.data }]);
    } else if (parsed.type === 'terminal-resize') {
      engineNotify('terminals.resize', [{ sessionId: parsed.sessionId, cols: parsed.cols, rows: parsed.rows }]);
    }
  } catch (err) {
    logError('ws', 'Failed to handle client message', err);
  }
}
