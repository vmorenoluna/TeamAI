// @vitest-environment node

/**
 * Unit tests for the helpers extracted from runSubtaskSession: criteria
 * filtering, pre/post-subtask sensors, stall-recovery header, wakeup-file
 * consumption, deliverable verification and the scope check.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import type { execFileSync as ExecFileSyncFn } from 'child_process';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockRunSensors, mockExecFileSync } = vi.hoisted(() => ({
  mockRunSensors: vi.fn(),
  mockExecFileSync: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(), off: vi.fn(), emit: vi.fn(), createSession: vi.fn(), sendMessage: vi.fn(),
    killSession: vi.fn(), getSession: vi.fn(), getAllSessions: vi.fn(() => []),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('child_process', () => ({
  // Callback-form execFile (promisified by git-platform): delegate to the sync mock so existing stubs apply.
  execFile: (cmd: string, args: unknown[], opts: unknown, cb?: (...a: unknown[]) => void) => {
    const done = typeof opts === "function" ? opts as (...a: unknown[]) => void : cb;
    try {
      const out = mockExecFileSync(cmd, args, opts);
      done?.(null, { stdout: out == null ? "" : String(out), stderr: "" });
    } catch (e) {
      done?.(e);
    }
  },
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: { ensureContainer: vi.fn(), getRunningContainer: vi.fn(async () => null) },
  hostToContainerPath: vi.fn((p: string) => p),
  checkDockerAvailable: vi.fn(async () => true),
  getCachedDockerAvailable: vi.fn(() => true),
}));

vi.mock('../../src/lib/sensors', () => ({
  runSensors: (...args: unknown[]) => mockRunSensors(...args),
  sensorRunSummary: vi.fn(() => 'SENSOR SUMMARY'),
}));

import {
  filterSubtaskCriteria, runPreSubtaskSensors, runPostSubtaskSensors, buildStallRecoveryHeader,
  consumeSubtaskWakeupFiles, verifySubtaskDeliverables, checkSubtaskScope,
  holdSubtaskForArbitration, integrateGroup, selectSubtasks, buildSubtaskRequest, runImplement,
  type ImplementPipeline, type ImplementDeps,
} from '../../src/lib/orchestrator/implement';
import { processManager } from '../../src/lib/process-manager';
import { ORCHESTRATOR_FAIL_TYPE } from '../../src/lib/orchestrator/types';
import type { PlanSubtask } from '../../src/lib/orchestrator/types';

let specDir: string;
let cwd: string;
let execGitCapture: ReturnType<typeof vi.fn<any[], string>>;
let advancePhase: ReturnType<typeof vi.fn>;
let writeCompletionSummary: ReturnType<typeof vi.fn>;
let pipelineConfig: Record<string, unknown>;

function makeSubtask(over: Partial<PlanSubtask> = {}): PlanSubtask {
  return { id: 1, title: 'Subtask', description: 'd', files: [], acceptance_criteria: [], ...over };
}

function makePipeline(over: Partial<ImplementPipeline> = {}): ImplementPipeline {
  return { taskId: 't1', specPath: specDir, worktreePath: cwd, ...over } as unknown as ImplementPipeline;
}

function makeDeps(): ImplementDeps {
  return {
    execGitCapture, advancePhase, writeCompletionSummary,
    getPipelineConfig: () => pipelineConfig,
  } as unknown as ImplementDeps;
}

function outputLog(): string {
  const p = join(specDir, 'output.log');
  return existsSync(p) ? readFileSync(p, 'utf-8') : '';
}

beforeEach(() => {
  const base = join(tmpdir(), 'subtask-helpers-' + randomUUID());
  specDir = join(base, 'spec');
  cwd = join(base, 'wt');
  mkdirSync(specDir, { recursive: true });
  mkdirSync(cwd, { recursive: true });
  execGitCapture = vi.fn<any[], string>(() => '');
  advancePhase = vi.fn();
  writeCompletionSummary = vi.fn();
  pipelineConfig = { maxImplementRetries: 3 };
  mockRunSensors.mockReset();
});

afterEach(() => {
  rmSync(join(specDir, '..'), { recursive: true, force: true });
});

describe('filterSubtaskCriteria', () => {
  const criteria = ['Feature works', '[QA CORRECTION: x]', '[QA ISSUE: y → Fix: z]'];

  it('keeps only the QA entries on a QA rework', () => {
    const r = filterSubtaskCriteria(makeSubtask({ acceptance_criteria: criteria }), true);
    expect(r.qaOnlyCriteria).toEqual(['[QA CORRECTION: x]', '[QA ISSUE: y → Fix: z]']);
    expect(r.criteriaLine.startsWith('QA issues to fix: ')).toBe(true);
  });

  it('returns a fallback line when a QA rework has no QA entries', () => {
    const r = filterSubtaskCriteria(makeSubtask({ acceptance_criteria: ['Feature works'] }), true);
    expect(r.qaOnlyCriteria).toEqual([]);
    expect(r.criteriaLine).toBe('No specific QA criteria for this subtask — see the QA feedback above for issues to address.');
  });

  it('returns every criterion without QA feedback', () => {
    const r = filterSubtaskCriteria(makeSubtask({ acceptance_criteria: criteria }), false);
    expect(r.qaOnlyCriteria).toEqual(criteria);
    expect(r.criteriaLine).toBe('Acceptance criteria: ' + criteria.join('; '));
  });
});

describe('runPreSubtaskSensors', () => {
  it('resolves and logs when runSensors rejects', async () => {
    pipelineConfig = { sensors: { pre_subtask: [{ name: 'a' }] } };
    mockRunSensors.mockRejectedValue(new Error('boom'));
    await expect(runPreSubtaskSensors(makePipeline(), makeDeps(), makeSubtask(), cwd, 'log')).resolves.toBeUndefined();
    expect(outputLog()).toContain('[SENSOR:pre_subtask] pre-subtask sensors failed (non-blocking): boom');
  });

  it('does not call runSensors when none are configured', async () => {
    await runPreSubtaskSensors(makePipeline(), makeDeps(), makeSubtask(), cwd, 'log');
    expect(mockRunSensors).not.toHaveBeenCalled();
  });
});

describe('runPostSubtaskSensors', () => {
  beforeEach(() => {
    pipelineConfig = { sensors: { post_subtask: [{ name: 'lint' }] } };
  });

  it('writes a FAIL sensor report for a failing sensor', async () => {
    mockRunSensors.mockResolvedValue({ allPassed: false, reports: [{ sensor: 'lint', passed: false, exitCode: 2 }] });
    await runPostSubtaskSensors(makePipeline(), makeDeps(), makeSubtask({ id: 4, title: 'T4' }), cwd, 'log');
    const report = JSON.parse(readFileSync(join(specDir, 'sensor_report-st4.json'), 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].sensor).toBe('lint');
    expect(report.failures[0].error).toBe('exit code 2');
  });

  it('writes no report when all sensors pass', async () => {
    mockRunSensors.mockResolvedValue({ allPassed: true, reports: [{ sensor: 'lint', passed: true, exitCode: 0 }] });
    await runPostSubtaskSensors(makePipeline(), makeDeps(), makeSubtask({ id: 4 }), cwd, 'log');
    expect(existsSync(join(specDir, 'sensor_report-st4.json'))).toBe(false);
  });

  it('resolves and logs when runSensors rejects', async () => {
    mockRunSensors.mockRejectedValue(new Error('kaput'));
    await expect(runPostSubtaskSensors(makePipeline(), makeDeps(), makeSubtask({ id: 4 }), cwd, 'log')).resolves.toBeUndefined();
    expect(outputLog()).toContain('[SENSOR:post_subtask] post-subtask sensors error:');
  });
});

describe('buildStallRecoveryHeader', () => {
  const cfg = { idleStallMinutes: 7, toolStallMinutes: 31 };
  const prefix = '⚠️ SESSION RECOVERED AFTER STALL-KILL (attempt 2/3)';

  it('describes an idle stall', () => {
    const h = buildStallRecoveryHeader('idle', 2, 3, cfg);
    expect(h.startsWith(prefix)).toBe(true);
    expect(h).toContain('over 7 minutes while IDLE');
  });

  it('describes a tool stall', () => {
    const h = buildStallRecoveryHeader('tool', 2, 3, cfg);
    expect(h.startsWith(prefix)).toBe(true);
    expect(h).toContain('over 31 minutes while a tool was running');
  });

  it('falls through to the tool variant when the kind is undefined', () => {
    const h = buildStallRecoveryHeader(undefined, 2, 3, cfg);
    expect(h.startsWith(prefix)).toBe(true);
    expect(h).toContain('over 31 minutes while a tool was running');
  });
});

describe('consumeSubtaskWakeupFiles', () => {
  const wakeup = (id: number, at: string) => JSON.stringify({
    subtask_id: id, wakeup_at: at, background_command: 'cmd' + id, expected_artifact: 'out.txt',
  });

  beforeEach(() => {
    execGitCapture.mockReturnValue('headsha\n');
  });

  it('consumes a wakeup file written for another subtask', async () => {
    const file = join(specDir, 'subtask_wakeup-st7.json');
    writeFileSync(file, wakeup(7, '2030-01-01T00:00:00Z'));
    const pipeline = makePipeline();
    const detected = await consumeSubtaskWakeupFiles(pipeline, makeDeps(), makeSubtask({ id: 8 }), cwd, false);
    expect(detected).toBe(true);
    expect(pipeline.wakeupSubtaskId).toBe(7);
    expect(existsSync(file)).toBe(false);
  });

  it('adopts the earliest wakeup_at across subtasks', async () => {
    writeFileSync(join(specDir, 'subtask_wakeup-st2.json'), wakeup(2, '2030-01-02T00:00:00Z'));
    writeFileSync(join(specDir, 'subtask_wakeup-st3.json'), wakeup(3, '2030-01-01T00:00:00Z'));
    const pipeline = makePipeline();
    const detected = await consumeSubtaskWakeupFiles(pipeline, makeDeps(), makeSubtask({ id: 4 }), cwd, false);
    expect(detected).toBe(true);
    expect(pipeline.wakeupUntil).toBe('2030-01-01T00:00:00Z');
  });

  it('treats a malformed file as missing and deletes it', async () => {
    const file = join(specDir, 'subtask_wakeup-st5.json');
    writeFileSync(file, '{not json');
    const pipeline = makePipeline();
    const detected = await consumeSubtaskWakeupFiles(pipeline, makeDeps(), makeSubtask({ id: 5 }), cwd, false);
    expect(detected).toBe(false);
    expect(outputLog()).toContain('[WAKEUP] Malformed subtask_wakeup-st5.json — treating as missing');
    expect(existsSync(file)).toBe(false);
  });
});

describe('verifySubtaskDeliverables', () => {
  it('returns incomplete and counts the first failure', async () => {
    const pipeline = makePipeline();
    const r = await verifySubtaskDeliverables(pipeline, makeDeps(), makeSubtask({ id: 6, files_to_create: ['out/a.txt'] }), cwd);
    expect(r).toBe('incomplete');
    expect(pipeline.deliverableFailCounts?.[6]).toBe(1);
    expect(advancePhase).not.toHaveBeenCalled();
  });

  it('fails the task once the retry cap is reached', async () => {
    const pipeline = makePipeline({ deliverableFailCounts: { 6: 2 } });
    const r = await verifySubtaskDeliverables(pipeline, makeDeps(), makeSubtask({ id: 6, files_to_create: ['out/a.txt'] }), cwd);
    expect(r).toBe('failed');
    const report = JSON.parse(readFileSync(join(specDir, 'qa_report.json'), 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(advancePhase).toHaveBeenCalledWith(pipeline, 'failed');
  });

  it('returns ok when every deliverable is committed', async () => {
    mkdirSync(join(cwd, 'out'));
    writeFileSync(join(cwd, 'out/a.txt'), 'x');
    const r = await verifySubtaskDeliverables(makePipeline(), makeDeps(), makeSubtask({ files_to_create: ['out/a.txt'] }), cwd);
    expect(r).toBe('ok');
  });
});

describe('checkSubtaskScope', () => {
  it('returns files outside files ∪ files_to_create as unlisted without rejecting', async () => {
    execGitCapture.mockReturnValue('src/a.ts\nnew.ts\nstray.ts\n');
    const violations = new Set<number>();
    const result = await checkSubtaskScope(
      makePipeline(), makeDeps(), makeSubtask({ id: 3, files: ['src/a.ts'], files_to_create: ['new.ts'] }),
      cwd, 'abc123', join(specDir, 'st3.log'), violations,
    );
    expect(violations.has(3)).toBe(false);
    expect(result.changedFiles).toEqual(['src/a.ts', 'new.ts', 'stray.ts']);
    expect(result.unlistedFiles).toEqual(['stray.ts']);
  });

  it('skips the check for the QA-fallback subtask 9999', async () => {
    const violations = new Set<number>();
    const result = await checkSubtaskScope(
      makePipeline(), makeDeps(), makeSubtask({ id: 9999, files: ['a.ts'] }),
      cwd, 'abc123', join(specDir, 'st9999.log'), violations,
    );
    expect(execGitCapture).not.toHaveBeenCalled();
    expect(violations.size).toBe(0);
    expect(result).toEqual({ changedFiles: [], unlistedFiles: [] });
  });

  it('returns empty lists and holds nothing when git diff fails', async () => {
    execGitCapture.mockImplementation(() => { throw new Error('boom'); });
    const violations = new Set<number>();
    const result = await checkSubtaskScope(
      makePipeline(), makeDeps(), makeSubtask({ id: 4, files: ['a.ts'] }),
      cwd, 'abc123', join(specDir, 'st4.log'), violations,
    );
    expect(result).toEqual({ changedFiles: [], unlistedFiles: [] });
    expect(violations.size).toBe(0);
    expect(outputLog()).toContain('[SCOPE] Could not verify file scope (git diff failed: boom)');
  });
  it('accepts a no-edit session when every assigned file already differs from the base branch (AC11)', async () => {
    execGitCapture.mockImplementation((args: string[]) => (args[0] === 'diff' && args[2].includes('...HEAD') ? 'src/a.ts\n' : ''));
    const violations = new Set<number>();
    const deps = { ...makeDeps(), projectRoot: cwd } as unknown as ImplementDeps;
    await checkSubtaskScope(
      makePipeline(), deps, makeSubtask({ id: 5, files: ['src/a.ts'] }),
      cwd, 'abc123', join(specDir, 'st5.log'), violations,
    );
    expect(violations.has(5)).toBe(false);
    expect(outputLog()).toContain('made no edit this session, but its assigned files are already changed on the branch — accepting');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
//  Hold-and-arbitrate — real git
// ═══════════════════════════════════════════════════════════════════════════

describe('scope hold and arbitration (real git)', async () => {
  let realExec: typeof ExecFileSyncFn;
  let repo: string;
  let sessionCount: number;
  let verdictsWriter: (() => unknown) | undefined;
  let cfgOverrides: Record<string, unknown>;

  const git = (dir: string, ...args: string[]) => realExec('git', args, { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }).trim();
  const read = (rel: string) => readFileSync(join(repo, rel), 'utf-8').split(String.fromCharCode(13, 10)).join(String.fromCharCode(10));
  const readJson = (file: string) => JSON.parse(readFileSync(join(specDir, file), 'utf-8'));
  const sentMessages = () => (processManager.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls.map(c => String(c[1]));

  function commit(dir: string, files: Record<string, string>, msg = 'work') {
    for (const [f, c] of Object.entries(files)) {
      mkdirSync(join(dir, f, '..'), { recursive: true });
      writeFileSync(join(dir, f), c);
    }
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', msg);
  }

  function writePlan(subtasks: unknown[]) {
    writeFileSync(join(specDir, 'plan.json'), JSON.stringify({ subtasks }, null, 2));
  }
  const st = (id: number, files: string[], extra: Record<string, unknown> = {}) =>
    ({ id, title: 't' + id, description: 'd', files, acceptance_criteria: [], ...extra }) as PlanSubtask;

  function pipelineFor(over: Record<string, unknown> = {}): ImplementPipeline {
    return {
      taskId: 't1', specPath: specDir, worktreePath: repo, branch: 'feat', phase: 'implement', ...over,
    } as unknown as ImplementPipeline;
  }

  function realDeps(): ImplementDeps {
    return {
      projectRoot: repo,
      execGit: (args: string[], dir: string) => { realExec('git', args, { cwd: dir, stdio: 'pipe' }); },
      execGitCapture: (args: string[], dir: string) => realExec('git', args, { cwd: dir, encoding: 'utf-8', stdio: 'pipe' }) as string,
      advancePhase: vi.fn((p: ImplementPipeline, phase: string) => { (p as any).phase = phase; }),
      executePhase: vi.fn(async () => undefined),
      persistAndEmitPhase: vi.fn(),
      restoreQaReportFromSnapshot: vi.fn(),
      restoreHumanFeedbackFromSnapshot: vi.fn(),
      cleanStaleSubtaskWorktrees: vi.fn(async () => undefined),
      gitPush: vi.fn(),
      isWorktreeHealthy: () => true,
      phaseHeader: vi.fn(),
      scheduleWakeup: vi.fn(),
      savePipelineState: vi.fn(),
      writeCompletionSummary,
      planWriteLock: { current: Promise.resolve() },
      sessionOpts: (role: string, cwd: string, taskId: string) => ({ taskId, role, cwd }),
      waitForCompletion: async () => {
        sessionCount++;
        const w = verdictsWriter?.();
        if (w !== undefined && w !== null) writeFileSync(join(specDir, 'scope_verdicts.json'), JSON.stringify(w));
      },
      getPipelineConfig: () => ({
        maxQaAttempts: 3, parallelSubtasks: true, maxImplementRetries: 3, maxStallRecoveries: 2,
        idleStallMinutes: 5, toolStallMinutes: 30, backlogCheck: false, ...cfgOverrides,
      }),
    } as unknown as ImplementDeps;
  }

  /** A subtask worked in an isolated worktree on `feat-st<id>`; its commits are held there. */
  async function holdParallel(subtask: PlanSubtask, edits: Record<string, string>, unlisted: string[], deps = realDeps()) {
    const wt = join(specDir, '..', 'wt-st' + subtask.id);
    const base = git(repo, 'rev-parse', 'HEAD');
    git(repo, 'worktree', 'add', '-q', wt, '-b', 'feat-st' + subtask.id, 'feat');
    commit(wt, edits);
    await holdSubtaskForArbitration(pipelineFor(), deps, subtask, wt, base, unlisted);
    git(repo, 'worktree', 'remove', '--force', wt);
    return base;
  }

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import('child_process')>('child_process');
    realExec = actual.execFileSync as typeof ExecFileSyncFn;
    mockExecFileSync.mockImplementation((...a: unknown[]) => (realExec as (...x: unknown[]) => unknown)(...a));
    repo = join(specDir, '..', 'repo');
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    git(repo, 'config', 'user.email', 't@t');
    git(repo, 'config', 'user.name', 't');
    git(repo, 'config', 'commit.gpgsign', 'false');
    commit(repo, { 'a.ts': 'a\n', 'b.ts': 'b\n' }, 'init');
    git(repo, 'checkout', '-q', '-b', 'feat');
    sessionCount = 0;
    verdictsWriter = undefined;
    cfgOverrides = {};
    (processManager.sendMessage as unknown as ReturnType<typeof vi.fn>).mockClear();
    (processManager.createSession as unknown as ReturnType<typeof vi.fn>).mockClear();
    writeCompletionSummary.mockClear();
  });

  afterEach(() => {
    mockExecFileSync.mockReset();
  });

  describe('sequential hold (main worktree)', () => {
    it('moves the session commits to <branch>-st<id>, resets the feature branch and writes the report', async () => {
      const base = git(repo, 'rev-parse', 'HEAD');
      commit(repo, { 'a.ts': 'a\na2\n', 'b.ts': 'b\nb2\n' });
      const sessionHead = git(repo, 'rev-parse', 'HEAD');
      const scopeViolations = new Set<number>();

      const subtask = st(1, ['a.ts']);
      const { unlistedFiles } = await checkSubtaskScope(pipelineFor(), realDeps(), subtask, repo, base, join(specDir, 'st1.log'), scopeViolations);
      expect(unlistedFiles).toEqual(['b.ts']);
      await holdSubtaskForArbitration(pipelineFor(), realDeps(), subtask, repo, base, unlistedFiles);

      expect(scopeViolations.has(1)).toBe(false);
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(base);
      expect(git(repo, 'rev-parse', 'feat-st1')).toBe(sessionHead);
      const report = readJson('scope_report-st1.json');
      expect(report).toMatchObject({
        subtask_id: 1, base, session_head: sessionHead, held_ref: 'feat-st1', declared_files: ['a.ts'],
        unlisted: [{ path: 'b.ts', insertions: 1, deletions: 0, coder_reason: null }],
      });
      const log = outputLog();
      expect(log).toContain('holding its work for planner arbitration');
      expect(log).toContain('  - b.ts');
      expect(log).toContain('[SCOPE] Declared files: a.ts');
      expect(log).toContain("[SCOPE-HOLD] Holding subtask 1's commits on feat-st1 pending scope arbitration");
    });

    it('leaves the commits in place (held_ref null) and never resets when the worktree is dirty', async () => {
      const base = git(repo, 'rev-parse', 'HEAD');
      commit(repo, { 'b.ts': 'b\nb2\n' });
      const sessionHead = git(repo, 'rev-parse', 'HEAD');
      writeFileSync(join(repo, 'a.ts'), 'dirty\n');
      const deps = realDeps();
      const execGit = vi.fn(deps.execGit);
      deps.execGit = execGit;

      await holdSubtaskForArbitration(pipelineFor(), deps, st(1, ['a.ts']), repo, base, ['b.ts']);

      expect(execGit.mock.calls.some(c => c[0][0] === 'reset')).toBe(false);
      expect(git(repo, 'rev-parse', 'HEAD')).toBe(sessionHead);
      expect(readJson('scope_report-st1.json').held_ref).toBeNull();
      expect(outputLog()).toContain('[SCOPE-HOLD] Subtask 1 held in place (worktree has uncommitted changes)');
    });

    it('attaches the coder reason from scope_notes, ignores unknown paths and deletes the notes file', async () => {
      const base = git(repo, 'rev-parse', 'HEAD');
      commit(repo, { 'b.ts': 'b\nb2\n' });
      const notes = join(specDir, 'scope_notes-st1.json');
      writeFileSync(notes, JSON.stringify({ files: [{ path: 'b.ts', reason: 'X' }, { path: 'zzz.ts', reason: 'ignored' }] }));

      await holdSubtaskForArbitration(pipelineFor(), realDeps(), st(1, ['a.ts']), repo, base, ['b.ts']);

      const report = readJson('scope_report-st1.json');
      expect(report.unlisted).toHaveLength(1);
      expect(report.unlisted[0]).toMatchObject({ path: 'b.ts', coder_reason: 'X' });
      expect(existsSync(notes)).toBe(false);
    });
  });

  describe('parallel hold (integrateGroup)', () => {
    it('cherry-picks the sibling, skips the held subtask, removes its worktree but keeps its branch', async () => {
      const pipeline = pipelineFor();
      const deps = realDeps();
      const s1 = st(1, ['a.ts']);
      const s2 = st(2, ['b.ts']);
      const wt1 = join(specDir, '..', 'wt-st1');
      const wt2 = join(specDir, '..', 'wt-st2');
      const base = git(repo, 'rev-parse', 'HEAD');
      git(repo, 'worktree', 'add', '-q', wt1, '-b', 'feat-st1', 'feat');
      git(repo, 'worktree', 'add', '-q', wt2, '-b', 'feat-st2', 'feat');
      commit(wt1, { 'a.ts': 'a\na1\n', 'extra.ts': 'x\n' });
      commit(wt2, { 'b.ts': 'b\nb2\n' });
      await holdSubtaskForArbitration(pipeline, deps, s1, wt1, base, ['extra.ts']);

      const ok = await integrateGroup(
        pipeline, deps, [s1, s2],
        [{ status: 'fulfilled', value: undefined }, { status: 'fulfilled', value: undefined }],
        new Set<number>(), new Map([[1, wt1], [2, wt2]]), join(specDir, 'output.log'),
      );

      expect(ok).toBe(true);
      expect(read('b.ts')).toBe('b\nb2\n');
      expect(read('a.ts')).toBe('a\n');
      expect(existsSync(join(repo, 'extra.ts'))).toBe(false);
      expect(outputLog()).toContain("[SCOPE-HOLD] Holding subtask 1's commits on feat-st1 pending scope arbitration");
      expect(outputLog()).not.toContain('[GROUP-BARRIER]');
      expect(existsSync(wt1)).toBe(false);
      expect(() => git(repo, 'rev-parse', '--verify', 'feat-st1')).not.toThrow();
      expect(() => git(repo, 'rev-parse', '--verify', 'feat-st2')).toThrow();
    });
  });

  describe('selection', () => {
    it('excludes a subtask with a pending scope report and logs it', () => {
      writePlan([st(4, ['a.ts']), st(5, ['b.ts'])]);
      writeFileSync(join(specDir, 'scope_report-st4.json'), JSON.stringify({
        subtask_id: 4, base: 'x', session_head: 'y', held_ref: null, declared_files: [], unlisted: [], created_at: '',
      }));
      const selection = selectSubtasks(pipelineFor());
      expect(selection.effectiveSubtasks.map(s => s.id)).toEqual([5]);
      expect(outputLog()).toContain('[SCOPE-HOLD] Subtask 4 awaiting scope arbitration — not dispatched');
    });

    it('does not take the all-completed skip while a report is pending: arbitration runs instead', async () => {
      writePlan([st(4, ['a.ts'], { completed: false })]);
      const base = git(repo, 'rev-parse', 'HEAD');
      commit(repo, { 'b.ts': 'b\nb2\n' });
      await holdSubtaskForArbitration(pipelineFor(), realDeps(), st(4, ['a.ts']), repo, base, ['b.ts']);
      verdictsWriter = () => ({ verdicts: [{ subtask_id: 4, path: 'b.ts', verdict: 'approve', reason: 'needed' }] });

      await runImplement(pipelineFor(), realDeps());

      expect(outputLog()).not.toContain('[SKIP] All subtasks already completed');
      expect(sessionCount).toBe(1);
    });
  });

  describe('Phase 4 arbitration', () => {
    it('runs ONE planner session for two held subtasks and integrates both on approval', async () => {
      const s1 = st(1, ['a.ts']);
      const s2 = st(2, ['b.ts']);
      writePlan([s1, s2]);
      await holdParallel(s1, { 'a.ts': 'a\na1\n', 'x1.ts': 'x1\n' }, ['x1.ts']);
      await holdParallel(s2, { 'b.ts': 'b\nb1\n', 'x2.ts': 'x2\n' }, ['x2.ts']);
      verdictsWriter = () => ({ verdicts: [
        { subtask_id: 1, path: 'x1.ts', verdict: 'approve', reason: 'needed' },
        { subtask_id: 2, path: 'x2.ts', verdict: 'approve', reason: 'needed' },
      ] });
      const deps = realDeps();
      const sessionOpts = vi.fn(deps.sessionOpts);
      deps.sessionOpts = sessionOpts;
      const pipeline = pipelineFor();

      await runImplement(pipeline, deps);

      expect(sessionCount).toBe(1);
      expect(sessionOpts.mock.calls.filter(c => c[0] === 'planner')).toHaveLength(1);
      const message = sentMessages().find(m => m.includes('ℹ️ SCOPE ARBITRATION'));
      expect(message).toBeDefined();
      expect(message).toContain('scope_report-st1.json');
      expect(message).toContain('scope_report-st2.json');
      expect(pipeline.scopeReplanCount).toBe(1);
      const plan = readJson('plan.json');
      expect(plan.subtasks.find((s: any) => s.id === 1).files).toContain('x1.ts');
      expect(plan.subtasks.find((s: any) => s.id === 2).files).toContain('x2.ts');
      expect(plan.subtasks.every((s: any) => s.completed === true)).toBe(true);
      for (const f of ['a.ts', 'x1.ts', 'b.ts', 'x2.ts']) expect(existsSync(join(repo, f))).toBe(true);
      expect(existsSync(join(specDir, 'scope_report-st1.json'))).toBe(false);
      expect(existsSync(join(specDir, 'scope_report-st2.json'))).toBe(false);
      expect(() => git(repo, 'rev-parse', '--verify', 'feat-st1')).toThrow();
      expect(() => git(repo, 'rev-parse', '--verify', 'feat-st2')).toThrow();
    });

    it('drops a rejected path, completes the subtask without a re-run and records the rejection', async () => {
      const s1 = st(1, ['a.ts']);
      writePlan([s1]);
      await holdParallel(s1, { 'a.ts': 'a\na1\n', 'b.ts': 'b\nb2\n' }, ['b.ts']);
      verdictsWriter = () => ({ verdicts: [{ subtask_id: 1, path: 'b.ts', verdict: 'reject', reason: 'R' }] });

      await runImplement(pipelineFor(), realDeps());

      expect(read('b.ts')).toBe('b\n');
      expect(read('a.ts')).toBe('a\na1\n');
      expect(readJson('plan.json').subtasks[0].completed).toBe(true);
      expect(readJson('scope_rejections.json')).toEqual({ '1': [{ path: 'b.ts', reason: 'R' }] });
      expect(sessionCount).toBe(1);
    });

    it('re-runs a subtask whose only change was rejected, without spending an incomplete pass, and tells the coder', async () => {
      const s1 = st(1, ['a.ts']);
      writePlan([s1]);
      await holdParallel(s1, { 'b.ts': 'b\nb2\n' }, ['b.ts']);
      verdictsWriter = () => ({ verdicts: [{ subtask_id: 1, path: 'b.ts', verdict: 'reject', reason: 'R' }] });
      const deps = realDeps();
      const pipeline = pipelineFor({ incompleteImplementPassCount: 0 });

      await runImplement(pipeline, deps);

      expect(readJson('plan.json').subtasks[0].completed).not.toBe(true);
      const log = outputLog();
      expect(log).toContain('[VERIFY] Subtask 1 rejected — will re-run');
      expect(pipeline.incompleteImplementPassCount).toBe(0);
      expect(deps.executePhase).toHaveBeenCalled();
      expect(pipeline.phase).toBe('implement');

      const { request } = await buildSubtaskRequest(pipeline, deps, s1, repo, false, false, join(specDir, 'human_feedback.md'));
      expect(request).toContain('⚠️ SCOPE DECISIONS');
      expect(request).toContain('b.ts — R');
    });

    it('starts a second session after an invalid verdict file when maxScopeStall allows it', async () => {
      const s1 = st(1, ['a.ts']);
      writePlan([s1]);
      await holdParallel(s1, { 'a.ts': 'a\na1\n', 'x.ts': 'x\n' }, ['x.ts']);
      let n = 0;
      verdictsWriter = () => (++n === 1 ? null : { verdicts: [{ subtask_id: 1, path: 'x.ts', verdict: 'approve', reason: 'ok' }] });
      cfgOverrides = { maxScopeStall: 3 };
      const pipeline = pipelineFor();

      await runImplement(pipeline, realDeps());

      expect(sessionCount).toBe(2);
      expect(pipeline.scopeReplanCount).toBe(2);
      expect(readJson('plan.json').subtasks[0].completed).toBe(true);
    });

    it('fails the task when the default stall budget is spent by an invalid verdict file', async () => {
      const s1 = st(1, ['a.ts']);
      writePlan([s1]);
      await holdParallel(s1, { 'a.ts': 'a\na1\n', 'x.ts': 'x\n' }, ['x.ts']);
      verdictsWriter = () => null;
      const pipeline = pipelineFor();

      await runImplement(pipeline, realDeps());

      expect(sessionCount).toBe(1);
      expect(pipeline.phase).toBe('failed');
      const qa = readJson('qa_report.json');
      expect(qa.fail_type).toBe(ORCHESTRATOR_FAIL_TYPE);
      expect(qa.criteria[0].criterion).toBe('Scope arbitration budget');
      expect(outputLog()).toContain('[SCOPE-BUDGET]');
      expect(writeCompletionSummary).toHaveBeenCalledWith(pipeline, 'implement-failure');
      expect(existsSync(join(specDir, 'scope_report-st1.json'))).toBe(true);
      expect(() => git(repo, 'rev-parse', '--verify', 'feat-st1')).not.toThrow();
    });

    it('fails without a second session when the next round repeats the first report', async () => {
      const s1 = st(1, ['a.ts']);
      writePlan([s1]);
      await holdParallel(s1, { 'b.ts': 'b\nb2\n' }, ['b.ts']);
      verdictsWriter = () => ({ verdicts: [{ subtask_id: 1, path: 'b.ts', verdict: 'reject', reason: 'R' }] });
      const pipeline = pipelineFor();

      await runImplement(pipeline, realDeps());
      expect(sessionCount).toBe(1);

      // The coder redoes the same out-of-scope change: a second report with the same unlisted file.
      await holdParallel(s1, { 'b.ts': 'b\nb3\n' }, ['b.ts']);
      writePlan([{ ...s1, completed: false }]);
      await runImplement(pipeline, realDeps());

      expect(sessionCount).toBe(1);
      expect(pipeline.phase).toBe('failed');
      expect(readJson('qa_report.json').criteria[0].criterion).toBe('Scope arbitration budget');
      expect(existsSync(join(specDir, 'scope_report-st1.json'))).toBe(true);
      expect(() => git(repo, 'rev-parse', '--verify', 'feat-st1')).not.toThrow();
    });

    it('fails without a session when the total re-plan budget is already spent', async () => {
      const s1 = st(1, ['a.ts']);
      writePlan([s1]);
      await holdParallel(s1, { 'a.ts': 'a\na1\n', 'x.ts': 'x\n' }, ['x.ts']);
      const pipeline = pipelineFor({ scopeReplanCount: 6 });

      await runImplement(pipeline, realDeps());

      expect(sessionCount).toBe(0);
      expect(pipeline.phase).toBe('failed');
      expect(readJson('qa_report.json').criteria[0].criterion).toBe('Scope arbitration budget');
      expect(existsSync(join(specDir, 'scope_report-st1.json'))).toBe(true);
    });

    it('does not arbitrate while a wakeup is pending', async () => {
      const s1 = st(1, ['a.ts']);
      writePlan([s1]);
      await holdParallel(s1, { 'a.ts': 'a\na1\n', 'x.ts': 'x\n' }, ['x.ts']);
      const deps = realDeps();
      const pipeline = pipelineFor({ wakeupUntil: '2030-01-01T00:00:00Z', wakeupSubtaskId: 9 });

      await runImplement(pipeline, deps);

      expect(sessionCount).toBe(0);
      expect(deps.scheduleWakeup).toHaveBeenCalled();
      expect(existsSync(join(specDir, 'scope_report-st1.json'))).toBe(true);
    });
  });
});
