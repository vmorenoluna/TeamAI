/**
 * Feedback target constants — pure data, no runtime imports.
 *
 * Split out of human-feedback.ts so client components (the review panel) can
 * import the target list/labels without bundling Node's `fs` into the browser.
 */
import type { PipelinePhase } from '@/constants/phases';

export type FeedbackTarget = 'analyst' | 'planner' | 'coder' | 'qa-reviewer';

export const FEEDBACK_TARGETS: readonly FeedbackTarget[] = [
  'analyst',
  'planner',
  'coder',
  'qa-reviewer',
] as const;

/** Short human-facing labels for the target selector. */
export const FEEDBACK_TARGET_LABELS: Record<FeedbackTarget, string> = {
  analyst: 'Analyst',
  planner: 'Planner',
  coder: 'Engineer',
  'qa-reviewer': 'QA Reviewer',
};

export function isFeedbackTarget(value: unknown): value is FeedbackTarget {
  return typeof value === 'string' && (FEEDBACK_TARGETS as readonly string[]).includes(value);
}

export const TARGET_TO_PHASE: Record<FeedbackTarget, PipelinePhase> = {
  analyst: 'spec',
  planner: 'plan',
  coder: 'implement',
  'qa-reviewer': 'qa-review',
};

/** Map a feedback target to the phase that agent resumes at. */
export function targetToResumePhase(target: FeedbackTarget): PipelinePhase {
  return TARGET_TO_PHASE[target];
}
