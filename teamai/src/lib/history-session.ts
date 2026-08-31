/**
 * Session-level DONE-ticket store (§3f).
 *
 * The HistoryScanner is stateless per request (server actions create a new
 * instance each time), so the incremental-append path and the scroll-driven
 * page accumulation need a process-wide store keyed by project root:
 *
 *   - appendSessionTicket()  — markTaskDone synthesizes the fresh card from
 *     the message data the pipeline already built and prepends it here. No
 *     re-query (the doc's incremental-append path), and it also covers the
 *     recordHistoryInGit-off case: the ticket shows for the rest of the
 *     session, then disappears on restart — exactly the documented behavior.
 *   - upsertSessionTickets() — scan results (commit/PR pages) accumulate here
 *     so scroll-driven pagination can grow the list without losing entries.
 *   - mergedDoneTickets()    — scanner results + session-only entries, sorted
 *     newest-first. Scanner-sourced entries win on slug collision (they carry
 *     the real commit date); session-only entries (toggle-off tickets) fill
 *     the gaps.
 *
 * Everything here is in-memory by design — restart clears it, which matches
 * the doc's "once the app restarts, that in-memory entry is gone".
 */
import type { DoneTicketFromHistory } from './history-scanner';

/** projectRoot → (slug → ticket) */
const store = new Map<string, Map<string, DoneTicketFromHistory>>();

function bucketFor(projectRoot: string): Map<string, DoneTicketFromHistory> {
  let bucket = store.get(projectRoot);
  if (!bucket) {
    bucket = new Map();
    store.set(projectRoot, bucket);
  }
  return bucket;
}

/** Insert/replace one synthesized ticket (newest by construction). */
export function appendSessionTicket(projectRoot: string, ticket: DoneTicketFromHistory): void {
  bucketFor(projectRoot).set(ticket.slug, ticket);
}

/** Merge a page/scan of tickets into the session store. */
export function upsertSessionTickets(projectRoot: string, tickets: DoneTicketFromHistory[]): void {
  const bucket = bucketFor(projectRoot);
  for (const t of tickets) bucket.set(t.slug, t);
}

/**
 * Session-only entries — slugs the last scanner run did NOT return (e.g.
 * recordHistoryInGit-off tickets, which no scan can ever recover).
 */
export function getSessionTickets(projectRoot: string): DoneTicketFromHistory[] {
  return [...bucketFor(projectRoot).values()].sort(
    (a, b) => b.completedAt.getTime() - a.completedAt.getTime(),
  );
}

/**
 * Scanner results merged over the session store: scanner entries win on
 * collision (real commit date/hash), session-only entries survive. Sorted
 * newest-first, deduped by slug.
 */
export function mergedDoneTickets(
  projectRoot: string,
  scanned: DoneTicketFromHistory[],
): DoneTicketFromHistory[] {
  const bucket = bucketFor(projectRoot);
  for (const t of scanned) bucket.set(t.slug, t);
  return [...bucket.values()].sort(
    (a, b) => b.completedAt.getTime() - a.completedAt.getTime(),
  );
}

/** Test/teardown helper — clear one project's session entries. */
export function clearSessionTickets(projectRoot: string): void {
  store.delete(projectRoot);
}

/**
 * Synthesize a DoneTicketFromHistory from data the pipeline already built
 * (§3f incremental-append): the builder's subject/body/trailer lines plus
 * the task record. Used by markTaskDone at the moment of completion.
 */
export function synthesizeDoneTicket(input: {
  slug: string;
  taskId: string;
  title: string;
  summary: string;
  trailerLines: string[];
  prUrl?: string;
}): DoneTicketFromHistory {
  const qa = input.trailerLines.find(l => /^QA:/i.test(l.trim()));
  const phases = input.trailerLines.find(l => /^Phases:/i.test(l.trim()));
  return {
    title: input.title,
    summary: input.summary,
    slug: input.slug,
    taskId: input.taskId,
    qaResult: qa ? qa.replace(/^QA:\s*/i, '') : undefined,
    phaseChain: phases ? phases.replace(/^Phases:\s*/i, '') : undefined,
    completedAt: new Date(),
    prUrl: input.prUrl,
    source: input.prUrl ? 'both' : 'commit',
  };
}
