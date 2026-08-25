/**
 * Human feedback — single source of truth for writing, reading, and routing
 * the reviewer's comment to a specific agent.
 *
 * One file (`human_feedback.md`) carries both the machine-parseable target and
 * the human-readable message, so the existing UI banner, restore, and cleanup
 * paths keep working without introducing a new artifact file.
 *
 * File format:
 *
 *   # Human Review Feedback
 *   Target: <analyst | planner | coder | qa-reviewer>
 *
 *   <message>
 */
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import path from 'path';
import type { PipelinePhase } from '@/constants/phases';
import type { FeedbackTarget } from './feedback-target';
import { clearPreservedPlanSubtasks } from './plan-validation';
import {
  FEEDBACK_TARGETS,
  isFeedbackTarget,
  targetToResumePhase,
  TARGET_TO_PHASE,
} from './feedback-target';

// Re-export the client-safe constants for existing importers.
export type { FeedbackTarget };
export { FEEDBACK_TARGETS, isFeedbackTarget, targetToResumePhase, TARGET_TO_PHASE };

// ── Types ──────────────────────────────────────────────────────────────────

export interface HumanFeedback {
  /** Undefined only for legacy human_feedback.md files written before targeting. */
  target?: FeedbackTarget;
  /** Sub-task ids the reviewer flagged (coder and planner targets). Undefined when absent. */
  subtaskIds?: number[];
  message: string;
}

// ── File path + read/write ─────────────────────────────────────────────────

const HEADER = '# Human Review Feedback';

export function feedbackFilePath(specPath: string): string {
  return path.join(specPath, 'human_feedback.md');
}

/** Write the feedback with its target. The target is mandatory on every new write. */
export function writeHumanFeedback(
  specPath: string,
  target: FeedbackTarget,
  message: string,
  subtaskIds?: number[],
): void {
  const subtaskLine = subtaskIds && subtaskIds.length > 0
    ? `Subtasks: ${subtaskIds.join(',')}\n`
    : '';
  const content = `${HEADER}\nTarget: ${target}\n${subtaskLine}\n${message.trim()}\n`;
  writeFileSync(feedbackFilePath(specPath), content);
  // A new directive invalidates any pending preserve-list snapshot from a
  // prior scoped planner replan — a crash mid-replan could have left one on
  // disk, and it would otherwise be mistaken for a fresh baseline.
  clearPreservedPlanSubtasks(specPath);
}

/** Read the feedback, parsing the `Target:` header when present. */
export function readHumanFeedback(specPath: string): HumanFeedback | null {
  const p = feedbackFilePath(specPath);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, 'utf-8');
  const body = raw.replace(/^# Human Review Feedback\r?\n/, '');
  const targetMatch = body.match(/^Target:\s*([a-z-]+)\s*\r?\n/);
  const target =
    targetMatch && isFeedbackTarget(targetMatch[1]) ? (targetMatch[1] as FeedbackTarget) : undefined;
  let rest = targetMatch ? body.slice(targetMatch[0].length) : body;
  let subtaskIds: number[] | undefined;
  const subtaskMatch = rest.match(/^Subtasks:\s*([0-9][0-9,\s]*)\s*\r?\n/);
  if (subtaskMatch) {
    subtaskIds = subtaskMatch[1]
      .split(',')
      .map((n) => parseInt(n.trim(), 10))
      .filter((n) => !Number.isNaN(n));
    rest = rest.slice(subtaskMatch[0].length);
  }
  const message = rest.trim();
  return {
    ...(target ? { target } : {}),
    ...(subtaskIds && subtaskIds.length > 0 ? { subtaskIds } : {}),
    message,
  };
}

// ── Prompt directive blocks ────────────────────────────────────────────────

const TARGET_LABELS: Record<FeedbackTarget, string> = {
  analyst: 'the analyst (spec writer)',
  planner: 'the planner',
  coder: 'the engineer (coder)',
  'qa-reviewer': 'the QA reviewer',
};

/** Full override block for the targeted agent. */
export function buildOverrideDirective(feedback: HumanFeedback, scopeNote?: string): string {
  const label = feedback.target ? TARGET_LABELS[feedback.target] : 'you';
  const parts = [
    '## 🧑 HUMAN DIRECTIVE — OVERRIDES EVERYTHING ELSE',
    '',
    `The human reviewer sent this instruction for ${label}. It takes precedence over the ` +
      "spec, the plan, the QA report, and any other agent's directives wherever they conflict. " +
      'If any of those documents tell you otherwise, follow this directive instead and note the ' +
      'deviation in your summary.',
    '',
  ];
  if (scopeNote) {
    parts.push(scopeNote, '');
  }
  parts.push(feedback.message);
  return parts.join('\n');
}

