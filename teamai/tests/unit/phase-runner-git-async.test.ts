/**
 * Phase-runner git calls are async: none of the orchestrator's phase-runner
 * sources use a synchronous child_process API, a pending git call no longer
 * freezes the event loop, and a rejected call is either a documented
 * best-effort fallback or fails the phase (never hangs, never advances).
 *
 *   AC1: no execFileSync / execSync / spawnSync in the five converted sources.
 *   AC2: sweepAbandonedWorktreeRelocations (`git worktree list --porcelain`).
 *   AC3: runQaReview pre-QA fetch and the `rev-parse HEAD` stamp.
 *   AC4: rebaseOntoLatestDefault fetch / `rev-list --count`.
 *   AC5: pushAndVerify's `rev-parse origin/<branch>` rejection fails the phase.
 *   AC6: pushAndVerify treats an open PR (checkExistingPRViaCLI) as non-fatal.
 *   AC7: _recoverStBranchCommits (`rev-parse --verify`, `log .. --oneline`).
 *   AC8: reconcileDivergedBranch's rebase rejection (via runQaReview).
 *
 * Every wait is condition-driven (deferred promises / event handlers).
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { readFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

import { makePipeline, setupTestProject, makeOrch, type AnyOrch } from '../utils/orchestrator-harness';
import { execFileError } from '../utils/mock-child-process';

const h = vi.hoisted(() => ({
  handler: (_file: string, _args: string[]): string | Promise<string> => '',
}));
const mockExecFileSync = vi.hoisted(() => vi.fn(() => '0'));
const mockExecFile = await vi.hoisted(async () => {
  const { createExecFileMock } = await import('../utils/mock-child-process');
  return createExecFileMock({ resetSafe: true, handler: (file, args) => h.handler(file, args) });
});

vi.mock('child_process', async (orig) => {
  const { buildChildProcessMock } = await import('../utils/mock-child-process');
  return { ...buildChildProcessMock(await orig(), mockExecFile), execFileSync: mockExecFileSync };
});

vi.mock('../../src/lib/logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));

const pm = vi.hoisted(() => {
  const state = { reportPath: '', createSession: 0 };
  const processManager = {
    // Event-driven: the QA session "finishes" as soon as a listener for it exists.
    on: vi.fn((event: string, handler: (...a: unknown[]) => void) => {
      if (event === 'event') queueMicrotask(() => handler({ sessionId: 'sess-qa', event: { type: 'result' } }));
    }),
    off: vi.fn(), emit: vi.fn(),
    createSession: vi.fn(async () => {
      state.createSession++;
      if (state.reportPath) {
        const { writeFileSync: write } = await import('fs');
        write(state.reportPath, JSON.stringify({ overall: 'PASS', criteria: [{ criterion: 'c', status: 'PASS', evidence: 'ok' }] }));
      }
      return 'sess-qa';
    }),
    sendMessage: vi.fn(), killSession: vi.fn(), getSession: vi.fn(),
    getAllSessions: vi.fn(() => []), getStaleSessions: vi.fn(() => []), removeStaleSession: vi.fn(),
    getTerminalSessions: vi.fn(() => []), killTerminalSession: vi.fn(), writeToSession: vi.fn(), terminateSession: vi.fn(),
  };
  return { state, processManager };
});
vi.mock('../../src/lib/process-manager', () => ({
  processManager: pm.processManager,
  containerSessionOpts: (projectRoot: string) => ({ projectRoot }),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: { ensureContainer: vi.fn(), getRunningContainer: vi.fn(async () => null) },
  hostToContainerPath: vi.fn((p: string) => p),
  checkDockerAvailable: vi.fn(async () => true),
  getCachedDockerAvailable: vi.fn(() => true),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

const gp = vi.hoisted(() => ({
  resolveBaseBranch: vi.fn(async () => 'main'),
  detectGitPlatform: vi.fn(async () => 'github'),
  checkExistingPRViaCLI: vi.fn(async (): Promise<string | null> => null),
  createPRViaCLI: vi.fn(async () => 'https://github.com/o/r/pull/1'),
  buildPRBody: vi.fn(() => 'body'),
  isPrMerged: vi.fn(async () => false),
}));
vi.mock('../../src/lib/git-platform', () => gp);

import { getOrchestrator } from '../../src/lib/orchestrator';
import { sweepAbandonedWorktreeRelocations, pushAndVerify, _recoverStBranchCommits } from '../../src/lib/orchestrator/implement';
import { rebaseOntoLatestDefault } from '../../src/lib/orchestrator/phase-runners';

const WAIT = { timeout: 10_000 };
const TEST_TIMEOUT = 30_000;

/** A promise settled from the outside, to hold one git call pending. */
function deferred<T = string>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Resolves once a macrotask queued *now* has run, i.e. the event loop was not frozen. */
function eventLoopTurn(): Promise<boolean> {
  return new Promise<boolean>(r => setImmediate(() => r(true)));
}

