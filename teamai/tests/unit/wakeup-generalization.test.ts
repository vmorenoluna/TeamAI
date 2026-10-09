/**
 * ADR-002 generalization tests: spec/plan/qa-review phases share the same
 * wakeup-file contract implement.ts has always had, via orchestrator/wakeup.ts.
 *
 * Covers the incident that motivated this (task
 * an-earlier-demo-task): an analyst session started a
 * multi-hour deterministic verification job and correctly said it would
 * wait, but the spec phase had no wakeup detection at all — the missing
 * spec.md was parked for human review, discarding a still-running
 * legitimate job.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { randomUUID } from 'crypto';
import { createTestProject } from '../utils/test-project';
import { createFireEvent, AnyOrch } from '../utils/orchestrator-harness';

const { onHandlers, mockCreateSession, mockSendMessage, mockKillSession, mockEmit } = vi.hoisted(() => ({
  onHandlers: new Map<string, Array<(...args: any[]) => void>>(),
  mockCreateSession: vi.fn(),
  mockSendMessage: vi.fn(),
  mockKillSession: vi.fn(),
  mockEmit: vi.fn(),
}));

const mockExecFileSync = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({
  execFile: vi.fn(),
  execFileSync: mockExecFileSync,
}));

vi.mock('../../src/lib/logger', () => ({
  log: vi.fn(), error: vi.fn(), warn: vi.fn(),
}));

vi.mock('../../src/lib/process-manager', () => ({
  processManager: {
    on: (event: string, handler: (...args: any[]) => void) => {
      if (!onHandlers.has(event)) onHandlers.set(event, []);
      onHandlers.get(event)!.push(handler);
      return vi.fn();
    },
    off: vi.fn(),
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

import { Orchestrator } from '../../src/lib/orchestrator';

const fireEvent = createFireEvent(onHandlers);

function setupProject() {
  const { root, clean } = createTestProject();
  mkdirSync(join(root, '.teamai'), { recursive: true });
  const taskId = randomUUID();
  const taskDir = join(root, '.teamai', 'wakeup-generalization-test');
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    title: 'Wakeup Generalization Test',
    description: 'a test task',
    phase: 'spec',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));
  return { root, taskId, taskDir, clean };
}

function makePipeline(taskId: string, specPath: string, overrides: Record<string, any> = {}): any {
  return {
    taskId,
    title: 'Wakeup Generalization Test',
    description: 'a test task',
    phase: 'spec',
    specPath,
    worktreePath: join(specPath, '..', 'wt'),
    branch: 'feat/wakeup-generalization-test',
    qaAttempt: 0,
    maxQaAttempts: 3,
    specRevision: 1,
    qaRevision: 0,
    ...overrides,
  };
}

function gitOkImplementation(_cmd: string, args?: string[]) {
  if (Array.isArray(args)) {
    if (args[0] === 'push' || args[0] === 'fetch' || args[0] === 'pull') return '';
    if (args[0] === 'rev-parse') return 'abc123\n';
  }
  return '';
}

/** Simulates the background job's declared artifact actually landing on
 *  disk — required for a wakeup re-entry to register as "produced this
 *  cycle" rather than "still running, reschedule". */
