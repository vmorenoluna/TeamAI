/**
 * Process-wide event bus for app-level events, shared across module instances
 * (Next.js bundles server code more than once) via globalThis.
 */
import { EventEmitter } from 'events';

declare global {
  var __teamaiAppEvents: EventEmitter | undefined;
}

function createAppEvents(): EventEmitter {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(0);
  return emitter;
}

export const appEvents: EventEmitter =
  globalThis.__teamaiAppEvents ?? (globalThis.__teamaiAppEvents = createAppEvents());