/** Whether `h.handler` has been asked to run `git <first> ...`. */
function called(calls: string[][], ...prefix: string[]): boolean {
  return calls.some(a => prefix.every((p, i) => a[i] === p));
}

beforeEach(() => {
  h.handler = () => '';
  mockExecFileSync.mockReset();
  mockExecFileSync.mockReturnValue('0');
  gp.checkExistingPRViaCLI.mockReset();
  gp.checkExistingPRViaCLI.mockResolvedValue(null);
  pm.state.reportPath = '';
  pm.state.createSession = 0;
});

// ── AC1 ──────────────────────────────────────────────────────────────────

describe('AC1: no synchronous child_process API in the converted sources', () => {
  const files = [
    'src/lib/orchestrator/implement.ts',
    'src/lib/orchestrator/qa-review.ts',
    'src/lib/orchestrator/phase-runners.ts',
    'src/lib/orchestrator/phase-context.ts',
    'src/lib/orchestrator.ts',
  ];
  for (const file of files) {
    it(`${file} has no execFileSync / execSync / spawnSync`, () => {
      const source = readFileSync(join(__dirname, '..', '..', file), 'utf-8');
      expect(source).not.toMatch(/execFileSync|execSync|spawnSync/);
    });
  }
});

// ── AC2 ──────────────────────────────────────────────────────────────────

describe('AC2: sweepAbandonedWorktreeRelocations', () => {
  let base: string;
  let pipeline: AnyOrch;
  const deps = () => ({ projectRoot: base }) as never;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'teamai-sweep-'));
    for (const d of ['slug', 'slug-r1', 'slug-r2']) mkdirSync(join(base, 'wt', d), { recursive: true });
    mkdirSync(join(base, 'spec'), { recursive: true });
    pipeline = makePipeline({
      taskId: 't1', specPath: join(base, 'spec'), worktreePath: join(base, 'wt', 'slug'),
    });
  });
  afterEach(() => rmSync(base, { recursive: true, force: true }));

  it('lets the event loop run while `git worktree list` is pending, then removes only the unregistered -r dir', async () => {
    const list = deferred();
    h.handler = (_f, args) => (args[0] === 'worktree' && args[1] === 'list' ? list.promise : '');

    let done = false;
    const p = sweepAbandonedWorktreeRelocations(pipeline, deps()).then(() => { done = true; });

    expect(await eventLoopTurn()).toBe(true);
    expect(done).toBe(false);
    expect(existsSync(join(base, 'wt', 'slug-r2'))).toBe(true);

    list.resolve(`worktree ${join(base, 'wt', 'slug-r1')}\nHEAD abc\nbranch refs/heads/x\n`);
    await p;

    expect(existsSync(join(base, 'wt', 'slug-r2'))).toBe(false);
    expect(existsSync(join(base, 'wt', 'slug-r1'))).toBe(true);
    expect(existsSync(join(base, 'wt', 'slug'))).toBe(true);
  }, TEST_TIMEOUT);

  it('removes nothing and does not reject when `git worktree list` rejects', async () => {
    h.handler = (file, args) => {
      if (args[0] === 'worktree' && args[1] === 'list') throw execFileError(file, args, 'fatal: not a git repository');
      return '';
    };
    await expect(sweepAbandonedWorktreeRelocations(pipeline, deps())).resolves.toBeUndefined();
    expect(existsSync(join(base, 'wt', 'slug-r1'))).toBe(true);
    expect(existsSync(join(base, 'wt', 'slug-r2'))).toBe(true);
  }, TEST_TIMEOUT);
});

