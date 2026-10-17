/**
 * Async merge/PR preparation: the squash no longer blocks the event loop, and a
 * rejecting `git push -u --force` in create-pr fails the phase (run-error),
 * with no PR attempted and no hang.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { writeFileSync, mkdirSync, rmSync, mkdtempSync } from 'fs';
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

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: vi.fn(), off: vi.fn(), emit: vi.fn(), createSession: vi.fn(), sendMessage: vi.fn(),
    killSession: vi.fn(), getSession: vi.fn(), getAllSessions: vi.fn(() => []), getStaleSessions: vi.fn(() => []),
    removeStaleSession: vi.fn(), getTerminalSessions: vi.fn(() => []), killTerminalSession: vi.fn(),
    writeToSession: vi.fn(), terminateSession: vi.fn(),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot }),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: { ensureContainer: vi.fn(), getRunningContainer: vi.fn(() => null) },
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

const gp = vi.hoisted(() => ({
  resolveBaseBranch: vi.fn(async () => 'main'),
  detectGitPlatform: vi.fn(async () => 'github'),
  checkExistingPRViaCLI: vi.fn(async () => null),
  createPRViaCLI: vi.fn(async () => 'https://github.com/o/r/pull/1'),
  buildPRBody: vi.fn(() => 'body'),
  isPrMerged: vi.fn(async () => false),
}));
vi.mock('../../src/lib/git-platform', () => gp);

import { getOrchestrator } from '../../src/lib/orchestrator';
import { squashWithMessage } from '../../src/lib/orchestrator/artifact-commit';

describe('merge/PR preparation is async', () => {
  beforeEach(() => {
    h.handler = () => '';
    mockExecFileSync.mockReturnValue('0');
  });

  it('squashWithMessage lets the event loop run while `git reset --soft` is pending', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'teamai-squash-'));
    try {
      h.handler = async (_file, args) => {
        if (args[0] === 'status') return '';
        if (args[0] === 'merge-base') return 'aaa';
        if (args[0] === 'rev-parse') return 'bbb';
        if (args[0] === 'reset') await new Promise(r => setTimeout(r, 50));
        return '';
      };
      let settled = false;
      const p = squashWithMessage(dir, 'msg', 'main', dir, {
        restoreWorktreeGitFileToHostPaths: () => undefined,
        worktreeGitEnv: () => ({}),
      }).then(r => { settled = true; return r; });

      let queuedRan = false;
      await new Promise<void>(r => setImmediate(() => { queuedRan = true; r(); }));
      expect(queuedRan).toBe(true);
      expect(settled).toBe(false);

      expect(await p).toBe(true);
      expect(settled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20_000);

  describe('create-pr push failure', () => {
    let testData: ReturnType<typeof setupTestProject>;
    afterEach(() => testData.clean());

    it('fails the task with a run-error summary containing the push error, without opening a PR', async () => {
      testData = setupTestProject({ initGit: false });
      writeFileSync(join(testData.taskDir, 'spec_summary.md'), 'summary');
      const orch = makeOrch(testData.root, getOrchestrator);
      const worktreePath = join(testData.root, 'wt-missing');
      mkdirSync(testData.taskDir, { recursive: true });
      const pipeline = makePipeline({
        taskId: testData.taskId, phase: 'create-pr', specPath: testData.taskDir,
        worktreePath, branch: 'feat/x',
      });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);
      (orch as AnyOrch).activeTasks.add(testData.taskId);

      const phases: string[] = [];
      h.handler = (file, args) => {
        if (file === 'git' && args.includes('push') && args.includes('--force') && args.includes('-u')) {
          throw execFileError(file, args, 'fatal: remote hung up unexpectedly');
        }
        return '';
      };
      const advance = (orch as AnyOrch).advancePhase.bind(orch);
      (orch as AnyOrch).advancePhase = (p: AnyOrch, phase: string, ...rest: unknown[]) => {
        phases.push(phase);
        return advance(p, phase, ...rest);
      };

      await (orch as AnyOrch)._runPipeline(pipeline);

      expect(pipeline.phase).toBe('failed');
      expect(phases).toContain('failed');
      expect(phases).not.toContain('pr-open');
      expect(phases).not.toContain('done');
      expect(gp.createPRViaCLI).not.toHaveBeenCalled();
      const task = (orch as AnyOrch).taskStore.getById(testData.taskId);
      expect(task.failureReason).toBe('run-error');
      expect(task.completionSummary).toContain('remote hung up unexpectedly');
    }, 20_000);
  });
});