function writeArtifact(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

describe('ADR 002 generalized to spec/plan/qa-review (wakeup.ts)', () => {
  let project: ReturnType<typeof setupProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date());
    vi.clearAllMocks();
    onHandlers.clear();
    project = setupProject();
    orch = new Orchestrator(project.root);
    mockExecFileSync.mockImplementation(gitOkImplementation);
  });

  afterEach(() => {
    vi.useRealTimers();
    project.clean();
  });

  // ── runSpec ──────────────────────────────────────────────────────────

  describe('runSpec', () => {
    it('pauses instead of parking for human review when the analyst writes phase_wakeup.json', async () => {
      mockCreateSession.mockResolvedValue('sess-spec-wakeup');
      const pipeline = makePipeline(project.taskId, project.taskDir, { phase: 'spec' });

      const promise = (orch as AnyOrch).runSpec(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      writeFileSync(join(project.taskDir, 'phase_wakeup.json'), JSON.stringify({
        wakeup_at: '2026-07-04T12:00:00Z',
        background_command: 'python long_job.py --seed 42',
        expected_artifact: 'job-results/summary.jsonl',
      }));
      fireEvent('event', { sessionId: 'sess-spec-wakeup', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;

      // Never parked for human review — a legitimate background job is running.
      expect(pipeline.phase).toBe('spec');
      expect(pipeline.wakeupUntil).toBe('2026-07-04T12:00:00Z');
      expect(pipeline.wakeupCommand).toBe('python long_job.py --seed 42');
      expect(pipeline.wakeupArtifact).toBe('job-results/summary.jsonl');
      expect(pipeline.wakeupAttemptCount).toBe(1);
      expect(existsSync(join(project.taskDir, 'phase_wakeup.json'))).toBe(false);
    });

    it('injects a WAKEUP RE-ENTRY header naming the background command and artifact on re-entry', async () => {
      mockCreateSession.mockResolvedValue('sess-spec-reentry');
      const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);
      const pipeline = makePipeline(project.taskId, project.taskDir, {
        phase: 'spec',
        wakeupCommand: 'python long_job.py --seed 42', wakeupArtifact: 'job-results/summary.jsonl', wakeupAttemptCount: 1,
      });

      try {
        const promise = (orch as AnyOrch).runSpec(pipeline);
        await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

        const prompt = mockSendMessage.mock.calls[0][1] as string;
        expect(prompt).toContain('WAKEUP RE-ENTRY');
        expect(prompt).toContain('python long_job.py --seed 42');
        expect(prompt).toContain('job-results/summary.jsonl');
        // The re-entered session still needs the original spec instruction.
        expect(prompt).toContain('/spec');

        // The background job's artifact landed — the re-entered analyst
        // verified it and went on to finish the actual spec.
        writeArtifact(join(project.root, 'job-results', 'summary.jsonl'), '{}');
        writeFileSync(join(project.taskDir, 'spec.md'), '# Spec');
        writeFileSync(join(project.taskDir, 'spec_summary.md'), 'Summary.');
        fireEvent('event', { sessionId: 'sess-spec-reentry', event: { type: 'result' } });
        await vi.advanceTimersByTimeAsync(30);
        await promise;

        expect(pipeline.wakeupUntil).toBeUndefined();
        expect(pipeline.wakeupCommand).toBeUndefined();
        expect(pipeline.wakeupArtifact).toBeUndefined();
        expect(pipeline.wakeupAttemptCount).toBe(0);
        expect(pipeline.phase).toBe('plan');
      } finally {
        executeSpy.mockRestore();
      }
    });

    it('fails the task once the wakeup attempt cap is exceeded (default cap: 3)', async () => {
      mockCreateSession.mockResolvedValue('sess-spec-cap');
      const pipeline = makePipeline(project.taskId, project.taskDir, {
        phase: 'spec',
        wakeupCommand: 'python long_job.py --seed 42', wakeupArtifact: 'job-results/summary.jsonl', wakeupAttemptCount: 2,
      });

      const promise = (orch as AnyOrch).runSpec(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      // Same command relaunched a 3rd time — not a genuine fix, still counts.
      writeFileSync(join(project.taskDir, 'phase_wakeup.json'), JSON.stringify({
        wakeup_at: '2026-07-05T00:00:00Z',
        background_command: 'python long_job.py --seed 42',
        expected_artifact: 'job-results/summary.jsonl',
      }));
      fireEvent('event', { sessionId: 'sess-spec-cap', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;

      expect(pipeline.phase).toBe('failed');
      expect(pipeline.wakeupUntil).toBeUndefined();
      const report = JSON.parse(readFileSync(join(project.taskDir, 'qa_report.json'), 'utf-8'));
      expect(report.overall).toBe('FAIL');
      expect(report.criteria[0].name).toBe('Wakeup attempt limit exceeded');
    });
  });

  // ── runPlan ──────────────────────────────────────────────────────────

  describe('runPlan', () => {
    it('pauses instead of proceeding when the planner writes phase_wakeup.json', async () => {
      writeFileSync(join(project.taskDir, 'spec.md'), '# Spec');
      mockCreateSession.mockResolvedValue('sess-plan-wakeup');
      const pipeline = makePipeline(project.taskId, project.taskDir, { phase: 'plan' });

      const promise = (orch as AnyOrch).runPlan(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      writeFileSync(join(project.taskDir, 'phase_wakeup.json'), JSON.stringify({
        wakeup_at: '2026-07-04T12:00:00Z',
        background_command: 'python dry_run_job.py',
        expected_artifact: 'dry-run/summary.jsonl',
      }));
      fireEvent('event', { sessionId: 'sess-plan-wakeup', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;

      expect(pipeline.phase).toBe('plan');
      expect(pipeline.wakeupUntil).toBe('2026-07-04T12:00:00Z');
      expect(pipeline.wakeupCommand).toBe('python dry_run_job.py');
      expect(existsSync(join(project.taskDir, 'phase_wakeup.json'))).toBe(false);
      // plan.json was never written this cycle — nothing to validate/serialize yet.
      expect(existsSync(join(project.taskDir, 'plan.json'))).toBe(false);
    });
  });

  // ── runQaReview ──────────────────────────────────────────────────────

  describe('runQaReview', () => {
    it('pauses instead of reporting an unreadable report when the reviewer writes phase_wakeup.json', async () => {
      mockCreateSession.mockResolvedValue('sess-qa-wakeup');
      const pipeline = makePipeline(project.taskId, project.taskDir, {
        phase: 'qa-review', worktreePath: project.root, qaAttempt: 0,
      });

      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      writeFileSync(join(project.taskDir, 'phase_wakeup.json'), JSON.stringify({
        wakeup_at: '2026-07-04T12:00:00Z',
        background_command: 'python verify_evidence_job.py',
        expected_artifact: 'verify/summary.jsonl',
      }));
      fireEvent('event', { sessionId: 'sess-qa-wakeup', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;

      expect(pipeline.phase).toBe('qa-review');
      expect(pipeline.wakeupUntil).toBe('2026-07-04T12:00:00Z');
      // Not treated as "QA agent produced no readable report" — no FAIL report.
      expect(existsSync(join(project.taskDir, 'qa_report.json'))).toBe(false);
      // This was a genuine first attempt, so it DOES consume a QA attempt.
      expect(pipeline.qaAttempt).toBe(1);
    });

    it('does not consume a second QA attempt when re-entering mid-wakeup-cycle', async () => {
      mockCreateSession.mockResolvedValue('sess-qa-reentry');
      const pipeline = makePipeline(project.taskId, project.taskDir, {
        phase: 'qa-review', worktreePath: project.root, qaAttempt: 1,
        wakeupCommand: 'python verify_evidence_job.py', wakeupArtifact: 'verify/summary.jsonl', wakeupAttemptCount: 1,
      });

      const promise = (orch as AnyOrch).runQaReview(pipeline);
      await vi.waitFor(() => { expect(mockSendMessage).toHaveBeenCalled(); });

      const prompt = mockSendMessage.mock.calls[0][1] as string;
      expect(prompt).toContain('WAKEUP RE-ENTRY');

      writeArtifact(join(project.root, 'verify', 'summary.jsonl'), '{}');
      writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({ overall: 'PASS', criteria: [] }));
      fireEvent('event', { sessionId: 'sess-qa-reentry', event: { type: 'result' } });
      await vi.advanceTimersByTimeAsync(30);
      await promise;

      // Re-entry continuing the SAME attempt — must not burn a second one.
      expect(pipeline.qaAttempt).toBe(1);
      expect(pipeline.wakeupCommand).toBeUndefined();
      expect(pipeline.phase).toBe('awaiting-review');
    });
  });
});
