/**
 * Agent-prompt classification shared by the prompt-routing and
 * command-contract tests.
 *
 * Those suites pin WHAT the orchestrator asks each agent to do — which work
 * mode a pipeline state selects, which header blocks and paths reach the
 * agent, and which contract rules that mode's instructions carry — without
 * pinning HOW the request is encoded on the wire. The encoding lives only in
 * the functions below, so a change to the delivery mechanism updates this
 * file and leaves every assertion in those suites untouched.
 *
 * Current encoding: a slash command (or a bare `REVISION:` / `REPLAN:` marker)
 * embedded in the message, with the instructions for every mode of a phase
 * living in that phase's single command file.
 */
import { readFileSync } from 'fs';
import { join } from 'path';

/** Every distinct kind of work the orchestrator hands to an agent session. */
export type AgentMode =
  | 'spec'
  | 'spec-revise'
  | 'spec-summary'
  | 'plan'
  | 'plan-revise'
  | 'implement'
  | 'implement-fix'
  | 'qa-review'
  | 'merge'
  | 'resolve-cherry-pick';

/** Classify the work mode an orchestrator → agent message selects. */
export function promptMode(message: string): AgentMode {
  if (message.includes('Resolve cherry-pick conflicts')) return 'resolve-cherry-pick';
  if (message.includes('It has no `spec_summary.md` alongside it')) return 'spec-summary';
  if (message.includes('REVISION: ')) return 'spec-revise';
  if (message.includes('REPLAN: ')) return 'plan-revise';
  if (/(^|\n)\/spec /.test(message)) return 'spec';
  if (/(^|\n)\/plan /.test(message)) return 'plan';
  if (/(^|\n)\/implement Subtask /.test(message)) {
    return message.includes('## ⚠️ QA FEEDBACK') ? 'implement-fix' : 'implement';
  }
  if (/(^|\n)\/qa-review /.test(message)) return 'qa-review';
  if (/(^|\n)\/merge /.test(message)) return 'merge';
  throw new Error('Unclassifiable agent message:\n' + message.slice(0, 400));
}

/**
 * The orchestrator-assembled part of a message — task context, header blocks,
 * paths — as opposed to command instructions it may be wrapped in (which can
 * legitimately mention those same header names while explaining them).
 * Content and header assertions are made against this.
 */
export function requestOf(message: string): string {
  return message;
}

/** Command file that defines each mode's instructions, or null for modes
 *  the orchestrator currently describes inline instead of via a command. */
const MODE_COMMAND_FILE: Record<AgentMode, string | null> = {
  'spec': 'spec.md',
  'spec-revise': 'spec.md',
  'spec-summary': null,
  'plan': 'plan.md',
  'plan-revise': 'plan.md',
  'implement': 'implement.md',
  'implement-fix': 'implement.md',
  'qa-review': 'qa-review.md',
  'merge': 'merge.md',
  'resolve-cherry-pick': null,
};

/** The instruction text that governs a mode, or null when none exists. */
export function commandInstructions(mode: AgentMode): string | null {
  const file = MODE_COMMAND_FILE[mode];
  if (!file) return null;
  return readFileSync(join(process.cwd(), 'defaults', 'commands', file), 'utf-8');
}
