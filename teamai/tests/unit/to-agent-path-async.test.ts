// @vitest-environment node

/**
 * AC20 — toAgentPath is async (it may consult Docker for the container's
 * remoteWorkspaceFolder). Every prompt that embeds a translated path must
 * await it: the message carries the container path (/workspaces/proj/...) and
 * never the stringified Promise ("[object Promise]").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { mockCreateSession, mockSendMessage } = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
  mockSendMessage: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn(),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(),
    off: vi.fn(),
    emit: vi.fn(),
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    killSession: vi.fn(),
    getSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    getStaleSessions: vi.fn(() => []),
    writeToSession: vi.fn(),
    terminateSession: vi.fn(),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: { ensureContainer: vi.fn(), getRunningContainer: vi.fn(() => null) },
  hostToContainerPath: vi.fn((p: string) => p),
  checkDockerAvailable: vi.fn(async () => true),
  getCachedDockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

import { runSpecPhase, runPlanPhase } from '../../src/lib/orchestrator/phase-runners';
import { runQaReview } from '../../src/lib/orchestrator/qa-review';
import { runScopeArbitration, writeScopeReport } from '../../src/lib/orchestrator/scope-arbitration';
import { requestOf } from '../utils/agent-prompts';

const REMOTE = '/workspaces/proj';

class StopAfterSend extends Error {}

let root: string;
let specPath: string;
let worktreePath: string;

/** Translating async toAgentPath: host `root` → remoteWorkspaceFolder. */
const toAgentPath = async (p: string): Promise<string> => {
  await new Promise(resolve => setImmediate(resolve));
  return p.split('\\').join('/').replace(root.split('\\').join('/'), REMOTE);
};

function pipeline(phase: string) {
  return {
    taskId: 'task-1', title: 'Build the thing', description: 'Build the thing', phase,
    specPath, worktreePath, branch: 'feat/build', qaAttempt: 0, maxQaAttempts: 3,
    specRevision: 1, qaRevision: 0, sessionId: undefined as string | undefined,
  };
}

function deps(overrides: Record<string, unknown> = {}) {
  return {
    projectRoot: root,
    persistAndEmitPhase: vi.fn(),
    sessionOpts: (role: string, cwd: string, taskId: string) => ({ role, cwd, taskId }),
    waitForCompletion: vi.fn(async () => { throw new StopAfterSend(); }),
    advancePhase: (p: { phase: string }, phase: string) => { p.phase = phase; },
    rotateOutputLog: vi.fn(),
    phaseHeader: vi.fn(),
    savePipelineState: vi.fn(),
    toAgentPath,
    executePhase: vi.fn(async () => undefined),
    gitPush: vi.fn(),
    execGit: vi.fn(async () => undefined),
    execGitCapture: vi.fn(async () => ''),
    getPipelineConfig: () => ({ wakeupScanRetryDelayMs: 0, maxImplementRetries: 3, maxQaAttempts: 3, parallelSubtasks: true }),
    scheduleWakeup: vi.fn(),
    writeCompletionSummary: vi.fn(),
    writeQaFeedback: vi.fn(),
    autoReviseSpec: vi.fn(async () => undefined),
    planWriteLock: { current: Promise.resolve() },
    removeWorktree: vi.fn(),
    buildTicketMessage: () => null,
    ...overrides,
  };
}

async function run(fn: () => Promise<unknown>): Promise<void> {
  try { await fn(); } catch (err) { if (!(err instanceof StopAfterSend)) throw err; }
}

const sentMessage = (n = 0): string => requestOf(mockSendMessage.mock.calls[n][1] as string);

function expectTranslated(message: string, rel: string): void {
  expect(message).toContain(`${REMOTE}/.teamai/task-slug/${rel}`);
  expect(message).not.toContain('[object Promise]');
  expect(message).not.toContain(root.split('\\').join('/'));
}

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'teamai-agentpath-'));
  specPath = join(root, '.teamai', 'task-slug');
  worktreePath = join(root, '.worktrees', 'task-slug');
  mkdirSync(specPath, { recursive: true });
  let n = 0;
  mockCreateSession.mockImplementation(async () => `sess-${++n}`);
});

