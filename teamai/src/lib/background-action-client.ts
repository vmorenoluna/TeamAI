/**
 * Client-only registry of background operations this tab started.
 *
 * A server action that returns before its work finishes reports the outcome as an
 * `action-result` WebSocket message. The component that started the operation tracks
 * its id here and awaits the returned promise; the global banner passes every
 * message to `deliverActionResult`, which settles the tracked promise. Messages for
 * ids nobody tracked are "unclaimed" and the banner shows failures itself.
 */

export interface ActionResultMessage {
  operationId: string;
  action?: string;
  taskId?: string;
  ok: boolean;
  error?: string;
}

export interface TrackedResult {
  ok: boolean;
  error?: string;
}

const MAX_REMEMBERED_SETTLED = 200;

const pending = new Map<string, (result: TrackedResult) => void>();
// Ids already settled, so a duplicate delivery (socket + poll) still counts as claimed.
const settledIds = new Set<string>();

export function trackOperation(operationId: string): Promise<TrackedResult> {
  return new Promise<TrackedResult>(resolve => {
    pending.set(operationId, resolve);
  });
}

export function untrackOperation(operationId: string): void {
  pending.delete(operationId);
}

export function pendingOperationIds(): string[] {
  return Array.from(pending.keys());
}

/** Idempotent. Returns true iff the id is (or was) tracked by this tab. */
export function deliverActionResult(msg: ActionResultMessage): boolean {
  const resolve = pending.get(msg.operationId);
  if (!resolve) return settledIds.has(msg.operationId);
  pending.delete(msg.operationId);
  settledIds.add(msg.operationId);
  if (settledIds.size > MAX_REMEMBERED_SETTLED) {
    const oldest = settledIds.values().next().value;
    if (oldest !== undefined) settledIds.delete(oldest);
  }
  resolve(msg.ok ? { ok: true } : { ok: false, error: msg.error ?? 'Unknown error' });
  return true;
}
