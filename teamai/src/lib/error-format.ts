/**
 * Shared error formatting for Server Action rejections.
 *
 * Produces a uniform `Failed to <verb>: <message>` string with a
 * two-layer fallback:
 *
 *   1. **Type fallback** — non-`Error` rejections (string, number,
 *      null, undefined, plain object) → `'Unknown error'`. Prevents
 *      leaking raw object dumps or `null` into banner UI.
 *   2. **Empty-message fallback** — `Error` instance with `message === ''`
 *      → also `'Unknown error'`. Prevents the broken
 *      `'Failed to <verb>: '` (trailing colon-space, empty suffix)
 *      banner output from `new Error()` without a message.
 *
 * Used by every client component that wraps a `try { await action() }
 * catch (err) { setError(...) }` path so the user-visible banner
 * wording stays consistent across the UI.
 *
 * Note: this intentionally DEVIATES from a literal
 * `err instanceof Error ? err.message : 'Unknown error'` ternary in
 * order to handle the empty-message case described above. Callers
 * should still prefer passing `new Error('<descriptive message>')`;
 * the empty-message fallback is a defensive UX guard, not an excuse
 * to throw empty `Error`s.
 *
 * @param verb - Human description of the action that failed
 *               (e.g. `"save pipeline config"`, `"resume chat session"`).
 *               Rendered verbatim into `"Failed to <verb>: ..."`.
 * @param err  - The thrown/rejected value from the Server Action.
 *
 * @example
 *   try {
 *     await savePipelineConfig({ maxQaAttempts: 3, ... });
 *   } catch (err) {
 *     setError(formatActionError('save pipeline config', err));
 *   }
 */
export function formatActionError(verb: string, err: unknown): string {
  // Strengthened guard — also falls back on empty .message; see JSDoc above for rationale.
  return `Failed to ${verb}: ${err instanceof Error && err.message ? err.message : 'Unknown error'}`;
}
