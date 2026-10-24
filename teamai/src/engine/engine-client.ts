/**
 * API-side handle on the engine process. Reads the host that server.ts parks on
 * globalThis. Imports ONLY the protocol and types: pulling the orchestrator,
 * process manager or handlers in here would load the engine into the API process.
 */
import { EngineUnavailableError } from './protocol';

export interface EngineCallOptions {
  timeoutMs?: number;
}

export interface EngineClientHost {
  call(method: string, args?: unknown[], opts?: EngineCallOptions): Promise<unknown>;
  notify(method: string, args?: unknown[]): void;
}

declare global {
  var __teamaiEngine: EngineClientHost | undefined;
}

function getHost(): EngineClientHost {
  const host = globalThis.__teamaiEngine;
  if (!host) throw new EngineUnavailableError('Pipeline engine is not running');
  return host;
}

export async function engineCall<T>(method: string, args: unknown[] = [], opts?: EngineCallOptions): Promise<T> {
  return (await getHost().call(method, args, opts)) as T;
}

export function engineNotify(method: string, args: unknown[] = []): void {
  getHost().notify(method, args);
}
