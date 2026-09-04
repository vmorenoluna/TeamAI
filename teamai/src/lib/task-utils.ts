/**
 * Given a list of phase-change events for a failed task, determine which
 * phase it should resume from. Returns the last real phase before 'failed'
 * (e.g., 'qa-review'), falling back to 'qa-review' if none found.
 *
 * A task whose `failureReason` is 'spec-revision-exhausted' always resumes
 * at 'spec' regardless of what events.jsonl's last entry says: the
 * spec-revision bailout (review-actions.ts autoReviseSpec) transitions
 * straight from 'qa-review' to 'failed' without ever recording an
 * intermediate 'spec' phase-change event, so the events-based lookup would
 * otherwise resume at 'qa-review' — re-running QA against the same code the
 * spec-revision budget already proved doesn't work, instead of giving the
 * analyst a chance to revise the spec first.
 *
 * `hasSpecConcerns` covers a second, distinct case: the QA-attempt budget
 * (checked before spec-concern routing in qa-review.ts, so a task cannot
 * loop unboundedly just because every report also attaches a spec concern)
 * can exhaust on a round whose report *did* flag a spec_concerns entry —
 * recorded as 'qa-attempts-exhausted', not 'spec-revision-exhausted'. Left
 * alone, that resumes at 'qa-review' too: a bare retry re-runs QA against
 * completely unchanged code and reproduces the identical spec-based failure.
 * When the caller reports the last QA report had spec concerns, resume at
 * 'spec' here as well so the analyst gets a chance to fix the spec first.
 *
 * Pure function — no async, no side effects. Extracted to this utility file
 * so it can be imported by both server actions and unit tests without the
 * `'use server'` async requirement.
 */
export function getResumePhaseForFailedTask(
  events: Array<{ phase: string; timestamp: string }>,
  failureReason?: string,
  hasSpecConcerns?: boolean,
): string {
  if (failureReason === 'spec-revision-exhausted') return 'spec';
  if (failureReason === 'qa-attempts-exhausted' && hasSpecConcerns) return 'spec';

  const lastRealPhase = events
    .map(e => e.phase)
    .filter(p => p !== 'backlog' && p !== 'failed' && p !== 'done')
    .pop();
  return lastRealPhase ?? 'qa-review';
}
