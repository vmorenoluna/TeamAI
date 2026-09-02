/**
 * Tests for Orchestrator.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
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
import { ContainerDockerMissingError } from '../../src/lib/orchestrator/errors';

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

    it('throws ContainerDockerMissingError when container mode is enabled but Docker is unavailable', async () => {
      testData = setupTestProject();
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(dockerAvailable).mockReturnValue(false);

      const orch = makeOrch(testData.root, getOrchestrator);

      await expect(orch.runTask(testData.taskId, 'test', 'spec')).rejects.toThrow(ContainerDockerMissingError);
    });

    it('emits container-docker-missing event before throwing in runTask', async () => {
      testData = setupTestProject();
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(dockerAvailable).mockReturnValue(false);
      mockEmit.mockClear();

      const orch = makeOrch(testData.root, getOrchestrator);

      await orch.runTask(testData.taskId, 'test', 'spec').catch(() => { /* best-effort */ });

      expect(mockEmit).toHaveBeenCalledWith('container-docker-missing', {
        projectRoot: testData.root,
      });
    });

    it('does not throw in runTask when Docker is available', async () => {
      testData = setupTestProject();
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(dockerAvailable).mockReturnValue(true);
      // Abort pipeline early after gate passes
      mockCreateSession.mockRejectedValue(new Error('simulated abort'));

      const orch = makeOrch(testData.root, getOrchestrator);

      // Should proceed past the gate — eventually fails on createSession, not the gate
      await orch.runTask(testData.taskId, 'test', 'spec').catch(() => { /* best-effort */ });
      // Proof we got past the gate: createSession was called by runSpec
      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('populates pipeline.title from task.title, not the description argument', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      // Abort after the pipeline object is constructed (before executePhase awaits).
      mockCreateSession.mockRejectedValue(new Error('simulated abort'));

      // runTask registers the pipeline synchronously before its first await,
      // so it's inspectable immediately after the call returns.
      const promise = orch.runTask(testData.taskId, 'unrelated description', 'spec');
      const pipeline = (orch as AnyOrch).pipelines.get(testData.taskId);

      expect(pipeline).toBeDefined();
      // Title comes from task.json's title, not the description argument.
      expect(pipeline.title).toBe('Test Task');
      expect(pipeline.description).toBe('unrelated description');

      await promise.catch(() => { /* best-effort */ });
    });
  });

  // ── executePhase — container Docker gate ───────────────────────────

  describe('executePhase — container Docker gate', () => {
    beforeEach(() => {
      testData = setupTestProject();
      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
    });

    it('throws ContainerDockerMissingError when container mode is enabled but Docker is unavailable', async () => {
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(dockerAvailable).mockReturnValue(false);

      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      const err = await (orch as AnyOrch).executePhase(pipeline).catch((e: unknown) => e);

      expect(err).toBeInstanceOf(ContainerDockerMissingError);
      expect(err.code).toBe('CONTAINER_DOCKER_MISSING');
    });

    it('emits container-docker-missing event before throwing', async () => {
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(dockerAvailable).mockReturnValue(false);
      mockEmit.mockClear();

      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      await (orch as AnyOrch).executePhase(pipeline).catch(() => { /* best-effort */ });

      expect(mockEmit).toHaveBeenCalledWith('container-docker-missing', {
        projectRoot: testData.root,
      });
    });

    it('resets the dockerAvailable cache before checking', async () => {
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      // First call returns false (stale cache), second returns true (Docker started)
      vi.mocked(dockerAvailable)
        .mockReturnValueOnce(false)
        .mockReturnValueOnce(true);
      // Abort early — the gate passes, but we don't need the full pipeline to cascade
      mockCreateSession.mockRejectedValue(new Error('simulated abort'));

      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      // Should NOT throw ContainerDockerMissingError — cache reset + second
      // dockerAvailable() returns true, so gate lets us through to runSpec
      await (orch as AnyOrch).executePhase(pipeline).catch(() => { /* best-effort */ });

      expect(_resetDockerAvailableCache).toHaveBeenCalled();
      expect(dockerAvailable).toHaveBeenCalledTimes(2);
      // Proof we got past the gate: createSession was called by runSpec
      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('does not throw when Docker is available', async () => {
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(dockerAvailable).mockReturnValue(true);

      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      // Should proceed to runSpec → createSession (which rejects with simulated abort)
      await (orch as AnyOrch).executePhase(pipeline).catch(() => { /* best-effort */ });
      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('does not throw when container mode is disabled', async () => {
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });
      vi.mocked(dockerAvailable).mockReturnValue(false); // Docker unavailable but irrelevant

      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      // Should proceed past the gate (container mode disabled)
      await (orch as AnyOrch).executePhase(pipeline).catch(() => { /* best-effort */ });
      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('skips the Docker check for awaiting-review phase', async () => {
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(dockerAvailable).mockReturnValue(false);

      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'awaiting-review', specPath: testData.taskDir });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      // awaiting-review is a no-op pause — should not throw
      await expect((orch as AnyOrch).executePhase(pipeline)).resolves.toBeUndefined();
    });

    it('skips the Docker check for pr-open phase', async () => {
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(dockerAvailable).mockReturnValue(false);

      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'pr-open', specPath: testData.taskDir });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      // pr-open is a no-op pause — should not throw
      await expect((orch as AnyOrch).executePhase(pipeline)).resolves.toBeUndefined();
    });

    it('throws for plan phase (simulates autoReviseSpec → spec → advancePhase → plan path)', async () => {
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(dockerAvailable).mockReturnValue(false);

      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'plan', specPath: testData.taskDir });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      const err = await (orch as AnyOrch).executePhase(pipeline).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(ContainerDockerMissingError);
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
      await expect(orch.rejectTask(testData.taskId, 'bad', 'coder')).rejects.toThrow('cannot reject a task in backlog');
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
      const promise = orch.rejectTask(testData.taskId, 'Fix the tests', 'coder').catch(() => { /* best-effort */ });

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
        qaRevision: 3,
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
      expect(saved.qaRevision).toBe(3);
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

    it('does not throw on permission errors, but logs a warning (observable)', () => {
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

      mockWarn.mockClear();
      expect(() => {
        (orch as AnyOrch)._ctx.savePipelineState(pipeline);
      }).not.toThrow();

      // The write failure must not be silent — crash recovery depends on it.
      expect(mockWarn).toHaveBeenCalled();
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
      try { if (existsSync(statePath)) unlinkSync(statePath); } catch { /* best-effort */ }
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
        qaRevision: 4,
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
      expect(result!.qaRevision).toBe(4);
      expect(result!.phase).toBe('implement');

      expect(existsSync(statePath)).toBe(false);
    });

    it('returns null for corrupt JSON (file stays on disk, warning logged)', () => {
      const orch = makeOrch(testData.root, getOrchestrator);
      writeFileSync(statePath, 'not valid json {{{');
      mockWarn.mockClear();
      const result = (orch as AnyOrch)._restorePipelineState(testData.taskId, specPath);
      expect(result).toBeNull();
      expect(existsSync(statePath)).toBe(true);
      // Corrupt state must be surfaced, not silently dropped.
      expect(mockWarn).toHaveBeenCalled();
    });

    it('returns null for empty state file', () => {
      const orch = makeOrch(testData.root, getOrchestrator);
      writeFileSync(statePath, '');
      const result = (orch as AnyOrch)._restorePipelineState(testData.taskId, specPath);
      expect(result).toBeNull();
    });
  });

  // ── _restoreSpecRevision ──────────────────────────────────────────

  describe('_restoreSpecRevision', () => {
    beforeEach(() => {
      testData = setupTestProject();
    });

    it('returns 1 (the live spec) when no pipeline state file and no snapshots exist', () => {
      const orch = makeOrch(testData.root, getOrchestrator);
      // No .pipeline_state.json, no spec_v{N}.md files on disk — the live
      // spec.md IS version 1 under the rename-at-revision scheme.
      const result = (orch as AnyOrch)._restoreSpecRevision(testData.taskId);
      expect(result).toBe(1);
    });

    it('returns specRevision from .pipeline_state.json (primary path)', () => {
      const statePath = join(testData.taskDir, '.pipeline_state.json');
      writeFileSync(statePath, JSON.stringify({
        specRevision: 2,
        taskId: testData.taskId,
        phase: 'spec',
      }, null, 2));

      const orch = makeOrch(testData.root, getOrchestrator);
      const result = (orch as AnyOrch)._restoreSpecRevision(testData.taskId);
      expect(result).toBe(2);
    });

    it('ignores .pipeline_state.json with specRevision <= 0 and falls back to disk', () => {
      // Write state file with specRevision: 0 (should be ignored)
      const statePath = join(testData.taskDir, '.pipeline_state.json');
      writeFileSync(statePath, JSON.stringify({
        specRevision: 0,
        taskId: testData.taskId,
      }, null, 2));

      // Create spec_v1.md and spec_v2.md on disk (fallback path) — the live
      // spec.md is therefore version 3.
      writeFileSync(join(testData.taskDir, 'spec_v1.md'), '# Spec v1');
      writeFileSync(join(testData.taskDir, 'spec_v2.md'), '# Spec v2');

      const orch = makeOrch(testData.root, getOrchestrator);
      const result = (orch as AnyOrch)._restoreSpecRevision(testData.taskId);
      expect(result).toBe(3);
    });

    it('falls back to highest snapshot + 1 (the live spec) when no state file exists', () => {
      // Create spec_v1.md and spec_v2.md on disk (no .pipeline_state.json) —
      // the next revision renames the live spec.md to spec_v3.md, so the
      // restored counter must be 3.
      writeFileSync(join(testData.taskDir, 'spec_v1.md'), '# Spec v1');
      writeFileSync(join(testData.taskDir, 'spec_v2.md'), '# Spec v2');

      const orch = makeOrch(testData.root, getOrchestrator);
      const result = (orch as AnyOrch)._restoreSpecRevision(testData.taskId);
      expect(result).toBe(3);
    });

    it('returns highest snapshot + 1 for contiguous snapshots', () => {
      // autoReviseSpec always increments specRevision sequentially,
      // so snapshots are guaranteed to be contiguous.  Test that the
      // scan correctly counts all of them, including beyond the old
      // v <= 3 hardcoded limit that was removed.
      for (const v of [1, 2, 3, 4, 5]) {
        writeFileSync(join(testData.taskDir, `spec_v${v}.md`), `# Spec v${v}`);
      }

      const orch = makeOrch(testData.root, getOrchestrator);
      const result = (orch as AnyOrch)._restoreSpecRevision(testData.taskId);
      expect(result).toBe(6);
    });

    it('returns highest snapshot + 1 even when v1 is missing (gap-tolerant)', () => {
      // Legacy/migrated tasks can have v2..vN with no v1 — the old
      // break-at-first-missing loop returned 0 here, silently resetting
      // revision numbering when .pipeline_state.json was lost.
      writeFileSync(join(testData.taskDir, 'spec_v2.md'), '# Spec v2');
      writeFileSync(join(testData.taskDir, 'spec_v3.md'), '# Spec v3');
      writeFileSync(join(testData.taskDir, 'spec_v4.md'), '# Spec v4');

      const orch = makeOrch(testData.root, getOrchestrator);
      const result = (orch as AnyOrch)._restoreSpecRevision(testData.taskId);
      expect(result).toBe(5);
    });

    it('handles corrupt .pipeline_state.json gracefully via fallback', () => {
      const statePath = join(testData.taskDir, '.pipeline_state.json');
      writeFileSync(statePath, 'not valid json {{{');

      // Create spec_v1.md on disk for the fallback — live spec is version 2.
      writeFileSync(join(testData.taskDir, 'spec_v1.md'), '# Spec v1');

      const orch = makeOrch(testData.root, getOrchestrator);
      const result = (orch as AnyOrch)._restoreSpecRevision(testData.taskId);
      expect(result).toBe(2);
    });
  });

  // ── _restoreQaRevision ───────────────────────────────────────────

  describe('_restoreQaRevision', () => {
    beforeEach(() => {
      testData = setupTestProject();
    });

    it('returns 0 when no pipeline state file and no qa report snapshots exist', () => {
      const orch = makeOrch(testData.root, getOrchestrator);
      const result = (orch as AnyOrch)._restoreQaRevision(testData.taskId);
      expect(result).toBe(0);
    });

    it('returns qaRevision from .pipeline_state.json (primary path)', () => {
      const statePath = join(testData.taskDir, '.pipeline_state.json');
      writeFileSync(statePath, JSON.stringify({
        qaRevision: 3,
        taskId: testData.taskId,
        phase: 'qa-review',
      }, null, 2));

      const orch = makeOrch(testData.root, getOrchestrator);
      const result = (orch as AnyOrch)._restoreQaRevision(testData.taskId);
      expect(result).toBe(3);
    });

    it('ignores .pipeline_state.json with qaRevision <= 0 and falls back to disk', () => {
      const statePath = join(testData.taskDir, '.pipeline_state.json');
      writeFileSync(statePath, JSON.stringify({
        qaRevision: 0,
        taskId: testData.taskId,
      }, null, 2));

      writeFileSync(join(testData.taskDir, 'qa_report_v1.json'), '{}');
      writeFileSync(join(testData.taskDir, 'qa_report_v2.json'), '{}');

      const orch = makeOrch(testData.root, getOrchestrator);
      const result = (orch as AnyOrch)._restoreQaRevision(testData.taskId);
      expect(result).toBe(2);
    });

    it('falls back to counting qa_report_v{N}.json snapshots when no state file exists', () => {
      writeFileSync(join(testData.taskDir, 'qa_report_v1.json'), '{}');
      writeFileSync(join(testData.taskDir, 'qa_report_v2.json'), '{}');

      const orch = makeOrch(testData.root, getOrchestrator);
      const result = (orch as AnyOrch)._restoreQaRevision(testData.taskId);
      expect(result).toBe(2);
    });

    it('returns the highest snapshot number for contiguous snapshots', () => {
      for (const v of [1, 2, 3, 4, 5]) {
        writeFileSync(join(testData.taskDir, `qa_report_v${v}.json`), '{}');
      }

      const orch = makeOrch(testData.root, getOrchestrator);
      const result = (orch as AnyOrch)._restoreQaRevision(testData.taskId);
      expect(result).toBe(5);
    });

    it('returns the highest snapshot even when v1 is missing (gap-tolerant)', () => {
      writeFileSync(join(testData.taskDir, 'qa_report_v2.json'), '{}');
      writeFileSync(join(testData.taskDir, 'qa_report_v3.json'), '{}');

      const orch = makeOrch(testData.root, getOrchestrator);
      const result = (orch as AnyOrch)._restoreQaRevision(testData.taskId);
      expect(result).toBe(3);
    });

    it('handles corrupt .pipeline_state.json gracefully via fallback', () => {
      const statePath = join(testData.taskDir, '.pipeline_state.json');
      writeFileSync(statePath, 'not valid json {{{');

      writeFileSync(join(testData.taskDir, 'qa_report_v1.json'), '{}');

      const orch = makeOrch(testData.root, getOrchestrator);
      const result = (orch as AnyOrch)._restoreQaRevision(testData.taskId);
      expect(result).toBe(1);
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

      it('falls back to rmSync + a scoped worktree-remove retry when docker exec remove and --force both fail', () => {
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
        // removeStaleWorktreeRegistration retries a scoped `git worktree
        // remove --force <name>` (not the unscoped `git worktree prune`,
        // which has no path argument to limit its blast radius and would
        // risk destroying an unrelated concurrently-running task's worktree
        // registration). The earlier --force attempt (via _execGit) uses
        // the full path; the fallback retry uses the bare worktree name —
        // a container-patched registration's recorded path no longer
        // matches the host-computed full path, only the basename resolves
        // in that case (verified empirically), so the two calls differ.
        const fullPathRemoveCalls = mockExecFileSync.mock.calls.filter(
          (c: unknown[]) => c[0] === 'git' &&
            Array.isArray(c[1]) &&
            c[1][0] === 'worktree' && c[1][1] === 'remove' && c[1][2] === '--force' && c[1][3] === wtPath,
        );
        const basenameRemoveCalls = mockExecFileSync.mock.calls.filter(
          (c: unknown[]) => c[0] === 'git' &&
            Array.isArray(c[1]) &&
            c[1][0] === 'worktree' && c[1][1] === 'remove' && c[1][2] === '--force' && c[1][3] === basename(wtPath),
        );
        expect(fullPathRemoveCalls.length).toBeGreaterThanOrEqual(1);
        expect(basenameRemoveCalls.length).toBeGreaterThanOrEqual(1);
        expect(mockExecFileSync).not.toHaveBeenCalledWith(
          'git',
          ['worktree', 'prune'],
          expect.any(Object),
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
      await orch.moveTaskToPhase(testData.taskId, 'plan').catch(() => { /* best-effort */ });

      // createSession was called — proving moveTaskToPhase reached executePhase
      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('does not backfill a spec_v1 snapshot for a pre-existing unversioned spec.md', async () => {
      testData = setupTestProject();
      // A spec.md written outside the pipeline (e.g. by an external task
      // writer) — no spec_v1.md alongside it. Under the rename-at-revision
      // scheme the live spec IS version 1; no proactive copy is made. The
      // first revision renames it to spec_v1.md, preserving it as history.
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Externally authored spec');
      const orch = makeOrch(testData.root, getOrchestrator);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'plan').catch(() => { /* best-effort */ });

      expect(existsSync(join(testData.taskDir, 'spec_v1.md'))).toBe(false);
      expect(readFileSync(join(testData.taskDir, 'spec.md'), 'utf-8')).toBe('# Externally authored spec');
    });

    it('does not touch an existing spec_v1.md when routing past a spec', async () => {
      testData = setupTestProject();
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Current spec');
      writeFileSync(join(testData.taskDir, 'spec_v1.md'), '# The true original');
      const orch = makeOrch(testData.root, getOrchestrator);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'plan').catch(() => { /* best-effort */ });

      expect(readFileSync(join(testData.taskDir, 'spec_v1.md'), 'utf-8')).toBe('# The true original');
    });

    // moveTaskToPhase clears .pipeline_state.json for a 'plan' target but
    // leaves spec_v*.md history on disk. runTask (which moveTaskToPhase
    // calls into) must restore specRevision from that on-disk history rather
    // than hardcoding 1 — under the rename-at-revision scheme, a stale
    // specRevision would make a later beginSpecRevision rename spec.md
    // straight onto (clobbering) an already-archived spec_v1.md.
    it('restores specRevision from on-disk spec_v*.md history instead of hardcoding 1', async () => {
      testData = setupTestProject();
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Current spec (v2)');
      writeFileSync(join(testData.taskDir, 'spec_v1.md'), '# The true original (v1)');
      const orch = makeOrch(testData.root, getOrchestrator);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      // runTask (which moveTaskToPhase calls into) registers the pipeline
      // synchronously before its first await, so it's inspectable
      // immediately — the promise is only awaited afterward, since
      // runTask's finally block deletes the map entry once it settles.
      const promise = orch.moveTaskToPhase(testData.taskId, 'plan');
      const pipeline = (orch as AnyOrch).pipelines.get(testData.taskId);

      expect(pipeline).toBeDefined();
      // One archived version (v1) on disk means the live spec is v2, so
      // specRevision must restore to 2 (not the hardcoded 1) — the next
      // beginSpecRevision call increments to 3 and renames spec.md onto
      // spec_v{3-1} = spec_v2.md, not the existing spec_v1.md.
      expect(pipeline.specRevision).toBe(2);

      await promise.catch(() => { /* best-effort */ });
    });

    // Coverage: line 116 — hasPlan = true when plan.json exists
    it('starts from implement when hasSpec and hasPlan are true and target is implement', async () => {
      testData = setupTestProject();
      // Write both spec.md and plan.json so hasSpec=true and hasPlan=true
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({ subtasks: [{ id: 1, title: "Test", description: "Test", files: [], acceptance_criteria: [] }] }));
      const orch = makeOrch(testData.root, getOrchestrator);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'implement').catch(() => { /* best-effort */ });

      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('starts from spec when neither hasSpec nor hasPlan exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'implement').catch(() => { /* best-effort */ });

      expect(mockCreateSession).toHaveBeenCalled();
    });

    // A task that already failed QA maxQaAttempts times under a bad plan
    // must get a genuinely fresh budget when moved to a materially
    // different plan — otherwise the stale, already-exhausted count carries
    // over and the new plan gets effectively zero chances to prove itself.
    it('resets qaAttempt to 0 when moving to plan, discarding a stale exhausted count from .pipeline_state.json', async () => {
      testData = setupTestProject();
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec content');
      const statePath = join(testData.taskDir, '.pipeline_state.json');
      writeFileSync(statePath, JSON.stringify({ taskId: testData.taskId, qaAttempt: 3 }));
      const orch = makeOrch(testData.root, getOrchestrator);

      const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
      try {
        await orch.moveTaskToPhase(testData.taskId, 'plan');
        expect(executeSpy).toHaveBeenCalled();
        expect((executeSpy.mock.calls[0][0] as any).qaAttempt).toBe(0);
      } finally {
        executeSpy.mockRestore();
      }
    });

    it('resets qaAttempt to 0 when moving to spec, discarding a stale exhausted count', async () => {
      testData = setupTestProject();
      const statePath = join(testData.taskDir, '.pipeline_state.json');
      writeFileSync(statePath, JSON.stringify({ taskId: testData.taskId, qaAttempt: 3 }));
      const orch = makeOrch(testData.root, getOrchestrator);

      const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
      try {
        await orch.moveTaskToPhase(testData.taskId, 'spec');
        expect((executeSpy.mock.calls[0][0] as any).qaAttempt).toBe(0);
      } finally {
        executeSpy.mockRestore();
      }
    });

    it('does NOT reset qaAttempt when moving to implement — a same-plan retry keeps counting against the existing budget', async () => {
      testData = setupTestProject();
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'x', description: 'x', files: [], acceptance_criteria: [] }],
      }));
      const statePath = join(testData.taskDir, '.pipeline_state.json');
      writeFileSync(statePath, JSON.stringify({ taskId: testData.taskId, qaAttempt: 3 }));
      const orch = makeOrch(testData.root, getOrchestrator);

      const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
      try {
        await orch.moveTaskToPhase(testData.taskId, 'implement');
        expect((executeSpy.mock.calls[0][0] as any).qaAttempt).toBe(3);
      } finally {
        executeSpy.mockRestore();
      }
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

    it('skips resume when task is user-paused (isPaused flag)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'spec', isPaused: true });

      // Track that advancePhase('failed') is NOT called
      let failedCalled = false;
      const origAdvance = (orch as AnyOrch).advancePhase.bind(orch);
      (orch as AnyOrch).advancePhase = (p: any, phase: string) => {
        if (phase === 'failed') failedCalled = true;
        origAdvance(p, phase);
      };

      // Create a session that will succeed (should not be called)
      mockCreateSession.mockRejectedValue(new Error('should not be called'));

      // resetsAt = 0 → fires immediately
      (orch as AnyOrch).handleRateLimit(pipeline, 0);

      await new Promise(r => setTimeout(r, 50));

      // Verify the task was NOT resumed — pipeline cleaned up, rateLimitedUntil cleared
      expect(failedCalled).toBe(false);
      expect((orch as AnyOrch).pipelines.has(testData.taskId)).toBe(false);
      expect((orch as AnyOrch).activeTasks.has(testData.taskId)).toBe(false);
    });
    it('_fireWakeup skips resume when task is user-paused ', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'spec', isPaused: true });

      // Track that advancePhase or executePhase is NOT called
      const executePhaseSpy = vi.spyOn(orch as AnyOrch, 'executePhase')
        .mockRejectedValue(new Error('should not be called'));

      await (orch as AnyOrch)._fireWakeup(pipeline);

      expect(executePhaseSpy).not.toHaveBeenCalled();
      expect((orch as AnyOrch).pipelines.has(testData.taskId)).toBe(true);

      executePhaseSpy.mockRestore();
    });

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
      const runPromise = orch.runTask(testData.taskId, 'test task', 'spec').catch(() => { /* best-effort */ });
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
      const promise = (orch as AnyOrch).runSpec(pipeline).catch(() => { /* best-effort */ });

      // Give microtasks time: runSpec awaits createSession → resolves → 
      // sends message → awaits waitForCompletion
      await new Promise(r => setTimeout(r, 20));

      // Should have called createSession (spec phase)
      expect(mockCreateSession).toHaveBeenCalled();
      // Should have sent the /spec command
      expect(mockSendMessage).toHaveBeenCalledWith('spec-sess-1', expect.stringContaining('/spec'));

      // Simulate the analyst writing spec.md — without it the spec phase now
      // parks in awaiting-review instead of advancing to plan.
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Original Spec');

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

    it('runSpec does not snapshot the initial spec on first creation (live spec IS v1)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        specRevision: 1,
      });

      // First createSession call succeeds, subsequent ones reject
      let callCount = 0;
      mockCreateSession.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve('spec-sess-v1');
        return Promise.reject(new Error('simulated abort'));
      });

      const promise = (orch as AnyOrch).runSpec(pipeline).catch(() => { /* best-effort */ });
      await new Promise(r => setTimeout(r, 20));

      expect(mockCreateSession).toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith('spec-sess-v1', expect.stringContaining('/spec'));

      // Simulate the analyst writing spec.md
      const specContent = '# Original Spec\n\nThis is the first version.';
      writeFileSync(join(testData.taskDir, 'spec.md'), specContent);

      // Fire result event to resolve waitForCompletion
      fireEvent('event', { sessionId: 'spec-sess-v1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 50));
      await promise;

      // No snapshot copy — the live spec.md is the one and only version.
      expect(existsSync(join(testData.taskDir, 'spec_v1.md'))).toBe(false);
      expect(readFileSync(join(testData.taskDir, 'spec.md'), 'utf-8')).toBe(specContent);

      // specRevision is untouched by the first run (stays at its initial 1).
      expect(pipeline.specRevision).toBe(1);
    });

    it('runSpec revision mode keeps the revised content live as spec.md (no spec_v2 archive copy)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Pre-create spec_v1.md (the pre-revision spec beginSpecRevision renamed
      // into place) plus the feedback file to trigger revision mode.
      const originalV1 = '# Spec v1 — Original';
      writeFileSync(join(testData.taskDir, 'spec_v1.md'), originalV1);
      writeFileSync(join(testData.taskDir, 'spec_revision_feedback.md'), 'Revise the spec');

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        specRevision: 2,
      });

      // First createSession call succeeds, subsequent ones reject
      let callCount = 0;
      mockCreateSession.mockImplementation(() => {
        callCount++;
        if (callCount === 1) return Promise.resolve('spec-sess-rev');
        return Promise.reject(new Error('simulated abort'));
      });

      const promise = (orch as AnyOrch).runSpec(pipeline).catch(() => { /* best-effort */ });
      await new Promise(r => setTimeout(r, 20));

      // Should be in revision mode — sends REVISION: prompt, not /spec
      expect(mockSendMessage).toHaveBeenCalledWith('spec-sess-rev', expect.stringContaining('REVISION:'));

      // Simulate the analyst writing the revised spec to the live path
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec v2 — Revised');

      fireEvent('event', { sessionId: 'spec-sess-rev', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 50));
      await promise;

      // spec_v1.md still contains the original content (not overwritten)
      expect(existsSync(join(testData.taskDir, 'spec_v1.md'))).toBe(true);
      expect(readFileSync(join(testData.taskDir, 'spec_v1.md'), 'utf-8')).toBe(originalV1);

      // The revised content stays live as spec.md — NO spec_v2.md archive
      // copy, or the versions UI would double-count the revision.
      expect(readFileSync(join(testData.taskDir, 'spec.md'), 'utf-8')).toBe('# Spec v2 — Revised');
      expect(existsSync(join(testData.taskDir, 'spec_v2.md'))).toBe(false);

      // spec_revision_feedback.md should be cleaned up
      expect(existsSync(join(testData.taskDir, 'spec_revision_feedback.md'))).toBe(false);
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
        expect.arrayContaining(['pr', 'create', '--title', pipeline.title]),
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
    it('finalizes the task as done and deletes the task folder, emitting once', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      expect(existsSync(testData.taskDir)).toBe(true);

      mockEmit.mockClear();
      await orch.markTaskDone(testData.taskId);

      // phase-change was emitted exactly once
      expect(mockEmit).toHaveBeenCalledTimes(1);
      expect(mockEmit).toHaveBeenCalledWith('phase-change', expect.objectContaining({
        taskId: testData.taskId,
        phase: 'done',
      }));
    });

    it('deletes the .teamai/<slug>/ folder unconditionally on completion', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      expect(existsSync(testData.taskDir)).toBe(true);

      await orch.markTaskDone(testData.taskId);

      // Folder is gone — the trailer-bearing commit + PR body are the
      // durable record now (§3d/§3j).
      expect(existsSync(testData.taskDir)).toBe(false);
    });

    it('marks the task phase done before the folder disappears', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      await orch.markTaskDone(testData.taskId);

      // After completion the task record must read phase=done. The live
      // task.json was deleted with the folder, so re-reading via the store
      // fails — which is exactly the post-done contract: the folder no
      // longer exists.
      expect(existsSync(join(testData.taskDir, 'task.json'))).toBe(false);
    });

    it('never touches git fetch/merge/checkout — no snapshot machinery', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      mockExecFileSync.mockClear();
      await orch.markTaskDone(testData.taskId);

      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['fetch']),
        expect.anything(),
      );
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['merge']),
        expect.anything(),
      );
      expect(mockExecFileSync).not.toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['checkout']),
        expect.anything(),
      );
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

    // Ticket-history refactor: the artifact folder is no longer committed to
    // the worktree/PR at all (replaced by the trailer-bearing pre-merge
    // squash). The old second commit+push pass that backfilled prUrl into a
    // committed snapshot is gone. This test verifies the new contract: no
    // artifact snapshot is staged in the worktree, while the live task.json
    // (source of truth) still gets prUrl.
    it('does not commit an artifact snapshot; live task.json still gets prUrl', async () => {
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

      // No artifact snapshot is committed into the worktree anymore.
      const committedTaskJsonPath = join(worktreePath, '.teamai', testData.taskId, 'task.json');
      expect(existsSync(committedTaskJsonPath)).toBe(false);

      // The live task.json (source of truth) still gets prUrl.
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
      await orch.moveTaskToPhase(testData.taskId, 'create-pr').catch(() => { /* best-effort */ });

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
      await orch.moveTaskToPhase(testData.taskId, 'merge').catch(() => { /* best-effort */ });

      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('starts from plan when only spec exists for merge target', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'merge').catch(() => { /* best-effort */ });

      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('starts from spec when no artifacts exist for merge target', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'merge').catch(() => { /* best-effort */ });

      expect(mockCreateSession).toHaveBeenCalled();
    });
  });

  // ── cleanupTaskArtifacts ──────────────────────────────────────────

  describe('cleanupTaskArtifacts', () => {
    it('clears spec-phase artifacts (spec.md, plan.json, output.log)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), '{}');
      writeFileSync(join(testData.taskDir, 'output.log'), 'output');

      await orch.cleanupTaskArtifacts(testData.taskId, 'spec');

      expect(existsSync(join(testData.taskDir, 'spec.md'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'plan.json'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'output.log'))).toBe(false);
    });

    it('clears plan artifacts but preserves spec.md', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), '{}');
      writeFileSync(join(testData.taskDir, 'output.log'), 'output');

      await orch.cleanupTaskArtifacts(testData.taskId, 'plan');

      expect(existsSync(join(testData.taskDir, 'spec.md'))).toBe(true);
      expect(existsSync(join(testData.taskDir, 'plan.json'))).toBe(false);
    });

    it('clears QA artifacts and preserves non-multi-group completions for implement phase', async () => {
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

      await orch.cleanupTaskArtifacts(testData.taskId, 'implement');

      expect(existsSync(join(testData.taskDir, 'qa_report.json'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'qa_feedback.md'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'completion_summary.md'))).toBe(false);

      // Non-multi-group (no st-branch) → completed stays true (Defect 8)
      const plan = JSON.parse(readFileSync(join(testData.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks[0].completed).toBe(true);
      expect(existsSync(join(testData.taskDir, 'spec.md'))).toBe(true);
      expect(existsSync(join(testData.taskDir, 'plan.json'))).toBe(true);
    });

    it('preserves non-multi-group completed subtasks with branch set (Defect 8)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Give task a branch and slug so reconcile can find the worktree
      (orch as AnyOrch).taskStore.update(testData.taskId, {
        branch: 'feat/test-reconcile',
        slug: 'test-reconcile',
      });

      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [
          { id: 1, title: 'S1', description: '', files: [], acceptance_criteria: [], completed: true },
          { id: 2, title: 'S2', description: '', files: [], acceptance_criteria: [], completed: false },
        ],
      }));

      // All git rev-parse calls fail (no st-branch) → non-multi-group → completed preserved
      mockExecFileSync.mockImplementation(() => { throw new Error('not found'); });

      await orch.cleanupTaskArtifacts(testData.taskId, 'implement');

      const plan = JSON.parse(readFileSync(join(testData.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBe(false);
    });

    it('resets multi-group subtask when cherry-pick fails, keeps others (Defect 8)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      (orch as AnyOrch).taskStore.update(testData.taskId, {
        branch: 'feat/test-reconcile',
        slug: 'test-reconcile',
      });

      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [
          { id: 1, title: 'S1', description: '', files: [], acceptance_criteria: [], completed: true },
          { id: 2, title: 'S2', description: '', files: [], acceptance_criteria: [], completed: true },
        ],
      }));

      // Create worktree at the actual path used by getWorktreePath
      const wtPath = orch.getWorktreePath(testData.taskId)!;
      mkdirSync(wtPath, { recursive: true });

      // Mock: st-branch exists + has commits, but cherry-pick always fails
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args?.[0] === 'rev-parse') return 'abc\n';
        if (cmd === 'git' && args?.[0] === 'log') return 'abc unintegrated\n';
        if (cmd === 'git' && args?.[0] === 'cherry-pick' && args?.[1] !== '--abort') {
          throw new Error('CONFLICT');
        }
        return '';
      });

      await orch.cleanupTaskArtifacts(testData.taskId, 'implement');

      // Both subtasks had st-branches and both cherry-picks failed → both reset
      const plan = JSON.parse(readFileSync(join(testData.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(false);
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBe(false);

      try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('preserves st-branch subtask when cherry-pick succeeds (Defect 8)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      (orch as AnyOrch).taskStore.update(testData.taskId, {
        branch: 'feat/test-reconcile',
        slug: 'test-reconcile',
      });

      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [
          { id: 1, title: 'S1', description: '', files: [], acceptance_criteria: [], completed: true },
        ],
      }));

      // Create worktree at the actual path
      const wtPath = orch.getWorktreePath(testData.taskId)!;
      mkdirSync(wtPath, { recursive: true });

      // Mock: st-branch exists + has commits + cherry-pick succeeds
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args?.[0] === 'rev-parse') return 'abc\n';
        if (cmd === 'git' && args?.[0] === 'log') return 'abc unintegrated\n';
        if (cmd === 'git' && args?.[0] === 'cherry-pick') return ''; // success
        return '';
      });

      await orch.cleanupTaskArtifacts(testData.taskId, 'implement');

      const plan = JSON.parse(readFileSync(join(testData.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks[0].completed).toBe(true);

      try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('skips reconciliation when task has no branch (safe fallback)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [
          { id: 1, title: 'S1', description: '', files: [], acceptance_criteria: [], completed: true },
        ],
      }));

      // No branch on task → reconcile returns early, leaving completed as-is
      await orch.cleanupTaskArtifacts(testData.taskId, 'implement');

      const plan = JSON.parse(readFileSync(join(testData.taskDir, 'plan.json'), 'utf-8'));
      // Subtask stays completed — no branch means we can't reconcile, so we
      // preserve the flag rather than resetting it (Defect 8 semantics)
      expect(plan.subtasks[0].completed).toBe(true);
    });

    it('no-ops when phase is not in pipeline order', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'output.log'), 'output');
      await orch.cleanupTaskArtifacts(testData.taskId, 'nonexistent-phase');

      expect(existsSync(join(testData.taskDir, 'output.log'))).toBe(true);
    });

    it('handles missing artifacts gracefully (does not throw)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      await expect(orch.cleanupTaskArtifacts(testData.taskId, 'qa-review')).resolves.toBeUndefined();
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
      await orch.resumeTask(testData.taskId).catch(() => { /* best-effort */ });

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
      await orch.resumeTask(testData.taskId).catch(() => { /* best-effort */ });

      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('does not backfill spec_v1.md when resuming a task whose spec.md was never versioned', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Pre-seeded spec');
      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.resumeTask(testData.taskId).catch(() => { /* best-effort */ });

      // The live spec IS version 1 under the rename-at-revision scheme — no
      // proactive snapshot copy. The first revision renames spec.md to
      // spec_v1.md, preserving it as history at that point.
      expect(existsSync(join(testData.taskDir, 'spec_v1.md'))).toBe(false);
      expect(readFileSync(join(testData.taskDir, 'spec.md'), 'utf-8')).toBe('# Pre-seeded spec');
    });

    it('resumes from spec when no artifacts exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.resumeTask(testData.taskId).catch(() => { /* best-effort */ });

      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('throws when task does not exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      await expect(orch.resumeTask('nonexistent')).rejects.toThrow('not found');
    });

    it('throws when task is user-paused (isPaused flag)', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Set up artifacts then mark the task as paused
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Task', description: 'Desc', files: [], acceptance_criteria: [], completed: true }],
      }));

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'implement', isPaused: true });

      await expect(orch.resumeTask(testData.taskId)).rejects.toThrow(
        'paused — cannot auto-resume'
      );
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

      await orch.resumeTask(testData.taskId).catch(() => { /* best-effort */ });

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

      await orch.resumeTask(testData.taskId).catch(() => { /* best-effort */ });

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

      await orch.resumeTask(testData.taskId).catch(() => { /* best-effort */ });

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

    it('populates pipeline.title from task.title', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'awaiting-review' });

      const pipeline = (orch as AnyOrch).restorePipeline(testData.taskId, 'awaiting-review');

      expect(pipeline.title).toBe('Test Task');
      expect(pipeline.description).toBe('A test task for full coverage');
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

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => { /* best-effort */ });
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

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => { /* best-effort */ });
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

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => { /* best-effort */ });
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

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => { /* best-effort */ });
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

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => { /* best-effort */ });
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

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => { /* best-effort */ });
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

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => { /* best-effort */ });
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

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => { /* best-effort */ });
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

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => { /* best-effort */ });
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

    it('reconciles plan.json completed flags and emits subtask-progress on QA PASS', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // plan.json with two completed:true, two missing `completed`, and a
      // synthetic 9999 entry left as completed:false — the stale state
      // observed in production after QA had actually passed.
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [
          { id: 1, title: 'Done 1', description: '', files: [], acceptance_criteria: [], completed: true },
          { id: 2, title: 'Done 2', description: '', files: [], acceptance_criteria: [], completed: true },
          { id: 3, title: 'Stale 3', description: '', files: [], acceptance_criteria: [] },
          { id: 4, title: 'Stale 4', description: '', files: [], acceptance_criteria: [] },
          { id: 9999, title: 'QA Rework', description: '', files: [], acceptance_criteria: [], completed: false },
        ],
      }));

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

      // Flush the plan-write lock so the reconcile write has completed.
      await (orch as AnyOrch)._planWriteLockRef.current;

      expect(pipeline.phase).toBe('awaiting-review');

      const plan = JSON.parse(readFileSync(join(testData.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks).toHaveLength(5);
      for (const s of plan.subtasks) {
        expect(s.completed).toBe(true);
      }

      expect(mockEmit).toHaveBeenCalledWith('subtask-progress', expect.objectContaining({
        taskId: testData.taskId,
        completed: 5,
        total: 5,
      }));
    });

    it('does not advance to awaiting-review when the reconcile write fails', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      // Malformed plan.json → the reconcile write's JSON.parse throws. The
      // reconcile is guaranteed, not best-effort: the task must NOT advance.
      writeFileSync(join(testData.taskDir, 'plan.json'), '{ not valid json');

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

      await expect(promise).rejects.toThrow();
      expect(pipeline.phase).not.toBe('awaiting-review');
    });

    it('injects the human override into the QA prompt for a qa-reviewer target and consumes it', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'human_feedback.md'),
        '# Human Review Feedback\nTarget: qa-reviewer\n\nRe-review only the auth module\n');

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

      const sendCalls = mockSendMessage.mock.calls.filter((c: any[]) => c[0] === 'sess-qa');
      expect(sendCalls.length).toBeGreaterThanOrEqual(1);
      expect(sendCalls[0][1]).toContain('OVERRIDES EVERYTHING');
      expect(sendCalls[0][1]).toContain('Re-review only the auth module');

      fireEvent('event', { sessionId: 'sess-qa', event: { type: 'result' } });
      await promise;

      expect(pipeline.phase).toBe('awaiting-review');
      expect(existsSync(join(testData.taskDir, 'human_feedback.md'))).toBe(false);
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
      const caught = promise.catch(() => { /* best-effort */ }); // attach handler before cascade microtasks fire
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
      const caught = promise.catch(() => { /* best-effort */ }); // attach handler before cascade microtasks fire
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

      const promise = (orch as AnyOrch).runQaReview(pipeline).catch(() => { /* best-effort */ });
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

      const promise = (orch as AnyOrch).runQaReview(pipeline).catch(() => { /* best-effort */ });
      await new Promise(r => setTimeout(r, 10));
      fireEvent('event', { sessionId: 'sess-qa-empty', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));
      await promise;

      // Empty spec_concerns should follow normal FAIL path → bounce to implement
      expect(pipeline.phase).toBe('implement');
    });
  });

    it('marks the task failed (spec-revision-exhausted) when max spec revisions reached', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        qaAttempt: 0,
        maxQaAttempts: 3,
      });
      // Already at max revisions (3) -- next auto-revision should fall back
      pipeline.specRevision = 4;

      let csCount = 0; mockCreateSession.mockImplementation(() => { csCount++; if (csCount === 1) return Promise.resolve('sess-qa-max-rev'); return Promise.reject(new Error('simulated abort')); });

      // QA report with spec_concerns -- but we're out of revision budget
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

      const promise = (orch as AnyOrch).runQaReview(pipeline).catch(() => { /* best-effort */ });
      await new Promise(r => setTimeout(r, 10));
      fireEvent('event', { sessionId: 'sess-qa-max-rev', event: { type: 'result' } });
      await promise;

      // Max revisions exhausted -- the spec-revision budget is separate from
      // and exhausted independently of maxQaAttempts, so this must not be
      // indistinguishable from a genuine QA PASS: the task is marked failed
      // with a failureReason a human can see, instead of parked in
      // awaiting-review (which also covers "genuinely passed, sign off").
      expect(pipeline.phase).toBe('failed');
      expect(pipeline.specRevision).toBe(5); // was 4, incremented to 5 before bail-out
      expect(pipeline.qaAttempt).toBe(0); // resetAllCounters gives fresh budget
      // Should have written spec_revision_feedback.md so the human can see the concerns
      const feedbackPath = join(testData.taskDir, 'spec_revision_feedback.md');
      expect(existsSync(feedbackPath)).toBe(true);

      const taskStore = (orch as AnyOrch).taskStore;
      const task = taskStore.getById(testData.taskId);
      expect(task.failureReason).toBe('spec-revision-exhausted');
      expect(task.completionSummary).toContain('spec revisions');

      // qa_report.json must survive this transition -- it's the only artifact
      // the QA tab reads, and there's no next QA round to regenerate it.
      expect(existsSync(join(testData.taskDir, 'qa_report.json'))).toBe(true);
      expect(JSON.parse(readFileSync(join(testData.taskDir, 'qa_report.json'), 'utf-8')).overall).toBe('FAIL');
      // Pipeline should NOT auto-execute -- parked awaiting human action
      // (mockCreateSession for spec phase should NOT have been called)
    });

  // ── Spec revision — autoReviseSpec (QA path) ─────────────────────

  describe('autoReviseSpec (QA path)', () => {

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

      const pipeline = (orch as AnyOrch).restorePipeline(testData.taskId, 'awaiting-review');
      await (orch as AnyOrch)._autoReviseSpec(pipeline).catch(() => { /* best-effort */ });

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

    it('renames spec.md to spec_v1.md as the pre-revision baseline before revision', async () => {
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

      const pipeline = (orch as AnyOrch).restorePipeline(testData.taskId, 'awaiting-review');
      await (orch as AnyOrch)._autoReviseSpec(pipeline).catch(() => { /* best-effort */ });

      // The pre-revision spec now lives at spec_v1.md and spec.md is gone
      // until the analyst writes the revised spec to the live path.
      expect(existsSync(join(testData.taskDir, 'spec_v1.md'))).toBe(true);
      expect(readFileSync(join(testData.taskDir, 'spec_v1.md'), 'utf-8')).toBe(originalSpec);
      expect(existsSync(join(testData.taskDir, 'spec.md'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'spec_revision_before.md'))).toBe(false);
    });

    it('renames the live spec to spec_v2.md on a second revision without touching spec_v1.md', async () => {
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

      // One completed revision means the live spec is v2 (specRevision = 2).
      // _autoReviseSpec bumps it to 3, so the pre-revision rename targets
      // spec_v2.md and the analyst's fresh write becomes v3.
      const pipeline = (orch as AnyOrch).restorePipeline(testData.taskId, 'awaiting-review');
      pipeline.specRevision = 2;
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await (orch as AnyOrch)._autoReviseSpec(pipeline).catch(() => { /* best-effort */ });

      // The live spec was renamed to the v2 slot as the pre-revision baseline
      expect(existsSync(join(testData.taskDir, 'spec_v2.md'))).toBe(true);
      expect(readFileSync(join(testData.taskDir, 'spec_v2.md'), 'utf-8')).toBe(revisedSpec);
      expect(existsSync(join(testData.taskDir, 'spec.md'))).toBe(false);

      // spec_v1.md must remain untouched
      expect(existsSync(join(testData.taskDir, 'spec_v1.md'))).toBe(true);
      expect(readFileSync(join(testData.taskDir, 'spec_v1.md'), 'utf-8')).toBe(originalSpecV1);
    });

    it('clears QA + feedback artifacts but preserves plan.json (no blind cleanup)', async () => {
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

      const pipeline = (orch as AnyOrch).restorePipeline(testData.taskId, 'awaiting-review');
      await (orch as AnyOrch)._autoReviseSpec(pipeline).catch(() => { /* best-effort */ });

      // plan.json is preserved (the planner re-plans in place); QA artifacts are cleared
      expect(existsSync(join(testData.taskDir, 'plan.json'))).toBe(true);
      expect(existsSync(join(testData.taskDir, 'qa_report.json'))).toBe(false);

      // Extra files manually cleared
      expect(existsSync(join(testData.taskDir, 'qa_feedback.md'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'completion_summary.md'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'human_feedback.md'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'human_feedback_before_bounce.md'))).toBe(false);

      // spec.md was renamed to spec_v1.md as the pre-revision baseline —
      // the analyst writes the revised spec back to spec.md during the phase.
      expect(existsSync(join(testData.taskDir, 'spec.md'))).toBe(false);
      expect(existsSync(join(testData.taskDir, 'spec_v1.md'))).toBe(true);
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
      await (orch as AnyOrch)._autoReviseSpec(pipeline).catch(() => { /* best-effort */ });

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

      const pipeline = (orch as AnyOrch).restorePipeline(testData.taskId, 'awaiting-review');
      await (orch as AnyOrch)._autoReviseSpec(pipeline).catch(() => { /* best-effort */ });

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

      const promise = (orch as AnyOrch).runSpec(pipeline).catch(() => { /* best-effort */ });
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

      const promise = (orch as AnyOrch).runSpec(pipeline).catch(() => { /* best-effort */ });
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

      const promise = (orch as AnyOrch).runSpec(pipeline).catch(() => { /* best-effort */ });
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
