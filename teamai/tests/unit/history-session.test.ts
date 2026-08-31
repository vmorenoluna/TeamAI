// @vitest-environment node

/**
 * Unit tests for the session-level DONE-ticket store (§3f):
 *   - appendSessionTicket / upsertSessionTickets / mergedDoneTickets
 *   - scanner entries win on slug collision; session-only entries survive
 *   - per-project isolation and clearSessionTickets
 *   - synthesizeDoneTicket trailer parsing (QA:/Phases:) and source selection
 */
import { describe, it, expect } from 'vitest';
import {
  appendSessionTicket,
  upsertSessionTickets,
  mergedDoneTickets,
  getSessionTickets,
  clearSessionTickets,
  synthesizeDoneTicket,
} from '../../src/lib/history-session';
import type { DoneTicketFromHistory } from '../../src/lib/history-scanner';

function ticket(slug: string, completedAt = new Date('2026-08-01T00:00:00Z')): DoneTicketFromHistory {
  return {
    title: `Ticket ${slug}`,
    summary: 'Did the thing.',
    slug,
    taskId: `task-${slug}`,
    qaResult: 'PASS (5/5 criteria)',
    completedAt,
    source: 'commit',
  };
}

describe('history-session store', () => {
  it('appends and returns session-only tickets newest-first', () => {
    clearSessionTickets('/p1');
    appendSessionTicket('/p1', ticket('old', new Date('2026-07-01T00:00:00Z')));
    appendSessionTicket('/p1', ticket('new', new Date('2026-08-01T00:00:00Z')));

    const session = getSessionTickets('/p1');
    expect(session.map(t => t.slug)).toEqual(['new', 'old']);
    clearSessionTickets('/p1');
  });

  it('merges scanner results over the store: scanner wins on collision, session-only survives', () => {
    clearSessionTickets('/p2');
    // Session-only ticket (no scanner equivalent) and a colliding one.
    appendSessionTicket('/p2', ticket('only-session'));
    appendSessionTicket('/p2', ticket('collision', new Date('2026-01-01T00:00:00Z')));

    const scanned: DoneTicketFromHistory[] = [
      { ...ticket('collision', new Date('2026-08-02T00:00:00Z')), source: 'both' },
      ticket('from-scan', new Date('2026-08-03T00:00:00Z')),
    ];
    const merged = mergedDoneTickets('/p2', scanned);

    const bySlug = new Map(merged.map(t => [t.slug, t]));
    expect(bySlug.get('collision')?.source).toBe('both');
    expect(bySlug.get('collision')?.completedAt.getTime()).toBe(new Date('2026-08-02T00:00:00Z').getTime());
    expect(bySlug.get('only-session')).toBeDefined();
    expect(bySlug.get('from-scan')).toBeDefined();
    // Newest first.
    expect(merged[0]!.slug).toBe('from-scan');
    clearSessionTickets('/p2');
  });

  it('isolates projects and clears one project at a time', () => {
    clearSessionTickets('/pa');
    clearSessionTickets('/pb');
    appendSessionTicket('/pa', ticket('a'));
    appendSessionTicket('/pb', ticket('b'));

    expect(getSessionTickets('/pa').map(t => t.slug)).toEqual(['a']);
    expect(getSessionTickets('/pb').map(t => t.slug)).toEqual(['b']);

    clearSessionTickets('/pa');
    expect(getSessionTickets('/pa')).toEqual([]);
    expect(getSessionTickets('/pb').map(t => t.slug)).toEqual(['b']);
    clearSessionTickets('/pb');
  });

  it('upsertSessionTickets accumulates scan pages without losing entries', () => {
    clearSessionTickets('/p3');
    upsertSessionTickets('/p3', [ticket('page1')]);
    upsertSessionTickets('/p3', [ticket('page2')]);
    expect(getSessionTickets('/p3').map(t => t.slug).sort()).toEqual(['page1', 'page2']);
    clearSessionTickets('/p3');
  });
});

describe('synthesizeDoneTicket', () => {
  it('parses QA: and Phases: trailer lines and marks source by prUrl', () => {
    const t = synthesizeDoneTicket({
      slug: 'add-thing',
      taskId: 'task-1',
      title: 'Add thing',
      summary: 'Implemented the thing.',
      trailerLines: ['Task: add-thing', 'QA: PASS (5/5 criteria)', 'Phases: spec, plan, implement, qa-review'],
      prUrl: 'https://github.com/acme/repo/pull/9',
    });
    expect(t.qaResult).toBe('PASS (5/5 criteria)');
    expect(t.phaseChain).toBe('spec, plan, implement, qa-review');
    expect(t.source).toBe('both');
    expect(t.prUrl).toBe('https://github.com/acme/repo/pull/9');
  });

  it('uses commit source and drops trailers when there is no PR', () => {
    const t = synthesizeDoneTicket({
      slug: 'local-thing',
      taskId: 'task-2',
      title: 'Local thing',
      summary: 'Merged locally.',
      trailerLines: [],
    });
    expect(t.qaResult).toBeUndefined();
    expect(t.phaseChain).toBeUndefined();
    expect(t.source).toBe('commit');
    expect(t.prUrl).toBeUndefined();
  });
});
