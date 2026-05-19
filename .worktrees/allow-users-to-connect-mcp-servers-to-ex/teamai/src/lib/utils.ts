/**
 * Shared utilities used across the TeamAI codebase.
 */

/** Convert a string into a filesystem-safe slug (branch name, directory name, etc.) */
export function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
}
