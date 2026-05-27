/**
 * Full coverage tests for Orchestrator.
 *
 * Covers remaining uncovered lines:
 *   - getPipelineConfig (valid, missing, invalid)
 *   - moveTaskToPhase branching (hasSpec/hasPlan combinations)
 *   - runTask full pipeline with session events
 *   - waitForCompletion (event, exit, rate limit paths)
 *   - handleRateLimit
 *   - _execGit (host and container modes)
 *   - _toAgentPath (with container enabled)
 *   - sessionOpts (with various options)
 *   - _phaseHeader (failure case)
 *   - approveTask, rejectTask (path building)
 *   - advancePhase all phase transitions
 *   - cancelPipeline, isTaskActive edge cases
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';

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
  execFileSync: mockExecFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  warn: mockWarn,
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
import { processManager } from '../../src/lib/process-manager';
import { readContainerConfig, containerManager, hostToContainerPath, dockerAvailable, _resetDockerAvailableCache, readContainerRemoteUser } from '../../src/lib/container-manager';

type AnyOrch = any;

/** Fire an event to all registered handlers for the given event type */
function fireEvent(event: string, data: any) {
  const handlers = onHandlers.get(event);
  if (handlers) {
    for (const h of [...handlers]) {
      try { h(data); } catch { /* ignore */ }
    }
  }
}

// ── Helpers ──

