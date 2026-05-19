/**
 * Structured logger for TeamAI.
 *
 * Adheres to the existing convention of `[module]` prefixed messages.
 * In production, `log` and `warn` are suppressed; only `error` is emitted.
 */

const isDev = process.env.NODE_ENV !== 'production';

function format(module: string, message: string): string {
  return `[${module}] ${message}`;
}

/** Informational log — suppressed in production */
export function log(module: string, message: string, ...details: unknown[]): void {
  if (!isDev) return;
  if (details.length > 0) {
    console.log(format(module, message), ...details);
  } else {
    console.log(format(module, message));
  }
}

/** Warning log — suppressed in production */
export function warn(module: string, message: string, ...details: unknown[]): void {
  if (!isDev) return;
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

const logger = { log, warn, error };
export default logger;
