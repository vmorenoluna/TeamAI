/**
 * Which process this code runs in. The API server (Next.js + WebSocket) sets
 * TEAMAI_PROCESS_ROLE=api; the engine child process runs the orchestrator, auto
 * mode and ProcessManager. Leaf module: imports nothing from the app.
 */
export type ProcessRole = 'api' | 'engine';

/** Read on every call — never cached. `undefined` in tests and scripts, where no role is set. */
export function getProcessRole(): ProcessRole | undefined {
  const role = process.env.TEAMAI_PROCESS_ROLE;
  if (role === 'api' || role === 'engine') return role;
  return undefined;
}

export class EngineBoundaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EngineBoundaryError';
  }
}

/** Throws when engine-only work is attempted from the API process. */
export function assertNotApiProcess(what: string): void {
  if (process.env.TEAMAI_PROCESS_ROLE === 'api') {
    throw new EngineBoundaryError(`${what} must run in the engine process, not the API process`);
  }
}