function setupTestProject(options?: { initGit?: boolean; containerEnabled?: boolean }): { root: string; taskId: string; taskDir: string; clean: () => void } {
  const root = join(tmpdir(), `teamai-ocrh-${randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });

  // Init git repo (needed for worktree operations)
  if (options?.initGit !== false) {
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@teamai.dev'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'TeamAI Test'], { cwd: root, stdio: 'ignore' });
      writeFileSync(join(root, '.gitkeep'), '');
      execFileSync('git', ['add', '.gitkeep'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
    } catch { /* git might not be available in test env */ }
  }

  mkdirSync(join(root, '.teamai'), { recursive: true });

  if (options?.containerEnabled) {
    writeFileSync(join(root, '.teamai', 'container.json'), JSON.stringify({ enabled: true }));
  }

  const taskId = randomUUID();
  const taskDir = join(root, '.teamai', taskId);
  mkdirSync(taskDir, { recursive: true });

  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    title: 'Test Task',
    description: 'A test task for full coverage',
    phase: 'backlog',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  const clean = () => {
    onHandlers.clear();
    vi.clearAllMocks();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  };

  return { root, taskId, taskDir, clean };
}

/** Returns a fresh orchestrator for the given project root. */
function makeOrch(root: string): Orchestrator {
  const orch = getOrchestrator(root);
  (orch as AnyOrch).pipelines.clear();
  (orch as AnyOrch).activeTasks.clear();
  return orch;
}

/** Make a minimal pipeline object for testing. */
function makePipeline(overrides: Record<string, any> = {}): any {
  return {
    taskId: 'task-id',
    description: 'test',
    phase: 'spec',
    specPath: '/test/spec',
    worktreePath: '/test/wt',
    branch: 'feat/test',
    qaAttempt: 0,
    maxQaAttempts: 3,
    ...overrides,
  };
}

// ── Tests ──

describe('Orchestrator — Full Coverage', () => {
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
    if (testData) testData.clean();
    vi.resetModules();
  });

  // ── getPipelineConfig ──────────────────────────────────────────────

  describe('getPipelineConfig', () => {
    it('returns default config when pipeline.json does not exist', () => {
      testData = setupTestProject();
      rmSync(join(testData.root, '.teamai', 'pipeline.json'), { force: true });

      const orch = makeOrch(testData.root);
      const config = (orch as AnyOrch).getPipelineConfig();

      expect(config.phases).toEqual(['spec', 'plan', 'implement', 'qa-review', 'merge']);
      expect(config.maxQaAttempts).toBe(3);
      expect(config.parallelSubtasks).toBe(true);
    });

    it('returns configured values when pipeline.json exists', () => {
      testData = setupTestProject();
      writeFileSync(join(testData.root, '.teamai', 'pipeline.json'), JSON.stringify({
        phases: ['spec', 'implement', 'merge'],
        maxQaAttempts: 5,
        parallelSubtasks: false,
      }));

      const orch = makeOrch(testData.root);
      const config = (orch as AnyOrch).getPipelineConfig();

      expect(config.phases).toEqual(['spec', 'implement', 'merge']);
      expect(config.maxQaAttempts).toBe(5);
      expect(config.parallelSubtasks).toBe(false);
    });

    it('returns default config when pipeline.json has invalid JSON', () => {
      testData = setupTestProject();
      writeFileSync(join(testData.root, '.teamai', 'pipeline.json'), '{invalid}');

      const orch = makeOrch(testData.root);
      const config = (orch as AnyOrch).getPipelineConfig();

      expect(config.phases).toEqual(['spec', 'plan', 'implement', 'qa-review', 'merge']);
      expect(config.maxQaAttempts).toBe(3);
      expect(mockWarn).toHaveBeenCalled();
    });
  });

  // ── moveTaskToPhase — no-run phases ────────────────────────────────

  describe('moveTaskToPhase — no-run phases', () => {
    it('moves to backlog without spawning', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      await orch.moveTaskToPhase(testData.taskId, 'backlog');

      expect(mockEmit).toHaveBeenCalledWith('phase-change', {
        taskId: testData.taskId,
        phase: 'backlog',
      });
    });

    it('moves to done without spawning', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      await orch.moveTaskToPhase(testData.taskId, 'done');

      expect(mockEmit).toHaveBeenCalledWith('phase-change', {
        taskId: testData.taskId,
        phase: 'done',
      });
    });

    it('throws for nonexistent task', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      await expect(orch.moveTaskToPhase('nonexistent', 'spec')).rejects.toThrow('not found');
    });
  });

  // ── runTask ────────────────────────────────────────────────────────

  describe('runTask', () => {
    it('rejects when task is already active', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      (orch as AnyOrch).activeTasks.add(testData.taskId);

      await expect(orch.runTask(testData.taskId, 'test')).rejects.toThrow(/already running/i);
    });
  });

  // ── waitForCompletion (tested via private access) ─────────────────

  describe('waitForCompletion', () => {
    let orch: Orchestrator;

    beforeEach(() => {
      testData = setupTestProject();
      orch = makeOrch(testData.root);
    });

    it('resolves on result event', async () => {
      const promise = (orch as AnyOrch).waitForCompletion('sess-1');

      fireEvent('event', { sessionId: 'sess-1', event: { type: 'result' } });

      await expect(promise).resolves.toBeUndefined();
    });

    it('resolves on exit with code 0', async () => {
      const promise = (orch as AnyOrch).waitForCompletion('sess-2');

      fireEvent('exit', { sessionId: 'sess-2', code: 0 });

      await expect(promise).resolves.toBeUndefined();
    });

    it('rejects on exit with non-zero code', async () => {
      const promise = (orch as AnyOrch).waitForCompletion('sess-3');

      fireEvent('exit', { sessionId: 'sess-3', code: 1 });

      await expect(promise).rejects.toThrow('Session exited with code 1');
    });

    it('rejects with RateLimitError on rate limit event + result error', async () => {
      const now = Math.floor(Date.now() / 1000);
      const promise = (orch as AnyOrch).waitForCompletion('sess-4');

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
      const promise = (orch as AnyOrch).waitForCompletion('sess-5');

      // Fire event for different session — should not resolve
      fireEvent('event', { sessionId: 'other-sess', event: { type: 'result' } });

      // Fire for correct session
      fireEvent('event', { sessionId: 'sess-5', event: { type: 'result' } });

      await expect(promise).resolves.toBeUndefined();
    });

    it('rejects with timeout error when no event arrives within timeout', async () => {
      const promise = (orch as AnyOrch).waitForCompletion('sess-timeout', 10);

      // Don't fire any events — the 10ms timeout should fire
      await expect(promise).rejects.toThrow('Pipeline timed out');
    });

    it('cleans up listeners on timeout', async () => {
      // Spy on processManager.off to verify cleanup
      const offSpy = vi.spyOn(processManager, 'off');

      try {
        await (orch as AnyOrch).waitForCompletion('sess-cleanup', 10);
      } catch {
        // expected timeout
      }

      // Should have cleaned up both event listeners
      expect(offSpy).toHaveBeenCalledWith('event', expect.any(Function));
      expect(offSpy).toHaveBeenCalledWith('exit', expect.any(Function));
      offSpy.mockRestore();
    });

    it('does not timeout if already resolved', async () => {
      const promise = (orch as AnyOrch).waitForCompletion('sess-fast', 5_000);

      fireEvent('event', { sessionId: 'sess-fast', event: { type: 'result' } });

      await expect(promise).resolves.toBeUndefined();
    });
  });

  // ── cancelPipeline ────────────────────────────────────────────────

  describe('cancelPipeline', () => {
    it('does nothing when no pipeline exists', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      expect(() => orch.cancelPipeline('nonexistent')).not.toThrow();
    });

    it('calls killSession and cleans up', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
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
      const orch = makeOrch(testData.root);
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
      const orch = makeOrch(testData.root);
      expect(orch.isTaskActive('unknown')).toBe(false);
    });
  });

  // ── approveTask / rejectTask ───────────────────────────────────────

  describe('approveTask', () => {
    it('throws when not awaiting review', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      await expect(orch.approveTask(testData.taskId, 'local-merge')).rejects.toThrow('is not awaiting-review');
    });
  });

  describe('rejectTask', () => {
    it('throws when not awaiting review', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      await expect(orch.rejectTask(testData.taskId, 'bad')).rejects.toThrow('is not awaiting-review');
    });

    it('writes feedback and resets qaAttempt when awaiting review', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
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
      const orch = makeOrch(testData.root);

      const opts = (orch as AnyOrch).sessionOpts('coder', '/cwd', 'task-1', '/log.txt');
      expect(opts.taskId).toBe('task-1');
      expect(opts.role).toBe('coder');
      expect(opts.cwd).toBe('/cwd');
      expect(opts.projectRoot).toBe(testData.root);
      expect(opts.permissionMode).toBe('bypassPermissions');
      expect(opts.logFile).toBe('/log.txt');
    });

    it('omits logFile when not provided', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      const opts = (orch as AnyOrch).sessionOpts('planner', '/cwd', 'task-2');
      expect(opts.logFile).toBeUndefined();
    });
  });

  // ── _extractPrUrl ────────────────────────────────────────────────

  describe('_extractPrUrl', () => {
    it('extracts a GitHub PR URL from the log file', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      const logFile = join(testData.taskDir, 'output.log');

      writeFileSync(logFile, 'Created PR: https://github.com/owner/repo/pull/42\nDone!');

      const result = (orch as AnyOrch)._extractPrUrl(logFile);
      expect(result).toBe('https://github.com/owner/repo/pull/42');
    });

    it('extracts a GitLab MR URL from the log file', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      const logFile = join(testData.taskDir, 'output.log');

      writeFileSync(logFile, 'MR created: https://gitlab.com/group/project/-/merge_requests/99');

      const result = (orch as AnyOrch)._extractPrUrl(logFile);
      expect(result).toBe('https://gitlab.com/group/project/-/merge_requests/99');
    });

    it('extracts a Bitbucket PR URL from the log file', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      const logFile = join(testData.taskDir, 'output.log');

      writeFileSync(logFile, 'https://bitbucket.org/team/repo/pull-requests/7 created');

      const result = (orch as AnyOrch)._extractPrUrl(logFile);
      expect(result).toBe('https://bitbucket.org/team/repo/pull-requests/7');
    });

    it('returns null when no PR URL is found', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      const logFile = join(testData.taskDir, 'output.log');

      writeFileSync(logFile, 'Task completed successfully. No URLs here.');

      const result = (orch as AnyOrch)._extractPrUrl(logFile);
      expect(result).toBeNull();
    });

    it('returns null when the log file does not exist', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      const logFile = join(testData.taskDir, 'nonexistent.log');

      const result = (orch as AnyOrch)._extractPrUrl(logFile);
      expect(result).toBeNull();
    });

    it('returns the first match when multiple PR URLs exist', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      const logFile = join(testData.taskDir, 'output.log');

      writeFileSync(logFile, 'First: https://github.com/owner/repo/pull/1\nSecond: https://github.com/other/repo/pull/2');

      const result = (orch as AnyOrch)._extractPrUrl(logFile);
      expect(result).toBe('https://github.com/owner/repo/pull/1');
    });

    it('handles http URLs (not just https)', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      const logFile = join(testData.taskDir, 'output.log');

      writeFileSync(logFile, 'http://github.com/owner/repo/pull/99');

      const result = (orch as AnyOrch)._extractPrUrl(logFile);
      expect(result).toBe('http://github.com/owner/repo/pull/99');
    });

    it('returns null for an empty log file', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      const logFile = join(testData.taskDir, 'output.log');

      writeFileSync(logFile, '');

      const result = (orch as AnyOrch)._extractPrUrl(logFile);
      expect(result).toBeNull();
    });
  });

  // ── _phaseHeader ──────────────────────────────────────────────────

  describe('_phaseHeader', () => {
    it('handles write failure gracefully', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      expect(() =>
        (orch as AnyOrch)._phaseHeader('/nonexistent/deep/path/output.log', 'spec'),
      ).not.toThrow();
    });

    it('writes to valid log path', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      const logFile = join(testData.taskDir, 'output.log');

      expect(() => (orch as AnyOrch)._phaseHeader(logFile, 'plan')).not.toThrow();

      const content = readFileSync(logFile, 'utf-8');
      expect(content).toContain('▶ PLAN');
    });
  });

  // ── advancePhase ──────────────────────────────────────────────────

  describe('advancePhase', () => {
    it('updates phase and emits phase-change', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      const pipeline = makePipeline({ taskId: testData.taskId });

      (orch as AnyOrch).advancePhase(pipeline, 'plan');

      expect(pipeline.phase).toBe('plan');
      expect(mockEmit).toHaveBeenCalledWith('phase-change', {
        taskId: testData.taskId,
        phase: 'plan',
      });
    });

    it('emits for all phase transitions', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
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

  // ── _execGit ───────────────────────────────────────────────────────

  describe('_execGit', () => {
    it('calls git on host when container is disabled', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

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
      vi.mocked(hostToContainerPath).mockImplementation((hp: string, _root: string, _ws: string) => { // eslint-disable-line @typescript-eslint/no-unused-vars
        return '/workspace' + (hp === testData.root ? '' : '/cwd');
      });

      const orch = makeOrch(testData.root);

      mockExecFileSync.mockReturnValue('');
      (orch as AnyOrch)._execGit(['status'], testData.root);

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
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

      const orch = makeOrch(testData.root);

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
        'docker',
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

      const orch = makeOrch(testData.root);

      mockExecFileSync.mockReturnValue('');
      // Path outside project root — should NOT be mapped
      (orch as AnyOrch)._execGit(['add', '/tmp/external-file'], testData.root);

      // hostToContainerPath should not have been called with this path
      // The path won't startWith projectRoot, so it passes through as-is
      expect(mockExecFileSync).toHaveBeenCalledWith(
        'docker',
        expect.arrayContaining(['git', 'add', '/tmp/external-file']),
      );
    });

    it('falls back to host git when container is enabled but not running', () => {
      testData = setupTestProject();
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      // No running container
      vi.mocked(containerManager.getRunningContainer).mockReturnValue(null);

      const orch = makeOrch(testData.root);

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
      const orch = makeOrch(testData.root);

      expect((orch as AnyOrch)._toAgentPath('/some/path')).toBe('/some/path');
    });

    it('translates path via hostToContainerPath when container enabled and running', () => {
      testData = setupTestProject();
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(containerManager.getRunningContainer).mockReturnValue({
        containerId: 'abc',
        remoteWorkspaceFolder: '/workspace',
      } as any);
      vi.mocked(hostToContainerPath).mockReturnValue('/workspace/path');

      const orch = makeOrch(testData.root);
      const result = (orch as AnyOrch)._toAgentPath('/some/path');

      expect(hostToContainerPath).toHaveBeenCalled();
      expect(result).toBe('/workspace/path');
    });
  });

  // ── getWorktreeBase ────────────────────────────────────────────────

  describe('getWorktreeBase', () => {
    it('returns ../worktrees when container disabled', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      const base = (orch as AnyOrch).getWorktreeBase();
      expect(base).toContain('worktrees');
      expect(base).not.toContain('.worktrees');
    });

    it('returns .worktrees when container is enabled', () => {
      testData = setupTestProject();
      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      const orch = makeOrch(testData.root);

      const base = (orch as AnyOrch).getWorktreeBase();
      expect(base).toContain('.worktrees');
    });
  });

  // ── getWorktreePath ────────────────────────────────────────────────

  describe('getWorktreePath', () => {
    it('returns null when task has no branch', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      // Task has no branch field
      expect(orch.getWorktreePath(testData.taskId)).toBeNull();
    });

    it('returns the worktree path when task has a branch', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      // Set a branch on the task
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { branch: 'feat/test-task' });

      const result = orch.getWorktreePath(testData.taskId);
      expect(result).not.toBeNull();
      expect(result).toContain('worktrees');
      expect(result).toContain('test-task');
    });
  });

  // ── removeWorktree ────────────────────────────────────────────────

  describe('removeWorktree (private, via public getWorktreePath)', () => {
    it('does not throw when worktree path does not exist on disk', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      // No branch → getWorktreePath returns null → removeWorktree returns early
      expect(() => (orch as AnyOrch).removeWorktree(testData.taskId)).not.toThrow();
    });

    // Coverage: lines 568-573 — _execGit throws, catch block handles gracefully
    it('handles _execGit failure gracefully in catch block', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      // Give the task a branch so getWorktreePath returns a path
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { branch: 'feat/test-branch' });

      // Create the worktree directory on disk so existsSync returns true
      // and removeWorktree proceeds past the early-return guard at line 567
      const wtPath = (orch as AnyOrch).getWorktreePath(testData.taskId);
      if (wtPath) mkdirSync(wtPath, { recursive: true });

      // Make _execGit throw (via underlying execFileSync mock)
      mockExecFileSync.mockImplementation(() => {
        throw new Error('git worktree remove failed');
      });

      // Should not throw — the catch block at 571-573 handles it silently
      expect(() => (orch as AnyOrch).removeWorktree(testData.taskId)).not.toThrow();

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

        const orch = makeOrch(testData.root);
        const taskStore = (orch as AnyOrch).taskStore;
        taskStore.update(testData.taskId, { description: 'test-task', branch: 'feat/test-task' });

        // In container mode, getWorktreeBase returns .worktrees inside projectRoot
        const wtPath = orch.getWorktreePath(testData.taskId)!;
        mkdirSync(wtPath, { recursive: true });

        mockExecFileSync.mockReturnValue('');
        (orch as AnyOrch).removeWorktree(testData.taskId);

        // Tier 1: normal remove via docker exec
        expect(mockExecFileSync).toHaveBeenCalledWith(
          'docker',
          expect.arrayContaining(['exec', '-u', 'node', 'cont-abc', 'git', 'worktree', 'remove']),
        );
        // Branch cleanup runs on host (not through _execGit)
        expect(mockExecFileSync).toHaveBeenCalledWith(
          'git',
          expect.arrayContaining(['branch', '-D', 'feat/test-task']),
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

        const orch = makeOrch(testData.root);
        const taskStore = (orch as AnyOrch).taskStore;
        taskStore.update(testData.taskId, { description: 'test-task', branch: 'feat/test-task' });

        const wtPath = orch.getWorktreePath(testData.taskId)!;
        mkdirSync(wtPath, { recursive: true });

        // Normal remove (docker exec) throws — simulate uncommitted changes
        mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
          if (cmd === 'docker' && args.includes('remove') && !args.includes('--force')) {
            throw new Error('worktree has uncommitted changes');
          }
          return '';
        });

        (orch as AnyOrch).removeWorktree(testData.taskId);

        // Both tiers were attempted via docker exec
        expect(mockExecFileSync).toHaveBeenCalledWith(
          'docker',
          expect.arrayContaining(['exec', '-u', 'node', 'cont-abc', 'git', 'worktree', 'remove']),
        );
        expect(mockExecFileSync).toHaveBeenCalledWith(
          'docker',
          expect.arrayContaining(['exec', '-u', 'node', 'cont-abc', 'git', 'worktree', 'remove', '--force']),
        );
        // Branch cleanup still runs on host
        expect(mockExecFileSync).toHaveBeenCalledWith(
          'git',
          expect.arrayContaining(['branch', '-D', 'feat/test-task']),
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

        const orch = makeOrch(testData.root);
        const taskStore = (orch as AnyOrch).taskStore;
        taskStore.update(testData.taskId, { description: 'test-task', branch: 'feat/test-task' });

        const wtPath = orch.getWorktreePath(testData.taskId)!;
        mkdirSync(wtPath, { recursive: true });
        // Create a file inside the worktree to verify rmSync truly removes content
        writeFileSync(join(wtPath, 'locked-file.txt'), 'this file should be deleted by rmSync');

        // Both docker exec attempts throw — simulate locked files
        mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
          if (cmd === 'docker' && args.includes('remove')) {
            throw new Error('worktree is locked');
          }
          return '';
        });

        (orch as AnyOrch).removeWorktree(testData.taskId);

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
          expect.arrayContaining(['branch', '-D', 'feat/test-task']),
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
      const orch = makeOrch(testData.root);

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
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({ subtasks: [] }));
      const orch = makeOrch(testData.root);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'implement').catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('starts from spec when neither hasSpec nor hasPlan exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'implement').catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();
    });
  });

  // ── _writeQaFeedback ──────────────────────────────────────────────

  describe('_writeQaFeedback', () => {
    it('writes qa_feedback.md with failed criteria when report has criteria', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
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

      (orch as AnyOrch)._writeQaFeedback(pipeline, report);

      const feedbackPath = join(testData.taskDir, 'qa_feedback.md');
      expect(existsSync(feedbackPath)).toBe(true);
      const content = readFileSync(feedbackPath, 'utf-8');
      expect(content).toContain('## Overall: FAIL');
      expect(content).toContain('**All endpoints documented**');
      expect(content).toContain('Missing DELETE');
      expect(content).not.toContain('Examples included'); // PASS criteria excluded
      expect(content).toContain('[error] DELETE endpoint not documented');
    });

    it('handles report with no criteria or issues gracefully', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      const pipeline = makePipeline({ specPath: testData.taskDir });
      const report = { overall: 'FAIL' };

      (orch as AnyOrch)._writeQaFeedback(pipeline, report);

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
      const orch = makeOrch(testData.root);

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

      (orch as AnyOrch)._writeCompletionSummary(pipeline);

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
      const orch = makeOrch(testData.root);
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        qaAttempt: 1,
      });

      (orch as AnyOrch)._writeCompletionSummary(pipeline);

      const summaryPath = join(testData.taskDir, 'completion_summary.md');
      expect(existsSync(summaryPath)).toBe(true);
      const content = readFileSync(summaryPath, 'utf-8');
      expect(content).toContain('Task failed after 1 QA attempts');
    });

    it('stores completionSummary on the task via taskStore', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        qaAttempt: 3,
      });

      (orch as AnyOrch)._writeCompletionSummary(pipeline);

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
      const orch = makeOrch(testData.root);
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
      const orch = makeOrch(testData.root);
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });

      // Pipeline must be registered so handleRateLimit can re-acquire the lock
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      // Mock createSession to reject with a regular Error (not a RateLimitError)
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
      const orch = makeOrch(testData.root);

      // Use a pipeline with phase='spec' so executePhase → runSpec → createSession → waitForCompletion
      const pipeline = makePipeline({ taskId: testData.taskId, phase: 'spec', specPath: testData.taskDir });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      // Make createSession succeed so executePhase reaches waitForCompletion
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
  });

  // ── Pipeline phase methods ────────────────────────────────────────

  describe('pipeline phase methods', () => {
    // Coverage: runSpec (lines 247-261) — creates session, sends message, waits, advances
    it('runSpec creates session, sends message, and advances to plan on completion', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
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
    it('creates session, sends /merge command, waits, kills, cleans up', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      const slug = 'test-task';
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      mkdirSync(pipeline.worktreePath, { recursive: true });
      // Set branch AND description on the task so getWorktreePath returns the correct path.
      // getWorktreePath derives the path from slugify(task.description), which must match
      // the worktree directory we created above.
      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { description: slug, branch: `feat/${slug}` });
      mockCreateSession.mockResolvedValue('sess-merge');
      mockExecFileSync.mockReturnValue('');

      const promise = (orch as AnyOrch).runMerge(pipeline);
      await new Promise(r => setTimeout(r, 10));

      expect(mockCreateSession).toHaveBeenCalled();
      expect(mockSendMessage).toHaveBeenCalledWith('sess-merge', expect.stringContaining('/merge'));

      fireEvent('event', { sessionId: 'sess-merge', event: { type: 'result' } });
      await promise;

      expect(mockKillSession).toHaveBeenCalledWith('sess-merge');
      // removeWorktree tries normal remove first, then branch -D (force delete)
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
      expect(pipeline.phase).toBe('done');

      // Clean up the created worktree dir
      if (existsSync(pipeline.worktreePath)) {
        rmSync(pipeline.worktreePath, { recursive: true, force: true });
      }
    });
  });

  // ── runCreatePR ───────────────────────────────────────────────────

  describe('runCreatePR', () => {
    it('pushes branch, creates session, sends prompt, extracts PR URL', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature\n\nImplement this feature.');

      const slug = 'test-task';
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      mockCreateSession.mockResolvedValue('sess-pr');
      mockExecFileSync
        .mockReturnValueOnce('')
        .mockReturnValueOnce('https://github.com/owner/repo.git')
        .mockReturnValueOnce('refs/remotes/origin/main');

      const promise = (orch as AnyOrch).runCreatePR(pipeline);
      await new Promise(r => setTimeout(r, 10));

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'git',
        expect.arrayContaining(['push', '-u', 'origin', `feat/${slug}`]),
        expect.any(Object),
      );
      expect(mockSendMessage).toHaveBeenCalledWith('sess-pr', expect.stringContaining('Pull Request'));

      fireEvent('event', { sessionId: 'sess-pr', event: { type: 'result' } });
      await promise;

      expect(mockKillSession).toHaveBeenCalledWith('sess-pr');
      expect(pipeline.phase).toBe('pr-open');
    });

    it('extracts PR URL from log and runs gh pr update-branch', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
      writeFileSync(join(testData.taskDir, 'output.log'), 'Created: https://github.com/owner/repo/pull/42\n');

      const slug = 'test-task';
      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });

      mockCreateSession.mockResolvedValue('sess-pr');
      mockExecFileSync
        .mockReturnValueOnce('')
        .mockReturnValueOnce('https://github.com/owner/repo.git')
        .mockReturnValueOnce('refs/remotes/origin/main');

      const promise = (orch as AnyOrch).runCreatePR(pipeline);
      await new Promise(r => setTimeout(r, 10));
      fireEvent('event', { sessionId: 'sess-pr', event: { type: 'result' } });
      await promise;

      expect(mockExecFileSync).toHaveBeenCalledWith(
        'gh',
        expect.arrayContaining(['pr', 'update-branch']),
        expect.any(Object),
      );
    });

    it('handles gh pr update-branch failure gracefully', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
      writeFileSync(join(testData.taskDir, 'output.log'), 'Created: https://github.com/owner/repo/pull/42\n');

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: 'feat/test-task',
      });

      mockCreateSession.mockResolvedValue('sess-pr');
      let callCount = 0;
      mockExecFileSync.mockImplementation(() => {
        callCount++;
        if (callCount >= 4) throw new Error('gh command not found');
        return '';
      });

      const promise = (orch as AnyOrch).runCreatePR(pipeline);
      await new Promise(r => setTimeout(r, 10));
      fireEvent('event', { sessionId: 'sess-pr', event: { type: 'result' } });
      await promise;

      expect(pipeline.phase).toBe('pr-open');
    });

    it('sets platform to undefined when remote is unknown', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);
      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        branch: 'feat/test-task',
      });

      mockCreateSession.mockResolvedValue('sess-pr');
      mockExecFileSync
        .mockReturnValueOnce('')
        .mockReturnValueOnce('https://unknown.example.com/repo.git')
        .mockReturnValueOnce('refs/remotes/origin/main');

      const promise = (orch as AnyOrch).runCreatePR(pipeline);
      await new Promise(r => setTimeout(r, 10));
      fireEvent('event', { sessionId: 'sess-pr', event: { type: 'result' } });
      await promise;

      const taskStore = (orch as AnyOrch).taskStore;
      const updated = taskStore.getById(testData.taskId);
      expect(updated?.platform).toBeUndefined();
    });
  });

  // ── markTaskDone ──────────────────────────────────────────────────

  describe('markTaskDone', () => {
    it('removes worktree, updates phase to done, emits phase-change', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      await orch.markTaskDone(testData.taskId);

      expect(mockEmit).toHaveBeenCalledWith('phase-change', {
        taskId: testData.taskId,
        phase: 'done',
      });
    });
  });

  // ── approveTask with pull-request strategy ───────────────────────

  describe('approveTask — pull-request strategy', () => {
    it('executes create-pr when strategy is pull-request', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      const slug = 'test-task';
      const pipeline = makePipeline({
        taskId: testData.taskId,
        phase: 'awaiting-review',
        specPath: testData.taskDir,
        branch: `feat/${slug}`,
        worktreePath: join(testData.root, '..', 'worktrees', slug),
      });
      (orch as AnyOrch).pipelines.set(testData.taskId, pipeline);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
      mockCreateSession.mockResolvedValue('sess-pr-approve');
      mockExecFileSync.mockReturnValue('');

      const promise = orch.approveTask(testData.taskId, 'pull-request');
      await new Promise(r => setTimeout(r, 10));

      expect(mockSendMessage).toHaveBeenCalledWith('sess-pr-approve', expect.stringContaining('Pull Request'));

      fireEvent('event', { sessionId: 'sess-pr-approve', event: { type: 'result' } });
      await promise;

      expect(pipeline.phase).toBe('pr-open');
    });

    it('throws rollback to awaiting-review on error', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      const pipeline = makePipeline({
        taskId: testData.taskId,
        phase: 'awaiting-review',
        specPath: testData.taskDir,
        branch: 'feat/test-task',
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
      const orch = makeOrch(testData.root);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({ subtasks: [] }));

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { branch: 'feat/test-task' });

      const slug = 'test-task';
      const worktreePath = join(testData.root, '..', 'worktrees', slug);
      mkdirSync(worktreePath, { recursive: true });

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'create-pr').catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();

      if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
    });

    it('starts from implement when plan exists but worktree missing for merge', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

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
      const orch = makeOrch(testData.root);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Feature');
      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'merge').catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('starts from spec when no artifacts exist for merge target', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.moveTaskToPhase(testData.taskId, 'merge').catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();
    });
  });

  // ── cleanupTaskArtifacts ──────────────────────────────────────────

  describe('cleanupTaskArtifacts', () => {
    it('clears spec-phase artifacts (spec.md, plan.json, output.log)', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

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
      const orch = makeOrch(testData.root);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), '{}');
      writeFileSync(join(testData.taskDir, 'output.log'), 'output');

      orch.cleanupTaskArtifacts(testData.taskId, 'plan');

      expect(existsSync(join(testData.taskDir, 'spec.md'))).toBe(true);
      expect(existsSync(join(testData.taskDir, 'plan.json'))).toBe(false);
    });

    it('clears QA artifacts and resets subtask completions for implement phase', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

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
      const orch = makeOrch(testData.root);

      writeFileSync(join(testData.taskDir, 'output.log'), 'output');
      orch.cleanupTaskArtifacts(testData.taskId, 'nonexistent-phase');

      expect(existsSync(join(testData.taskDir, 'output.log'))).toBe(true);
    });

    it('handles missing artifacts gracefully (does not throw)', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      expect(() => orch.cleanupTaskArtifacts(testData.taskId, 'qa-review')).not.toThrow();
    });
  });

  // ── resumeTask ────────────────────────────────────────────────────

  describe('resumeTask', () => {
    it('resumes from implement when plan.json exists and resets completions', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Task', description: 'Desc', files: [], acceptance_criteria: [], completed: true }],
      }));

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.resumeTask(testData.taskId).catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();

      const plan = JSON.parse(readFileSync(join(testData.taskDir, 'plan.json'), 'utf-8'));
      expect(plan.subtasks[0].completed).toBe(false);
    });

    it('resumes from plan when only spec.md exists', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.resumeTask(testData.taskId).catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('resumes from spec when no artifacts exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      mockCreateSession.mockRejectedValue(new Error('simulated abort'));
      await orch.resumeTask(testData.taskId).catch(() => {});

      expect(mockCreateSession).toHaveBeenCalled();
    });

    it('throws when task does not exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      await expect(orch.resumeTask('nonexistent')).rejects.toThrow('not found');
    });
  });

  // ── restorePipeline ───────────────────────────────────────────────

  describe('restorePipeline', () => {
    it('restores pipeline from task data with correct branch', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

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
      const orch = makeOrch(testData.root);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { phase: 'awaiting-review', branch: undefined });

      const pipeline = (orch as AnyOrch).restorePipeline(testData.taskId, 'awaiting-review');

      expect(pipeline.branch).toBeDefined();
      expect(pipeline.branch).toContain('feat/');
    });

    it('throws when task is not in the required phase', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      expect(() => (orch as AnyOrch).restorePipeline(testData.taskId, 'awaiting-review')).toThrow(
        'is not awaiting-review'
      );
    });
  });

  // ── _removeWorktreeForce ──────────────────────────────────────────

  describe('_removeWorktreeForce', () => {
    it('force-removes the git worktree', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { branch: 'feat/test-task' });

      const wtPath = orch.getWorktreePath(testData.taskId);
      if (wtPath) mkdirSync(wtPath, { recursive: true });

      mockExecFileSync.mockReturnValue('');
      (orch as AnyOrch)._removeWorktreeForce(testData.taskId);

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
      const orch = makeOrch(testData.root);

      expect(() => (orch as AnyOrch)._removeWorktreeForce('nonexistent')).not.toThrow();
    });

    it('handles git failure gracefully', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { branch: 'feat/test-task' });

      const wtPath = orch.getWorktreePath(testData.taskId);
      if (wtPath) mkdirSync(wtPath, { recursive: true });

      mockExecFileSync.mockImplementation(() => { throw new Error('git error'); });
      expect(() => (orch as AnyOrch)._removeWorktreeForce(testData.taskId)).not.toThrow();
    });
  });

  // ── _cleanWorktree ────────────────────────────────────────────────

  describe('_cleanWorktree', () => {
    it('runs git checkout HEAD to discard changes', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { branch: 'feat/test-task' });

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
      const orch = makeOrch(testData.root);

      expect(() => (orch as AnyOrch)._cleanWorktree('nonexistent')).not.toThrow();
    });

    it('handles git failure gracefully', () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      const taskStore = (orch as AnyOrch).taskStore;
      taskStore.update(testData.taskId, { branch: 'feat/test-task' });

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
      const orch = makeOrch(testData.root);

      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: false });
      vi.mocked(dockerAvailable).mockReturnValue(false);

      const slug = 'test-task';
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
      const orch = makeOrch(testData.root);

      vi.mocked(readContainerConfig).mockReturnValue({ enabled: true, explicit: true });
      vi.mocked(dockerAvailable).mockReturnValue(true);
      vi.mocked(containerManager.ensureContainer).mockResolvedValue({
        remoteWorkspaceFolder: '/workspace',
        containerName: 'test-container',
        status: 'running',
      } as any);

      const slug = 'test-task';
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
      const orch = makeOrch(testData.root);

      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Task', description: 'Desc', files: [], acceptance_criteria: [] }],
      }));

      const slug = 'test-task';
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
      const orch = makeOrch(testData.root);

      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Task', description: 'Desc', files: [], acceptance_criteria: [] }],
      }));

      const slug = 'test-task';
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

  // ── runQaReview PASS/Failure paths ────────────────────────────────

  describe('runQaReview', () => {
    it('advances to awaiting-review when QA passes', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

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
      const orch = makeOrch(testData.root);

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

  // ── Clean up global orchestrators after tests ─────────────────────

  afterAll(() => {
    const g = global as any;
    if (g.__orchestrators) {
      g.__orchestrators.clear();
    }
  });
});
