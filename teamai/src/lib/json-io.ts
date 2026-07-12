/**
 * Resilient JSON file I/O helpers.
 *
 * Wraps `readFileSync` + `JSON.parse` with structured error handling for
 * agent-produced artifacts (qa_report.json, plan.json, etc.) where the
 * file may be missing, empty, or contain invalid JSON.
 */
import { readFileSync, existsSync } from 'fs';

export interface ReadJsonOptions<T> {
  /** If true, throws when the file is missing. Default: false (returns null). */
  required?: boolean;
  /** Optional validation function. Return an error string on failure, or null on success. */
  validate?: (data: T) => string | null;
}

export interface ReadJsonError {
  code: 'MISSING' | 'INVALID_JSON' | 'VALIDATION_FAILED';
  message: string;
}

export interface ReadJsonResult<T> {
  data: T | null;
  error: ReadJsonError | null;
}

/**
 * Read and parse a JSON file with optional validation.
 *
 * Returns `{ data, error }` — never throws. Callers can check `error` to
 * distinguish between "file doesn't exist", "invalid JSON", and "doesn't
 * pass validation", then surface a structured message instead of crashing
 * with a raw ENOENT/SyntaxError stack.
 *
 * @param path - Absolute path to the JSON file.
 * @param opts.required - If true, missing file is an error (code: 'MISSING').
 *   Default: false (returns null data with no error).
 * @param opts.validate - Optional validator: return a string describing the
 *   problem, or null if the data is valid.
 */
export function readJsonFile<T>(path: string, opts?: ReadJsonOptions<T>): ReadJsonResult<T> {
  if (!existsSync(path)) {
    if (opts?.required) {
      return {
        data: null,
        error: { code: 'MISSING', message: `Required file not found: ${path}` },
      };
    }
    return { data: null, error: null };
  }

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      data: null,
      error: { code: 'MISSING', message: `Cannot read file ${path}: ${msg}` },
    };
  }

  if (raw.trim().length === 0) {
    if (opts?.required) {
      return {
        data: null,
        error: { code: 'INVALID_JSON', message: `File is empty: ${path}` },
      };
    }
    return { data: null, error: null };
  }

  let parsed: T;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      data: null,
      error: { code: 'INVALID_JSON', message: `Invalid JSON in ${path}: ${msg}` },
    };
  }

  if (opts?.validate) {
    const validationError = opts.validate(parsed);
    if (validationError) {
      return {
        data: null,
        error: { code: 'VALIDATION_FAILED', message: `Validation failed for ${path}: ${validationError}` },
      };
    }
  }

  return { data: parsed, error: null };
}