/** Lower-priority context note so QA doesn't contradict a directive aimed at another agent. */
export function buildContextNote(feedback: HumanFeedback): string {
  const label = feedback.target ? TARGET_LABELS[feedback.target] : 'another agent';
  return [
    '## ℹ️ HUMAN DIRECTIVE CONTEXT',
    '',
    `The human reviewer previously directed ${label} with this request. Verify it was actually ` +
      "done; do not flag it as a deviation from the spec/plan — treat the human's request as " +
      'authoritative for this round.',
    '',
    feedback.message,
  ].join('\n');
}

/**
 * Format the list of subtasks a coder- or planner-targeted directive is scoped
 * to, so the agent sees the narrowed scope (ids + titles) rather than only the
 * raw id list stored in human_feedback.md. Returns '' for an empty selection.
 *
 * `mode` captures the semantic difference between the two consumers:
 * - 'rework' (coder): the selection is a **re-run filter** — only those
 *   subtasks are re-executed, everything else stays untouched.
 * - 'replan' (planner): the selection is a **preserve-list** — only those
 *   subtasks may be re-planned; every unlisted subtask must come back
 *   byte-for-byte identical (the orchestrator enforces this in code).
 */
export function buildSubtaskScopeNote(
  subtasks: { id: number; title: string }[],
  mode: 'rework' | 'replan' = 'rework',
): string {
  if (subtasks.length === 0) return '';
  if (mode === 'replan') {
    return [
      'The human reviewer scoped this directive to the following subtasks — re-plan ONLY these, do not regenerate or alter any other subtask:',
      ...subtasks.map(s => `  - #${s.id}: ${s.title}`),
      'Every subtask NOT listed above must be preserved byte-for-byte (same id, title, description, files, depends_on, acceptance_criteria, completed, qa_flagged).',
    ].join('\n');
  }
  return [
    'The human reviewer scoped this directive to the following subtasks — rework ONLY these, do not touch others:',
    ...subtasks.map(s => `  - #${s.id}: ${s.title}`),
  ].join('\n');
}

/** Resolve the subtask ids stored in human_feedback.md to their plan.json titles. */
function readScopedSubtasks(specPath: string, ids: number[]): { id: number; title: string }[] {
  const planPath = path.join(specPath, 'plan.json');
  if (!existsSync(planPath)) return [];
  try {
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    const idSet = new Set(ids);
    return (plan.subtasks || [])
      .filter((s: { id: number }) => idSet.has(s.id))
      .map((s: { id: number; title: string }) => ({ id: s.id, title: s.title }));
  } catch {
    return [];
  }
}

/**
 * Return the directive block to prepend to a phase's prompt, or '' if none.
 *
 * - The targeted agent gets the full override block.
 * - Downstream agents get nothing (they read the revised artifact).
 * - QA is the exception: it gets the override for its own target, or a context
 *   note for a directive aimed at another agent (so it doesn't flag the change).
 */
export function humanDirectiveFor(specPath: string, phaseRole: string): string {
  const fb = readHumanFeedback(specPath);
  if (!fb || !fb.target) return '';
  if (fb.target === phaseRole) {
    let scopeNote: string | undefined;
    if (fb.target === 'planner' && fb.subtaskIds?.length) {
      scopeNote = buildSubtaskScopeNote(readScopedSubtasks(specPath, fb.subtaskIds), 'replan');
    } else if (fb.target === 'coder' && fb.subtaskIds?.length) {
      scopeNote = buildSubtaskScopeNote(readScopedSubtasks(specPath, fb.subtaskIds), 'rework');
    }
    return buildOverrideDirective(fb, scopeNote) + '\n\n';
  }
  if (phaseRole === 'qa-reviewer') return buildContextNote(fb) + '\n\n';
  return '';
}

// ── Lifecycle / consumption ────────────────────────────────────────────────

const CONSUME_AFTER: Record<FeedbackTarget, PipelinePhase> = {
  analyst: 'spec',
  planner: 'plan',
  coder: 'qa-review',
  'qa-reviewer': 'qa-review',
};

/**
 * Delete the feedback file once the phase that fully consumes the directive has
 * run. The intent is baked into the target's revised artifact by that point
 * (analyst → spec, planner → plan), or into QA's verdict (coder/qa-reviewer).
 */
export function consumeFeedbackIfDue(specPath: string, phase: PipelinePhase): void {
  const fb = readHumanFeedback(specPath);
  if (!fb?.target || CONSUME_AFTER[fb.target] !== phase) return;
  const p = feedbackFilePath(specPath);
  try {
    if (existsSync(p)) unlinkSync(p);
  } catch {
    /* best-effort — a leftover file only means the banner persists one extra round */
  }
}
