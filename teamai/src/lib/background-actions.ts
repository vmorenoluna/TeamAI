import { randomUUID } from 'crypto';
import { processManager } from '@/lib/process-manager';
import { error as logError } from '@/lib/logger';

export type BackgroundActionName =
  | 'approve'
  | 'mark-done'
  | 'stop'
  | 'delete-worktree'
  | 'move'
  | 'retry'
  | 'resume'
  | 'play'
  | 'restart-phase'
  | 'run'
  | 'analyze-failure'
  | 'container-bootstrap'
  | 'container-revalidate';

export interface RunInBackgroundOptions {
  operationId?: string;
  action: BackgroundActionName;
  taskId?: string;
  projectRoot: string;
  notify: 'always' | 'failure-only';
}

export interface BackgroundResult {
  status: 'pending' | 'ok' | 'failed' | 'unknown';
  error?: string;
}

interface RegistryEntry {
  action: BackgroundActionName;
  taskId?: string;
  status: 'pending' | 'ok' | 'failed';
  error?: string;
  settledAt?: number;
}

/** Settled entries are kept this long so a client that missed the WebSocket event can still ask. */
const SETTLED_TTL_MS = 15 * 60 * 1000;
const MAX_SETTLED_ENTRIES = 500;

// Insertion-ordered; settled entries are re-inserted on settling so iteration order is oldest-settled first.
const registry = new Map<string, RegistryEntry>();

/** Lazy eviction (no timers): drops expired settled entries, then the oldest beyond the cap. Pending is never evicted. */
function evictSettled(): void {
  const now = Date.now();
  let settledCount = 0;
  for (const [id, entry] of registry) {
    if (entry.status === 'pending') continue;
    if (now - (entry.settledAt ?? now) >= SETTLED_TTL_MS) {
      registry.delete(id);
    } else {
      settledCount++;
    }
  }
  if (settledCount <= MAX_SETTLED_ENTRIES) return;
  for (const [id, entry] of registry) {
    if (settledCount <= MAX_SETTLED_ENTRIES) break;
    if (entry.status === 'pending') continue;
    registry.delete(id);
    settledCount--;
  }
}

function errorMessage(reason: unknown, action: BackgroundActionName): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  return message || `${action} failed`;
}

/**
 * Starts `work` without awaiting it and returns the operation id synchronously.
 * Never throws; failures are logged, recorded in the registry and emitted as
 * `action-result` events (picked up by server.ts and broadcast over the WebSocket).
 * Never calls revalidatePath: the work runs after the request has ended.
 */
export function runInBackground(
  opts: RunInBackgroundOptions,
  work: () => Promise<unknown>,
): string {
  const { action, taskId, projectRoot, notify } = opts;
  const operationId = opts.operationId ?? randomUUID();

  evictSettled();
  registry.set(operationId, { action, taskId, status: 'pending' });

  const settle = (status: 'ok' | 'failed', error?: string): void => {
    registry.delete(operationId);
    registry.set(operationId, { action, taskId, status, error, settledAt: Date.now() });
    evictSettled();
  };

  const onRejected = (reason: unknown): void => {
    const error = errorMessage(reason, action);
    settle('failed', error);
    logError('background-action', `${action} failed (task ${taskId ?? 'n/a'}, operation ${operationId})`, reason);
    processManager.emit('action-result', { operationId, action, taskId, projectRoot, ok: false, error });
  };

  const onResolved = (): void => {
    settle('ok');
    if (notify === 'always') {
      processManager.emit('action-result', { operationId, action, taskId, projectRoot, ok: true });
    }
  };

  let promise: Promise<unknown>;
  try {
    promise = Promise.resolve(work());
  } catch (err) {
    promise = Promise.reject(err);
  }
  promise.then(onResolved, onRejected).catch(err => logError('background-action', `${action} result handling failed`, err));

  return operationId;
}

export function getBackgroundResult(operationId: string): BackgroundResult {
  evictSettled();
  const entry = registry.get(operationId);
  if (!entry) return { status: 'unknown' };
  return entry.error !== undefined ? { status: entry.status, error: entry.error } : { status: entry.status };
}

export function isBackgroundPending(action: BackgroundActionName, taskId: string): boolean {
  for (const entry of registry.values()) {
    if (entry.status === 'pending' && entry.action === action && entry.taskId === taskId) return true;
  }
  return false;
}