// ── AC3 / AC8: runQaReview ───────────────────────────────────────────────

describe('runQaReview git calls', () => {
  let testData: ReturnType<typeof setupTestProject>;
  let pipeline: AnyOrch;
  let orch: AnyOrch;
  let calls: string[][];

  beforeEach(() => {
    testData = setupTestProject();
    orch = makeOrch(testData.root, getOrchestrator);
    writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
    writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{ id: 1, title: 'T', description: 'T', files: [], acceptance_criteria: ['ac1'], completed: true }],
    }));
    pipeline = makePipeline({
      taskId: testData.taskId, specPath: testData.taskDir, phase: 'qa-review', branch: 'feat/x',
      worktreePath: join(testData.root, '..', 'worktrees', `qa-${testData.taskId}`),
    });
    mkdirSync(pipeline.worktreePath, { recursive: true });
    pm.state.reportPath = join(testData.taskDir, 'qa_report.json');
    calls = [];
  });
  afterEach(() => {
    rmSync(pipeline.worktreePath, { recursive: true, force: true });
    testData.clean();
  });

  it('AC3: holds QA behind a pending pre-QA fetch without blocking the loop, then stamps head_at_review', async () => {
    const fetchGate = deferred();
    h.handler = (_f, args) => {
      calls.push(args);
      if (args[0] === 'fetch' && args[1] === 'origin' && args[2] === 'feat/x') return fetchGate.promise;
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'abc123def456\n';
      return '';
    };

    const p = orch.runQaReview(pipeline);
    await vi.waitFor(() => expect(called(calls, 'fetch', 'origin', 'feat/x')).toBe(true), WAIT);

    expect(await eventLoopTurn()).toBe(true);
    expect(pm.state.createSession).toBe(0);

    fetchGate.resolve('');
    await p;

    expect(pm.state.createSession).toBe(1);
    const report = JSON.parse(readFileSync(join(testData.taskDir, 'qa_report.json'), 'utf-8'));
    expect(report.head_at_review).toBe('abc123def456');
  }, TEST_TIMEOUT);

  it('AC3: a rejected `rev-parse HEAD` is best-effort — QA still completes without a stamp', async () => {
    h.handler = (file, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') throw execFileError(file, args, 'fatal: bad revision');
      return '';
    };
    await orch.runQaReview(pipeline);
    const report = JSON.parse(readFileSync(join(testData.taskDir, 'qa_report.json'), 'utf-8'));
    expect(report.head_at_review).toBeUndefined();
    expect(report.overall).toBe('PASS');
  }, TEST_TIMEOUT);

  it('AC8: a rejected rebase in reconcileDivergedBranch (no unmerged files) bounces without a merger or a rejection', async () => {
    let pushes = 0;
    h.handler = (file, args) => {
      calls.push(args);
      if (args[0] === 'log') return 'abc123 Unpushed commit\n';
      if (args[0] === 'push') {
        pushes++;
        throw execFileError(file, args, '! [rejected] feat/x -> feat/x (non-fast-forward)');
      }
      if (args[0] === 'rebase' && args[1] === 'origin/feat/x') throw execFileError(file, args, 'error: could not apply');
      return ''; // `diff --name-only --diff-filter=U` → no unmerged paths
    };

    await expect(orch.runQaReview(pipeline)).resolves.not.toThrow();

    expect(called(calls, 'rebase', 'origin/feat/x')).toBe(true);
    expect(pm.state.createSession).toBe(0); // no merger and no QA session
    expect(pushes).toBeGreaterThan(0);
    const report = JSON.parse(readFileSync(join(testData.taskDir, 'qa_report.json'), 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('Unpushed commits');
    const log = readFileSync(join(testData.taskDir, 'output.log'), 'utf-8');
    expect(log).toContain('failed for a non-conflict reason');
  }, TEST_TIMEOUT);
});