afterEach(() => {
  try { rmSync(root, { recursive: true, force: true }); } catch { /* best-effort */ }
});

describe('async toAgentPath in agent prompts', () => {
  it('runSpecPhase embeds container paths for spec.md and spec_summary.md', async () => {
    await run(() => runSpecPhase(pipeline('spec') as never, deps() as never));
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const msg = sentMessage();
    expectTranslated(msg, 'spec.md');
    expectTranslated(msg, 'spec_summary.md');
  });

  it('runPlanPhase embeds container paths for spec.md and plan.json', async () => {
    await run(() => runPlanPhase(pipeline('plan') as never, deps() as never));
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const msg = sentMessage();
    expectTranslated(msg, 'spec.md');
    expectTranslated(msg, 'plan.json');
  });

  it('runQaReview embeds container paths for spec.md and qa_report.json', async () => {
    await run(() => runQaReview(pipeline('qa-review') as never, deps() as never));
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const msg = sentMessage();
    expectTranslated(msg, 'spec.md');
    expectTranslated(msg, 'qa_report.json');
  });
});

describe('async toAgentPath in scope arbitration', () => {
  it('the planner header lists container paths for the scope report and verdicts file', async () => {
    const repo = join(root, 'repo');
    mkdirSync(repo);
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf-8' }).trim();
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 't@t'); git('config', 'user.name', 't'); git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(repo, 'a.ts'), 'a\n'); writeFileSync(join(repo, 'b.ts'), 'b\n');
    git('add', '-A'); git('commit', '-m', 'init');
    git('checkout', '-q', '-b', 'feat');
    const base = git('rev-parse', 'HEAD');
    writeFileSync(join(repo, 'b.ts'), 'b2\n');
    git('add', '-A'); git('commit', '-m', 'work');
    const head = git('rev-parse', 'HEAD');
    writeFileSync(join(specPath, 'plan.json'), JSON.stringify({
      subtasks: [{ id: 1, title: 't1', description: '', files: ['a.ts'], acceptance_criteria: [] }],
    }));

    const arbDeps = {
      projectRoot: repo,
      sessionOpts: (role: string, cwd: string, taskId: string) => ({ taskId, role, cwd }),
      waitForCompletion: vi.fn(async () => {
        writeFileSync(join(specPath, 'scope_verdicts.json'), JSON.stringify({
          verdicts: [{ subtask_id: 1, path: 'b.ts', verdict: 'approve', reason: 'needed' }], serialize: [],
        }));
      }),
      toAgentPath,
      planWriteLock: { current: Promise.resolve() },
      savePipelineState: vi.fn(),
      execGit: async (args: string[], cwd: string) => { execFileSync('git', args, { cwd, stdio: 'pipe' }); },
      execGitCapture: async (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: 'pipe' }),
      tryCherryPickWithRecovery: vi.fn(async () => true),
      verifySubtaskDeliverables: vi.fn(async () => 'ok'),
      filesAlreadyChangedOnBranch: vi.fn(async () => false),
      completeSubtask: vi.fn(async () => true),
    };
    await writeScopeReport(arbDeps as never, {
      specPath, cwd: repo, subtaskId: 1, base, sessionHead: head, heldRef: null,
      declaredFiles: ['a.ts'], unlistedPaths: ['b.ts'],
    });

    await runScopeArbitration(
      { taskId: 't', specPath, worktreePath: repo, branch: 'feat' } as never,
      arbDeps as never,
      { maxScopeStall: 2, maxScopeReplans: 6 },
    );

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const msg = mockSendMessage.mock.calls[0][1] as string;
    expect(msg).toContain(`${REMOTE}/.teamai/task-slug/scope_report-st1.json`);
    expect(msg).toContain(`${REMOTE}/.teamai/task-slug/scope_verdicts.json`);
    expect(msg).not.toContain('[object Promise]');
  });
});
