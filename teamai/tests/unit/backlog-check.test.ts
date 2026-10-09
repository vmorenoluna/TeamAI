// @vitest-environment node

import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  prepareBacklogCheck, validateCheck, commitBacklogCheck, runBacklogCheck,
  isHeldBySuperseder, finalizeSupersededTickets, checkFile, snapshotFile,
  globToRegExp, evidenceProduced,
  type BoardSnapshot, type CheckFile,
} from '@/lib/orchestrator/backlog-check';
import { hasPendingSpecRevision, startPhaseFromArtifacts } from '@/lib/orchestrator/helpers';
import { processManager } from '@/lib/process-manager';
import { TaskStore } from '@/lib/task-store';

const SRC = '11111111-1111-4111-8111-111111111111';
const A = '22222222-2222-4222-8222-222222222222';
const B = '33333333-3333-4333-8333-333333333333';

const dirs: string[] = [];
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'teamai-backlog-'));
  dirs.push(root);
  const store = new TaskStore(root);
  store.create(SRC, 'Source task', 'source description');
  store.create(A, 'Ticket A', 'a description');
  store.create(B, 'Ticket B', 'b description');
  const specPath = store.getDirById(SRC);
  return { root, store, specPath, specsDir: join(root, '.teamai') };
}
afterEach(() => {
  vi.restoreAllMocks();
  while (dirs.length) { try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* best-effort */ } }
});

function writeCheck(specPath: string, unit: string, check: CheckFile) {
  writeFileSync(join(specPath, checkFile(unit)), JSON.stringify(check));
}
const allUnrelated = (): CheckFile => ({
  tickets: [{ id: A, verdict: 'unrelated', reason: '' }, { id: B, verdict: 'unrelated', reason: '' }],
});
const commit = (env: ReturnType<typeof setup>, unit = 'spec', requireSelf = false) => commitBacklogCheck({
  specPath: env.specPath, unit, store: env.store, ownTaskId: SRC, requireSelf, specsDir: env.specsDir,
  reporter: 'the coder agent (Subtask 1)',
});

describe('prepareBacklogCheck', () => {
  it('snapshots every open ticket except the task itself and clears a stale check', () => {
    const env = setup();
    writeCheck(env.specPath, 'spec', allUnrelated());
    const header = prepareBacklogCheck({ specPath: env.specPath, unit: 'spec', store: env.store, ownTaskId: SRC, requireSelf: false });
    const snap: BoardSnapshot = JSON.parse(readFileSync(join(env.specPath, snapshotFile('spec')), 'utf-8'));
    expect(snap.tickets.map(t => t.id).sort()).toEqual([A, B]);
    expect(existsSync(join(env.specPath, checkFile('spec')))).toBe(false);
    expect(header).toContain('BACKLOG CHECK');
  });

  it('tells the analyst which agent filed an agent-reported ticket', () => {
    const env = setup();
    env.store.update(SRC, { reportedBy: A, reportedByAgent: 'the coder agent (Subtask 3)' });
    const header = prepareBacklogCheck({ specPath: env.specPath, unit: 'spec', store: env.store, ownTaskId: SRC, requireSelf: true });
    expect(header).toContain('filed by the coder agent (Subtask 3)');
    expect(header).toContain('unverified claim');
  });
});

describe('validateCheck', () => {
  const snap: BoardSnapshot = {
    fingerprint: 'x', takenAt: '', ownTaskId: SRC,
    tickets: [{ id: A, title: 'A', phase: 'backlog', description: '' }, { id: B, title: 'B', phase: 'backlog', description: '' }],
  };
  it('accepts one verdict per ticket', () => {
    expect(validateCheck(allUnrelated(), snap, false)).toEqual([]);
  });
  it('rejects a missing ticket, a duplicate, an unknown id and a reasonless verdict', () => {
    const problems = validateCheck({ tickets: [
      { id: A, verdict: 'supersedes', reason: '' },
      { id: A, verdict: 'unrelated', reason: '' },
      { id: 'nope', verdict: 'unrelated', reason: '' },
    ] }, snap, false);
    expect(problems.join('\n')).toMatch(/needs a reason/);
    expect(problems.join('\n')).toMatch(/2 verdicts/);
    expect(problems.join('\n')).toMatch(/not in the snapshot/);
    expect(problems.join('\n')).toMatch(new RegExp(`no verdict for 1 ticket\\(s\\): ${B}`));
  });
  it('requires the self verdict when asked, and a prefixed title for new tickets', () => {
    const problems = validateCheck({ ...allUnrelated(), new_tickets: [{ title: 'broken', description: 'x' }] }, snap, true);
    expect(problems.join('\n')).toMatch(/self/);
    expect(problems.join('\n')).toMatch(/must start with Fix:/);
  });
});

