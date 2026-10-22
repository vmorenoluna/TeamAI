export interface ActionResultEvent {
  operationId: string;
  action: string;
  taskId: string;
  projectRoot?: string;
  ok: boolean;
  error?: string;
}

/**
 * Serialises an `action-result` event for the WebSocket. `projectRoot` is used
 * only by `broadcastToProject` for filtering and is deliberately not sent.
 */
export function buildActionResultMessage(data: ActionResultEvent): string {
  return JSON.stringify({
    type: 'action-result',
    operationId: data.operationId,
    action: data.action,
    taskId: data.taskId,
    ok: data.ok,
    error: data.error,
  });
}
