/**
 * Shared utilities used across the TeamAI codebase.
 */

/** Convert a string into a filesystem-safe slug (branch name, directory name, etc.) */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
}

/** Truncate `text` to at most `max` chars, appending an ASCII "..." ellipsis when cut.
 *  Used to bound strings interpolated into CLI argv — Windows CreateProcess caps
 *  the command line at ~32KB, so unbounded user content must never be passed
 *  verbatim as a single argument. */
export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}