describe('commitBacklogCheck', () => {
  it('applies verdicts and files new tickets tagged with their reporter', () => {
    const env = setup();
    env.store.updatePhase(A, 'backlog');
    const dir = env.store.getDirById(B);
    writeFileSync(join(dir, 'spec.md'), 'old spec');
    prepareBacklogCheck({ specPath: env.specPath, unit: 'spec', store: env.store, ownTaskId: SRC, requireSelf: false });
    writeCheck(env.specPath, 'spec', {
      tickets: [{ id: A, verdict: 'supersedes', reason: 'covered' }, { id: B, verdict: 'invalidates', reason: 'baseline moved' }],
      new_tickets: [{ title: 'Fix: new thing', description: 'evidence' }],
    });
    const res = commit(env);
    expect(res.status).toBe('applied');
    expect(env.store.getById(A)!.supersededBy).toBe(SRC);
    const b = env.store.getById(B)!;
    expect(b.dependencies).toEqual([SRC]);
    expect(hasPendingSpecRevision(dir)).toBe(true);
    expect(startPhaseFromArtifacts(true, false, hasPendingSpecRevision(dir))).toBe('spec');
    const created = env.store.getAll().find(t => t.title === 'Fix: new thing')!;
    expect(created.reportedBy).toBe(SRC);
    expect(created.reportedByAgent).toBe('the coder agent (Subtask 1)');
    expect(created.description).toContain('Unverified');
  });

  it('refuses to apply when a ticket appeared after the snapshot', () => {
    const env = setup();
    prepareBacklogCheck({ specPath: env.specPath, unit: 'spec', store: env.store, ownTaskId: SRC, requireSelf: false });
    writeCheck(env.specPath, 'spec', { ...allUnrelated(), new_tickets: [{ title: 'Fix: dup', description: 'x' }] });
    env.store.create('44444444-4444-4444-8444-444444444444', 'Fix: dup elsewhere', 'filed meanwhile');
    const res = commit(env);
    expect(res.status).toBe('stale');
    expect(env.store.getAll().some(t => t.title === 'Fix: dup')).toBe(false);
  });

  it('ignores tickets removed after the snapshot', () => {
    const env = setup();
    prepareBacklogCheck({ specPath: env.specPath, unit: 'spec', store: env.store, ownTaskId: SRC, requireSelf: false });
    writeCheck(env.specPath, 'spec', { tickets: [{ id: A, verdict: 'update', reason: 'more' }, { id: B, verdict: 'unrelated', reason: '' }] });
    env.store.delete(A);
    expect(commit(env).status).toBe('applied');
  });

  it('only notes a running target', () => {
    const env = setup();
    env.store.updatePhase(A, 'implement');
    prepareBacklogCheck({ specPath: env.specPath, unit: 'spec', store: env.store, ownTaskId: SRC, requireSelf: false });
    writeCheck(env.specPath, 'spec', { tickets: [{ id: A, verdict: 'supersedes', reason: 'covered' }, { id: B, verdict: 'unrelated', reason: '' }] });
    const res = commit(env);
    expect(res.status === 'applied' && res.effects.outcomes[0].result).toBe('note-only');
    expect(env.store.getById(A)!.supersededBy).toBeUndefined();
  });
});

describe('runBacklogCheck', () => {
  function stubSessions(onSession: () => void) {
    vi.spyOn(processManager, 'createSession').mockResolvedValue('session-1' as never);
    vi.spyOn(processManager, 'sendMessage').mockImplementation(() => undefined as never);
    vi.spyOn(processManager, 'killSession').mockImplementation(() => undefined as never);
    return vi.fn(async () => { onSession(); });
  }

  it('runs a follow-up session when the check file is missing, then applies', async () => {
    const env = setup();
    prepareBacklogCheck({ specPath: env.specPath, unit: 'st1', store: env.store, ownTaskId: SRC, requireSelf: false });
    const wait = stubSessions(() => writeCheck(env.specPath, 'st1', allUnrelated()));
    const out = await runBacklogCheck({
      specPath: env.specPath, unit: 'st1', unitLabel: 'Subtask 1', taskId: SRC, role: 'coder', cwd: env.root,
      requireSelf: false, projectRoot: env.root, store: env.store,
      sessionOpts: () => ({}) as never, waitForCompletion: wait,
    });
    expect(out.ok).toBe(true);
    expect(wait).toHaveBeenCalledTimes(1);
  });

  it('gives up after the follow-up budget', async () => {
    const env = setup();
    prepareBacklogCheck({ specPath: env.specPath, unit: 'qa', store: env.store, ownTaskId: SRC, requireSelf: false });
    const wait = stubSessions(() => { /* agent never writes the file */ });
    const out = await runBacklogCheck({
      specPath: env.specPath, unit: 'qa', unitLabel: 'The QA review', taskId: SRC, role: 'qa-reviewer', cwd: env.root,
      requireSelf: false, projectRoot: env.root, store: env.store,
      sessionOpts: () => ({}) as never, waitForCompletion: wait,
    });
    expect(out.ok).toBe(false);
    expect(wait).toHaveBeenCalledTimes(3);
  });
});

