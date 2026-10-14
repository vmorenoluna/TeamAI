import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'fs';
import os from 'os';
import path from 'path';

const created: string[] = [];
vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    createSession: vi.fn(async () => 'sess-' + created.length),
    sendMessage: vi.fn((_id: string, msg: string) => { created.push(msg); }),
    killSession: vi.fn(),
  },
}));
vi.mock('../../src/lib/command-templates', () => ({
  renderCommand: (_name: string, args: string) => args,
}));

import {
  writeScopeReport, listPendingScopeReports, readScopeRejections, runScopeArbitration,
  integrateHeldSubtasks, writeScopeBudgetFailReport, scopeReportPath,
  type ScopeArbitrationDeps, type ScopeReport,
} from '../../src/lib/orchestrator/scope-arbitration';
import type { TaskPipeline } from '../../src/lib/orchestrator/types';

const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();

let root: string;
let repo: string;
let spec: string;
let verdictsToWrite: unknown;
let sessions: number;

function commitFile(rel: string, content: string, msg = 'c') {
  mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true });
  writeFileSync(path.join(repo, rel), content);
  git(repo, 'add', '-A');
  git(repo, 'commit', '-m', msg);
}

function plan(subtasks: unknown[]) {
  writeFileSync(path.join(spec, 'plan.json'), JSON.stringify({ subtasks }, null, 2));
}
const st = (id: number, files: string[], extra: Record<string, unknown> = {}) =>
  ({ id, title: 't' + id, description: '', files, acceptance_criteria: [], ...extra });

function makePipeline(): TaskPipeline {
  return { taskId: 't', specPath: spec, worktreePath: repo, branch: 'feat' } as unknown as TaskPipeline;
}

let completed: number[];
function makeDeps(): ScopeArbitrationDeps {
  return {
    projectRoot: repo,
    sessionOpts: (role, cwd, taskId) => ({ taskId, role, cwd }),
    waitForCompletion: async () => {
      sessions++;
      if (verdictsToWrite !== undefined) {
        const v = typeof verdictsToWrite === 'function' ? (verdictsToWrite as () => unknown)() : verdictsToWrite;
        if (v !== null) writeFileSync(path.join(spec, 'scope_verdicts.json'), JSON.stringify(v));
      }
      // The planner's own plan.json edits must be ignored
      writeFileSync(path.join(spec, 'plan.json'), JSON.stringify({ subtasks: [] }));
    },
    toAgentPath: p => p,
    planWriteLock: { current: Promise.resolve() },
    savePipelineState: vi.fn(),
    execGit: (args, cwd) => { execFileSync('git', args, { cwd, stdio: 'pipe' }); },
    execGitCapture: (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }),
    tryCherryPickWithRecovery: async (_p, _l, ref) => {
      try { git(repo, 'cherry-pick', `feat..${ref}`); return true; } catch { return false; }
    },
    verifySubtaskDeliverables: () => 'ok',
    filesAlreadyChangedOnBranch: () => false,
    completeSubtask: async (_p, s, _c, _pre, ids) => { ids.push(s.id); completed.push(s.id); return true; },
  };
}

const log = () => readFileSync(path.join(spec, 'output.log'), 'utf-8');
const cfg = { maxScopeStall: 2, maxScopeReplans: 6 };

