/**
 * IPC protocol between the API server and the engine child process.
 * Every message and payload is JSON-serializable. Leaf module: the client
 * imports it, so it must not import the orchestrator or process manager.
 */

/** Error name the engine returns when a requested method does not exist. */
export const ENGINE_METHOD_NOT_FOUND = 'EngineMethodNotFound';

export interface SerializedError {
  name: string;
  message: string;
  code?: string;
}

// API -> engine
export interface CallMessage {
  type: 'call';
  id: number;
  method: string;
  args: unknown[];
}
export interface NotifyMessage {
  type: 'notify';
  method: string;
  args: unknown[];
}
export interface ShutdownMessage {
  type: 'shutdown';
}
export type ApiToEngineMessage = CallMessage | NotifyMessage | ShutdownMessage;

// engine -> API
export interface ReadyMessage {
  type: 'ready';
}
export interface ResultOkMessage {
  type: 'result';
  id: number;
  ok: true;
  value: unknown;
}
export interface ResultErrorMessage {
  type: 'result';
  id: number;
  ok: false;
  error: SerializedError;
}
export type ResultMessage = ResultOkMessage | ResultErrorMessage;
export interface EventMessage {
  type: 'event';
  name: string;
  args: unknown[];
}
export type EngineToApiMessage = ReadyMessage | ResultMessage | EventMessage;

/** An error thrown in the engine, rehydrated in the API process. */
export class EngineRemoteError extends Error {
  code?: string;
  constructor(serialized: SerializedError) {
    super(serialized.message);
    this.name = serialized.name;
    if (serialized.code !== undefined) this.code = serialized.code;
  }
}

/** The engine process is not running or went away mid-call. */
export class EngineUnavailableError extends Error {
  constructor(message = 'Engine process is unavailable') {
    super(message);
    this.name = 'EngineUnavailableError';
  }
}

/** A call to the engine did not answer in time. */
export class EngineTimeoutError extends Error {
  constructor(message = 'Engine call timed out') {
    super(message);
    this.name = 'EngineTimeoutError';
  }
}

export function serializeError(err: unknown): SerializedError {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const out: SerializedError = { name: err.name, message: err.message };
    if (typeof code === 'string') out.code = code;
    return out;
  }
  return { name: 'Error', message: String(err) };
}

export function deserializeError(serialized: SerializedError): EngineRemoteError {
  return new EngineRemoteError(serialized);
}
