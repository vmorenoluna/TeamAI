/**
 * Out-of-scope bug ticket creation.
 *
 * The coder (implement) and analyst (spec) roles report bugs, missing features, or refactor opportunities it
 * discovers outside its assigned subtask scope as `[BUG] ...` summary lines
 * instead of hand-writing `.teamai/{slug}/task.json` files. This module parses
 * those lines and creates deterministic kanban tickets via TaskStore, so the
 * slug, UUID, and timestamps are always generated correctly by the
 * orchestrator rather than by an agent.
 */
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import { TaskStore } from '../task-store';

export interface OutOfScopeBug {
  /** Ticket title including the conventional prefix (e.g. `Fix: ...`). */
  title: string;
  /** Reason the item was judged out-of-scope (may be empty). */
  reason: string;
}

/**
 * Matches a coder summary line of the form
 * `[BUG] Fix: {description} — {reason it's out-of-scope}`. The reason after
 * the em dash is optional; the prefix set matches create-task.md's
 * conventional prefixes so an unexpected prefix still produces a ticket.
 */
const OUT_OF_SCOPE_BUG_RE = /\[BUG\]\s*(Fix|Feat|Refactor|Docs):\s*([^—\n]+)(?:—\s*([^\n]+))?/g;

/** Pure parser: extract out-of-scope bug reports from free-form summary text. */
export function extractOutOfScopeBugs(text: string): OutOfScopeBug[] {
  const bugs: OutOfScopeBug[] = [];
  for (const match of text.matchAll(OUT_OF_SCOPE_BUG_RE)) {
    const title = `${match[1]}: ${match[2].trim()}`;
    const reason = (match[3] ?? '').trim();
    bugs.push({ title, reason });
  }
  return bugs;
}

/**
 * Create backlog tickets for every `[BUG]` report in `text`, skipping any
 * whose title already exists as a task (so a subtask re-run that re-reports
 * the same finding does not create duplicate tickets). Returns the created
 * task ids.
 */
export function createOutOfScopeTickets(
  projectRoot: string,
  text: string,
  taskStore?: TaskStore,
): string[] {
  const bugs = extractOutOfScopeBugs(text);
  if (bugs.length === 0) return [];

  const store = taskStore ?? new TaskStore(projectRoot);
  const existingTitles = new Set(store.getAll().map(t => t.title));
  const ids: string[] = [];

  for (const bug of bugs) {
    if (existingTitles.has(bug.title)) continue;
    const description = bug.reason
      ? `Reported by a pipeline agent as out of scope for its assigned work.\n\nReason: ${bug.reason}`
      : 'Reported by a pipeline agent as out of scope for its assigned work.';
    const task = store.create(randomUUID(), bug.title, description);
    existingTitles.add(bug.title);
    ids.push(task.id);
  }

  return ids;
}

/**
 * Read a subtask session log and create any out-of-scope bug tickets found in
 * it. Best-effort — a missing/unreadable log must never fail the pipeline.
 * Returns the created task ids (empty if none).
 */
export function createOutOfScopeTicketsFromLog(
  projectRoot: string,
  logFile: string,
  taskStore?: TaskStore,
): string[] {
  let text = '';
  try {
    text = readFileSync(logFile, 'utf-8');
  } catch {
    return [];
  }
  return createOutOfScopeTickets(projectRoot, text, taskStore);
}
