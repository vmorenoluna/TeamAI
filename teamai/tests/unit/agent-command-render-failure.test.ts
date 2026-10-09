// @vitest-environment node

/**
 * A command that cannot be rendered must fail the phase BEFORE an agent
 * session is spawned — never leave a live session waiting on a message that
 * never arrives. No real agent is invoked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const { mockCreateSession, mockSendMessage } = vi.hoisted(() => ({
  mockCreateSession: vi.fn(),
  mockSendMessage: vi.fn(),
}));

vi.mock('../../src/lib/logger', () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(), off: vi.fn(), emit: vi.fn(),
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    killSession: vi.fn(),
    getSession: vi.fn(),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot }),
}));
vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: vi.fn(() => { throw new Error('not a git repo'); }),
}));
vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: { ensureContainer: vi.fn(), getRunningContainer: vi.fn(() => null) },
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));
vi.mock('../../src/lib/command-templates', () => ({
  renderCommand: vi.fn(() => { throw new Error('Command include "_shared/x.md" not found'); }),
}));

import { runSpecPhase, runPlanPhase, runMergePhase } from '../../src/lib/orchestrator/phase-runners';
import { runQaReview } from '../../src/lib/orchestrator/qa-review';
import { runSubtaskSession } from '../../src/lib/orchestrator/implement';

let root: string;
let specPath: string;

beforeEach(() => {
  vi.clearAllMocks();
  root = join(tmpdir(), `teamai-render-fail-${randomUUID().slice(0, 8)}`);
  specPath = join(root, '.teamai', 'task-slug');
  mkdirSync(specPath, { recursive: true });
  writeFileSync(join(specPath, 'plan.json'), JSON.stringify({ subtasks: [] }));
  mockCreateSession.mockResolvedValue('sess-1');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const pipeline = (phase: string) => ({
  taskId: 'task-1', title: 'T', description: 'T', phase, specPath,
  worktreePath: join(root, '.worktrees', 'task-slug'), branch: 'feat/t',
  qaAttempt: 0, maxQaAttempts: 3, specRevision: 1, qaRevision: 0,
});

const deps = () => ({
  projectRoot: root,
  persistAndEmitPhase: vi.fn(), advancePhase: vi.fn(), rotateOutputLog: vi.fn(), phaseHeader: vi.fn(),
  savePipelineState: vi.fn(), executePhase: vi.fn(), writeCompletionSummary: vi.fn(), scheduleWakeup: vi.fn(),
  sessionOpts: (role: string, cwd: string, taskId: string) => ({ role, cwd, taskId }),
  waitForCompletion: vi.fn(async () => undefined),
  toAgentPath: (p: string) => p,
  gitPush: vi.fn(),
  execGit: vi.fn((args: string[]) => { if (args[0] === 'merge' && args[1] !== '--abort') throw new Error('CONFLICT'); }),
  execGitCapture: vi.fn(() => ''),
  getPipelineConfig: () => ({
    wakeupScanRetryDelayMs: 0, maxImplementRetries: 3, maxQaAttempts: 3, parallelSubtasks: true,
    maxStallRecoveries: 3, idleStallMinutes: 10, toolStallMinutes: 30,
  }),
  taskStore: { get: vi.fn(), update: vi.fn(), getAll: vi.fn(() => []) },
  planWriteLock: { current: Promise.resolve() },
  removeWorktree: vi.fn(),
  buildTicketMessage: () => null,
});

describe('a command that cannot be rendered never spawns a session', () => {
  const cases: [string, () => Promise<unknown>][] = [
    ['spec', () => runSpecPhase(pipeline('spec') as never, deps() as never)],
    ['plan', () => runPlanPhase(pipeline('plan') as never, deps() as never)],
    ['qa-review', () => runQaReview(pipeline('qa-review') as never, deps() as never)],
    ['implement', () => runSubtaskSession(
      pipeline('implement') as never, deps() as never,
      { id: 1, title: 'S', description: 'S', files: ['a.ts'], acceptance_criteria: ['ok'] } as never,
      root, join(specPath, 'output.log'), false, false, join(specPath, 'human_feedback.md'),
      [], new Set(), { current: Promise.resolve() },
    )],
    ['merge', () => runMergePhase(pipeline('merge') as never, deps() as never)],
  ];

  for (const [name, runPhase] of cases) {
    it(name, async () => {
      await expect(runPhase()).rejects.toThrow(/not found/);
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(mockSendMessage).not.toHaveBeenCalled();
    });
  }
});
