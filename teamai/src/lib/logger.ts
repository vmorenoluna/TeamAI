/**
 * Structured logger for TeamAI.
 *
 * All messages follow the `[module] message` convention.
 * In production, `log`/`info` are suppressed; `warn` and `error` are emitted.
 *
 * Use `log` or `info` for informational messages, `warn` for warnings that
 * must be visible in production (crash-recovery, state-persistence failures),
 * and `error` for errors that are always emitted.
 */

const isDev = process.env.NODE_ENV !== 'production';

function format(module: string, message: string): string {
  return `[${module}] ${message}`;
}

/** Informational log — suppressed in production. Use `info` for the same behavior. */
export function log(module: string, message: string, ...details: unknown[]): void {
  if (!isDev) return;
  if (details.length > 0) {
    console.log(format(module, message), ...details);
  } else {
    console.log(format(module, message));
  }
}

/** Warning log — always emitted (unlike informational logs), so
 *  crash-recovery and state-persistence failures stay visible in production. */
export function warn(module: string, message: string, ...details: unknown[]): void {
  if (details.length > 0) {
    console.warn(format(module, message), ...details);
  } else {
    console.warn(format(module, message));
  }
}

/** Error log — always emitted */
export function error(module: string, message: string, err?: unknown): void {
  const detail =
    err instanceof Error
      ? `${err.message}${err.stack ? '\n' + err.stack : ''}`
      : err !== undefined
        ? String(err)
        : '';
  if (detail) {
    console.error(format(module, message), detail);
  } else {
    console.error(format(module, message));
  }
}

/** Alias for `log` — informational message, suppressed in production */
export const info = log;

const logger = { log, info, warn, error };
export default logger;