describe('superseded lifecycle', () => {
  it('holds while the superseder lives, releases if it is deleted unfinished', () => {
    const env = setup();
    env.store.update(A, { supersededBy: SRC });
    expect(isHeldBySuperseder(env.store.getById(A)!, env.store.getAll(), id => env.store.isTaskCompleted(id))).toBe(true);
    env.store.delete(SRC);
    expect(isHeldBySuperseder(env.store.getById(A)!, env.store.getAll(), id => env.store.isTaskCompleted(id))).toBe(false);
  });

  it('deletes the ticket once the superseder completed, never a running one', () => {
    const env = setup();
    env.store.update(A, { supersededBy: SRC });
    env.store.update(B, { supersededBy: SRC });
    env.store.updatePhase(B, 'spec');
    env.store.updatePhase(SRC, 'done');
    env.store.delete(SRC);
    expect(finalizeSupersededTickets(env.store)).toEqual([A]);
    expect(env.store.getById(B)).not.toBeNull();
  });
});

describe('evidence trigger (implement subtasks)', () => {
  it('globToRegExp: ** spans directories, * stays in a segment', () => {
    expect(globToRegExp('scripts/sweep_logs/**').test('scripts/sweep_logs/a/b.log')).toBe(true);
    expect(globToRegExp('scripts/*.log').test('scripts/a.log')).toBe(true);
    expect(globToRegExp('scripts/*.log').test('scripts/x/a.log')).toBe(false);
    expect(globToRegExp('**/*.jsonl').test('a.jsonl')).toBe(true);
    expect(globToRegExp('a.b').test('axb')).toBe(false);
  });

  it('matches changed repo files and recent files under the task folder', () => {
    const env = setup();
    mkdirSync(join(env.specPath, 'probe'), { recursive: true });
    const since = Date.now() - 1000;
    writeFileSync(join(env.specPath, 'probe', 'run.jsonl'), '{}');
    const hits = evidenceProduced({
      patterns: ['scripts/sweep_logs/**', '$TEAMAI_SPEC_DIR/probe/**'],
      changedFiles: ['src/main/x.scala', 'scripts/sweep_logs/new.log'],
      specPath: env.specPath, since,
    });
    expect(hits.sort()).toEqual(['$TEAMAI_SPEC_DIR/probe/run.jsonl', 'scripts/sweep_logs/new.log']);
    expect(evidenceProduced({ patterns: ['$TEAMAI_SPEC_DIR/probe/**'], changedFiles: [], specPath: env.specPath, since: Date.now() + 60_000 }))
      .toEqual([]);
  });

  it('optional: a missing file means nothing to report, but a written file is still verified', async () => {
    const env = setup();
    vi.spyOn(processManager, 'createSession').mockResolvedValue('s' as never);
    vi.spyOn(processManager, 'sendMessage').mockImplementation(() => undefined as never);
    vi.spyOn(processManager, 'killSession').mockImplementation(() => undefined as never);
    const base = {
      specPath: env.specPath, unit: 'st2', unitLabel: 'Subtask 2', taskId: SRC, role: 'coder' as const, cwd: env.root,
      requireSelf: false, projectRoot: env.root, store: env.store, sessionOpts: () => ({}) as never, optional: true,
    };
    prepareBacklogCheck({ specPath: env.specPath, unit: 'st2', store: env.store, ownTaskId: SRC, requireSelf: false, optionalUnlessEvidence: [] });
    const idle = vi.fn(async () => undefined);
    expect((await runBacklogCheck({ ...base, waitForCompletion: idle })).ok).toBe(true);
    expect(idle).not.toHaveBeenCalled();

    prepareBacklogCheck({ specPath: env.specPath, unit: 'st2', store: env.store, ownTaskId: SRC, requireSelf: false, optionalUnlessEvidence: [] });
    writeCheck(env.specPath, 'st2', { tickets: [{ id: A, verdict: 'update', reason: 'new evidence' }] }); // misses B
    const fix = vi.fn(async () => writeCheck(env.specPath, 'st2', { tickets: [{ id: A, verdict: 'update', reason: 'new evidence' }, { id: B, verdict: 'unrelated', reason: '' }] }));
    expect((await runBacklogCheck({ ...base, waitForCompletion: fix })).ok).toBe(true);
    expect(fix).toHaveBeenCalledTimes(1);
  });

  it('the header says when an implement subtask must check', () => {
    const env = setup();
    const h = prepareBacklogCheck({ specPath: env.specPath, unit: 'st3', store: env.store, ownTaskId: SRC, requireSelf: false, optionalUnlessEvidence: ['scripts/sweep_logs/**'] });
    expect(h).toContain('required only if');
    expect(h).toContain('`scripts/sweep_logs/**`');
  });
});
