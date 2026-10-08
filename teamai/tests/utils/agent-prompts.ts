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
 * Current encoding: the orchestrator renders one command template per work
 * mode (src/lib/command-templates.ts) and sends the rendered text; its first
 * line is the template's `<!-- .claude/commands/<mode>.md -->` header and the
 * orchestrator's request is substituted for `$ARGUMENTS`.
 */
import { readCommandTemplate } from '../../src/lib/command-templates';

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

/** Command template that defines each mode's instructions, or null for modes
 *  the orchestrator describes inline instead of via a command (none today). */
const MODE_COMMAND: Record<AgentMode, string | null> = {
  'spec': 'spec',
  'spec-revise': 'spec-revise',
  'spec-summary': 'spec-summary',
  'plan': 'plan',
  'plan-revise': 'plan-revise',
  'implement': 'implement',
  'implement-fix': 'implement-fix',
  'qa-review': 'qa-review',
  'merge': 'merge',
  'resolve-cherry-pick': 'resolve-cherry-pick',
};

const COMMAND_HEADER = /^<!-- \.claude\/commands\/([a-z-]+)\.md -->\n/;

/** Name of the command template a message was rendered from, if any. */
function renderedCommand(message: string): string | null {
  return COMMAND_HEADER.exec(message)?.[1] ?? null;
}

/** Classify the work mode an orchestrator → agent message selects. */
export function promptMode(message: string): AgentMode {
  const command = renderedCommand(message);
  if (command) {
    const mode = (Object.keys(MODE_COMMAND) as AgentMode[]).find(m => MODE_COMMAND[m] === command);
    if (mode) return mode;
    throw new Error(`Message renders unknown command "${command}"`);
  }
  throw new Error('Unclassifiable agent message:\n' + message.slice(0, 400));
}

/**
 * The orchestrator-assembled part of a message — task context, header blocks,
 * paths — as opposed to command instructions it may be wrapped in (which can
 * legitimately mention those same header names while explaining them).
 * Content and header assertions are made against this.
 */
export function requestOf(message: string): string {
  const command = renderedCommand(message);
  if (!command) return message;
  const template = readCommandTemplate(command);
  const parts = template.split('$ARGUMENTS');
  if (parts.length === 1) {
    const prefix = `${template.replace(/\s+$/, '')}\n\nARGUMENTS: `;
    if (!message.startsWith(prefix)) throw new Error(`Message is not a rendering of "${command}"`);
    return message.slice(prefix.length);
  }
  if (parts.length !== 2) throw new Error(`"${command}" uses $ARGUMENTS more than once`);
  const [prefix, suffix] = parts;
  if (!message.startsWith(prefix) || !message.endsWith(suffix)) {
    throw new Error(`Message is not a rendering of "${command}"`);
  }
  return message.slice(prefix.length, message.length - suffix.length);
}

/** The instruction text that governs a mode, or null when none exists. */
export function commandInstructions(mode: AgentMode): string | null {
  const command = MODE_COMMAND[mode];
  return command ? readCommandTemplate(command) : null;
}
