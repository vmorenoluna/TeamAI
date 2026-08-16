// @vitest-environment node

import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  extractOutOfScopeBugs,
  createOutOfScopeTickets,
  createOutOfScopeTicketsFromLog,
} from '@/lib/orchestrator/out-of-scope-tickets';
import { TaskStore } from '@/lib/task-store';

const tempDirs: string[] = [];
function makeTempProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'teamai-bugs-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop()!;
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
});

describe('extractOutOfScopeBugs', () => {
  it('parses a single bug report with a reason', () => {
    expect(extractOutOfScopeBugs('[BUG] Fix: broken toggle — it is outside this subtask scope')).toEqual([
      { title: 'Fix: broken toggle', reason: 'it is outside this subtask scope' },
    ]);
  });

  it('parses a bug report without a reason', () => {
    expect(extractOutOfScopeBugs('[BUG] Fix: broken toggle')).toEqual([
      { title: 'Fix: broken toggle', reason: '' },
    ]);
  });

  it('parses multiple bug reports embedded in free-form text', () => {
    const text =
      'All done.\n' +
      '[BUG] Fix: leak in parser — touches a file outside scope\n' +
      'Also noticed [BUG] Refactor: dedupe validators\n';
    expect(extractOutOfScopeBugs(text)).toEqual([
      { title: 'Fix: leak in parser', reason: 'touches a file outside scope' },
      { title: 'Refactor: dedupe validators', reason: '' },
    ]);
  });

  it('returns an empty array when no bug marker is present', () => {
    expect(extractOutOfScopeBugs('Clean summary with no findings.')).toEqual([]);
  });

  it('tolerates timestamps and log prefixes around the marker', () => {
    const text = '[2026-08-16T10:30:00] [BUG] Fix: stale cache — reason text\n';
    expect(extractOutOfScopeBugs(text)).toEqual([
      { title: 'Fix: stale cache', reason: 'reason text' },
    ]);
  });
});

describe('createOutOfScopeTickets', () => {
  it('creates a backlog ticket with the reported title and reason', () => {
    const project = makeTempProject();
    const ids = createOutOfScopeTickets(project, '[BUG] Fix: broken toggle — out of scope');
    expect(ids).toHaveLength(1);

    const store = new TaskStore(project);
    const task = store.getById(ids[0]);
    expect(task).toBeTruthy();
    expect(task!.title).toBe('Fix: broken toggle');
    expect(task!.phase).toBe('backlog');
    expect(task!.description).toContain('Reason: out of scope');
  });

  it('deduplicates by title when the same finding is reported twice', () => {
    const project = makeTempProject();
    const ids = createOutOfScopeTickets(
      project,
      '[BUG] Fix: broken toggle — out of scope\n[BUG] Fix: broken toggle — reported again\n',
    );
    expect(ids).toHaveLength(1);
  });

  it('skips a title that already exists as a task', () => {
    const project = makeTempProject();
    const store = new TaskStore(project);
    store.create('existing-id', 'Fix: broken toggle', 'pre-existing');

    const ids = createOutOfScopeTickets(project, '[BUG] Fix: broken toggle — out of scope');
    expect(ids).toHaveLength(0);
  });

  it('returns an empty array when no bug markers are present', () => {
    const project = makeTempProject();
    expect(createOutOfScopeTickets(project, 'no findings')).toEqual([]);
    expect(existsSync(join(project, '.teamai'))).toBe(false);
  });
});

describe('createOutOfScopeTicketsFromLog', () => {
  it('reads the log file and creates tickets', () => {
    const project = makeTempProject();
    const logFile = join(project, 'output-st1.log');
    writeFileSync(logFile, '[2026-08-16T10:30:00] [BUG] Fix: bad cache — out of scope\n');

    const ids = createOutOfScopeTicketsFromLog(project, logFile);
    expect(ids).toHaveLength(1);
  });

  it('returns an empty array for a missing log file', () => {
    const project = makeTempProject();
    expect(createOutOfScopeTicketsFromLog(project, join(project, 'nope.log'))).toEqual([]);
  });
});