beforeEach(() => {
  created.length = 0; sessions = 0; completed = []; verdictsToWrite = undefined;
  root = mkdtempSync(path.join(os.tmpdir(), 'scope-arb-'));
  repo = path.join(root, 'repo'); spec = path.join(root, 'spec');
  mkdirSync(repo); mkdirSync(spec);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@t'); git(repo, 'config', 'user.name', 't');
  git(repo, 'config', 'commit.gpgsign', 'false');
  commitFile('a.ts', 'a\n'); commitFile('b.ts', 'b\n'); commitFile('x.md', 'x\n');
  git(repo, 'checkout', '-q', '-b', 'feat');
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

/** Subtask branch off feat editing the given files; returns session head. */
function heldBranch(name: string, edits: Record<string, string | Buffer>): string {
  git(repo, 'checkout', '-q', '-b', name, 'feat');
  for (const [f, c] of Object.entries(edits)) writeFileSync(path.join(repo, f), c);
  git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'work');
  const head = git(repo, 'rev-parse', 'HEAD');
  git(repo, 'checkout', '-q', 'feat');
  return head;
}

function report(id: number, over: Partial<Omit<ScopeReport, 'unlisted'>> & { unlisted: string[] }): ScopeReport {
  const base = git(repo, 'rev-parse', 'feat');
  return writeScopeReport(makeDeps(), {
    specPath: spec, cwd: repo, subtaskId: id, base,
    sessionHead: over.session_head ?? git(repo, 'rev-parse', 'feat'), heldRef: over.held_ref ?? null,
    declaredFiles: over.declared_files ?? ['a.ts'], unlistedPaths: over.unlisted,
  });
}

describe('scope report', () => {
  it('records numstat, null for binary, notes reason; ignores unknown notes and removes notes file', () => {
    const head = heldBranch('feat-st1', { 'b.ts': 'b\nb2\n', 'bin.dat': Buffer.from([0, 1, 2, 0, 255]) });
    writeFileSync(path.join(spec, 'scope_notes-st1.json'), JSON.stringify({
      files: [{ path: 'b.ts', reason: 'X' }, { path: 'zzz.ts', reason: 'ignored' }],
    }));
    const r = report(1, { unlisted: ['b.ts', 'bin.dat'], session_head: head, held_ref: 'feat-st1' });
    expect(r.unlisted[0]).toMatchObject({ path: 'b.ts', insertions: 1, deletions: 0, coder_reason: 'X' });
    expect(r.unlisted[1]).toMatchObject({ path: 'bin.dat', insertions: null, deletions: null, coder_reason: null });
    expect(JSON.stringify(r)).not.toContain('zzz');
    expect(existsSync(path.join(spec, 'scope_notes-st1.json'))).toBe(false);
    expect(listPendingScopeReports(spec).map(x => x.subtask_id)).toEqual([1]);
    expect(existsSync(scopeReportPath(spec, 1) + '.tmp')).toBe(false);
  });

  it('logs and deletes malformed notes', () => {
    writeFileSync(path.join(spec, 'scope_notes-st2.json'), '{nope');
    report(2, { unlisted: ['b.ts'] });
    expect(log()).toContain('[SCOPE] Ignoring malformed scope_notes-st2.json');
    expect(existsSync(path.join(spec, 'scope_notes-st2.json'))).toBe(false);
  });
});

describe('runScopeArbitration', () => {
  const verdicts = (v: unknown[], serialize: unknown[] = []) => ({ verdicts: v, serialize });
  const ap = (id: number, p: string) => ({ subtask_id: id, path: p, verdict: 'approve', reason: 'needed' });
  const rj = (id: number, p: string) => ({ subtask_id: id, path: p, verdict: 'reject', reason: 'unrelated' });

  function setupHeld() {
    plan([st(1, ['a.ts'])]);
    const head = heldBranch('feat-st1', { 'a.ts': 'a2\n', 'b.ts': 'b2\n' });
    report(1, { unlisted: ['b.ts'], session_head: head, held_ref: 'feat-st1' });
  }

  it('starts one planner session with the arbitration header, maps it, ignores plan edits (approve -> integrate without re-run)', async () => {
    setupHeld();
    verdictsToWrite = verdicts([ap(1, 'b.ts')]);
    const pipeline = makePipeline(); const deps = makeDeps();
    const res = await runScopeArbitration(pipeline, deps, cfg);
    expect(res.status).toBe('applied');
    expect(sessions).toBe(1);
    expect(created[0]).toMatch(/^ℹ️ SCOPE ARBITRATION/);
    expect(created[0]).toContain(scopeReportPath(spec, 1));
    expect(created[0]).toContain('scope_verdicts.json');
    expect(created[0]).not.toContain('BACKLOG CHECK');
    expect(JSON.parse(readFileSync(path.join(spec, 'session_map.json'), 'utf-8'))['scope-replan']).toBeTruthy();
    const written = JSON.parse(readFileSync(path.join(spec, 'plan.json'), 'utf-8'));
    expect(written.subtasks[0].files).toEqual(['a.ts', 'b.ts']);
    expect(pipeline.scopeReplanCount).toBe(1);
    expect(pipeline.scopeRoundHistory![1][0].approved).toEqual(['1:b.ts']);
    expect(log()).toContain('[SCOPE-REPLAN] Applied 1 approval(s), 0 rejection(s), 0 serialization(s)');

    const out = await integrateHeldSubtasks(pipeline, deps, res as never, []);
    expect(out.completed).toEqual([1]);
    expect(readFileSync(path.join(repo, 'b.ts'), 'utf-8')).toBe('b2\n');
    expect(log()).toContain('[SCOPE-REPLAN] Subtask 1 integrated without a re-run');
    expect(existsSync(scopeReportPath(spec, 1))).toBe(false);
    expect(git(repo, 'branch', '--list', 'feat-st1')).toBe('');
  });

  it('reject drops the path (held_ref) and records rejections; rejected-only change re-runs', async () => {
    plan([st(1, ['a.ts'])]);
    const head = heldBranch('feat-st1', { 'b.ts': 'b2\n' });
    report(1, { unlisted: ['b.ts'], session_head: head, held_ref: 'feat-st1' });
    verdictsToWrite = verdicts([rj(1, 'b.ts')]);
    const pipeline = makePipeline(); const deps = makeDeps();
    const res = await runScopeArbitration(pipeline, deps, cfg);
    const out = await integrateHeldSubtasks(pipeline, deps, res as never, []);
    expect(out.completed).toEqual([]);
    expect(readFileSync(path.join(repo, 'b.ts'), 'utf-8')).toBe('b\n');
    expect(readScopeRejections(spec)).toEqual({ '1': [{ path: 'b.ts', reason: 'unrelated' }] });
    expect(log()).toContain('[VERIFY] Subtask 1 ended without touching any of its assigned files — no edit was made:');
    expect(log()).toContain('[VERIFY] Subtask 1 rejected — will re-run');
    expect(JSON.parse(readFileSync(path.join(spec, 'plan.json'), 'utf-8')).subtasks[0].completed).toBeUndefined();
    expect(log()).not.toContain('integrated without a re-run');
  });

  it('reject drops the path in place (no held_ref) while keeping listed work', async () => {
    plan([st(1, ['a.ts'])]);
    const base = git(repo, 'rev-parse', 'feat');
    writeFileSync(path.join(repo, 'a.ts'), 'a2\n'); writeFileSync(path.join(repo, 'b.ts'), 'b2\n');
    writeFileSync(path.join(repo, 'new.ts'), 'n\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-m', 'work');
    const head = git(repo, 'rev-parse', 'HEAD');
    writeScopeReport(makeDeps(), { specPath: spec, cwd: repo, subtaskId: 1, base, sessionHead: head, heldRef: null, declaredFiles: ['a.ts'], unlistedPaths: ['b.ts', 'new.ts'] });
    verdictsToWrite = verdicts([rj(1, 'b.ts'), rj(1, 'new.ts')]);
    const pipeline = makePipeline(); const deps = makeDeps();
    const res = await runScopeArbitration(pipeline, deps, cfg);
    const out = await integrateHeldSubtasks(pipeline, deps, res as never, []);
    expect(readFileSync(path.join(repo, 'b.ts'), 'utf-8')).toBe('b\n');
    expect(existsSync(path.join(repo, 'new.ts'))).toBe(false);
    expect(readFileSync(path.join(repo, 'a.ts'), 'utf-8')).toBe('a2\n');
    expect(git(repo, 'log', '-1', '--format=%s')).toBe('chore(scope): drop changes rejected by the planner for subtask 1');
    expect(out.completed).toEqual([1]);
  });

  describe('invalid verdicts', () => {
    const cases: Array<[string, () => unknown]> = [
      ['missing file', () => null],
      ['unparseable', () => 'x'],
      ['missing verdict for a pair', () => verdicts([ap(1, 'b.ts')])],
      ['several verdicts', () => verdicts([ap(1, 'b.ts'), rj(1, 'b.ts'), ap(1, 'x.md')])],
      ['bad verdict value', () => verdicts([{ subtask_id: 1, path: 'b.ts', verdict: 'maybe', reason: 'r' }, ap(1, 'x.md')])],
      ['empty reason', () => verdicts([{ ...ap(1, 'b.ts'), reason: ' ' }, ap(1, 'x.md')])],
      ['pair not in action', () => verdicts([ap(1, 'b.ts'), ap(1, 'x.md'), ap(1, 'nope.ts')])],
      ['serialize names subtask not in action', () => verdicts([ap(1, 'b.ts'), ap(1, 'x.md')], [{ subtask_id: 2, parallel_group: 'Z' }])],
      ['depends_on non-existent id', () => verdicts([ap(1, 'b.ts'), ap(1, 'x.md')], [{ subtask_id: 1, parallel_group: 'Z', depends_on: [99] }])],
      ['depends_on itself', () => verdicts([ap(1, 'b.ts'), ap(1, 'x.md')], [{ subtask_id: 1, parallel_group: 'Z', depends_on: [1] }])],
      ['cycle', () => verdicts([ap(1, 'b.ts'), ap(1, 'x.md')], [{ subtask_id: 1, parallel_group: 'Z', depends_on: [2] }])],
      ['shared file in same group', () => verdicts([ap(1, 'b.ts'), ap(1, 'x.md')])],
    ];
    it.each(cases)('%s leaves plan/hold intact, +1 stall, no new round record', async (name, v) => {
      plan([
        st(1, ['a.ts'], { parallel_group: 'B' }),
        st(2, ['x.md'], { parallel_group: 'B', depends_on: name === 'cycle' ? [1] : [] }),
      ]);
      const head = heldBranch('feat-st1', { 'b.ts': 'b2\n', 'x.md': 'x2\n' });
      report(1, { unlisted: ['b.ts', 'x.md'], session_head: head, held_ref: 'feat-st1' });
      const before = readFileSync(path.join(spec, 'plan.json'), 'utf-8');
      verdictsToWrite = v;
      // plan.json edits by the mock planner must not leak: restore comparison against recorded bytes
      const pipeline = makePipeline(); const deps = makeDeps();
      const mockWait = deps.waitForCompletion;
      deps.waitForCompletion = async id => { await mockWait(id); writeFileSync(path.join(spec, 'plan.json'), before); };
      const res = await runScopeArbitration(pipeline, deps, cfg);
      expect(res.status).toBe('exhausted');
      expect(readFileSync(path.join(spec, 'plan.json'), 'utf-8')).toBe(before);
      expect(existsSync(scopeReportPath(spec, 1))).toBe(true);
      expect(git(repo, 'branch', '--list', 'feat-st1')).not.toBe('');
      expect(log()).toContain('[SCOPE-REPLAN] Invalid scope verdicts:');
      expect(pipeline.scopeStallCounts![1]).toBe(2); // 1 for the no-progress round + 1 for the invalid file
      expect(pipeline.scopeRoundHistory![1]).toHaveLength(1);
    });
  });

  it('AC20: approve + serialize puts subtask 3 in group B.2 depending on 2', async () => {
    plan([st(2, ['b.ts'], { parallel_group: 'B' }), st(3, ['a.ts'], { parallel_group: 'B' })]);
    const head = heldBranch('feat-st3', { 'x.md': 'x2\n' });
    report(3, { unlisted: ['x.md'], session_head: head, held_ref: 'feat-st3' });
    verdictsToWrite = verdicts([ap(3, 'x.md')], [{ subtask_id: 3, parallel_group: 'B.2', depends_on: [2] }]);
    const res = await runScopeArbitration(makePipeline(), makeDeps(), cfg);
    expect(res.status).toBe('applied');
    const s3 = JSON.parse(readFileSync(path.join(spec, 'plan.json'), 'utf-8')).subtasks[1];
    expect(s3.files).toEqual(expect.arrayContaining(['x.md']));
    expect(s3.parallel_group).toBe('B.2');
    expect(s3.depends_on).toEqual(expect.arrayContaining([2]));
    expect(log()).toContain('1 serialization(s)');
  });

  it('invalid then retry: second session with stall 3, exhausted with default 2', async () => {
    setupHeld();
    let n = 0;
    verdictsToWrite = () => (++n === 1 ? null : verdicts([ap(1, 'b.ts')]));
    const pipeline = makePipeline();
    const res = await runScopeArbitration(pipeline, makeDeps(), { maxScopeStall: 3, maxScopeReplans: 6 });
    expect(res.status).toBe('applied');
    expect(sessions).toBe(2);
    expect(pipeline.scopeReplanCount).toBe(2);
    expect(pipeline.scopeRoundHistory![1]).toHaveLength(1);

    n = 0; sessions = 0;
    const p2 = makePipeline();
    expect((await runScopeArbitration(p2, makeDeps(), cfg)).status).toBe('exhausted');
    expect(sessions).toBe(1);
  });

  it('exhausts on a repeating report (stall) without starting a session, and on the rounds cap', async () => {
    plan([st(1, ['a.ts'])]);
    const head = heldBranch('feat-st1', { 'b.ts': 'b2\n' });
    report(1, { unlisted: ['b.ts'], session_head: head, held_ref: 'feat-st1' });
    const pipeline = makePipeline();
    pipeline.scopeStallCounts = { 1: 1 };
    pipeline.scopeRoundHistory = { 1: [{ round: 1, failed: ['1:b.ts'], passed: [], approved: [] }] };
    pipeline.scopeReplanCount = 1;
    const res = await runScopeArbitration(pipeline, makeDeps(), cfg);
    expect(res).toMatchObject({ status: 'exhausted', budget: 'stall', subtaskIds: [1], files: ['b.ts'] });
    expect(sessions).toBe(0);

    const p2 = makePipeline();
    p2.scopeReplanCount = 6;
    const res2 = await runScopeArbitration(p2, makeDeps(), cfg);
    expect(res2).toMatchObject({ status: 'exhausted', budget: 'rounds' });
    expect(sessions).toBe(0);
    expect(p2.scopeReplanCount).toBe(6);

    writeScopeBudgetFailReport(spec, res as never);
    const qa = JSON.parse(readFileSync(path.join(spec, 'qa_report.json'), 'utf-8'));
    expect(qa.overall).toBe('FAIL');
    expect(qa.criteria[0].criterion).toBe('Scope arbitration budget');
    expect(qa.criteria[0].notes).toMatch(/stall[\s\S]*1[\s\S]*b\.ts/);
  });

  it('returns none without reports', async () => {
    plan([st(1, ['a.ts'])]);
    expect(await runScopeArbitration(makePipeline(), makeDeps(), cfg)).toEqual({ status: 'none', actionStarted: false });
  });
});
