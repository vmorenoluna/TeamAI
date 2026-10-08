/**
 * Agent command templates (`defaults/commands/*.md`).
 *
 * Each pipeline work mode has its own command (spec / spec-revise, plan /
 * plan-revise, implement / implement-fix, qa-review, merge), and sections
 * several commands need verbatim — the wakeup contract, the coder rules, the
 * plan.json rules — live once under `defaults/commands/_shared/`, pulled in
 * with a line of the form:
 *
 *   <!-- @include _shared/<name>.md -->
 *
 * The orchestrator does NOT invoke these as slash commands. It renders the
 * template itself (includes expanded, `$ARGUMENTS` substituted — the same
 * expansion Claude Code performs) and sends the result as the session's
 * message. Two Claude Code behaviours make slash invocation unreliable here:
 *
 *  - A slash command is only expanded when the message STARTS with it. The
 *    orchestrator prepends header blocks (wakeup re-entry, human directive,
 *    deliverable re-verification, stall recovery, session context), so a
 *    `/implement` further down the message reached the agent as plain text
 *    and the command's instructions were never loaded.
 *  - A session only sees the `.claude/commands/` of its own cwd. Implement,
 *    QA and merge sessions run in the task worktree, whose `.claude/` is the
 *    branch's committed copy — not the one force-synced into the project
 *    root at startup — so it can lag TeamAI's current commands, or lack a
 *    newly added command entirely (e.g. on a task that was already in flight
 *    when TeamAI was upgraded).
 *
 * Rendering from TeamAI's own defaults makes every session receive exactly
 * the instructions this TeamAI version ships, wherever it runs.
 *
 * Project copies: `project-store.ts` still syncs each command into the
 * project's `.claude/commands/` (includes expanded, so each copy is
 * self-contained) for anyone invoking one by hand.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'fs';
import { join, resolve, relative, isAbsolute } from 'path';

/** Directory holding TeamAI's shipped command templates. */
export function getCommandsDir(): string {
  return join(/* turbopackIgnore: true */ process.cwd(), 'defaults', 'commands');
}

const INCLUDE_LINE = /^[ \t]*<!--[ \t]*@include[ \t]+(\S+)[ \t]*-->[ \t]*$/gm;
const MAX_INCLUDE_DEPTH = 5;

/**
 * Replace every `<!-- @include <path> -->` line with the referenced file's
 * content (trailing newline trimmed), resolving paths against `commandsDir`.
 * Throws on a missing file, a path that escapes `commandsDir`, or nesting
 * deeper than MAX_INCLUDE_DEPTH — a command that silently loses a section
 * would ship an incomplete contract to every agent.
 */
export function expandCommandIncludes(raw: string, commandsDir: string = getCommandsDir(), depth = 0): string {
  return raw.replace(INCLUDE_LINE, (_line, includePath: string) => {
    if (depth >= MAX_INCLUDE_DEPTH) {
      throw new Error(`Command include nesting exceeds ${MAX_INCLUDE_DEPTH} levels at "${includePath}"`);
    }
    const target = resolve(commandsDir, includePath);
    const rel = relative(commandsDir, target);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error(`Command include "${includePath}" resolves outside ${commandsDir}`);
    }
    if (!existsSync(target)) {
      throw new Error(`Command include "${includePath}" not found in ${commandsDir}`);
    }
    const content = readFileSync(target, 'utf-8').replace(/\s+$/, '');
    return expandCommandIncludes(content, commandsDir, depth + 1);
  });
}

/** Names (without `.md`) of every top-level command template. Subdirectories
 *  such as `_shared/` hold include fragments, not commands. */
export function listCommandNames(commandsDir: string = getCommandsDir()): string[] {
  if (!existsSync(commandsDir)) return [];
  return readdirSync(commandsDir)
    .filter(f => f.endsWith('.md') && statSync(join(commandsDir, f)).isFile())
    .map(f => f.slice(0, -'.md'.length))
    .sort();
}

/** A command's full text with includes expanded, `$ARGUMENTS` left in place. */
export function readCommandTemplate(name: string, commandsDir: string = getCommandsDir()): string {
  const file = join(commandsDir, `${name}.md`);
  if (!existsSync(file)) throw new Error(`Unknown agent command "${name}" (no ${file})`);
  return expandCommandIncludes(readFileSync(file, 'utf-8'), commandsDir);
}

/**
 * Render a command the way Claude Code expands `/<name> <args>`: every
 * `$ARGUMENTS` is replaced with `args`; a template without the placeholder
 * gets `ARGUMENTS: <args>` appended instead.
 */
export function renderCommand(name: string, args: string, commandsDir: string = getCommandsDir()): string {
  const template = readCommandTemplate(name, commandsDir);
  if (template.includes('$ARGUMENTS')) {
    // Function replacer: `args` is free text and may contain `$&`, `$1`, ...
    return template.replace(/\$ARGUMENTS/g, () => args);
  }
  return `${template.replace(/\s+$/, '')}\n\nARGUMENTS: ${args}`;
}