// ── AC4 ──────────────────────────────────────────────────────────────────

describe('AC4: rebaseOntoLatestDefault', () => {
  let dir: string;
  let logFile: string;
  let execGit: Mock<[string[], string], Promise<void>>;
  let execGitCapture: Mock<[string[], string], Promise<string>>;
  const makeDeps = () => ({
    projectRoot: dir, baseBranch: 'main', execGit, execGitCapture,
    sessionOpts: vi.fn(() => ({})), waitForCompletion: vi.fn(async () => undefined), gitPush: vi.fn(async () => undefined),
  }) as never;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'teamai-rebase-'));
    logFile = join(dir, 'output.log');
    execGit = vi.fn(async (_a: string[], _c: string): Promise<void> => undefined);
    execGitCapture = vi.fn(async (_a: string[], _c: string) => '0\n');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('skips the rebase when `rev-list --count` is 0, after a fetch that did not block the loop', async () => {
    const fetchGate = deferred();
    h.handler = (_f, args) => (args[0] === 'fetch' ? fetchGate.promise : '');

    let done = false;
    const p = rebaseOntoLatestDefault(dir, 't', 'feat/x', logFile, makeDeps()).then(r => { done = true; return r; });
    expect(await eventLoopTurn()).toBe(true);
    expect(done).toBe(false);
    expect(execGitCapture).not.toHaveBeenCalled();

    fetchGate.resolve('');
    expect(await p).toBe(true);

    expect(execGitCapture).toHaveBeenCalledWith(['rev-list', '--count', 'HEAD..origin/main'], dir);
    expect(execGit.mock.calls.some(([a]) => a[0] === 'rebase' && a[1] !== '--abort')).toBe(false);
    expect(readFileSync(logFile, 'utf-8')).toContain('skipping rebase');
  }, TEST_TIMEOUT);

  it('warns and proceeds when the fetch rejects', async () => {
    h.handler = (file, args) => {
      if (args[0] === 'fetch') throw execFileError(file, args, 'fatal: unable to access remote');
      return '';
    };
    expect(await rebaseOntoLatestDefault(dir, 't', 'feat/x', logFile, makeDeps())).toBe(true);
    const log = readFileSync(logFile, 'utf-8');
    expect(log).toContain('Could not fetch origin/main');
    expect(log).toContain('skipping rebase');
  }, TEST_TIMEOUT);
});

// ── AC5 / AC6 ────────────────────────────────────────────────────────────

