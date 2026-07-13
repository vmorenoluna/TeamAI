/**
 * Tests for Workflow Improvements (sha stamping, cleanup router, QA timeout).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from 'fs';
import { join } from 'path';

import { createFireEvent, makePipeline, AnyOrch, setupTestProject, makeOrch } from '../utils/orchestrator-harness';

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
  execFile: vi.fn(),
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

import { getOrchestrator } from '../../src/lib/orchestrator';
import { readContainerConfig, containerManager, hostToContainerPath, dockerAvailable, _resetDockerAvailableCache, readContainerRemoteUser } from '../../src/lib/container-manager';

const fireEvent = createFireEvent(onHandlers);

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
    if (testData) testData.clean(onHandlers);
  });

  // ── Improvement 1: head_at_review SHA stamping ──────────────────

  describe('Improvement 1: SHA stamping', () => {
    it('stamps head_at_review sha into qa_report.json after QA completes', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

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
      const orch = makeOrch(testData.root, getOrchestrator);

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

    it('routes artifact-cleanup failures and includes fail_type in qa_feedback.md', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{ id: 1, title: 'Benchmark', description: 'Run benchmark', files: ['scripts/benchmark.sh'], acceptance_criteria: ['ac1'], completed: true }],
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
        return '';
      });

      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-qa-${++sessionCounter}`));

      const promise = (orch as AnyOrch).runQaReview(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 20));

      // Write a QA report with fail_type: cleanup — artifact scenario (coder substituted math for benchmark output)
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        fail_type: 'cleanup',
        criteria: [
          { criterion: 'Post-fix benchmark exits with < 20 failures', status: 'FAIL', notes: 'Coder claimed mathematically verified instead of running the benchmark', fix_needed: 'run ./scripts/benchmark.sh and commit output/' },
        ],
      }));

      fireEvent('event', { sessionId: 'sess-qa-1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

      // Read qa_feedback.md now — _writeQaFeedback wrote it synchronously,
      // and runImplement won't delete it until after all coder sessions complete
      const feedbackPath = join(testData.taskDir, 'qa_feedback.md');
      expect(existsSync(feedbackPath)).toBe(true);
      const feedbackContent = readFileSync(feedbackPath, 'utf-8');
      expect(feedbackContent).toContain('**fail_type**: cleanup');
      expect(feedbackContent).toContain('run ./scripts/benchmark.sh and commit output/');

      // Now let the implement cascade complete
      for (let i = 2; i <= sessionCounter; i++) {
        fireEvent('event', { sessionId: `sess-qa-${i}`, event: { type: 'result' } });
        await new Promise(r => setTimeout(r, 10));
      }
      await promise;

      // Verify the cleanup router logged the artifact requirements
      const logFile = join(testData.taskDir, 'output.log');
      expect(existsSync(logFile)).toBe(true);
      const logContent = readFileSync(logFile, 'utf-8');
      expect(logContent).toContain('[QA-ROUTER] fail_type=cleanup');
      expect(logContent).toContain('automated mechanical fix');
      expect(logContent).toContain('run ./scripts/benchmark.sh');

      try { rmSync(pipeline.worktreePath, { recursive: true, force: true }); } catch {}
    });
  });

  // ── Improvement 6: QA timeout ────────────────────────────────────

  describe('Improvement 6: QA session budget cap', () => {
    it('re-throws RateLimitError instead of treating as timeout', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

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

  // ── Verification script subtask ─────────────────────────────────

  describe('Verification script subtask', () => {
    it('includes script-run instruction from plan subtask in coder prompt', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec\n\nAcceptance criteria:\n- Post-fix benchmark exits with < 20 failures');

      // Plan with a dedicated verification script subtask (per plan.md rule: explicit command, output artifact, check)
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{
          id: 1,
          title: 'Run benchmark verification',
          description: 'Run ./scripts/benchmark.sh and commit output/sweep_output/. Verify the summary shows fewer than 20 failures. Command: ./scripts/benchmark.sh. Output artifact: sweep_output/summary.jsonl. Check: section failures shows < 20.',
          files: ['scripts/benchmark.sh'],
          acceptance_criteria: ['Post-fix benchmark exits with < 20 failures'],
          completed: false,
        }],
      }));

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        worktreePath: join(testData.root, '..', 'worktrees', 'test-slug'),
        phase: 'implement',
      });

      mkdirSync(pipeline.worktreePath, { recursive: true });
      // Write a minimal .git file so _isWorktreeHealthy returns true — avoids triggering
      // the worktree-recreation path which calls real rmSync and deletes the directory
      writeFileSync(join(pipeline.worktreePath, '.git'), 'gitdir: /fake/path\n');
      mockExecFileSync.mockImplementation(() => '');

      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-${++sessionCounter}`));

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 50));

      // Verify the coder prompt includes the script-run instruction from the plan subtask
      const coderCalls = mockSendMessage.mock.calls.filter(
        ([sid]: [string, ...any[]]) => sid === 'sess-1'
      );
      expect(coderCalls.length).toBe(1);
      const coderPrompt = coderCalls[0][1] as string;
      expect(coderPrompt).toContain('Run ./scripts/benchmark.sh');
      expect(coderPrompt).toContain('commit output/sweep_output/');
      expect(coderPrompt).toContain('Post-fix benchmark exits with < 20 failures');
      expect(coderPrompt).toContain('Command: ./scripts/benchmark.sh');
      expect(coderPrompt).toContain('section failures shows < 20');

      // Complete the pipeline cascade: implement → qa-review → awaiting-review
      fireEvent('event', { sessionId: 'sess-1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

      // Write a PASS QA report so the QA cascade succeeds cleanly
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'PASS',
        criteria: [{ criterion: 'Test', status: 'PASS', evidence: 'ok' }],
      }));

      if (sessionCounter >= 2) {
        fireEvent('event', { sessionId: 'sess-2', event: { type: 'result' } });
      }
      await new Promise(r => setTimeout(r, 50));
      await promise;

      try { rmSync(pipeline.worktreePath, { recursive: true, force: true }); } catch {}
    });
  });

  // ── Sensor gate ─────────────────────────────────────────────────

  describe('Sensor gate', () => {
    it('bounces to implement with fail_type: cleanup when sensor_report failures exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');

      // Plan with an uncompleted subtask — forces the group loop to execute
      // and the sensor gate to run after session completion (the "all completed"
      // skip guard only fires when effectiveSubtasks.length === 0).
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{
          id: 1,
          title: 'Add feature',
          description: 'Implement the feature',
          files: ['src/feature.ts'],
          acceptance_criteria: ['Feature works'],
          completed: false,
        }],
      }));

      // Create sensor_report file with failures — simulates post_subtask sensor failures
      writeFileSync(join(testData.taskDir, 'sensor_report-st1.json'), JSON.stringify({
        failures: [{
          subtask: 'Add feature',
          sensor: 'Lint',
          error: 'Linting failed: 3 errors',
          fix_needed: 'Fix lint errors: run npx eslint src/',
        }],
        overall: 'FAIL',
      }));

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        worktreePath: join(testData.root, '..', 'worktrees', 'test-slug'),
        phase: 'implement',
      });

      mkdirSync(pipeline.worktreePath, { recursive: true });
      writeFileSync(join(pipeline.worktreePath, '.git'), 'gitdir: /fake/path\\n');
      mockExecFileSync.mockImplementation(() => '');

      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-sg-${++sessionCounter}`));

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 50));

      // Complete the coder session (subtask 1)
      fireEvent('event', { sessionId: 'sess-sg-1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 50));

      // After the session completes and the group loop finishes, the sensor gate
      // should have read sensor_report-st1.json and written qa_feedback.md.
      const feedbackPath = join(testData.taskDir, 'qa_feedback.md');
      expect(existsSync(feedbackPath)).toBe(true);
      const feedback = readFileSync(feedbackPath, 'utf-8');
      expect(feedback).toContain('**fail_type**: cleanup');
      expect(feedback).toContain('Sensor: Add feature');
      expect(feedback).toContain('Lint');
      expect(feedback).toContain('Fix lint errors');

      // Verify [SENSOR-GATE] was logged to output.log
      const logFile = join(testData.taskDir, 'output.log');
      expect(existsSync(logFile)).toBe(true);
      const log = readFileSync(logFile, 'utf-8');
      expect(log).toContain('[SENSOR-GATE]');

      // Verify sensor_report file was cleaned up by the gate
      expect(existsSync(join(testData.taskDir, 'sensor_report-st1.json'))).toBe(false);

      // The gate bounced to implement — complete the implement cascade by firing
      // result events for any additional sessions created in QA rework mode.
      for (let i = 2; i <= sessionCounter; i++) {
        fireEvent('event', { sessionId: `sess-sg-${i}`, event: { type: 'result' } });
        await new Promise(r => setTimeout(r, 10));
      }
      await promise;

      // Verify the gate message is still in the log (not overwritten by the bounce)
      const finalLog = readFileSync(logFile, 'utf-8');
      expect(finalLog).toContain('[SENSOR-GATE]');
      expect(finalLog).toContain('post_subtask sensors failed');

      try { rmSync(pipeline.worktreePath, { recursive: true, force: true }); } catch {}
    });

    it('proceeds to qa-review when no sensor_report files exist', async () => {
      testData = setupTestProject();
      const orch = makeOrch(testData.root, getOrchestrator);

      writeFileSync(join(testData.taskDir, 'spec.md'), '# Spec');
      writeFileSync(join(testData.taskDir, 'plan.json'), JSON.stringify({
        subtasks: [{
          id: 1,
          title: 'Add feature',
          description: 'Implement the feature',
          files: ['src/feature.ts'],
          acceptance_criteria: ['Feature works'],
          completed: false,
        }],
      }));

      // No sensor_report files — gate should proceed normally to qa-review

      const pipeline = makePipeline({
        taskId: testData.taskId,
        specPath: testData.taskDir,
        worktreePath: join(testData.root, '..', 'worktrees', 'test-slug'),
        phase: 'implement',
      });

      mkdirSync(pipeline.worktreePath, { recursive: true });
      writeFileSync(join(pipeline.worktreePath, '.git'), 'gitdir: /fake/path\\n');
      mockExecFileSync.mockImplementation(() => '');

      let sessionCounter = 0;
      mockCreateSession.mockImplementation(() => Promise.resolve(`sess-sg-${++sessionCounter}`));

      const promise = (orch as AnyOrch).runImplement(pipeline).catch(() => {});
      await new Promise(r => setTimeout(r, 50));

      // Complete the coder session
      fireEvent('event', { sessionId: 'sess-sg-1', event: { type: 'result' } });
      await new Promise(r => setTimeout(r, 30));

      // Verify no sensor gate log entry was written (no failures to report)
      const logFile = join(testData.taskDir, 'output.log');
      const log = readFileSync(logFile, 'utf-8');
      expect(log).not.toContain('[SENSOR-GATE]');

      // Verify no qa_feedback.md was created (gate didn't fire)
      expect(existsSync(join(testData.taskDir, 'qa_feedback.md'))).toBe(false);

      // Let the QA cascade complete — write a PASS report and fire session events
      writeFileSync(join(testData.taskDir, 'qa_report.json'), JSON.stringify({
        overall: 'PASS',
        criteria: [{ criterion: 'Test', status: 'PASS', evidence: 'ok' }],
      }));

      if (sessionCounter >= 2) {
        fireEvent('event', { sessionId: 'sess-sg-2', event: { type: 'result' } });
      }
      await new Promise(r => setTimeout(r, 50));
      await promise;

      try { rmSync(pipeline.worktreePath, { recursive: true, force: true }); } catch {}
    });
  });
});
