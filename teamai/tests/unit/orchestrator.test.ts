/**
 * Tests for Orchestrator.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

import { createFireEvent, makePipeline, AnyOrch, setupTestProject, makeOrch } from '../utils/orchestrator-harness';

// ── Hoisted mocks for shared state ──

const { mockWarn, onHandlers } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  onHandlers: new Map<string, Array<(...args: any[]) => void>>(),
}));

const mockOn = vi.hoisted(() => vi.fn());
const mockOff = vi.hoisted(() => vi.fn());
const mockEmit = vi.hoisted(() => vi.fn());
const mockCreateSession = vi.hoisted(() => vi.fn());
const mockSendMessage = vi.hoisted(() => vi.fn());
const mockKillSession = vi.hoisted(() => vi.fn());
const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), warn: mockWarn, error: vi.fn(),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!onHandlers.has(event)) onHandlers.set(event, []);
      onHandlers.get(event)!.push(handler);
      return mockOn(event, handler);
    },
    off: (event: string, handler: (...args: any[]) => void) => {
      const handlers = onHandlers.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
      return mockOff(event, handler);
    },
    emit: (...args: any[]) => mockEmit(...args),
    createSession: (...args: any[]) => mockCreateSession(...args),
    sendMessage: (...args: any[]) => mockSendMessage(...args),
    killSession: (...args: any[]) => mockKillSession(...args),
    getSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    getStaleSessions: vi.fn(() => []),
    removeStaleSession: vi.fn(),
    getTerminalSessions: vi.fn(() => []),
    killTerminalSession: vi.fn(),
    writeToSession: vi.fn(),
    terminateSession: vi.fn(),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: {
    ensureContainer: vi.fn(),
    getRunningContainer: vi.fn(() => null),
  },
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

// ── Imports after mocks ──

import { Orchestrator, getOrchestrator } from '../../src/lib/orchestrator';
import { getToolPath } from '../../src/lib/tool-checker';
import { processManager } from '../../src/lib/process-manager';
import { readContainerConfig, containerManager, hostToContainerPath, dockerAvailable, _resetDockerAvailableCache, readContainerRemoteUser } from '../../src/lib/container-manager';

const fireEvent = createFireEvent(onHandlers);

// ── Tests ──

describe('Orchestrator', () => {
  let testData: ReturnType<typeof setupTestProject>;

  beforeEach(() => {
    vi.resetAllMocks();
    onHandlers.clear();
    // Default: container not enabled
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });
    vi.mocked(hostToContainerPath).mockImplementation((p: string) => p);
    vi.mocked(containerManager.getRunningContainer).mockReturnValue(null);
    // Re-establish defaults that vi.resetAllMocks clears from module-level vi.mock()
    vi.mocked(readContainerRemoteUser).mockReturnValue('node');
    vi.mocked(dockerAvailable).mockReturnValue(true);
    vi.mocked(_resetDockerAvailableCache).mockReturnValue(undefined);
  });

  afterEach(() => {
    if (testData) testData.clean(onHandlers);
    vi.resetModules();
  });

  // ── getPipelineConfig ──────────────────────────────────────────────

  describe('getPipelineConfig', () => {
    it('returns default config when pipeline.json does not exist', () => {
      testData = setupTestProject();
      rmSync(join(testData.root, '.teamai', 'pipeline.json'), { force: true });

      const orch = makeOrch(testData.root, getOrchestrator);
      const config = (orch as AnyOrch).getPipelineConfig();

      expect(config.maxQaAttempts).toBe(3);
      expect(config.parallelSubtasks).toBe(true);
    });

    it('returns configured values when pipeline.json exists', () => {
      testData = setupTestProject();
      writeFileSync(join(testData.root, '.teamai', 'pipeline.json'), JSON.stringify({
        maxQaAttempts: 5,
        parallelSubtasks: false,
      }));

      const orch = makeOrch(testData.root, getOrchestrator);
      const config = (orch as AnyOrch).getPipelineConfig();

      expect(config.maxQaAttempts).toBe(5);
      expect(config.parallelSubtasks).toBe(false);
    });

    it('returns default config when pipeline.json has invalid JSON', () => {
      testData = setupTestProject();
      writeFileSync(join(testData.root, '.teamai', 'pipeline.json'), '{invalid}');

      const orch = makeOrch(testData.root, getOrchestrator);
      const config = (orch as AnyOrch).getPipelineConfig();

      expect(config.maxQaAttempts).toBe(3);
      expect(mockWarn).toHaveBeenCalled();
    });
  });

  // ── moveTaskToPhase — no-run phases ────────────────────────────────

  describe('moveTaskToPhase — no-run phases', () => {
    it('moves to backlog without spawning', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      await orch.moveTaskToPhase(testData.taskId, 'backlog');

      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId: testData.taskId,
        phase: 'backlog',
      }));
    });

    it('moves to done without spawning', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      await orch.moveTaskToPhase(testData.taskId, 'done');

      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId: testData.taskId,
        phase: 'done',
      }));
    });

    it('throws for nonexistent task', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      await expect(orch.moveTaskToPhase('nonexistent', 'spec')).rejects.toThrow('not found');
    });
  });

  // ── runTask ────────────────────────────────────────────────────────

  describe('runTask', () => {
    it('rejects when task is already active', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      (orch as AnyOrch).activeTasks.add(testData.taskId);

      await expect(orch.runTask(testData.taskId, 'test')).rejects.toThrow(/already running/i);
    });
  });

  // ── waitForCompletion (tested via private access) ─────────────────

  describe('waitForCompletion', () => {
    let orch: Orchestrator;

    beforeEach(() => {
      testData = setupTestProject();
      orch = makeOrch(testData.root, getOrchestrator);
    });

    it('resolves on result event', async () => {
      const promise = (orch as AnyOrch)._ctx.waitForCompletion('sess-1');

      fireEvent('event', { sessionId: 'sess-1', event: { type: 'result' } });

      await expect(promise).resolves.toBeUndefined();
    });

    it('resolves on exit with code 0', async () => {
      const promise = (orch as AnyOrch)._ctx.waitForCompletion('sess-2');

      fireEvent('exit', { sessionId: 'sess-2', code: 0 });

      await expect(promise).resolves.toBeUndefined();
    });

    it('rejects on exit with non-zero code', async () => {
      const promise = (orch as AnyOrch)._ctx.waitForCompletion('sess-3');

      fireEvent('exit', { sessionId: 'sess-3', code: 1 });

      await expect(promise).rejects.toThrow('Session exited with code 1');
    });

    it('rejects with RateLimitError on rate limit event + result error', async () => {
      const now = Math.floor(Date.now() / 1000);
      const promise = (orch as AnyOrch)._ctx.waitForCompletion('sess-4');

      fireEvent('event', {
        sessionId: 'sess-4',
        event: {
          type: 'rate_limit_event',
          rate_limit_info: { status: 'limited', resetsAt: now + 60 },
        },
      });
      fireEvent('event', {
        sessionId: 'sess-4',
        event: { type: 'result', is_error: true },
      });

      await expect(promise).rejects.toThrow('Rate limited');
    });

    it('ignores events from other sessions', async () => {
      const promise = (orch as AnyOrch)._ctx.waitForCompletion('sess-5');

      // Fire event for different session — should not resolve
      fireEvent('event', { sessionId: 'other-sess', event: { type: 'result' } });

      // Fire for correct session
      fireEvent('event', { sessionId: 'sess-5', event: { type: 'result' } });

      await expect(promise).resolves.toBeUndefined();
    });

    it('cleans up listeners on completion', async () => {
      // Spy on processManager.off to verify cleanup
      const offSpy = vi.spyOn(processManager, 'off');

      const promise = (orch as AnyOrch)._ctx.waitForCompletion('sess-cleanup');
      fireEvent('event', { sessionId: 'sess-cleanup', event: { type: 'result' } });
      await promise;

      // Should have cleaned up both event listeners
      expect(offSpy).toHaveBeenCalledWith('event', expect.any(Function));
      expect(offSpy).toHaveBeenCalledWith('exit', expect.any(Function));
      offSpy.mockRestore();
    });
  });

  // ── cancelPipeline ────────────────────────────────────────────────

  describe('cancelPipeline', () => {
    it('does nothing when no pipeline exists', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      expect(() => orch.cancelPipeline('nonexistent')).not.toThrow();
    });

    it('calls killSession and cleans up', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({
        taskId: testData.taskId,
        sessionId: 'sess-cancel',
      });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);
      (orch as AnyOrch).activeTasks.add(testData.taskId);

      orch.cancelPipeline(testData.taskId);

      expect(mockKillSession).toHaveBeenCalledWith('sess-cancel');
      expect((orch as AnyOrch).pipelines.has(testData.taskId)).toBe(false);
      expect((orch as AnyOrch).activeTasks.has(testData.taskId)).toBe(false);
    });

    it('does not call killSession when no sessionId', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({
        taskId: testData.taskId,
        // no sessionId
      });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      orch.cancelPipeline(testData.taskId);

      expect(mockKillSession).not.toHaveBeenCalled();
    });
  });

  // ── isTaskActive ──────────────────────────────────────────────────

  describe('isTaskActive', () => {
    it('returns false for unknown task', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      expect(orch.isTaskActive('unknown')).toBe(false);
    });
  });

  // ── approveTask / rejectTask ───────────────────────────────────────

  describe('approveTask', () => {
    it('throws when not awaiting review', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      await expect(orch.approveTask(testData.taskId, 'local-merge')).rejects.toThrow('cannot approve a task in backlog');
    });
  });

  describe('rejectTask', () => {
    it('throws when not awaiting review', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      await expect(orch.rejectTask(testData.taskId, 'bad')).rejects.toThrow('cannot reject a task in backlog');
    });

    it('writes feedback and resets qaAttempt when awaiting review', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      // Update the task phase since rejectTask checks taskStore, not the pipeline
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'awaiting-review' });
      const pipeline = makePipeline({
        taskId: testData.taskId,
        phase: 'awaiting-review',
        specPath: testData.taskDir,
        qaAttempt: 2,
      });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      // rejectTask will try to execute 'implement' phase after writing feedback
      // That will call createSession, so we need to handle it
      mockCreateSession.mockResolvedValue('sess-reject');
      const promise = orch.rejectTask(testData.taskId, 'Fix the tests').catch(() => {});

      // Verify feedback was written
      const feedbackPath = join(testData.taskDir, 'human_feedback.md');
      expect(existsSync(feedbackPath)).toBe(true);
      expect(readFileSync(feedbackPath, 'utf-8')).toContain('Fix the tests');
      expect(pipeline.qaAttempt).toBe(0);
      expect(pipeline.phase).toBe('implement');

      // Fire events to let the pipeline complete
      fireEvent('event', { sessionId: 'sess-reject', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));
      await promise;
    });
  });

  // ── sessionOpts ────────────────────────────────────────────────────

  describe('sessionOpts', () => {
    it('includes all options when provided', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const opts = (orch as AnyOrch)._ctx.sessionOpts('coder', '/cwd', 'task-1', '/log.txt');
      expect(opts.taskId).toBe('task-1');
      expect(opts.role).toBe('coder');
      expect(opts.cwd).toBe('/cwd');
      expect(opts.projectRoot).toBe(testData.root);
      expect(opts.permissionMode).toBe('bypassPermissions');
      expect(opts.logFile).toBe('/log.txt');
    });

    it('omits logFile when not provided', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const opts = (orch as AnyOrch)._ctx.sessionOpts('planner', '/cwd', 'task-2');
      expect(opts.logFile).toBeUndefined();
    });
  });

  // ── _extractPrUrl ────────────────────────────────────────────────

  describe('_extractPrUrl', () => {
    it('extracts a GitHub PR URL from the log file', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const logFile = join(testData.taskDir, 'output.log');

      writeFileSync(logFile, 'Created PR: https://github.com/owner/repo/pull/42\nDone!');

      const result = (orch as AnyOrch)._ctx.extractPrUrl(logFile);
      expect(result).toBe('https://github.com/owner/repo/pull/42');
    });

    it('extracts a GitLab MR URL from the log file', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const logFile = join(testData.taskDir, 'output.log');

      writeFileSync(logFile, 'MR created: https://gitlab.com/group/project/-/merge_requests/99');

      const result = (orch as AnyOrch)._ctx.extractPrUrl(logFile);
      expect(result).toBe('https://gitlab.com/group/project/-/merge_requests/99');
    });

    it('extracts a Bitbucket PR URL from the log file', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const logFile = join(testData.taskDir, 'output.log');

      writeFileSync(logFile, 'https://bitbucket.org/team/repo/pull-requests/7 created');

      const result = (orch as AnyOrch)._ctx.extractPrUrl(logFile);
      expect(result).toBe('https://bitbucket.org/team/repo/pull-requests/7');
    });

    it('returns null when no PR URL is found', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const logFile = join(testData.taskDir, 'output.log');

      writeFileSync(logFile, 'Task completed successfully. No URLs here.');

      const result = (orch as AnyOrch)._ctx.extractPrUrl(logFile);
      expect(result).toBeNull();
    });

    it('returns null when the log file does not exist', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const logFile = join(testData.taskDir, 'nonexistent.log');

      const result = (orch as AnyOrch)._ctx.extractPrUrl(logFile);
      expect(result).toBeNull();
    });

    it('returns the first match when multiple PR URLs exist', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const logFile = join(testData.taskDir, 'output.log');

      writeFileSync(logFile, 'First: https://github.com/owner/repo/pull/1\nSecond: https://github.com/other/repo/pull/2');

      const result = (orch as AnyOrch)._ctx.extractPrUrl(logFile);
      expect(result).toBe('https://github.com/owner/repo/pull/1');
    });

    it('handles http URLs (not just https)', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const logFile = join(testData.taskDir, 'output.log');

      writeFileSync(logFile, 'http://github.com/owner/repo/pull/99');

      const result = (orch as AnyOrch)._ctx.extractPrUrl(logFile);
      expect(result).toBe('http://github.com/owner/repo/pull/99');
    });

    it('returns null for an empty log file', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const logFile = join(testData.taskDir, 'output.log');

      writeFileSync(logFile, '');

      const result = (orch as AnyOrch)._ctx.extractPrUrl(logFile);
      expect(result).toBeNull();
    });
  });

  // ── _phaseHeader ──────────────────────────────────────────────────

  describe('_phaseHeader', () => {
    it('handles write failure gracefully', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      expect(() =>
        (orch as AnyOrch)._ctx.phaseHeader('/nonexistent/deep/path/output.log', 'spec'),
      ).not.toThrow();
    });

    it('writes to valid log path', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const logFile = join(testData.taskDir, 'output.log');

      expect(() => (orch as AnyOrch)._ctx.phaseHeader(logFile, 'plan')).not.toThrow();

      const content = readFileSync(logFile, 'utf-8');
      expect(content).toContain('▶ PLAN');
    });
  });

  // ── advancePhase ──────────────────────────────────────────────────

  describe('advancePhase', () => {
    it('updates phase and emits phase-change', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ taskId: testData.taskId });

      (orch as AnyOrch).advancePhase(pipeline, 'plan');

      expect(pipeline.phase).toBe('plan');
      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId: testData.taskId,
        phase: 'plan',
      }));
    });

    it('emits for all phase transitions', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'backlog' });
      mockEmit.mockClear();

      const phases = ['spec', 'plan', 'implement', 'qa-review',
        'awaiting-review', 'merge', 'create-pr', 'done', 'failed'];

      for (const phase of phases) {
        (orch as AnyOrch).advancePhase(pipeline, phase);
        expect(pipeline.phase).toBe(phase);
      }

      expect(mockEmit).toHaveBeenCalledTimes(phases.length);
    });
  });

  // ── _rotateOutputLog ──────────────────────────────────────────────

  describe('_rotateOutputLog', () => {
    it('does nothing when the log file does not exist', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      expect(() => {
        (orch as AnyOrch)._ctx.rotateOutputLog('/nonexistent/log/file.log');
      }).not.toThrow();
    });

    it('does nothing when log file is under the size threshold', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const logFile = join(testData.root, '.teamai', 'small-log.log');
      writeFileSync(logFile, 'a'.repeat(1000));
      const before = readFileSync(logFile, 'utf-8');
      (orch as AnyOrch)._ctx.rotateOutputLog(logFile);
      const after = readFileSync(logFile, 'utf-8');
      expect(after).toBe(before);
    });

    it('truncates to last ~50KB when the log exceeds 100KB', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const logFile = join(testData.root, '.teamai', 'large-log.log');
      const PAD = 'x'.repeat(102400);
      const SUFFIX = 'Y'.repeat(51200);
      writeFileSync(logFile, PAD + SUFFIX);
      (orch as AnyOrch)._ctx.rotateOutputLog(logFile);
      const after = readFileSync(logFile, 'utf-8');
      expect(after.length).toBeGreaterThan(49000);
      expect(after.length).toBeLessThan(52000);
      expect(after).toContain('LOG TRUNCATED');
      expect(after).toContain('Y'.repeat(49000));
      expect(after).not.toContain('x'.repeat(100));
    });

    it('does not throw on permission errors (best-effort)', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      expect(() => {
        (orch as AnyOrch)._ctx.rotateOutputLog('/root/forbidden/log.log');
      }).not.toThrow();
    });
  });

  // ── _persistAndEmitPhase ──────────────────────────────────────────

  describe('_persistAndEmitPhase', () => {
    it('persists the current pipeline phase to disk and emits phase-change', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = {
        taskId: testData.taskId,
        description: 'test',
        phase: 'implement' as const,
        specPath: testData.taskDir,
        worktreePath: '/test/wt',
        branch: 'feat/test',
        qaAttempt: 0,
        maxQaAttempts: 3,
      };

      mockEmit.mockClear();
      (orch as AnyOrch)._ctx.persistAndEmitPhase(pipeline);

      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId: testData.taskId,
        phase: 'implement',
      }));

      const taskJson = JSON.parse(readFileSync(join(pipeline.specPath, 'task.json'), 'utf-8'));
      expect(taskJson.phase).toBe('implement');
    });

    it('persists different phases correctly', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = {
        taskId: testData.taskId,
        description: 'test',
        phase: 'merge' as const,
        specPath: testData.taskDir,
        worktreePath: '/test/wt',
        branch: 'feat/test',
        qaAttempt: 0,
        maxQaAttempts: 3,
      };

      mockEmit.mockClear();
      (orch as AnyOrch)._ctx.persistAndEmitPhase(pipeline);

      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId: testData.taskId,
        phase: 'merge',
      }));

      const taskJson = JSON.parse(readFileSync(join(pipeline.specPath, 'task.json'), 'utf-8'));
      expect(taskJson.phase).toBe('merge');
    });
  });

  // ── _savePipelineState ────────────────────────────────────────────

  describe('_savePipelineState', () => {
    it('writes pipeline state to .pipeline_state.json atomically', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const statePath = join(testData.taskDir, '.pipeline_state.json');
      const tmpPath = statePath + '.tmp';

      const pipeline = {
        taskId: testData.taskId,
        description: 'test',
        phase: 'implement' as const,
        specPath: testData.taskDir,
        worktreePath: '/test/wt',
        branch: 'feat/test',
        qaAttempt: 2,
        maxQaAttempts: 3,
        mergeStrategy: 'pull-request' as const,
        sessionId: 'sess-123',
      };

      (orch as AnyOrch)._ctx.savePipelineState(pipeline);

      expect(existsSync(tmpPath)).toBe(false);
      expect(existsSync(statePath)).toBe(true);

      const saved = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(saved.taskId).toBe(testData.taskId);
      expect(saved.phase).toBe('implement');
      expect(saved.sessionId).toBe('sess-123');
      expect(saved.mergeStrategy).toBe('pull-request');
      expect(saved.qaAttempt).toBe(2);
      expect(saved.branch).toBe('feat/test');
      expect(saved.worktreePath).toBe('/test/wt');
      expect(saved.updatedAt).toBeDefined();
    });

    it('writes pipeline state with undefined sessionId gracefully', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const statePath = join(testData.taskDir, '.pipeline_state.json');

      const pipeline = {
        taskId: testData.taskId,
        description: 'test',
        phase: 'spec' as const,
        specPath: testData.taskDir,
        worktreePath: '/test/wt',
        branch: 'feat/test',
        qaAttempt: 0,
        maxQaAttempts: 3,
      };

      (orch as AnyOrch)._ctx.savePipelineState(pipeline);

      const saved = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(saved.sessionId).toBeUndefined();
      expect(saved.mergeStrategy).toBeUndefined();
      expect(saved.qaAttempt).toBe(0);
    });

    it('does not throw on permission errors (best-effort)', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = {
        taskId: testData.taskId,
        description: 'test',
        phase: 'spec' as const,
        specPath: '/root/forbidden',
        worktreePath: '/test/wt',
        branch: 'feat/test',
        qaAttempt: 0,
        maxQaAttempts: 3,
      };

      expect(() => {
        (orch as AnyOrch)._ctx.savePipelineState(pipeline);
      }).not.toThrow();
    });
  });

  // ── _restorePipelineState ─────────────────────────────────────────

  describe('_restorePipelineState', () => {
    let specPath: string;
    let statePath: string;

    beforeEach(() => {
      testData = setupTestProject();
      specPath = testData.taskDir;
      statePath = join(specPath, '.pipeline_state.json');
      try { if (existsSync(statePath)) unlinkSync(statePath); } catch {}
    });

    it('returns null when no state file exists', () => {
      const orch = makeOrch(testData.root, getOrchestrator);
      expect(existsSync(statePath)).toBe(false);
      const result = (orch as AnyOrch)._restorePipelineState(testData.taskId, specPath);
      expect(result).toBeNull();
    });

    it('returns parsed state and cleans up the file after reading', () => {
      const orch = makeOrch(testData.root, getOrchestrator);
      const state = {
        taskId: testData.taskId,
        phase: 'implement',
        sessionId: 'sess-abc',
        mergeStrategy: 'local-merge',
        qaAttempt: 1,
        branch: 'feat/test',
        worktreePath: '/test/wt',
        updatedAt: new Date().toISOString(),
      };
      writeFileSync(statePath, JSON.stringify(state, null, 2));

      const result = (orch as AnyOrch)._restorePipelineState(testData.taskId, specPath);

      expect(result).not.toBeNull();
      expect(result!.sessionId).toBe('sess-abc');
      expect(result!.mergeStrategy).toBe('local-merge');
      expect(result!.qaAttempt).toBe(1);
      expect(result!.phase).toBe('implement');

      expect(existsSync(statePath)).toBe(false);
    });

    it('returns null for corrupt JSON (file stays on disk for debugging)', () => {
      const orch = makeOrch(testData.root, getOrchestrator);
      writeFileSync(statePath, 'not valid json {{{');
      const result = (orch as AnyOrch)._restorePipelineState(testData.taskId, specPath);
      expect(result).toBeNull();
      expect(existsSync(statePath)).toBe(true);
    });

    it('returns null for empty state file', () => {
      const orch = makeOrch(testData.root, getOrchestrator);
      writeFileSync(statePath, '');
      const result = (orch as AnyOrch)._restorePipelineState(testData.taskId, specPath);
      expect(result).toBeNull();
    });
  });

  // ── _execGit ───────────────────────────────────────────────────────

  describe('_execGit', () => {
    it('calls git on host when container is disabled', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      mockExecFileSync.mockReturnValue('');
      (orch as AnyOrch)._execGit(['status'], testData.root);

      expect(mockExecFileSync).toHaveBeenCalledWith('git', ['status'], { cwd: testData.root });
    });

    it('calls docker exec when container is enabled and running', () => {
      testData = setupTestProject();
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(containerManager.getRunningContainer).mockReturnValue({
        containerId: 'cont-abc',
        remoteWorkspaceFolder: '/workspace',
      } as any);
      vi.mocked(hostToContainerPath).mockImplementation((hp: string, _root: string, _ws: string) => {
        return '/workspace' + (hp === testData.root ? '' : '/cwd');
      });

      const orch = makeOrch(testData.root, getOrchestrator);

      mockExecFileSync.mockReturnValue('');
      (orch as AnyOrch)._execGit(['status'], testData.root);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        getToolPath('docker'),
        expect.arrayContaining(['exec', '-u', 'node', 'cont-abc', 'git', 'status']),
      );
    });

    // Coverage: line 540 — absolute project path mapped through hostToContainerPath
    it('maps absolute project paths via hostToContainerPath in container mode', () => {
      testData = setupTestProject();
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(containerManager.getRunningContainer).mockReturnValue({
        containerId: 'cont-xyz',
        remoteWorkspaceFolder: '/workspace',
      } as any);
      const mapSpy = vi.mocked(hostToContainerPath).mockReturnValue('/workspace/some/file');

      const orch = makeOrch(testData.root, getOrchestrator);

      mockExecFileSync.mockReturnValue('');
      // Pass an absolute path starting with projectRoot — should be mapped
      const absolutePath = join(testData.root, 'some', 'file');
      (orch as AnyOrch)._execGit(['add', absolutePath], testData.root);

      expect(mapSpy).toHaveBeenCalledWith(
        absolutePath,
        testData.root,
        '/workspace',
      );
      expect(mockExecFileSync).toHaveBeenCalledWith(
        getToolPath('docker'),
        expect.arrayContaining(['git', 'add', '/workspace/some/file']),
      );
    });

    it('leaves non-project absolute paths unchanged in container mode', () => {
      testData = setupTestProject();
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(containerManager.getRunningContainer).mockReturnValue({
        containerId: 'cont-xyz',
        remoteWorkspaceFolder: '/workspace',
      } as any);
      vi.mocked(hostToContainerPath).mockImplementation((p: string) => p);

      const orch = makeOrch(testData.root, getOrchestrator);

      mockExecFileSync.mockReturnValue('');
      // Path outside project root — should NOT be mapped
      (orch as AnyOrch)._execGit(['add', '/tmp/external-file'], testData.root);

      // hostToContainerPath should not have been called with this path
      // The path won't startWith projectRoot, so it passes through as-is
      expect(mockExecFileSync).toHaveBeenCalledWith(
        getToolPath('docker'),
        expect.arrayContaining(['git', 'add', '/tmp/external-file']),
      );
    });

    it('falls back to host git when container is enabled but not running', () => {
      testData = setupTestProject();
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      // No running container
      vi.mocked(containerManager.getRunningContainer).mockReturnValue(null);

      const orch = makeOrch(testData.root, getOrchestrator);

      mockExecFileSync.mockReturnValue('');
      (orch as AnyOrch)._execGit(['status'], testData.root);

      // Falls back to host git
      expect(mockExecFileSync).toHaveBeenCalledWith('git', ['status'], { cwd: testData.root });
    });
  });

  // ── _toAgentPath ───────────────────────────────────────────────────

  describe('_toAgentPath', () => {
    it('returns host path unchanged when container is disabled', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      expect((orch as AnyOrch)._ctx.toAgentPath('/some/path')).toBe('/some/path');
    });

    it('translates path via hostToContainerPath when container enabled and running', () => {
      testData = setupTestProject();
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(containerManager.getRunningContainer).mockReturnValue({
        containerId: 'abc',
        remoteWorkspaceFolder: '/workspace',
      } as any);
      vi.mocked(hostToContainerPath).mockReturnValue('/workspace/path');

      const orch = makeOrch(testData.root, getOrchestrator);
      const result = (orch as AnyOrch)._ctx.toAgentPath('/some/path');

      expect(hostToContainerPath).toHaveBeenCalled();
      expect(result).toBe('/workspace/path');
    });
  });

  // ── getWorktreeBase ────────────────────────────────────────────────

  describe('getWorktreeBase', () => {
    it('returns ../worktrees when container disabled', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const base = (orch as AnyOrch).getWorktreeBase();
      expect(base).toContain('worktrees');
      expect(base).not.toContain('.worktrees');
    });

    it('returns .worktrees when container is enabled', () => {
      testData = setupTestProject();
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      const orch = makeOrch(testData.root, getOrchestrator);

      const base = (orch as AnyOrch).getWorktreeBase();
      expect(base).toContain('.worktrees');
    });
  });

  // ── getWorktreePath ────────────────────────────────────────────────

  describe('getWorktreePath', () => {
    it('returns null when task has no branch', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Task has no branch field
      expect(orch.getWorktreePath(testData.taskId)).toBeNull();
    });

    it('returns the worktree path when task has a branch', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Set description and branch so getWorktreePath derives the correct directory
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { description: testData.slug, branch: testData.branchName });

      const result = orch.getWorktreePath(testData.taskId);
      expect(result).not.toBeNull();
      expect(result).toContain('worktrees');
      expect(result).toContain(testData.slug);
    });
  });

  // ── _isWorktreeHealthy ────────────────────────────────────────────

  describe('_isWorktreeHealthy', () => {
    it('returns false when .git file does not exist', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const wtPath = join(testData.root, 'no-git');
      mkdirSync(wtPath, { recursive: true });
      expect((orch as AnyOrch)._ctx.isWorktreeHealthy(wtPath)).toBe(false);
    });

    it('returns false when .git is not a worktree file (no gitdir: prefix)', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const wtPath = join(testData.root, 'bad-git-format');
      mkdirSync(wtPath, { recursive: true });
      writeFileSync(join(wtPath, '.git'), 'not a worktree file');
      expect((orch as AnyOrch)._ctx.isWorktreeHealthy(wtPath)).toBe(false);
    });

    it('returns false when gitdir points to a nonexistent path', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const wtPath = join(testData.root, 'broken-gitdir');
      mkdirSync(wtPath, { recursive: true });
      writeFileSync(join(wtPath, '.git'), 'gitdir: /nonexistent/git/worktrees/test');
      expect((orch as AnyOrch)._ctx.isWorktreeHealthy(wtPath)).toBe(false);
    });

    it('returns true for a valid worktree with an existing gitdir', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const wtPath = join(testData.root, 'healthy-worktree');
      mkdirSync(wtPath, { recursive: true });
      const gitdirPath = join(testData.root, 'fake-gitdir');
      mkdirSync(gitdirPath, { recursive: true });
      writeFileSync(join(wtPath, '.git'), `gitdir: ${gitdirPath}`);
      expect((orch as AnyOrch)._ctx.isWorktreeHealthy(wtPath)).toBe(true);
    });
  });

  // ── removeWorktree ────────────────────────────────────────────────

  describe('removeWorktree (private, via public getWorktreePath)', () => {
    it('does not throw when worktree path does not exist on disk', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // No branch → getWorktreePath returns null → removeWorktree returns early
      expect(() => (orch as AnyOrch)._ctx.removeWorktree(testData.taskId)).not.toThrow();
    });

    // Coverage: lines 568-573 — _execGit throws, catch block handles gracefully
    it('handles _execGit failure gracefully in catch block', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Give the task a branch so getWorktreePath returns a path
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { branch: testData.branchName });

      // Create the worktree directory on disk so existsSync returns true
      // and removeWorktree proceeds past the early-return guard at line 567
      const wtPath = (orch as AnyOrch).getWorktreePath(testData.taskId);
      if (wtPath) mkdirSync(wtPath, { recursive: true });

      // Make _execGit throw (via underlying execFileSync mock)
      mockExecFileSync.mockImplementation(() => {
        throw new Error('git worktree remove failed');
      });

      // Should not throw — the catch block at 571-573 handles it silently
      expect(() => (orch as AnyOrch)._ctx.removeWorktree(testData.taskId)).not.toThrow();

      // Verify _execGit was actually called (the git worktree remove command)
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object),
      );
    });

    // ── container mode ───────────────────────────────────────────

    describe('container mode', () => {
      it('removes worktree via docker exec, then cleans up branch on host', () => {
        testData = setupTestProject();
        vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
        vi.mocked(containerManager.getRunningContainer).mockReturnValue({
          containerId: 'cont-abc',
          remoteWorkspaceFolder: '/workspace',
        } as any);
        vi.mocked(hostToContainerPath).mockImplementation((hp: string, root: string, _ws: string) => {
          if (hp === root) return '/workspace';
          if (hp.startsWith(root)) return '/workspace' + hp.slice(root.length).replace(/\\/g, '/');
          return hp;
        });

        const orch = makeOrch(testData.root, getOrchestrator);
        const taskStore = (orch as AnyOrch).taskStore;
        taskStore.update(testData.taskId, { description: testData.slug, branch: testData.branchName });

        // In container mode, getWorktreeBase returns .worktrees inside projectRoot
        const wtPath = orch.getWorktreePath(testData.taskId)!;
        mkdirSync(wtPath, { recursive: true });

        mockExecFileSync.mockReturnValue('');
        (orch as AnyOrch)._ctx.removeWorktree(testData.taskId);

        // _execGit skips container routing for worktree commands — runs on host
        expect(mockExecFileSync).toHaveBeenCalledWith(
          'git',
          expect.arrayContaining(['worktree', 'remove']),
          expect.any(Object),
        );
        // Branch cleanup runs on host (not through _execGit)
        expect(mockExecFileSync).toHaveBeenCalledWith(
          'git',
          expect.arrayContaining(['branch', '-D', testData.branchName]),
          expect.objectContaining({ cwd: testData.root }),
        );
        // taskStore updated to clear branch
        const updated = taskStore.getById(testData.taskId);
        expect(updated?.branch).toBeUndefined();
      });

      it('falls back to --force via docker exec when normal remove fails', () => {
        testData = setupTestProject();
        vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
        vi.mocked(containerManager.getRunningContainer).mockReturnValue({
          containerId: 'cont-abc',
          remoteWorkspaceFolder: '/workspace',
        } as any);
        vi.mocked(hostToContainerPath).mockImplementation((hp: string, root: string, _ws: string) => {
          if (hp === root) return '/workspace';
          if (hp.startsWith(root)) return '/workspace' + hp.slice(root.length).replace(/\\/g, '/');
          return hp;
        });

        const orch = makeOrch(testData.root, getOrchestrator);
        const taskStore = (orch as AnyOrch).taskStore;
        taskStore.update(testData.taskId, { description: testData.slug, branch: testData.branchName });

        const wtPath = orch.getWorktreePath(testData.taskId)!;
        mkdirSync(wtPath, { recursive: true });

        // Normal remove (docker exec) throws — simulate uncommitted changes
        mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
          if (cmd === 'git' && args.includes('remove') && !args.includes('--force')) {
            throw new Error('worktree has uncommitted changes');
          }
          return '';
        });

        (orch as AnyOrch)._ctx.removeWorktree(testData.taskId);

        // _execGit skips container routing for worktree commands — runs on host
        expect(mockExecFileSync).toHaveBeenCalledWith(
          'git',
          expect.arrayContaining(['worktree', 'remove']),
          expect.any(Object),
        );
        expect(mockExecFileSync).toHaveBeenCalledWith(
          'git',
          expect.arrayContaining(['worktree', 'remove', '--force']),
          expect.any(Object),
        );
        // Branch cleanup still runs on host
        expect(mockExecFileSync).toHaveBeenCalledWith(
          'git',
          expect.arrayContaining(['branch', '-D', testData.branchName]),
          expect.objectContaining({ cwd: testData.root }),
        );
        // taskStore updated to clear branch
        const updated = taskStore.getById(testData.taskId);
        expect(updated?.branch).toBeUndefined();
      });

      it('falls back to rmSync + prune when docker exec remove and --force both fail', () => {
        testData = setupTestProject();
        vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
        vi.mocked(containerManager.getRunningContainer).mockReturnValue({
          containerId: 'cont-abc',
          remoteWorkspaceFolder: '/workspace',
        } as any);
        vi.mocked(hostToContainerPath).mockImplementation((hp: string, root: string, _ws: string) => {
          if (hp === root) return '/workspace';
          if (hp.startsWith(root)) return '/workspace' + hp.slice(root.length).replace(/\\/g, '/');
          return hp;
        });

        const orch = makeOrch(testData.root, getOrchestrator);
        const taskStore = (orch as AnyOrch).taskStore;
        taskStore.update(testData.taskId, { description: testData.slug, branch: testData.branchName });

        const wtPath = orch.getWorktreePath(testData.taskId)!;
        mkdirSync(wtPath, { recursive: true });
        // Create a file inside the worktree to verify rmSync truly removes content
        writeFileSync(join(wtPath, 'locked-file.txt'), 'this file should be deleted by rmSync');

        // Both docker exec attempts throw — simulate locked files
        mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
          if (cmd === 'git' && args.includes('remove')) {
            throw new Error('worktree is locked');
          }
          return '';
        });

        (orch as AnyOrch)._ctx.removeWorktree(testData.taskId);

        // rmSync was called — the worktree directory should be gone
        expect(existsSync(wtPath)).toBe(false);
        // git worktree prune was called on host (raw execFileSync)
        expect(mockExecFileSync).toHaveBeenCalledWith(
          'git',
          expect.arrayContaining(['worktree', 'prune']),
          expect.objectContaining({ cwd: testData.root }),
        );
        // Branch cleanup still runs
        expect(mockExecFileSync).toHaveBeenCalledWith(
          'git',
          expect.arrayContaining(['branch', '-D', testData.branchName]),
          expect.objectContaining({ cwd: testData.root }),
        );
        // taskStore updated to clear branch even in last-resort path
        const updated = taskStore.getById(testData.taskId);
        expect(updated?.branch).toBeUndefined();
      });
    });
  });

  // ── moveTaskToPhase — hasSpec/hasPlan branching ────────────────────

  describe('moveTaskToPhase — hasSpec/hasPlan branching', () => {
    it('starts from plan when hasSpec is true and target is plan', async () => {
      testData = setupTestProject();
      // Write a spec.md so hasSpec is true
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec content');
      const orch = makeOrch(testData.root, getOrchestrator);

      // Make createSession reject so pipeline stops at first phase
      // This lets us verify the branching logic ran without needing
      // to fire events for the cascading phase chain.
      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'plan').catch(() => {});

      // createSession was called — proving moveTaskToPhase reached executePhase
      expect(mockCreateSession).toHaveBeenCalled();
    });

    // Coverage: line 116 — hasPlan = true when plan.json exists
    it('starts from implement when hasSpec and hasPlan are true and target is implement', async () => {
      testData = setupTestProject();
      // Write both spec.md and plan.json so hasSpec=true and hasPlan=true
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({ subtasks: [{ id: 1, title: "Test", description: "Test", files: [], acceptance_criteria: [] }] }));
      const orch = makeOrch(testData.root, getOrchestrator);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'implement').catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('starts from spec when neither hasSpec nor hasPlan exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'implement').catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();
    });
  });

  // ── _writeQaFeedback ──────────────────────────────────────────────

  describe('_writeQaFeedback', () => {
    it('writes qa_feedback.md with failed criteria when report has criteria', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ specPath: testData.taskDir });
      const report = {
        overall: 'FAIL',
        criteria: [
          { name: 'All endpoints documented', status: 'FAIL', notes: 'Missing DELETE' },
          { name: 'Examples included', status: 'PASS', notes: '' },
        ],
        issues: [
          { severity: 'error', message: 'DELETE endpoint not documented' },
        ],
      };

      (orch as AnyOrch)._ctx.writeQaFeedback(pipeline, report);

      const feedbackPath = join(testData.taskDir, 'qa_feedback.md');
      expect(existsSync(feedbackPath)).toBe(true);
      const content = readFileSync(feedbackPath, 'utf-8');
      expect(content).toContain('## Overall: FAIL');
      expect(content).toContain('**All endpoints documented**');
      expect(content).toContain('Missing DELETE');
      expect(content).not.toContain('Examples included'); // PASS criteria excluded
      expect(content).toContain('DELETE endpoint not documented');
    });

    it('handles report with no criteria or issues gracefully', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ specPath: testData.taskDir });
      const report = { overall: 'FAIL' };

      (orch as AnyOrch)._ctx.writeQaFeedback(pipeline, report);

      const feedbackPath = join(testData.taskDir, 'qa_feedback.md');
      expect(existsSync(feedbackPath)).toBe(true);
      const content = readFileSync(feedbackPath, 'utf-8');
      expect(content).toContain('## Overall: FAIL');
    });
  });

  // ── _writeCompletionSummary ─────────────────────────────────────────

  describe('_writeCompletionSummary', () => {
    it('writes completion_summary.md with subtask status and QA report', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Write a plan.json with mixed completed status
      const plan = {
        subtasks: [
          { id: 1, title: 'Fix CSS', description: '', files: [], acceptance_criteria: [], completed: true },
          { id: 2, title: 'Add tests', description: '', files: [], acceptance_criteria: [] },
        ],
      };
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify(plan, null, 2));

      // Write a QA report
      const report = {
        overall: 'FAIL',
        criteria: [
          { name: 'Mobile visibility', status: 'FAIL', notes: 'Button still hidden at 375px' },
        ],
        issues: [
          { severity: 'error', message: 'CSS z-index too low' },
        ],
      };
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify(report, null, 2));

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        qaAttempt: 2,
        maxQaAttempts: 3,
      });

      (orch as AnyOrch)._ctx.writeCompletionSummary(pipeline);

      const summaryPath = join(testData.taskDir, 'completion_summary.md');
      expect(existsSync(summaryPath)).toBe(true);
      const content = readFileSync(summaryPath, 'utf-8');

      expect(content).toContain('Task failed after 2 QA attempts');
      expect(content).toContain('[x]');
      expect(content).toContain('Fix CSS');
      expect(content).toContain('[ ]');
      expect(content).toContain('Add tests');
      expect(content).toContain('Overall: **FAIL**');
      expect(content).toContain('Mobile visibility');
      expect(content).toContain('CSS z-index too low');
    });

    it('handles missing plan.json gracefully', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        qaAttempt: 1,
      });

      (orch as AnyOrch)._ctx.writeCompletionSummary(pipeline);

      const summaryPath = join(testData.taskDir, 'completion_summary.md');
      expect(existsSync(summaryPath)).toBe(true);
      const content = readFileSync(summaryPath, 'utf-8');
      expect(content).toContain('Task failed after 1 QA attempts');
    });

    it('stores completionSummary on the task via taskStore', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        qaAttempt: 3,
      });

      (orch as AnyOrch)._ctx.writeCompletionSummary(pipeline);

      // Verify the task was updated with completionSummary
      const taskStore = (orch as AnyOrch).taskStore;
      const updated = taskStore.getById(testData.taskId);
      expect(updated).not.toBeNull();
      expect(updated!.completionSummary).toBeDefined();
      expect(updated!.completionSummary).toContain('Task failed after 3 QA attempts');
    });
  });

  // ── handleRateLimit ───────────────────────────────────────────────

  describe('handleRateLimit', () => {
    it('updates task store with rateLimitedUntil and emits event', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ taskId: testData.taskId });

      const future = Math.floor(Date.now() / 1000) + 3600;
      (orch as AnyOrch).handleRateLimit(pipeline, future);

      // Should have emitted phase-change with rateLimitedUntil
      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId: testData.taskId,
        rateLimitedUntil: expect.any(String),
      }));
    });

    // Coverage: handleRateLimit retry callback — non-RateLimitError branch (lines 505-507)
    it('advances to failed when retry encounters non-rate-limit error', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });

      // Pipeline must be registered so handleRateLimit can re-acquire the lock
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      const tStore = (orch as AnyOrch).taskStore; tStore.update(testData.taskId, { phase: 'spec' }); // Mock createSession to reject with a regular Error (not a RateLimitError)
      // This makes executePhase fail fast when it reaches runSpec
      mockCreateSession.mockRejectedValue(new Error('simulated createSession failure'));

      // Use a promise that resolves when advancePhase is called with 'failed'
      const promise = new Promise<void>(resolve => {
        const origAdvance = (orch as AnyOrch).advancePhase.bind(orch);
        (orch as AnyOrch).advancePhase = (p: any, phase: string) => {
          origAdvance(p, phase);
          if (phase === 'failed') resolve();
        };
      });

      // resetsAt = 0 → resetsAtMs = 0 → waitMs = 0 → setTimeout fires on next tick
      (orch as AnyOrch).handleRateLimit(pipeline, 0);

      // Wait for the setTimeout callback to fire and advancePhase('failed') to be called
      await promise;

      // Clean up the patched method
      delete (orch as AnyOrch).advancePhase;

      // The finally block should have cleaned up pipelines/activeTasks
      // (wasRateLimited is false since it's not a RateLimitError)
      expect((orch as AnyOrch).pipelines.has(testData.taskId)).toBe(false);
      expect((orch as AnyOrch).activeTasks.has(testData.taskId)).toBe(false);
    });

    // Coverage: handleRateLimit retry callback — RateLimitError branch (lines 501-504)
    it('re-enters handleRateLimit when retry is also rate limited', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Use a pipeline with phase='spec' so executePhase → runSpec → createSession → waitForCompletion
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      const tStore2 = (orch as AnyOrch).taskStore; tStore2.update(testData.taskId, { phase: 'spec' }); // Make createSession succeed so executePhase reaches waitForCompletion
      mockCreateSession.mockResolvedValue('retry-sess');

      // Track how many times handleRateLimit is called
      let rateLimitCalls = 0;
      const origHandle = (orch as AnyOrch).handleRateLimit.bind(orch);
      (orch as AnyOrch).handleRateLimit = (p: any, r: number) => {
        rateLimitCalls++;
        return origHandle(p, r);
      };

      // Also track advancePhase with 'failed' — should NOT be called
      let failedCalled = false;
      const origAdvance = (orch as AnyOrch).advancePhase.bind(orch);
      (orch as AnyOrch).advancePhase = (p: any, phase: string) => {
        if (phase === 'failed') failedCalled = true;
        origAdvance(p, phase);
      };

      // resetsAt = 0 → waitMs = 0 → fires immediately
      (orch as AnyOrch).handleRateLimit(pipeline, 0);

      // Wait for setTimeout to fire and executePhase to run 
      // which calls runSpec → waitForCompletion
      await new Promise(r => setTimeout(r, 30));

      // Now waitForCompletion should be listening — fire rate limit events
      // This makes waitForCompletion reject with RateLimitError
      fireEvent('event', {
        sessionId: 'retry-sess',
        event: { type: 'rate_limit_event', rate_limit_info: { status: 'limited', resetsAt: 9999999999 } },
      });
      fireEvent('event', {
        sessionId: 'retry-sess',
        event: { type: 'result', is_error: true },
      });

      // Give microtasks time to process the rejection chain
      await new Promise(r => setTimeout(r, 30));

      // Restore original methods
      delete (orch as AnyOrch).handleRateLimit;
      delete (orch as AnyOrch).advancePhase;

      // handleRateLimit should have been called twice:
      // 1. Our initial call
      // 2. Nested call from the catch block (line 504)
      expect(rateLimitCalls).toBe(2);

      // Should NOT have advanced to 'failed' (RateLimitError is handled, not failed)
      expect(failedCalled).toBe(false);

      // wasRateLimited was true → finally block did NOT clean up
      expect((orch as AnyOrch).activeTasks.has(testData.taskId)).toBe(true);
    });

    it('skips resume when task was moved to backlog during rate limit', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'spec' });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      mockCreateSession.mockRejectedValue(new Error('should not be called — resume was skipped'));

      let advanceCalled = false;
      const origAdvance = (orch as AnyOrch).advancePhase.bind(orch);
      (orch as AnyOrch).advancePhase = (p: any, phase: string) => { advanceCalled = true; origAdvance(p, phase); };

      (orch as AnyOrch).handleRateLimit(pipeline, 0);

      taskStore.update(testData.taskId, { phase: 'backlog' });

      await new Promise(r => setTimeout(r, 30));

      delete (orch as AnyOrch).advancePhase;

      expect((orch as AnyOrch).pipelines.has(testData.taskId)).toBe(false);
      expect((orch as AnyOrch).activeTasks.has(testData.taskId)).toBe(false);
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(advanceCalled).toBe(false);

      const task = taskStore.getById(testData.taskId);
      expect(task?.rateLimitedUntil).toBeUndefined();
    });

    it('skips resume when pipeline was replaced (stale pipeline guard)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipelineA = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'spec' });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipelineA);

      // Create a second pipeline object — simulating user restarted the task.
      // The handleRateLimit closure captured pipelineA, but the maps now hold pipelineB.
      const pipelineB = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });

      mockCreateSession.mockRejectedValue(new Error('should not be called — stale pipeline skipped'));

      let advanceCalled = false;
      const origAdvance = (orch as AnyOrch).advancePhase.bind(orch);
      (orch as AnyOrch).advancePhase = (p: any, phase: string) => { advanceCalled = true; origAdvance(p, phase); };

      // Call handleRateLimit — its synchronous part registers pipelineA in the maps
      (orch as AnyOrch).handleRateLimit(pipelineA, 0);

      // Immediately replace pipelineA with pipelineB in the maps,
      // simulating that the task was stopped and restarted
      (orch as AnyOrch).pipelines.set(testData.taskId, pipelineB);

      // Wait for the setTimeout callback to fire
      await new Promise(r => setTimeout(r, 30));

      delete (orch as AnyOrch).advancePhase;

      // Identity guard should have skipped resume WITHOUT clearing activeTasks
      // (the new pipeline owns that lock)
      expect((orch as AnyOrch).activeTasks.has(testData.taskId)).toBe(true);

      // The map should still contain pipelineB (not deleted by the stale guard)
      expect((orch as AnyOrch).pipelines.get(testData.taskId)).toBe(pipelineB);

      // No phase execution should have occurred
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(advanceCalled).toBe(false);

      // rateLimitedUntil must be cleared even for stale pipelines
      const task = taskStore.getById(testData.taskId);
      expect(task?.rateLimitedUntil).toBeUndefined();
    });

    it('keeps pipeline in maps after runTask catches RateLimitError (rateLimited flag fix)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      mockCreateSession.mockResolvedValue('sess-rl-runTask');
      const runPromise = orch.runTask(testData.taskId, 'test task', 'spec').catch(() => {});
      await new Promise(r => setTimeout(r, 20));
      const future = Math.floor(Date.now() / 1000) + 9999;
      fireEvent('event', { sessionId: 'sess-rl-runTask', event: { type: 'rate_limit_event', rate_limit_info: { status: 'limited', resetsAt: future } } });
      fireEvent('event', { sessionId: 'sess-rl-runTask', event: { type: 'result', is_error: true } });
      await new Promise(r => setTimeout(r, 30));
      await runPromise;
      expect((orch as AnyOrch).pipelines.has(testData.taskId)).toBe(true);
      expect((orch as AnyOrch).activeTasks.has(testData.taskId)).toBe(true);
      
    });

    it('setTimeout stale-pipeline guard passes when pipeline remains in map', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);
      (orch as AnyOrch).activeTasks.add(testData.taskId);
      const tStore = (orch as AnyOrch).taskStore;
      tStore.update(testData.taskId, { phase: 'spec' });
      let executePhaseCalled = false;
      // Use a pending promise so the setTimeout callback's finally block
      // doesn't clean up activeTasks before our assertion runs.
      let resolveExecute!: () => void;
      const executePromise = new Promise<void>(r => { resolveExecute = r; });
      (orch as AnyOrch).executePhase = async (_p: any) => { executePhaseCalled = true; return executePromise; };
      (orch as AnyOrch).handleRateLimit(pipeline, 0);
      await new Promise(r => setTimeout(r, 30));
      // executePhase was called, but hasn't resolved yet — pipeline should still be in maps
      expect(executePhaseCalled).toBe(true);
      expect((orch as AnyOrch).activeTasks.has(testData.taskId)).toBe(true);
      // Now resolve and let the finally block clean up
      resolveExecute();
      await new Promise(r => setTimeout(r, 10));
      delete (orch as AnyOrch).executePhase;
      // finally block has run — clean up our manual additions
      (orch as AnyOrch).pipelines.delete(testData.taskId);
      (orch as AnyOrch).activeTasks.delete(testData.taskId);
    });
  });


  // ── Pipeline phase methods ────────────────────────────────────────

  describe('pipeline phase methods', () => {
    // Coverage: runSpec (lines 247-261) — creates session, sends message, waits, advances
    it('runSpec creates session, sends message, and advances to plan on completion', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
      });

      // First createSession call succeeds, subsequent ones reject
      let callCount = 0;
      mockCreateSession.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve('spec-sess-1');
        return Promise.reject(new Error('simulated abort'));
      });

      // Start runSpec
      const promise = (orch as AnyOrch).runSpec(pipeline).catch(() => {});

      // Give microtasks time: runSpec awaits createSession → resolves → 
      // sends message → awaits waitForCompletion
      await new Promise(r => setTimeout(r, 20));

      // Should have called createSession (spec phase)
      expect(mockCreateSession).toHaveBeenCalled();
      // Should have sent the /spec command
      expect(mockSendMessage).toHaveBeenCalledWith('spec-sess-1', expect.stringContaining('/spec'));

      // Fire result event to resolve waitForCompletion
      fireEvent('event', { sessionId: 'spec-sess-1', event: { type: 'result' } });

      // Let the promise chain complete (spec finishes, advances to plan, plan fails)
      await new Promise(r => setTimeout(r, 50));
      await promise;

      // Spec phase should have killed the session
      expect(mockKillSession).toHaveBeenCalledWith('spec-sess-1');

      // Phase should have advanced to 'plan' before the cascade failed
      expect(pipeline.phase).toBe('plan');
    });
  });

  // ── Singleton ─────────────────────────────────────────────────────

  describe('getOrchestrator singleton', () => {
    it('returns same instance for same path', () => {
      const p = join(tmpdir(), `teamai-sing-${randomUUID().slice(0, 8)}`);
      const orch1 = getOrchestrator(p);
      const orch2 = getOrchestrator(p);
      expect(orch1).toBe(orch2);
    });

    it('returns different instance for different path', () => {
      const p1 = join(tmpdir(), `teamai-sing-${randomUUID().slice(0, 8)}`);
      const p2 = join(tmpdir(), `teamai-sing-${randomUUID().slice(0, 8)}`);
      const orch1 = getOrchestrator(p1);
      const orch2 = getOrchestrator(p2);
      expect(orch1).not.toBe(orch2);
    });
  });

  // ── runMerge ──────────────────────────────────────────────────────

  describe('runMerge', () => {
    it('merges directly via git merge --no-edit, cleans up', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      mkdirSync(pipeline.worktreePath, { recursive: true });
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { description: slug, branch: `feat/${slug}` });
      mockExecFileSync.mockReturnValue('');

      const promise = (orch as AnyOrch).runMerge(pipeline);
      await promise;

      // Direct merge should have been attempted (no session created)
      expect(mockCreateSession).not.toHaveBeenCalled();
      // execGit was called for merge
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['merge', `feat/${slug}`]),
        expect.any(Object),
      );
      // Worktree removed
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object),
      );
      expect(pipeline.phase).toBe('done');

      if (existsSync(pipeline.worktreePath)) {
        rmSync(pipeline.worktreePath, { recursive: true, force: true });
      }
    });

    it('spawns merger agent when rebase has conflicts, then direct merge succeeds', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      mkdirSync(pipeline.worktreePath, { recursive: true });
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { description: slug, branch: `feat/${slug}` });

      // One session = merger for rebase (no merge session needed)
      mockCreateSession.mockResolvedValue('sess-merge-rebase');

      // Simulate rebase conflict, but merge succeeds
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && Array.isArray(args)) {
          const argStr = args.join(' ');
          if (argStr.includes('rebase') && !argStr.includes('--abort')) {
            throw new Error('Rebase conflict');
          }
        }
        return '';
      });

      const promise = (orch as AnyOrch).runMerge(pipeline);
      await new Promise(r => setTimeout(r, 20));

      // Merger session should have been created for rebase conflict
      expect(mockSendMessage).toHaveBeenCalledWith('sess-merge-rebase', '/merge origin/main');

      // Complete the merger session
      fireEvent('event', { sessionId: 'sess-merge-rebase', event: { type: 'result' } });
      await promise;

      expect(mockKillSession).toHaveBeenCalledWith('sess-merge-rebase');
      // Only one session created (rebase merger only, no merge session)
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      // Direct merge was attempted
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['merge', `feat/${slug}`]),
        expect.any(Object),
      );
      expect(pipeline.phase).toBe('done');

      if (existsSync(pipeline.worktreePath)) {
        rmSync(pipeline.worktreePath, { recursive: true, force: true });
      }
    });

    it('throws when rebase has conflicts and merger agent also fails', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      mkdirSync(pipeline.worktreePath, { recursive: true });
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { description: slug, branch: `feat/${slug}` });

      // Only the merger session (rebase conflict path) — merge never created
      mockCreateSession.mockResolvedValue('sess-merge-rebase');

      // Simulate rebase conflict
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && Array.isArray(args)) {
          const argStr = args.join(' ');
          if (argStr.includes('rebase') && !argStr.includes('--abort')) {
            throw new Error('Rebase conflict');
          }
        }
        return '';
      });

      const promise = (orch as AnyOrch).runMerge(pipeline);
      await new Promise(r => setTimeout(r, 20));

      // Merger session was created
      expect(mockSendMessage).toHaveBeenCalledWith('sess-merge-rebase', '/merge origin/main');

      // Simulate merger failure — exit with non-zero code
      fireEvent('exit', { sessionId: 'sess-merge-rebase', code: 1 });

      // Merge should throw (unlike create-pr which proceeds)
      await expect(promise).rejects.toThrow(/Rebase onto latest main failed/);

      // Phase should NOT have advanced to done
      expect(pipeline.phase).not.toBe('done');

      if (existsSync(pipeline.worktreePath)) {
        rmSync(pipeline.worktreePath, { recursive: true, force: true });
      }
    });

    it('spawns merger agent when direct merge has conflicts', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      mkdirSync(pipeline.worktreePath, { recursive: true });
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { description: slug, branch: `feat/${slug}` });

      // One session: merger for the merge conflict (rebase succeeds cleanly)
      mockCreateSession.mockResolvedValue('sess-merge-conflict');

      // Rebase succeeds, but merge fails with conflict
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && Array.isArray(args)) {
          const argStr = args.join(' ');
          if (argStr.includes('merge') && !argStr.includes('--abort') && argStr.includes(`feat/${slug}`)) {
            throw new Error('Merge conflict');
          }
        }
        return '';
      });

      const promise = (orch as AnyOrch).runMerge(pipeline);
      await new Promise(r => setTimeout(r, 20));

      // Merger session created for merge conflict
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      expect(mockSendMessage).toHaveBeenCalledWith('sess-merge-conflict', expect.stringContaining('/merge'));

      // Complete the merger session
      fireEvent('event', { sessionId: 'sess-merge-conflict', event: { type: 'result' } });
      await promise;

      expect(mockKillSession).toHaveBeenCalledWith('sess-merge-conflict');
      expect(pipeline.phase).toBe('done');

      if (existsSync(pipeline.worktreePath)) {
        rmSync(pipeline.worktreePath, { recursive: true, force: true });
      }
    });

    it('does not spawn any sessions when rebase and merge both succeed (fast path)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      mkdirSync(pipeline.worktreePath, { recursive: true });
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { description: slug, branch: `feat/${slug}` });

      mockExecFileSync.mockReturnValue('');

      const promise = (orch as AnyOrch).runMerge(pipeline);
      await promise;

      // No sessions should have been created at all
      expect(mockCreateSession).not.toHaveBeenCalled();
      // Direct merge was attempted
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['merge', `feat/${slug}`]),
        expect.any(Object),
      );
      expect(pipeline.phase).toBe('done');

      if (existsSync(pipeline.worktreePath)) {
        rmSync(pipeline.worktreePath, { recursive: true, force: true });
      }
    });
  });

  // ── runCreatePR ───────────────────────────────────────────────────

  describe('runCreatePR', () => {
    it('pushes branch, creates PR via gh CLI, advances to pr-open', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature\n\nImplement this feature.');

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      // Mock: no existing PR, then gh pr create returns the URL
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        const argStr = Array.isArray(args) ? args.join(' ') : '';
        if (cmd === 'gh' && argStr.includes('pr list')) return '';
        if (cmd === 'gh' && argStr.includes('pr create')) return 'https://github.com/owner/repo/pull/42';
        if (cmd === 'git' && argStr.includes('remote') && argStr.includes('get-url')) return 'https://github.com/owner/repo.git';
        if (cmd === 'git' && argStr.includes('symbolic-ref')) return 'refs/remotes/origin/main';
        return '';
      });

      const promise = (orch as AnyOrch).runCreatePR(pipeline);
      await promise;

      // Verify git push happened
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['push', '-u', 'origin', `feat/${slug}`]),
        expect.any(Object),
      );
      // Verify gh pr create was called
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['pr', 'create', '--title', pipeline.description]),
        expect.any(Object),
      );
      // No agent sessions should have been created for PR creation
      expect(mockCreateSession).not.toHaveBeenCalled();
      expect(pipeline.phase).toBe('pr-open');
    });

    it('reuses existing PR URL when open PR already exists', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      // Mock: existing PR found, no create needed
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        const argStr = Array.isArray(args) ? args.join(' ') : '';
        if (cmd === 'gh' && argStr.includes('pr list')) return 'https://github.com/owner/repo/pull/99';
        if (cmd === 'gh' && argStr.includes('pr create')) throw new Error('should not be called');
        if (cmd === 'git' && argStr.includes('remote') && argStr.includes('get-url')) return 'https://github.com/owner/repo.git';
        if (cmd === 'git' && argStr.includes('symbolic-ref')) return 'refs/remotes/origin/main';
        return '';
      });

      const promise = (orch as AnyOrch).runCreatePR(pipeline);
      await promise;

      // gh pr list was called, but gh pr create was NOT
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['pr', 'list']),
        expect.any(Object),
      );
      // pr create should not be called
      const prCreateCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'gh' && Array.isArray(call[1]) && call[1].includes('pr') && call[1].includes('create'),
      );
      expect(prCreateCalls.length).toBe(0);
      expect(pipeline.phase).toBe('pr-open');
    });

    it('advances to pr-open after successful PR creation', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        const argStr = Array.isArray(args) ? args.join(' ') : '';
        if (cmd === 'gh' && argStr.includes('pr list')) return '';
        if (cmd === 'gh' && argStr.includes('pr create')) return 'https://github.com/owner/repo/pull/42';
        if (cmd === 'git' && argStr.includes('remote') && argStr.includes('get-url')) return 'https://github.com/owner/repo.git';
        if (cmd === 'git' && argStr.includes('symbolic-ref')) return 'refs/remotes/origin/main';
        return '';
      });

      const promise = (orch as AnyOrch).runCreatePR(pipeline);
      await promise;

      expect(pipeline.phase).toBe('pr-open');
    });

    it('sets platform to undefined when remote is unknown', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && Array.isArray(args) && args[0] === 'remote') {
          return 'https://unknown.example.com/repo.git';
        }
        if (cmd === 'git' && Array.isArray(args) && args[0] === 'rev-parse') {
          return 'refs/remotes/origin/main';
        }
        return '';
      });

      const promise = (orch as AnyOrch).runCreatePR(pipeline);
      await promise;

      const taskStore = (orch as AnyOrch).taskStore;
      const updated = taskStore.getById(testData.taskId);
      expect(updated?.platform).toBeUndefined();
    });

    it('spawns merger agent when rebase has conflicts, then creates PR via CLI', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      let rebaseCalled = false;

      // Only one session: merger for rebase conflict (no PR session anymore)
      mockCreateSession.mockResolvedValue('sess-merger');

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git') {
          const argStr = Array.isArray(args) ? args.join(' ') : '';
          if (argStr.includes('rebase') && !argStr.includes('--abort')) {
            rebaseCalled = true;
            throw new Error('Rebase conflict');
          }
          if (argStr.includes('remote') && argStr.includes('get-url')) {
            return 'https://github.com/owner/repo.git';
          }
          if (argStr.includes('symbolic-ref')) {
            return 'refs/remotes/origin/main';
          }
        }
        // After rebase resolved, gh creates PR directly
        if (cmd === 'gh') {
          const argStr = Array.isArray(args) ? args.join(' ') : '';
          if (argStr.includes('pr list')) return '';
          if (argStr.includes('pr create')) return 'https://github.com/owner/repo/pull/42';
        }
        return '';
      });

      const promise = (orch as AnyOrch).runCreatePR(pipeline);
      await new Promise(r => setTimeout(r, 20));

      expect(rebaseCalled).toBe(true);

      // Merger session should have been created and sent /merge origin/main
      expect(mockSendMessage).toHaveBeenCalledWith('sess-merger', '/merge origin/main');

      // Complete the merger session
      fireEvent('event', { sessionId: 'sess-merger', event: { type: 'result' } });
      await promise;

      expect(mockKillSession).toHaveBeenCalledWith('sess-merger');
      // No second session for PR creation
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
      // gh pr create was called
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['pr', 'create']),
        expect.any(Object),
      );
      expect(pipeline.phase).toBe('pr-open');
    });

    it('falls back gracefully when merger agent cannot resolve conflicts', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      // Only one session: merger (no PR session)
      mockCreateSession.mockResolvedValue('sess-merger');

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git') {
          const argStr = Array.isArray(args) ? args.join(' ') : '';
          if (argStr.includes('rebase') && !argStr.includes('--abort')) {
            throw new Error('Rebase conflict');
          }
          if (argStr.includes('remote') && argStr.includes('get-url')) {
            return 'https://github.com/owner/repo.git';
          }
          if (argStr.includes('symbolic-ref')) {
            return 'refs/remotes/origin/main';
          }
        }
        // After rebase resolved, gh creates PR
        if (cmd === 'gh') {
          const argStr = Array.isArray(args) ? args.join(' ') : '';
          if (argStr.includes('pr list')) return '';
          if (argStr.includes('pr create')) return 'https://github.com/owner/repo/pull/42';
        }
        return '';
      });

      const promise = (orch as AnyOrch).runCreatePR(pipeline);
      await new Promise(r => setTimeout(r, 20));

      // Merger session was created      expect(mockSendMessage).toHaveBeenCalledWith('sess-merger', '/merge origin/main');
      // Simulate merger failure — exit with non-zero code
      fireEvent('exit', { sessionId: 'sess-merger', code: 1 });
      await promise;

      // Pipeline still advances to pr-open even though merger failed
      expect(pipeline.phase).toBe('pr-open');
      // Only one session created (just the merger, no PR session)
      expect(mockCreateSession).toHaveBeenCalledTimes(1);
    });

    it('does not spawn any sessions when rebase succeeds (fast path)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        const argStr = Array.isArray(args) ? args.join(' ') : '';
        if (cmd === 'gh' && argStr.includes('pr list')) return '';
        if (cmd === 'gh' && argStr.includes('pr create')) return 'https://github.com/owner/repo/pull/42';
        if (cmd === 'git' && argStr.includes('remote') && argStr.includes('get-url')) return 'https://github.com/owner/repo.git';
        if (cmd === 'git' && argStr.includes('symbolic-ref')) return 'refs/remotes/origin/main';
        return '';
      });

      const promise = (orch as AnyOrch).runCreatePR(pipeline);
      await promise;

      // No sessions should have been created at all
      expect(mockCreateSession).not.toHaveBeenCalled();
      // gh pr create was called
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['pr', 'create']),
        expect.any(Object),
      );
      expect(pipeline.phase).toBe('pr-open');
    });
  });

  // ── markTaskDone ──────────────────────────────────────────────────

  describe('markTaskDone', () => {
    it('deletes live directory, attempts scoped restore, falls back to recreate task.json on fetch failure, emits once', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Verify the task directory exists before markTaskDone
      expect(existsSync(testData.taskDir)).toBe(true);

      // Make git fetch fail (simulating no remote / offline)
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('fetch')) {
          throw new Error('fatal: Could not read from remote repository');
        }
        return '';
      });

      mockEmit.mockClear();
      await orch.markTaskDone(testData.taskId);

      // Fallback: directory was recreated with task.json + events.jsonl
      expect(existsSync(testData.taskDir)).toBe(true);
      expect(existsSync(join(testData.taskDir, 'task.json'))).toBe(true);
      expect(existsSync(join(testData.taskDir, 'events.jsonl'))).toBe(true);

      // phase-change was emitted exactly once
      expect(mockEmit).toHaveBeenCalledTimes(1);
      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId: testData.taskId,
        phase: 'done',
      }));

      // git fetch was attempted; checkout/merge were skipped since fetch failed
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['fetch', 'origin', 'main']),
        expect.objectContaining({ cwd: testData.root }),
      );
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['checkout']),
        expect.anything(),
      );
    });

    it('leaves the restored snapshot untouched when checkout succeeds (restored copy already has phase:done)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      expect(existsSync(testData.taskDir)).toBe(true);

      const restoredSnapshot = JSON.stringify({
        id: testData.taskId,
        title: 'Test Task',
        description: 'A test task for full coverage',
        phase: 'done',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      // Make the scoped `git checkout origin/master -- <dir>` "succeed" by
      // recreating the task directory as a side effect, simulating what a
      // real checkout would do (restore the committed snapshot) regardless
      // of how dirty the rest of the working tree is.
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('checkout')) {
          mkdirSync(testData.taskDir, { recursive: true });
          writeFileSync(join(testData.taskDir, 'task.json'), restoredSnapshot);
          return '';
        }
        return '';
      });

      mockEmit.mockClear();
      await orch.markTaskDone(testData.taskId);

      // Checkout succeeded — directory was restored from the snapshot
      expect(existsSync(testData.taskDir)).toBe(true);

      // phase-change was emitted exactly once
      expect(mockEmit).toHaveBeenCalledTimes(1);
      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId: testData.taskId,
        phase: 'done',
      }));

      // git fetch + scoped checkout were attempted
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['fetch', 'origin', 'main']),
        expect.objectContaining({ cwd: testData.root }),
      );
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['checkout', 'origin/main', '--']),
        expect.objectContaining({ cwd: testData.root }),
      );

      // The restored (tracked) snapshot must not be rewritten — modifying it
      // would leave the repo dirty after every completed task.
      expect(readFileSync(join(testData.taskDir, 'task.json'), 'utf-8')).toBe(restoredSnapshot);
      expect(existsSync(join(testData.taskDir, 'events.jsonl'))).toBe(false);
    });

    it('falls back to recreating task.json when pull succeeds but restores no artifacts', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Pull succeeds but does NOT restore the directory — e.g. the project
      // gitignores .teamai/ in-repo, so the artifact commit was skipped.
      mockExecFileSync.mockReturnValue('');

      mockEmit.mockClear();
      await orch.markTaskDone(testData.taskId);

      // Fallback recreated the minimal task so it stays on the kanban
      expect(existsSync(join(testData.taskDir, 'task.json'))).toBe(true);
      const taskJson = JSON.parse(readFileSync(join(testData.taskDir, 'task.json'), 'utf-8'));
      expect(taskJson.phase).toBe('done');
      expect(existsSync(join(testData.taskDir, 'events.jsonl'))).toBe(true);

      // Emitted exactly once, after everything settled
      expect(mockEmit).toHaveBeenCalledTimes(1);
      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId: testData.taskId,
        phase: 'done',
      }));
    });

    it('throws when task does not exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      await expect(orch.markTaskDone('nonexistent-id')).rejects.toThrow('not found');
    });

    // ── PR-merge guard ──────────────────────────────────────────────
    //
    // markTaskDone used to have no awareness of whether a PR-routed task's
    // PR had actually merged. Clicking "Mark as Done" in the UI is enabled
    // as soon as a PR exists (review-panel.tsx's isPrOpen), so a click
    // moments after PR creation — before merge — would delete the live
    // .teamai/{slug}/ directory and then fail to restore it from
    // origin/master (which doesn't have the task's commits yet), destroying
    // in-progress artifacts for nothing.

    describe('PR-merge guard', () => {
      function writeTaskJsonWithPr(taskDir: string, taskId: string) {
        writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
          id: taskId,
          title: 'Test Task',
          description: 'A test task for full coverage',
          phase: 'pr-open',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          platform: 'github',
          prUrl: 'https://github.com/example/repo/pull/42',
          mergeStrategy: 'pull-request',
        }));
      }

      it('refuses to mark done when the PR is still open, leaving the directory untouched', async () => {
        testData = setupTestProject();
        const orch = makeOrch(testData.root, getOrchestrator);
        writeTaskJsonWithPr(testData.taskDir, testData.taskId);

        mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
          if (args.includes('view') && args.includes('state')) {
            return JSON.stringify({ state: 'OPEN' });
          }
          return '';
        });

        mockEmit.mockClear();
        await expect(orch.markTaskDone(testData.taskId)).rejects.toThrow(/has not been merged yet/);

        // Nothing destructive happened — directory is untouched and no
        // phase-change was emitted.
        expect(existsSync(testData.taskDir)).toBe(true);
        expect(existsSync(join(testData.taskDir, 'task.json'))).toBe(true);
        expect(mockEmit).not.toHaveBeenCalled();

        // No fetch/checkout/rmSync-adjacent git calls were attempted.
        expect(mockExecFileSync).not.toHaveBeenCalledWith(
          'git',
          expect.arrayContaining(['fetch']),
          expect.anything(),
        );
      });

      it('proceeds when the PR is confirmed merged', async () => {
        testData = setupTestProject();
        const orch = makeOrch(testData.root, getOrchestrator);
        writeTaskJsonWithPr(testData.taskDir, testData.taskId);

        mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
          if (args.includes('view') && args.includes('state')) {
            return JSON.stringify({ state: 'MERGED' });
          }
          return '';
        });

        mockEmit.mockClear();
        await orch.markTaskDone(testData.taskId);

        expect(mockEmit).toHaveBeenCalledTimes(1);
        expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
          taskId: testData.taskId,
          phase: 'done',
        }));
      });

      it('proceeds when merge state cannot be determined (CLI failure) rather than blocking indefinitely', async () => {
        testData = setupTestProject();
        const orch = makeOrch(testData.root, getOrchestrator);
        writeTaskJsonWithPr(testData.taskDir, testData.taskId);

        mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
          if (args.includes('view') && args.includes('state')) {
            throw new Error('gh: command not found');
          }
          return '';
        });

        mockEmit.mockClear();
        await orch.markTaskDone(testData.taskId);

        expect(mockEmit).toHaveBeenCalledTimes(1);
        expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
          taskId: testData.taskId,
          phase: 'done',
        }));
      });
    });
  });

  // ── approveTask with pull-request strategy ───────────────────────

  describe('approveTask — pull-request strategy', () => {
    it('executes create-pr via CLI when strategy is pull-request', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      // Update the task phase since approveTask checks taskStore, not the pipeline
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'awaiting-review' });

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        phase: 'awaiting-review',
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        const argStr = Array.isArray(args) ? args.join(' ') : '';
        if (cmd === 'gh' && argStr.includes('pr list')) return '';
        if (cmd === 'gh' && argStr.includes('pr create')) return 'https://github.com/owner/repo/pull/42';
        if (cmd === 'git' && argStr.includes('remote') && argStr.includes('get-url')) return 'https://github.com/owner/repo.git';
        if (cmd === 'git' && argStr.includes('symbolic-ref')) return 'refs/remotes/origin/main';
        return '';
      });

      const promise = orch.approveTask(testData.taskId, 'pull-request');
      await promise;

      expect(pipeline.phase).toBe('pr-open');
      // No agent sessions should have been created
      expect(mockCreateSession).not.toHaveBeenCalled();
    });

    // Regression test: commitArtifactsToWorktree used to run once, before
    // prUrl was ever determined. The task.json snapshot it commits into the
    // worktree (and thus into the PR, and thus into whatever markTaskDone
    // restores from origin/master after merge) was permanently missing
    // prUrl as a result — every pull-request-strategy task's committed
    // artifacts lacked the PR reference, even though the live task.json had
    // it. Fixed by re-running the artifact commit + push once prUrl is
    // known. This test verifies the *committed worktree copy*, not just the
    // live task.json, actually contains prUrl.
    it('commits the artifact snapshot with prUrl included, not just the live task.json', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'awaiting-review' });

      const slug = testData.slug;
      const worktreePath = join(testData.root, '..', 'worktrees', slug);
      const pipeline = makePipeline({
        taskId: testData.taskId,
        phase: 'awaiting-review',
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath,
      });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        const argStr = Array.isArray(args) ? args.join(' ') : '';
        if (cmd === 'gh' && argStr.includes('pr list')) return '';
        if (cmd === 'gh' && argStr.includes('pr create')) return 'https://github.com/owner/repo/pull/42';
        if (cmd === 'git' && argStr.includes('remote') && argStr.includes('get-url')) return 'https://github.com/owner/repo.git';
        if (cmd === 'git' && argStr.includes('symbolic-ref')) return 'refs/remotes/origin/main';
        return '';
      });

      await orch.approveTask(testData.taskId, 'pull-request');

      // commitArtifactsToWorktree derives the committed subdirectory name
      // from path.basename(pipeline.specPath) — the task's UUID directory
      // name — not from the branch slug used above.
      const committedTaskJsonPath = join(worktreePath, '.teamai', testData.taskId, 'task.json');
      expect(existsSync(committedTaskJsonPath)).toBe(true);
      const committed = JSON.parse(readFileSync(committedTaskJsonPath, 'utf-8'));
      expect(committed.phase).toBe('done');
      expect(committed.prUrl).toBe('https://github.com/owner/repo/pull/42');

      // The live task.json (source of truth pre-merge) also has it — this
      // part already worked before the fix, included for contrast.
      const liveTaskJson = JSON.parse(readFileSync(join(testData.taskDir, 'task.json'), 'utf-8'));
      expect(liveTaskJson.prUrl).toBe('https://github.com/owner/repo/pull/42');
    });

    it('throws rollback to awaiting-review on error', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const pipeline = makePipeline({
        taskId: testData.taskId,
        phase: 'awaiting-review',
        specPath: testData.taskDir,
        branch: testData.branchName,
      });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      await expect(orch.approveTask(testData.taskId, 'pull-request')).rejects.toThrow();
      expect(pipeline.phase).toBe('awaiting-review');
    });
  });

  // ── moveTaskToPhase merge/create-pr branching ─────────────────────

  describe('moveTaskToPhase — merge/create-pr branching', () => {
    it('starts from create-pr when worktree, branch, and plan exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({ subtasks: [] }));

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { description: testData.slug, branch: testData.branchName });

      const slug = testData.slug;
      const worktreePath = join(testData.root, '..', 'worktrees', slug);
      mkdirSync(worktreePath, { recursive: true });

      // Simulate gh pr create failing (not available in test env)
      // The point is that moveTaskToPhase reached executePhase for create-pr
      mockExecFileSync.mockImplementation((cmd: string) => {
        if (cmd === 'gh') throw new Error('gh not available');
        return '';
      });
      await orch.moveTaskToPhase(testData.taskId, 'create-pr').catch(() => {});

      // execFileSync was called (for gh pr list or gh pr create), proving
      // moveTaskToPhase reached executePhase for create-pr
      expect(mockExecFileSync).toHaveBeenCalled();

      if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
    });

    it('starts from implement when plan exists but worktree missing for merge', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Task', description: 'Desc', files: [], acceptance_criteria: [] }],
      }));

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'merge').catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('starts from plan when only spec exists for merge target', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'merge').catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('starts from spec when no artifacts exist for merge target', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'merge').catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();
    });
  });

  // ── cleanupTaskArtifacts ──────────────────────────────────────────

  describe('cleanupTaskArtifacts', () => {
    it('clears spec-phase artifacts (spec.md, plan.json, output.log)', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), '{}');
      writeFileSync(join(testData.taskDir, 'output.log'), 'output');

      orch.cleanupTaskArtifacts(testData.taskId, 'spec');

      expect(existsSync(join(testData.taskDir, 'spec.md'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'plan.json'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'output.log'))).toBe(false);
    });

    it('clears plan artifacts but preserves spec.md', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), '{}');
      writeFileSync(join(testData.taskDir, 'output.log'), 'output');

      orch.cleanupTaskArtifacts(testData.taskId, 'plan');

      expect(existsSync(join(testData.taskDir, 'spec.md'))).toBe(true);
      expect(existsSync(join(testData.taskDir, 'plan.json'))).toBe(false);
    });

    it('clears QA artifacts and resets subtask completions for implement phase', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Task', description: '', files: [], acceptance_criteria: [], completed: true }],
      }));
      writeFileSync(join(testData.taskDir, 'qa_report.json'), '{}');
      writeFileSync(join(testData.taskDir, 'qa_feedback.md'), 'feedback');
      writeFileSync(join(testData.taskDir, 'completion_summary.md'), 'summary');
      writeFileSync(join(testData.taskDir, 'output.log'), 'output');

      orch.cleanupTaskArtifacts(testData.taskId, 'implement');

      expect(existsSync(join(testData.taskDir, 'qa_report.json'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'qa_feedback.md'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'completion_summary.md'))).toBe(false);

      const plan = JSON.parse(readFileSync(join(testData.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks[0].completed).toBe(false);
      expect(existsSync(join(testData.taskDir, 'spec.md'))).toBe(true);
      expect(existsSync(join(testData.taskDir, 'plan.json'))).toBe(true);
    });

    it('no-ops when phase is not in pipeline order', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'output.log'), 'output');
      orch.cleanupTaskArtifacts(testData.taskId, 'nonexistent-phase');

      expect(existsSync(join(testData.taskDir, 'output.log'))).toBe(true);
    });

    it('handles missing artifacts gracefully (does not throw)', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      expect(() => orch.cleanupTaskArtifacts(testData.taskId, 'qa-review')).not.toThrow();
    });
  });

  // ── resumeTask ────────────────────────────────────────────────────

  describe('resumeTask', () => {
    it('resumes from implement when plan.json exists and preserves completions', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Task', description: 'Desc', files: [], acceptance_criteria: [], completed: true }],
      }));

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.resumeTask(testData.taskId).catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();

      const plan = JSON.parse(readFileSync(join(testData.taskDir, 'plan.json'), 'utf-8'));
      // Completions are now preserved � runImplement skips already-completed subtasks
      expect(plan.subtasks[0].completed).toBe(true);
    });

    it('resumes from plan when only spec.md exists', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.resumeTask(testData.taskId).catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('resumes from spec when no artifacts exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.resumeTask(testData.taskId).catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('throws when task does not exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      await expect(orch.resumeTask('nonexistent')).rejects.toThrow('not found');
    });
  });


    it('resumes from qa-review phase when task is in qa-review (active phase)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Set up artifacts so the old artifact-detection path would pick 'implement'
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Task', description: 'Desc', files: [], acceptance_criteria: [], completed: true }],
      }));

      // Put the task in qa-review — an active pipeline phase (not in NO_RESUME_PHASES)
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'qa-review' });

      // Spy on runTask to capture the startPhase argument
      const runTaskSpy = vi.spyOn(orch as AnyOrch, 'runTask')
        .mockRejectedValue(new Error('simulated abort'));

      await orch.resumeTask(testData.taskId).catch(() => {});

      // Should resume from qa-review, not from implement (the artifact-detection default)
      expect(runTaskSpy).toHaveBeenCalledWith(
        testData.taskId,
        expect.any(String),
        'qa-review',
      );

      runTaskSpy.mockRestore();
    });

    it('resumes from implement phase when task is in implement (active phase)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Task', description: 'Desc', files: [], acceptance_criteria: [], completed: true }],
      }));

      // Put the task in implement — an active pipeline phase
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'implement' });

      const runTaskSpy = vi.spyOn(orch as AnyOrch, 'runTask')
        .mockRejectedValue(new Error('simulated abort'));

      await orch.resumeTask(testData.taskId).catch(() => {});

      // Should resume from implement (the task's current phase), not detect from artifacts
      expect(runTaskSpy).toHaveBeenCalledWith(
        testData.taskId,
        expect.any(String),
        'implement',
      );

      runTaskSpy.mockRestore();
    });

    it('falls back to artifact detection (implement) when task is in backlog', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Task', description: 'Desc', files: [], acceptance_criteria: [], completed: true }],
      }));

      // Task is in backlog — a NO_RESUME_PHASE, so artifact detection should kick in
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'backlog' });

      const runTaskSpy = vi.spyOn(orch as AnyOrch, 'runTask')
        .mockRejectedValue(new Error('simulated abort'));

      await orch.resumeTask(testData.taskId).catch(() => {});

      // Should use artifact detection: plan.json exists → start from implement
      expect(runTaskSpy).toHaveBeenCalledWith(
        testData.taskId,
        expect.any(String),
        'implement',
      );

      runTaskSpy.mockRestore();
    });


// ── restorePipeline ───────────────────────────────────────────────

  describe('restorePipeline', () => {
    it('restores pipeline from task data with correct branch', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'awaiting-review', branch: 'feat/some-feature' });

      const pipeline = (orch as AnyOrch).restorePipeline(testData.taskId, 'awaiting-review');

      expect(pipeline).toBeDefined();
      expect(pipeline.taskId).toBe(testData.taskId);
      expect(pipeline.phase).toBe('awaiting-review');
      expect(pipeline.branch).toBe('feat/some-feature');
      expect(pipeline.qaAttempt).toBe(0);
    });

    it('derives branch from description when task has no branch', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'awaiting-review', branch: undefined });

      const pipeline = (orch as AnyOrch).restorePipeline(testData.taskId, 'awaiting-review');

      expect(pipeline.branch).toBeDefined();
      expect(pipeline.branch).toContain('feat/');
    });

    it('throws when task is not in the required phase', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      expect(() => (orch as AnyOrch).restorePipeline(testData.taskId, 'awaiting-review')).toThrow(
        'must be awaiting-review'
      );
    });
  });

  // ── _removeWorktreeForce ──────────────────────────────────────────

  describe('_removeWorktreeForce', () => {
    it('force-removes the git worktree', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { branch: testData.branchName });

      const wtPath = orch.getWorktreePath(testData.taskId);
      if (wtPath) mkdirSync(wtPath, { recursive: true });

      mockExecFileSync.mockReturnValue('');
      (orch as AnyOrch)._ctx.removeWorktree(testData.taskId);

      // Now delegates to removeWorktree which tries normal remove first,
      // then git branch -D, then updates taskStore
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['worktree', 'remove']),
        expect.any(Object),
      );
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['branch', '-D']),
        expect.any(Object),
      );
    });

    it('no-ops when worktree does not exist', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      expect(() => (orch as AnyOrch)._ctx.removeWorktree('nonexistent')).not.toThrow();
    });

    it('handles git failure gracefully', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { branch: testData.branchName });

      const wtPath = orch.getWorktreePath(testData.taskId);
      if (wtPath) mkdirSync(wtPath, { recursive: true });

      mockExecFileSync.mockImplementation(() => { throw new Error('git error'); });
      expect(() => (orch as AnyOrch)._ctx.removeWorktree(testData.taskId)).not.toThrow();
    });
  });

  // ── _cleanWorktree ────────────────────────────────────────────────

  describe('_cleanWorktree', () => {
    it('runs git checkout HEAD to discard changes', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { branch: testData.branchName });

      const wtPath = orch.getWorktreePath(testData.taskId);
      if (wtPath) mkdirSync(wtPath, { recursive: true });

      mockExecFileSync.mockReturnValue('');
      (orch as AnyOrch)._cleanWorktree(testData.taskId);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['checkout', 'HEAD', '--', '.']),
        expect.any(Object),
      );
    });

    it('no-ops when worktree does not exist', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      expect(() => (orch as AnyOrch)._cleanWorktree('nonexistent')).not.toThrow();
    });

    it('handles git failure gracefully', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { branch: testData.branchName });

      const wtPath = orch.getWorktreePath(testData.taskId);
      if (wtPath) mkdirSync(wtPath, { recursive: true });

      mockExecFileSync.mockImplementation(() => { throw new Error('git error'); });
      expect(() => (orch as AnyOrch)._cleanWorktree(testData.taskId)).not.toThrow();
    });
  });

  // ── runImplement Docker availability check ───────────────────────

  describe('runImplement — Docker availability', () => {
    it('throws when container is enabled but Docker is not available', async () => {
      testData = setupTestProject({ containerEnabled: true });
      const orch = makeOrch(testData.root, getOrchestrator);

      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: false });
      vi.mocked(dockerAvailable).mockReturnValue(false);

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      mkdirSync(pipeline.worktreePath, { recursive: true });
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Task', description: 'Desc', files: [], acceptance_criteria: [] }],
      }));

      await expect((orch as AnyOrch).runImplement(pipeline)).rejects.toThrow('Docker is not running');

      if (existsSync(pipeline.worktreePath)) rmSync(pipeline.worktreePath, { recursive: true, force: true });
    });

    it('proceeds when container enabled and Docker is available', async () => {
      testData = setupTestProject({ containerEnabled: true });
      const orch = makeOrch(testData.root, getOrchestrator);

      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(dockerAvailable).mockReturnValue(true);
      vi.mocked(containerManager.ensureContainer).mockResolvedValue({
        remoteWorkspaceFolder: '/workspace',
        containerName: 'test-container',
        status: 'running',
      } as any);

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      mkdirSync(pipeline.worktreePath, { recursive: true });
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Task', description: 'Desc', files: [], acceptance_criteria: [] }],
      }));

      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-${++sessionCounter}`));
      vi.mocked(_resetDockerAvailableCache).mockImplementation(() => {});

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

      expect(mockCreateSession).toHaveBeenCalled();
      // _resetDockerAvailableCache is only called when !containerCfg.explicit (the Docker gate).
      // With explicit: true the gate is skipped, so _resetDockerAvailableCache is NOT called.

      fireEvent('event', { sessionId: 'sess-1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 10));

      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'PASS',
        criteria: [],
      }));
      fireEvent('event', { sessionId: 'sess-2', event: { type: 'result' } });
      await promise;

      if (existsSync(pipeline.worktreePath)) rmSync(pipeline.worktreePath, { recursive: true, force: true });
    });
  });

  // ── runImplement worktree creation ────────────────────────────────

  describe('runImplement — worktree creation', () => {
    it('creates worktree when it does not exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Task', description: 'Desc', files: [], acceptance_criteria: [] }],
      }));

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      if (existsSync(pipeline.worktreePath)) rmSync(pipeline.worktreePath, { recursive: true, force: true });

      let callCount = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-${++callCount}`));

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

      const gitCalls = mockExecFileSync.mock.calls.filter(
        (call: any[]) => call[0] === 'git' && (call[1] as string[]).includes('worktree')
      );
      expect(gitCalls.length).toBeGreaterThanOrEqual(1);

      fireEvent('event', { sessionId: 'sess-1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 10));

      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'PASS',
        criteria: [],
      }));
      fireEvent('event', { sessionId: 'sess-2', event: { type: 'result' } });
      await promise;

      if (existsSync(pipeline.worktreePath)) rmSync(pipeline.worktreePath, { recursive: true, force: true });
    });

    it('uses branch checkout fallback when worktree add with -b fails', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Task', description: 'Desc', files: [], acceptance_criteria: [] }],
      }));

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      if (existsSync(pipeline.worktreePath)) rmSync(pipeline.worktreePath, { recursive: true, force: true });

      let gitWorktreeAttemptCount = 0;
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args.includes('worktree') && args.includes('add')) {
          gitWorktreeAttemptCount++;
          if (args.includes('-b')) throw new Error('Branch already exists');
        }
        return '';
      });

      let callCount = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-${++callCount}`));

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

      expect(gitWorktreeAttemptCount).toBe(2);

      fireEvent('event', { sessionId: 'sess-1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 10));

      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'PASS',
        criteria: [],
      }));
      fireEvent('event', { sessionId: 'sess-2', event: { type: 'result' } });
      await promise;

      if (existsSync(pipeline.worktreePath)) rmSync(pipeline.worktreePath, { recursive: true, force: true });
    });
  });

  // ── runImplement QA/human feedback surfacing ───────────────────────

  describe('runImplement — QA/human feedback surfacing', () => {
    it('reads both qa_feedback.md and human_feedback.md and surfaces them to the coder prompt', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Write both feedback files
      writeFileSync(join(testData.taskDir, 'qa_feedback.md'),
        '# QA Feedback\\n\\nMobile layout is broken\\n');
      writeFileSync(join(testData.taskDir, 'human_feedback.md'),
        '# Human Review Feedback\\n\\nAlso fix the header alignment\\n');

      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Fix layout', description: 'Fix the mobile layout issues', files: ['src/App.tsx'], acceptance_criteria: ['Layout works at 375px [QA CORRECTION: Mobile layout is broken]'], qa_flagged: true }],
      }));

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });
      mkdirSync(pipeline.worktreePath, { recursive: true });

      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-${++sessionCounter}`));

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

      // Verify the coder got both feedbacks
      const sendCalls = mockSendMessage.mock.calls.filter(
        (call: any[]) => call[0] === 'sess-1'
      );
      expect(sendCalls.length).toBeGreaterThanOrEqual(1);
      const promptText = sendCalls[0][1];
      expect(promptText).toContain('QA FEEDBACK');
      expect(promptText).toContain('Mobile layout is broken');
      expect(promptText).toContain('Also fix the header alignment');
      expect(promptText).toContain('/implement Subtask 1');

      // Fire events to complete implement -> QA -> done
      fireEvent('event', { sessionId: 'sess-1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 10));

      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'PASS',
        criteria: [],
      }));
      fireEvent('event', { sessionId: 'sess-2', event: { type: 'result' } });
      await promise;

      // Verify both feedback files were cleaned up
      expect(existsSync(join(testData.taskDir, 'qa_feedback.md'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'human_feedback.md'))).toBe(false);

      if (existsSync(pipeline.worktreePath)) rmSync(pipeline.worktreePath, { recursive: true, force: true });
    });

    it('surfaces only qa_feedback.md when human_feedback.md is absent', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'qa_feedback.md'),
        '# QA Feedback\\n\\nMobile layout is broken\\n');

      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Fix layout', description: 'Fix the mobile layout issues', files: ['src/App.tsx'], acceptance_criteria: ['Layout works at 375px [QA CORRECTION: Mobile layout is broken]'], qa_flagged: true }],
      }));

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });
      mkdirSync(pipeline.worktreePath, { recursive: true });

      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-${++sessionCounter}`));

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

      const sendCalls = mockSendMessage.mock.calls.filter(
        (call: any[]) => call[0] === 'sess-1'
      );
      const promptText = sendCalls[0][1];
      expect(promptText).toContain('QA FEEDBACK');
      expect(promptText).toContain('Mobile layout is broken');
      // Human feedback should NOT appear in the prompt
      expect(promptText).not.toContain('Also fix the header alignment');

      fireEvent('event', { sessionId: 'sess-1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 10));

      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'PASS',
        criteria: [],
      }));
      fireEvent('event', { sessionId: 'sess-2', event: { type: 'result' } });
      await promise;

      expect(existsSync(join(testData.taskDir, 'qa_feedback.md'))).toBe(false);

      if (existsSync(pipeline.worktreePath)) rmSync(pipeline.worktreePath, { recursive: true, force: true });
    });

    it('does not include feedback header when neither feedback file exists', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Fix layout', description: 'Fix the mobile layout issues', files: ['src/App.tsx'], acceptance_criteria: ['Layout works at 375px [QA CORRECTION: Mobile layout is broken]'], qa_flagged: true }],
      }));

      const slug = testData.slug;
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });
      mkdirSync(pipeline.worktreePath, { recursive: true });

      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-${++sessionCounter}`));

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

      const sendCalls = mockSendMessage.mock.calls.filter(
        (call: any[]) => call[0] === 'sess-1'
      );
      const promptText = sendCalls[0][1];
      expect(promptText).not.toContain('QA FEEDBACK');
      expect(promptText).toContain('/implement Subtask 1');

      fireEvent('event', { sessionId: 'sess-1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 10));

      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'PASS',
        criteria: [],
      }));
      fireEvent('event', { sessionId: 'sess-2', event: { type: 'result' } });
      await promise;

      if (existsSync(pipeline.worktreePath)) rmSync(pipeline.worktreePath, { recursive: true, force: true });
    });
  });

  // ── runQaReview PASS/Failure paths ────────────────────────────────

  describe('runImplement — rebase onto latest master', () => {
    it('runs rebase before subtask processing (fast path)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{ id: 1, title: 'Add feature', description: 'Do it', files: ['src/app.ts'], acceptance_criteria: ['Works'] }],
      }));

      const slug = testData.slug;
      const pipeline = makePipeline({
      taskId: testData.taskId,
      specPath: testData.taskDir,
      branch: `feat/${slug}`,
      worktreePath: join(testData.root, '..', 'worktrees', slug),
    });
      mkdirSync(pipeline.worktreePath, { recursive: true });

      mockCreateSession.mockResolvedValue('sess-subtask');
      mockExecFileSync.mockReturnValue('');

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

    // No merger spawned on fast path
      const sendCalls = mockSendMessage.mock.calls;
      const mergeCalls = sendCalls.filter(
      (call: any[]) => typeof call[1] === 'string' && call[1].includes('/merge origin/main'),
      );
      expect(mergeCalls.length).toBe(0);

      const implCalls = sendCalls.filter(
      (call: any[]) => typeof call[1] === 'string' && call[1].includes('/implement Subtask 1'),
      );
      expect(implCalls.length).toBeGreaterThanOrEqual(1);

    // Complete subtask -> push -> QA -> done
      fireEvent('event', { sessionId: 'sess-subtask', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 10));
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS',
      criteria: [],
      }));
      fireEvent('event', { sessionId: 'sess-subtask', event: { type: 'result' } });
      await promise;

      if (existsSync(pipeline.worktreePath)) rmSync(pipeline.worktreePath, { recursive: true, force: true });
    });

    it('spawns merger agent when rebase has conflicts, then proceeds to subtasks', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{ id: 1, title: 'Add feature', description: 'Do it', files: ['src/app.ts'], acceptance_criteria: ['Works'] }],
      }));

      const slug = testData.slug;
      const pipeline = makePipeline({
      taskId: testData.taskId,
      specPath: testData.taskDir,
      branch: `feat/${slug}`,
      worktreePath: join(testData.root, '..', 'worktrees', slug),
    });
      mkdirSync(pipeline.worktreePath, { recursive: true });

      let mergerCreated = false;
      mockCreateSession.mockImplementation(() => {
      if (!mergerCreated) {
      mergerCreated = true;
      return Promise.resolve('sess-impl-rebase');
      }
      return Promise.resolve('sess-subtask');
    });

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && Array.isArray(args)) {
      const argStr = args.join(' ');
      if (argStr.includes('rebase') && !argStr.includes('--abort')) {
      throw new Error('Rebase conflict');
      }
      }
      return '';
    });

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

    // Merger session spawns first
      expect(mockSendMessage).toHaveBeenCalledWith('sess-impl-rebase', '/merge origin/main');

    // Complete merger
      fireEvent('event', { sessionId: 'sess-impl-rebase', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 10));

    // After rebase resolves, implement proceeds to subtask
      expect(mockSendMessage).toHaveBeenCalledWith('sess-subtask', expect.stringContaining('/implement Subtask 1'));

    // Complete subtask -> push -> QA -> done
      fireEvent('event', { sessionId: 'sess-subtask', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 10));
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS',
      criteria: [],
      }));
      fireEvent('event', { sessionId: 'sess-subtask', event: { type: 'result' } });
      await promise;

      if (existsSync(pipeline.worktreePath)) rmSync(pipeline.worktreePath, { recursive: true, force: true });
    });

    it('continues to subtasks even when rebase and merger both fail (silent failure)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [{ id: 1, title: 'Add feature', description: 'Do it', files: ['src/app.ts'], acceptance_criteria: ['Works'] }],
      }));

      const slug = testData.slug;
      const pipeline = makePipeline({
      taskId: testData.taskId,
      specPath: testData.taskDir,
      branch: `feat/${slug}`,
      worktreePath: join(testData.root, '..', 'worktrees', slug),
    });
      mkdirSync(pipeline.worktreePath, { recursive: true });

      let mergerCreated = false;
      mockCreateSession.mockImplementation(() => {
      if (!mergerCreated) {
      mergerCreated = true;
      return Promise.resolve('sess-impl-rebase');
      }
      return Promise.resolve('sess-subtask-after');
    });

      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'git' && Array.isArray(args)) {
      const argStr = args.join(' ');
      if (argStr.includes('rebase') && !argStr.includes('--abort')) {
      throw new Error('Rebase conflict');
      }
      }
      return '';
    });

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

    // Merger was spawned
      expect(mockSendMessage).toHaveBeenCalledWith('sess-impl-rebase', '/merge origin/main');

    // Simulate merger failure
      fireEvent('exit', { sessionId: 'sess-impl-rebase', code: 1 });
      await new Promise(r => setTimeout(r, 10));

    // Even though merger failed, implement continues (unlike merge which throws)
      expect(mockSendMessage).toHaveBeenCalledWith('sess-subtask-after', expect.stringContaining('/implement Subtask 1'));

    // Complete subtask -> push -> QA -> done
      fireEvent('event', { sessionId: 'sess-subtask-after', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 10));
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'PASS',
      criteria: [],
      }));
      fireEvent('event', { sessionId: 'sess-subtask-after', event: { type: 'result' } });
      await promise;

      if (existsSync(pipeline.worktreePath)) rmSync(pipeline.worktreePath, { recursive: true, force: true });
    });
    });

  describe('runQaReview', () => {
    it('advances to awaiting-review when QA passes', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
      });

      mockCreateSession.mockResolvedValue('sess-qa');
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'PASS',
        criteria: [],
      }));

      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await new Promise(r => setTimeout(r, 10));
      fireEvent('event', { sessionId: 'sess-qa', event: { type: 'result' } });
      await promise;

      expect(pipeline.phase).toBe('awaiting-review');
      expect(pipeline.qaAttempt).toBe(1);
    });

    it('writes completion summary and fails when max QA attempts reached', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        qaAttempt: 2,
        maxQaAttempts: 3,
      });

      mockCreateSession.mockResolvedValue('sess-qa');
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        criteria: [],
      }));

      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await new Promise(r => setTimeout(r, 10));
      fireEvent('event', { sessionId: 'sess-qa', event: { type: 'result' } });
      await promise;

      expect(pipeline.phase).toBe('failed');
      expect(existsSync(join(testData.taskDir, 'completion_summary.md'))).toBe(true);
    });
  });

  // ── Spec revision — runQaReview with spec_concerns ───────────────

  describe('runQaReview — spec concerns diversion', () => {
    it('auto-revises spec when spec_concerns exist instead of awaiting human review', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        qaAttempt: 0,
        maxQaAttempts: 3,
      });

      // First call: QA session; second call: spec revision session (abort to stop cascade)
      let callCount = 0;
      mockCreateSession.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve('sess-qa-spec');
        return Promise.reject(new Error('simulated abort after spec revision'));
      });

      // QA report with spec_concerns � the spec itself is the problem,
      // not the implementation
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        criteria: [
          { name: 'API response matches spec', status: 'PASS', notes: 'Code correctly uses { data: [...] } as spec says' },
        ],
        spec_concerns: [
          {
            issue: 'Spec assumes wrong API response shape',
            reasoning: 'The spec says the API returns { data: [...] } but the actual API returns { results: [...] }. The implementation follows the spec correctly but the spec itself is wrong.',
            suggested_fix: 'Update acceptance criteria to reference { results: [...] } instead of { data: [...] }',
          },
        ],
      }));

      const promise = (orch as AnyOrch).runQaReview(pipeline);
      const caught = promise.catch(() => {}); // attach handler before cascade microtasks fire
      await new Promise(r => setTimeout(r, 10));
      fireEvent('event', { sessionId: 'sess-qa-spec', event: { type: 'result' } });
      // Wait for auto-revision cascade to complete (including the abort)
      await caught;

      // Should have auto-revised spec � NOT awaiting human review
      expect(pipeline.phase).not.toBe('awaiting-review');
      expect(pipeline.phase).toBe('spec');
      expect(pipeline.qaAttempt).toBe(0); // reset for fresh cycle
      // Should write spec_revision_feedback.md
      const feedbackPath = join(testData.taskDir, 'spec_revision_feedback.md');
      expect(existsSync(feedbackPath)).toBe(true);
      const feedback = readFileSync(feedbackPath, 'utf-8');
      expect(feedback).toContain('Spec assumes wrong API response shape');
    });

    it('auto-revises spec even when overall is PASS but spec_concerns exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        qaAttempt: 0,
        maxQaAttempts: 3,
      });

      let callCount = 0;
      mockCreateSession.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve('sess-qa-pass-spec');
        return Promise.reject(new Error('simulated abort after spec revision'));
      });

      // QA passes implementation (code matches spec) but flags spec-level concerns
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'PASS',
        criteria: [
          { name: 'API integration', status: 'PASS', notes: 'Code follows spec' },
        ],
        spec_concerns: [
          {
            issue: 'Spec contradicts itself',
            reasoning: 'Requirement 3 says use POST but requirement 5 says use GET for the same endpoint. The implementation used POST per requirement 3, but this may be wrong.',
            suggested_fix: 'Resolve contradiction and pick one HTTP method.',
          },
        ],
      }));

      const promise = (orch as AnyOrch).runQaReview(pipeline);
      const caught = promise.catch(() => {}); // attach handler before cascade microtasks fire
      await new Promise(r => setTimeout(r, 10));
      fireEvent('event', { sessionId: 'sess-qa-pass-spec', event: { type: 'result' } });
      await caught;

      // Spec concerns trigger auto-revision � NOT human review
      expect(pipeline.phase).not.toBe('awaiting-review');
      expect(pipeline.phase).toBe('spec');
      const feedbackPath = join(testData.taskDir, 'spec_revision_feedback.md');
      expect(existsSync(feedbackPath)).toBe(true);
      const feedback = readFileSync(feedbackPath, 'utf-8');
      expect(feedback).toContain('Spec contradicts itself');
    });

    it('still bounces to implement when overall is FAIL and no spec_concerns exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        qaAttempt: 0,
        maxQaAttempts: 3,
      });

      // Need to mock createSession for both QA and implement phases
      let callCount = 0;
      mockCreateSession.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve('sess-qa-fail');
        return Promise.reject(new Error('simulated abort'));
      });

      // Standard FAIL — no spec_concerns
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        criteria: [
          { name: 'Button visible on mobile', status: 'FAIL', notes: 'Button hidden at 375px', fix_needed: 'Fix the z-index' },
        ],
      }));

      const promise = (orch as AnyOrch).runQaReview(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 10));
      fireEvent('event', { sessionId: 'sess-qa-fail', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));
      await promise;

      // Standard FAIL without spec_concerns should bounce to implement
      expect(pipeline.phase).toBe('implement');
    });

    it('handles empty spec_concerns array like no spec_concerns at all', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        qaAttempt: 0,
        maxQaAttempts: 3,
      });

      let callCount = 0;
      mockCreateSession.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve('sess-qa-empty');
        return Promise.reject(new Error('simulated abort'));
      });

      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        criteria: [
          { name: 'Test', status: 'FAIL', notes: 'Failed' },
        ],
        spec_concerns: [],
      }));

      const promise = (orch as AnyOrch).runQaReview(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 10));
      fireEvent('event', { sessionId: 'sess-qa-empty', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));
      await promise;

      // Empty spec_concerns should follow normal FAIL path → bounce to implement
      expect(pipeline.phase).toBe('implement');
    });
  });

    it('falls back to awaiting-review when max spec revisions reached', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        qaAttempt: 0,
        maxQaAttempts: 3,
      });
      // Already at max revisions (3) � next auto-revision should fall back
      pipeline.specRevision = 3;

      mockCreateSession.mockResolvedValue('sess-qa-max-rev');

      // QA report with spec_concerns � but we're out of revision budget
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        criteria: [
          { name: 'Edge case handling', status: 'FAIL', notes: 'Missing null check on input', fix_needed: 'Add null guard' },
        ],
        spec_concerns: [
          {
            issue: 'Spec uses deprecated API',
            reasoning: 'The spec references /v1/api which was deprecated in favour of /v2/api. The implementation used /v1 as specified, but this is wrong.',
            suggested_fix: 'Update spec to reference /v2/api',
          },
        ],
      }));

      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await new Promise(r => setTimeout(r, 10));
      fireEvent('event', { sessionId: 'sess-qa-max-rev', event: { type: 'result' } });
      await promise;

      // Max revisions exhausted � must fall back to human review, NOT auto-revise
      expect(pipeline.phase).toBe('awaiting-review');
      expect(pipeline.specRevision).toBeGreaterThanOrEqual(3);
      expect(pipeline.qaAttempt).toBe(1); // guard path: qaAttempt NOT reset (unlike auto-revision path)
      // Should NOT have auto-revised � no spec_revision_feedback.md
      const feedbackPath = join(testData.taskDir, 'spec_revision_feedback.md');
      expect(existsSync(feedbackPath)).toBe(false);
    });


  // ── Spec revision — reviseSpec method ─────────────────────────────

  describe('reviseSpec', () => {
    it('throws when task is not in awaiting-review', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      await expect(orch.reviseSpec(testData.taskId)).rejects.toThrow('cannot revise spec a task in backlog');
    });

    it('writes spec_revision_feedback.md from QA report spec_concerns', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Set task to awaiting-review
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'awaiting-review' });

      // Write existing spec.md and qa_report.json with spec_concerns
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Original Spec\n\nSome wrong assumptions.');
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        criteria: [],
        spec_concerns: [
          {
            issue: 'Wrong API assumption',
            reasoning: 'Spec says the API returns XML but it actually returns JSON.',
            suggested_fix: 'Update all API examples to use JSON.',
          },
          {
            issue: 'Missing edge case',
            reasoning: 'Spec does not cover the rate-limiting scenario.',
          },
        ],
      }));

      // Mock createSession to abort the cascading pipeline after spec starts
      mockCreateSession.mockRejectedValue(new Error('simulated abort'));

      await orch.reviseSpec(testData.taskId).catch(() => {});

      // Verify spec_revision_feedback.md was written with both concerns
      const feedbackPath = join(testData.taskDir, 'spec_revision_feedback.md');
      expect(existsSync(feedbackPath)).toBe(true);
      const feedback = readFileSync(feedbackPath, 'utf-8');
      expect(feedback).toContain('Wrong API assumption');
      expect(feedback).toContain('Spec says the API returns XML but it actually returns JSON');
      expect(feedback).toContain('Update all API examples to use JSON');
      expect(feedback).toContain('Missing edge case');
      expect(feedback).toContain('Spec does not cover the rate-limiting scenario');
    });

    it('snapshots spec.md as spec_v1.md before revision', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'awaiting-review' });

      const originalSpec = '# Original Spec\n\nAssumption: API returns XML.';
      writeFileSync(join(testData.taskDir, 'spec.md'), originalSpec);
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        spec_concerns: [
          { issue: 'Wrong format', reasoning: 'API returns JSON, not XML.' },
        ],
      }));

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.reviseSpec(testData.taskId).catch(() => {});

      // spec_v1.md should contain the original spec content
      const snapshotPath = join(testData.taskDir, 'spec_v1.md');
      expect(existsSync(snapshotPath)).toBe(true);
      expect(readFileSync(snapshotPath, 'utf-8')).toBe(originalSpec);
    });

    it('creates spec_v2.md on second revision without overwriting spec_v1.md', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'awaiting-review' });

      // Pre-create spec_v1.md to simulate a prior revision
      const originalSpecV1 = '# Original Spec v1\n\nAssumption: API returns XML.';
      writeFileSync(join(testData.taskDir, 'spec_v1.md'), originalSpecV1);
      const revisedSpec = '# Revised Spec\n\nAssumption: API returns JSON.';
      writeFileSync(join(testData.taskDir, 'spec.md'), revisedSpec);
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        spec_concerns: [
          { issue: 'Wrong authentication', reasoning: 'API uses OAuth, not API keys.' },
        ],
      }));

      // Manually bump specRevision to 1 so _autoReviseSpec bumps it to 2
      const pipeline = (orch as AnyOrch).restorePipeline(testData.taskId, 'awaiting-review');
      pipeline.specRevision = 1;
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.reviseSpec(testData.taskId).catch(() => {});

      // spec_v2.md should be created with the current spec.md content
      const snapshotV2 = join(testData.taskDir, 'spec_v2.md');
      expect(existsSync(snapshotV2)).toBe(true);
      expect(readFileSync(snapshotV2, 'utf-8')).toBe(revisedSpec);

      // spec_v1.md should still exist and NOT be overwritten
      const snapshotV1 = join(testData.taskDir, 'spec_v1.md');
      expect(existsSync(snapshotV1)).toBe(true);
      expect(readFileSync(snapshotV1, 'utf-8')).toBe(originalSpecV1);
    });

    it('clears downstream artifacts (plan.json, qa_report.json, feedback files)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'awaiting-review' });

      // Write artifacts that should be cleared
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({ subtasks: [] }));
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        spec_concerns: [{ issue: 'Test', reasoning: 'Test' }],
      }));
      writeFileSync(join(testData.taskDir, 'qa_feedback.md'), 'old qa feedback');
      writeFileSync(join(testData.taskDir, 'completion_summary.md'), 'old summary');
      writeFileSync(join(testData.taskDir, 'human_feedback.md'), 'old human feedback');
      writeFileSync(join(testData.taskDir, 'human_feedback_before_bounce.md'), 'old snapshot');

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.reviseSpec(testData.taskId).catch(() => {});

      // plan.json and qa_report.json cleared by clearArtifacts('plan')
      expect(existsSync(join(testData.taskDir, 'plan.json'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'qa_report.json'))).toBe(false);

      // Extra files manually cleared
      expect(existsSync(join(testData.taskDir, 'qa_feedback.md'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'completion_summary.md'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'human_feedback.md'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'human_feedback_before_bounce.md'))).toBe(false);

      // spec.md should still exist (it gets revised, not deleted)
      expect(existsSync(join(testData.taskDir, 'spec.md'))).toBe(true);
    });

    it('resets qaAttempt to 0 for a fresh QA cycle on revised spec', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'awaiting-review' });

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        spec_concerns: [{ issue: 'Test', reasoning: 'Test' }],
      }));

      // Register a pipeline with a non-zero qaAttempt
      const pipeline = makePipeline({
        taskId: testData.taskId,
        phase: 'awaiting-review',
        specPath: testData.taskDir,
        qaAttempt: 3,
      });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.reviseSpec(testData.taskId).catch(() => {});

      // QA attempt should be reset to 0
      expect(pipeline.qaAttempt).toBe(0);
    });

    it('advances to spec phase and starts the pipeline', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'awaiting-review' });

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        spec_concerns: [{ issue: 'Test', reasoning: 'Test' }],
      }));

      // Mock createSession to verify the pipeline actually starts (createSession is called)
      mockCreateSession.mockRejectedValue(new Error('simulated abort'));

      await orch.reviseSpec(testData.taskId).catch(() => {});

      // createSession should have been called (proves executePhase → runSpec was reached)
      expect(mockCreateSession).toHaveBeenCalled();
    });
  });

  // ── Spec revision — runSpec revision mode detection ───────────────

  describe('runSpec — revision mode', () => {
    it('sends REVISION prompt when spec_revision_feedback.md exists', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Write spec_revision_feedback.md to trigger revision mode
      writeFileSync(join(testData.taskDir, 'spec_revision_feedback.md'),
        '## Wrong API assumption\n\n**Reasoning:** API returns JSON, not XML.\n\n**Suggested fix:** Update spec.\n');

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
      });

      // First createSession succeeds (spec), second rejects (plan cascade)
      let callCount = 0;
      mockCreateSession.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve('sess-spec-rev');
        return Promise.reject(new Error('simulated abort'));
      });

      const promise = (orch as AnyOrch).runSpec(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

      // Should have sent a REVISION prompt, not /spec
      const sendCalls = mockSendMessage.mock.calls.filter(
        (call: any[]) => call[0] === 'sess-spec-rev'
      );
      expect(sendCalls.length).toBeGreaterThanOrEqual(1);
      const prompt = sendCalls[0][1];
      expect(prompt).toContain('REVISION:');
      expect(prompt).toContain('spec_revision_feedback.md');
      expect(prompt).toContain('Revise the spec to address ALL concerns');
      // REVISION prompt starts with REVISION:, not /spec
      expect(prompt.startsWith('REVISION:')).toBe(true);

      // Fire completion
      fireEvent('event', { sessionId: 'sess-spec-rev', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 50));
      await promise;
    });

    it('cleans up spec_revision_feedback.md after revision completes', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec_revision_feedback.md'),
        '## Test concern\n\n**Reasoning:** Test.\n');

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
      });

      let callCount = 0;
      mockCreateSession.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve('sess-spec-cleanup');
        return Promise.reject(new Error('simulated abort'));
      });

      const promise = (orch as AnyOrch).runSpec(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

      // File should still exist during spec execution
      expect(existsSync(join(testData.taskDir, 'spec_revision_feedback.md'))).toBe(true);

      fireEvent('event', { sessionId: 'sess-spec-cleanup', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 50));
      await promise;

      // After spec completes, revision feedback should be cleaned up
      expect(existsSync(join(testData.taskDir, 'spec_revision_feedback.md'))).toBe(false);
    });

    it('sends standard /spec prompt when spec_revision_feedback.md does not exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // No spec_revision_feedback.md — this is a normal spec phase

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
      });

      let callCount = 0;
      mockCreateSession.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve('sess-spec-normal');
        return Promise.reject(new Error('simulated abort'));
      });

      const promise = (orch as AnyOrch).runSpec(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

      const sendCalls = mockSendMessage.mock.calls.filter(
        (call: any[]) => call[0] === 'sess-spec-normal'
      );
      expect(sendCalls.length).toBeGreaterThanOrEqual(1);
      const prompt = sendCalls[0][1];
      expect(prompt).toContain('/spec');
      expect(prompt).not.toContain('REVISION:');

      fireEvent('event', { sessionId: 'sess-spec-normal', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 50));
      await promise;
    });
  });

  // ── Clean up global orchestrators after tests ─────────────────────

  afterAll(() => {
    const g = global as any;
    if (g.__orchestrators) {
      g.__orchestrators.clear();
    }
  });

  // ── runImplement — subtask-progress event emission ────────────────

  describe('runImplement — subtask-progress event emission', () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date());
      testData = setupTestProject();
      // Write plan.json with subtasks so runImplement can process them
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{
          id: 1,
          title: 'Subtask One',
          description: 'First subtask',
          files: ['src/a.ts'],
          acceptance_criteria: ['Works correctly'],
        }],
      }));
    });

    afterEach(() => {
      vi.useRealTimers();
      if (testData) testData.clean(onHandlers);
    });

    it('emits subtask-progress via processManager after a subtask completes', async () => {
      // Return empty string for git diff (scope check — no changed files),
      // and a valid hash for rev-parse and other git commands.
      mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
        if (args && args.includes('diff')) return ''; // scope check: no extra changes
        return 'abc123\n'; // rev-parse HEAD, push, etc.
      });
      mockCreateSession.mockResolvedValue('sess-impl-sp');

      const orch = makeOrch(testData.root, getOrchestrator);

      // Spy on executePhase to prevent cascading into subsequent phases
      const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

      try {
        const pipeline = makePipeline({
          taskId: testData.taskId,
          phase: 'implement',
          specPath: testData.taskDir,
          worktreePath: join(testData.root, 'worktrees', 'test-task'),
          branch: testData.branchName,
          qaAttempt: 0,
          maxQaAttempts: 3,
        });

        const promise = (orch as AnyOrch).runImplement(pipeline);

        // Wait for sendMessage — means the subtask session was created and prompt sent
        await vi.waitFor(() => {
          expect(mockSendMessage).toHaveBeenCalled();
        });

        expect(mockCreateSession).toHaveBeenCalled();

        // Fire the result event to complete the subtask session
        fireEvent('event', { sessionId: 'sess-impl-sp', event: { type: 'result' } });

        // Wait for runImplement to fully complete — the planWriteLock microtask
        // chain flushes during its completion, so subtask-progress is emitted by then
        await promise;

        // Verify subtask-progress was emitted with correct shape
        expect(mockEmit).toHaveBeenCalledWith('subtask-progress', expect.objectContaining({
          taskId: testData.taskId,
          completed: 1,
          total: 1,
          projectRoot: testData.root,
        }));
      } finally {
        executeSpy.mockRestore();
      }
    });

    it('emits correct completed count when only some subtasks are done', async () => {
      // Write a plan with 2 subtasks, 1 already completed. Only the non-completed
      // subtask runs, so after completion we should see completed: 2, total: 2.
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [
          { id: 1, title: 'Already done', description: '', files: ['src/a.ts'], acceptance_criteria: ['Works'], completed: true },
          { id: 2, title: 'Current one', description: '', files: ['src/b.ts'], acceptance_criteria: ['Works'] },
        ],
      }));

      // Return empty string for git diff (scope check — no changed files).
      mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
        if (args && args.includes('diff')) return '';
        return 'abc123\n';
      });
      mockCreateSession.mockResolvedValue('sess-impl-sp2');

      const orch = makeOrch(testData.root, getOrchestrator);
      const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

      try {
        const pipeline = makePipeline({
          taskId: testData.taskId,
          phase: 'implement',
          specPath: testData.taskDir,
          worktreePath: join(testData.root, 'worktrees', 'test-task'),
          branch: testData.branchName,
          qaAttempt: 0,
          maxQaAttempts: 3,
        });

        const promise = (orch as AnyOrch).runImplement(pipeline);

        await vi.waitFor(() => {
          expect(mockSendMessage).toHaveBeenCalled();
        });

        fireEvent('event', { sessionId: 'sess-impl-sp2', event: { type: 'result' } });
        await vi.advanceTimersByTimeAsync(50);

        // Should show completed: 2 (1 pre-existing + 1 just completed), total: 2
        expect(mockEmit).toHaveBeenCalledWith('subtask-progress', expect.objectContaining({
          taskId: testData.taskId,
          completed: 2,
          total: 2,
          projectRoot: testData.root,
        }));

        await promise;
      } finally {
        executeSpy.mockRestore();
      }
    });

    it('includes projectRoot in the emitted event for WebSocket filtering', async () => {
      // Return empty string for git diff (scope check — no changed files).
      mockExecFileSync.mockImplementation((_cmd: string, args?: string[]) => {
        if (args && args.includes('diff')) return '';
        return 'abc123\n';
      });
      mockCreateSession.mockResolvedValue('sess-impl-sp3');

      const orch = makeOrch(testData.root, getOrchestrator);
      const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

      try {
        const pipeline = makePipeline({
          taskId: testData.taskId,
          phase: 'implement',
          specPath: testData.taskDir,
          worktreePath: join(testData.root, 'worktrees', 'test-task'),
          branch: testData.branchName,
          qaAttempt: 0,
          maxQaAttempts: 3,
        });

        const promise = (orch as AnyOrch).runImplement(pipeline);

        await vi.waitFor(() => {
          expect(mockSendMessage).toHaveBeenCalled();
        });

        fireEvent('event', { sessionId: 'sess-impl-sp3', event: { type: 'result' } });
        await vi.advanceTimersByTimeAsync(50);

        // The projectRoot must be present so server.ts can filter broadcasts by project
        expect(mockEmit).toHaveBeenCalledWith('subtask-progress', expect.objectContaining({
          projectRoot: testData.root,
        }));

        await promise;
      } finally {
        executeSpy.mockRestore();
      }
    });
  });
});