describe('pushAndVerify', () => {
  let specPath: string;
  let advancePhase: ReturnType<typeof vi.fn>;
  const pipelineFor = () => makePipeline({ taskId: 't', specPath, worktreePath: specPath, branch: 'feat/x' });
  const makeDeps = (gitPush: () => Promise<void>) => ({
    projectRoot: specPath, gitPush: vi.fn(gitPush), phaseHeader: vi.fn(),
    advancePhase, writeCompletionSummary: vi.fn(),
  }) as never;

  beforeEach(() => {
    specPath = mkdtempSync(join(tmpdir(), 'teamai-push-'));
    advancePhase = vi.fn();
  });
  afterEach(() => rmSync(specPath, { recursive: true, force: true }));

  it('AC5: a rejected `rev-parse origin/<branch>` fails the phase with a FAIL report (not hung, not advanced)', async () => {
    h.handler = (file, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'origin/feat/x') throw execFileError(file, args, 'fatal: unknown revision');
      return 'abc\n';
    };
    await pushAndVerify(pipelineFor(), makeDeps(async () => undefined), join(specPath, 'output.log'));

    expect(advancePhase).toHaveBeenCalledTimes(1);
    expect(advancePhase).toHaveBeenCalledWith(expect.anything(), 'failed');
    const report = JSON.parse(readFileSync(join(specPath, 'qa_report.json'), 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].notes).toContain('unknown revision');
  }, TEST_TIMEOUT);

  it('AC6: an open PR found via checkExistingPRViaCLI makes a push failure non-fatal', async () => {
    gp.checkExistingPRViaCLI.mockResolvedValue('https://github.com/o/r/pull/7');
    await pushAndVerify(pipelineFor(), makeDeps(async () => { throw new Error('push rejected'); }), join(specPath, 'output.log'));

    expect(gp.checkExistingPRViaCLI).toHaveBeenCalledWith('github', 'feat/x', specPath);
    expect(advancePhase).not.toHaveBeenCalled();
    expect(existsSync(join(specPath, 'qa_report.json'))).toBe(false);
    expect(readFileSync(join(specPath, 'output.log'), 'utf-8')).toContain('push failure is non-fatal');
  }, TEST_TIMEOUT);

  it('AC6: a rejected PR lookup falls through to the normal failure', async () => {
    gp.checkExistingPRViaCLI.mockRejectedValue(new Error('gh: not found'));
    await pushAndVerify(pipelineFor(), makeDeps(async () => { throw new Error('push rejected'); }), join(specPath, 'output.log'));
    expect(advancePhase).toHaveBeenCalledWith(expect.anything(), 'failed');
  }, TEST_TIMEOUT);
});

// ── AC7 ──────────────────────────────────────────────────────────────────

describe('AC7: _recoverStBranchCommits', () => {
  let dir: string;
  let logFile: string;
  let execGitFn: Mock<[string[], string], Promise<void>>;
  const run = () => _recoverStBranchCommits(dir, execGitFn, logFile, 'feat/x', 'feat/x-st1', dir, 1);

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'teamai-recover-'));
    logFile = join(dir, 'output.log');
    execGitFn = vi.fn(async (_a: string[], _c: string): Promise<void> => undefined);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('keeps the loop free while `rev-parse --verify` is pending, then cherry-picks the unintegrated commits', async () => {
    const verify = deferred();
    h.handler = (_f, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') return verify.promise;
      if (args[0] === 'log') return 'abc123 subtask work\n';
      return '';
    };
    const p = run();
    expect(await eventLoopTurn()).toBe(true);
    expect(execGitFn).not.toHaveBeenCalled();

    verify.resolve('abc123\n');
    const result = await p;

    expect(result).toEqual({ recovered: true, commits: ['abc123 subtask work'] });
    expect(execGitFn).toHaveBeenCalledWith(['cherry-pick', 'feat/x..feat/x-st1'], dir);
  }, TEST_TIMEOUT);

  it('reports nothing to recover when `rev-parse --verify` rejects', async () => {
    h.handler = (file, args) => {
      if (args[0] === 'rev-parse') throw execFileError(file, args, 'fatal: Needed a single revision');
      return '';
    };
    expect(await run()).toEqual({ recovered: true, commits: [] });
    expect(execGitFn).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);

  it('reports recovery as impossible (not cherry-picking) when `log` rejects', async () => {
    h.handler = (file, args) => {
      if (args[0] === 'log') throw execFileError(file, args, 'fatal: ambiguous argument');
      return 'abc\n';
    };
    expect(await run()).toEqual({ recovered: false, commits: [] });
    expect(execGitFn).not.toHaveBeenCalled();
  }, TEST_TIMEOUT);
});
