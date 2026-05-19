/**
 * Given a list of phase-change events for a failed task, determine which
 * phase it should resume from. Returns the last real phase before 'failed'
 * (e.g., 'qa-review'), falling back to 'qa-review' if none found.
 *
 * Pure function — no async, no side effects. Extracted to this utility file
 * so it can be imported by both server actions and unit tests without the
 * `'use server'` async requirement.
 */
export function getResumePhaseForFailedTask(events: Array<{ phase: string; timestamp: string }>): string {
  const lastRealPhase = events
    .map(e => e.phase)
    .filter(p => p !== 'backlog' && p !== 'failed' && p !== 'done')
    .pop();
  return lastRealPhase ?? 'qa-review';
}
