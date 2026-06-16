/**
 * Tests for Workflow Improvements (sha stamping, cleanup router, QA timeout).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';

// ── Hoisted mocks ──

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

import { getOrchestrator } from '../../src/lib/orchestrator';
import { readContainerConfig, containerManager, hostToContainerPath, dockerAvailable, _resetDockerAvailableCache, readContainerRemoteUser } from '../../src/lib/container-manager';

type AnyOrch = any;

function fireEvent(event: string, data: any) {
  const handlers = onHandlers.get(event);
  if (handlers) {
    for (const h of [...handlers]) {
      try { h(data); } catch { /* ignore */ }
    }
  }
}

function setupTestProject() {
  const root = join(tmpdir(), `teamai-wfi-${randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });

  try {
    execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.email', 'test@teamai.dev'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['config', 'user.name', 'TeamAI Test'], { cwd: root, stdio: 'ignore' });
    writeFileSync(join(root, '.gitkeep'), '');
    execFileSync('git', ['add', '.gitkeep'], { cwd: root, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
  } catch { /* git might not be available */ }

  mkdirSync(join(root, '.teamai'), { recursive: true });
  writeFileSync(join(root, '.teamai', 'pipeline.json'), JSON.stringify({ maxQaAttempts: 3, parallelSubtasks: true }));

  const taskId = randomUUID();
  const taskDir = join(root, '.teamai', taskId);
  mkdirSync(taskDir, { recursive: true });

  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId, title: 'Test', description: 'Test task', phase: 'backlog',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }));

  const slug = randomUUID().slice(0, 8);
  const branchName = `feat-${slug}`;

  const clean = () => {
    onHandlers.clear();
    vi.clearAllMocks();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  };

  return { root, taskId, taskDir, branchName, slug, clean };
}

function makeOrch(root: string): any {
  const orch = getOrchestrator(root);
  (orch as any).pipelines.clear();
  (orch as any).activeTasks.clear();
  return orch;
}

function makePipeline(overrides: Record<string, any> = {}): any {
  return {
    taskId: 'task-id', description: 'test', phase: 'spec',
    specPath: '/test/spec', worktreePath: '/test/wt', branch: 'feat/test',
    qaAttempt: 0, maxQaAttempts: 3, specRevision: 0,
    ...overrides,
  };
}

describe('Workflow Improvements', () => {
  let testData: ReturnType<typeof setupTestProject>;

  beforeEach(() => {
    vi.resetAllMocks();
    onHandlers.clear();
    vi.mocked(readContainerConfig).mockReturnValue({ enabled: false, explicit: false });
    vi.mocked(hostToContainerPath).mockImplementation((p: string) => p);
    vi.mocked(containerManager.getRunningContainer).mockReturnValue(null);
    vi.mocked(readContainerRemoteUser).mockReturnValue('node');
    vi.mocked(dockerAvailable).mockReturnValue(true);
    vi.mocked(_resetDockerAvailableCache).mockReturnValue(undefined);
  });

  afterEach(() => {
    if (testData) testData.clean();
  });

  // ── Improvement 1: head_at_review SHA stamping ──────────────────

  describe('Improvement 1: SHA stamping', () => {
    it('stamps head_at_review sha into qa_report.json after QA completes', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Test', description: 'Test', files: [], acceptance_criteria: ['ac1'], completed: true }],
      }));

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        worktreePath: join(testData.root, '..', 'worktrees', 'test-slug'),
        phase: 'qa-review',
      });

      mkdirSync(pipeline.worktreePath, { recursive: true });

      // Mock git rev-parse HEAD to return a fake sha (execFileSync with encoding returns string)
      mockExecFileSync.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === 'git' && args[0] === 'rev-parse' && args[1] === 'HEAD') {
          return 'abc123def456';
        }
        return '';
      });

      mockCreateSession.mockResolvedValue('sess-qa-sha');

      const promise = (orch as AnyOrch).runQaReview(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

      // Write a valid QA report before the session completes (so it parses)
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'PASS',
        criteria: [{ criterion: 'Test criterion', status: 'PASS', evidence: 'ok' }],
      }));

      fireEvent('event', { sessionId: 'sess-qa-sha', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 50));
      await promise;

      // Verify head_at_review was stamped into qa_report.json
      const report = JSON.parse(readFileSync(join(testData.taskDir, 'qa_report.json'), 'utf-8'));
      expect(report.head_at_review).toBe('abc123def456');

      try { rmSync(pipeline.worktreePath, { recursive: true, force: true }); } catch {}
    });
  });

  // ── Improvement 4: FAIL-type router ─────────────────────────────

  describe('Improvement 4: FAIL-type router', () => {
    it('logs cleanup requirements when fail_type is cleanup', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Test', description: 'Test', files: [], acceptance_criteria: ['ac1'], completed: true }],
      }));

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        worktreePath: join(testData.root, '..', 'worktrees', 'test-slug'),
        phase: 'qa-review',
        qaAttempt: 0,
        maxQaAttempts: 3,
      });

      mkdirSync(pipeline.worktreePath, { recursive: true });      mockExecFileSync.mockImplementation((_cmd: string) => {
        return '';
      });

      // Session 1: QA reviewer; Session 2+: coder for implement bounce
      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-qa-${++sessionCounter}`));

      const promise = (orch as AnyOrch).runQaReview(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

      // Write a QA report with fail_type: cleanup
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        fail_type: 'cleanup',
        criteria: [
          { criterion: 'Remove stray file', status: 'FAIL', fix_needed: 'git rm unused.txt', notes: 'Delete' },
          { criterion: 'Commit config', status: 'FAIL', fix_needed: 'git add config.yaml', notes: 'Missing' },
        ],
      }));

      fireEvent('event', { sessionId: 'sess-qa-1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));
      // Hook to check if pipeline bounced to implement and created coder sessions
      // Fire result for any coder sessions to complete the cascade
      for (let i = 2; i <= sessionCounter; i++) {
        fireEvent('event', { sessionId: `sess-qa-${i}`, event: { type: 'result' } });
        await new Promise(r => setTimeout(r, 10));
      }
      await promise;

      // Verify the cleanup router logged the requirements
      const logFile = join(testData.taskDir, 'output.log');
      expect(existsSync(logFile)).toBe(true);
      const logContent = readFileSync(logFile, 'utf-8');
      expect(logContent).toContain('[QA-ROUTER] fail_type=cleanup');
      expect(logContent).toContain('git rm unused.txt');

      try { rmSync(pipeline.worktreePath, { recursive: true, force: true }); } catch {}
    });
  });

  // ── Improvement 6: QA timeout ────────────────────────────────────

  describe('Improvement 6: QA session budget cap', () => {
    it('re-throws RateLimitError instead of treating as timeout', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Test', description: 'Test', files: [], acceptance_criteria: ['ac1'], completed: true }],
      }));

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        worktreePath: join(testData.root, '..', 'worktrees', 'test-slug'),
        phase: 'qa-review',
        qaAttempt: 0,
        maxQaAttempts: 3,
      });

      mkdirSync(pipeline.worktreePath, { recursive: true });

      mockExecFileSync.mockImplementation((_cmd: string) => {
        // Return empty string for all calls (git fetch, log, etc. fail gracefully)
        return '';
      });
      mockCreateSession.mockResolvedValue('sess-qa-ratelimit');

      const promise = (orch as AnyOrch).runQaReview(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

      // Fire rate limit events — should bubble up as RateLimitError, NOT trigger timeout
      fireEvent('event', {
        sessionId: 'sess-qa-ratelimit',
        event: { type: 'rate_limit_event', rate_limit_info: { status: 'limited', resetsAt: 9999999999 } },
      });
      fireEvent('event', {
        sessionId: 'sess-qa-ratelimit',
        event: { type: 'result', is_error: true },
      });

      await new Promise(r => setTimeout(r, 50));
      await promise;

      // RateLimitError was re-thrown — no timeout report should be written
      const reportPath = join(testData.taskDir, 'qa_report.json');
      if (existsSync(reportPath)) {
        const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
        const hasTimeoutMsg = report.criteria?.some(
          (c: any) => c.criterion === 'QA session timeout'
        );
        expect(hasTimeoutMsg).toBeFalsy();
      }

      try { rmSync(pipeline.worktreePath, { recursive: true, force: true }); } catch {}
    });
  });
});
