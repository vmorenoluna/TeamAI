/**
 * Orchestrator pipeline integration tests.
 * Uses process.nextTick to deterministically emit result events from
 * createSession, allowing the pipeline to chain through phases without timing hacks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

// ── Hoisted mocks ──

const { mockWarn, onHandlers } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
  onHandlers: new Map<string, Array<(...args: any[]) => void>>(),
}));

const mockOn = vi.hoisted(() => vi.fn((event: string, handler: any) => {
  if (!onHandlers.has(event)) onHandlers.set(event, []);
  onHandlers.get(event)!.push(handler);
  return {};
}));

const mockOff = vi.hoisted(() => vi.fn((event: string, handler: any) => {
  const handlers = onHandlers.get(event);
  if (handlers) {
    const idx = handlers.indexOf(handler);
    if (idx >= 0) handlers.splice(idx, 1);
  }
  return {};
}));

const mockEmit = vi.hoisted(() => vi.fn());

vi.mock('../../src/lib/logger', () => ({ warn: mockWarn, error: vi.fn() }));

vi.mock('../../src/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false })),
  readContainerRemoteUser: vi.fn(() => 'node'),
  containerManager: {
    ensureContainer: vi.fn(),
    getRunningContainer: vi.fn(() => null),
  },
  hostToContainerPath: vi.fn((hostPath: string) => hostPath),
}));

vi.mock('child_process', () => ({
  execFileSync: vi.fn(() => ''),
  spawn: vi.fn(),
  ChildProcess: class MockCP {},
}));

vi.mock('../../src/lib/process-manager', () => {
  const pm = {
    on: mockOn,
    off: mockOff,
    emit: mockEmit,
    createSession: vi.fn(async () => {
      let cnt = (globalThis as any).__pmSessionCount ?? 0;
      cnt += 1;
      (globalThis as any).__pmSessionCount = cnt;
      const sid = `session-${cnt}`;
      process.nextTick(() => {
        const handlers = onHandlers.get('event') || [];
        for (const h of handlers) {
          h({ sessionId: sid, event: { type: 'result' } });
        }
      });
      return sid;
    }),
    sendMessage: vi.fn(),
    killSession: vi.fn(),
    getSession: vi.fn(),
    getAllSessions: vi.fn(() => []),
    createTerminalSession: vi.fn(),
    writeToTerminal: vi.fn(),
    resizeTerminal: vi.fn(),
    killTerminalSession: vi.fn(),
    getTerminalSessions: vi.fn(() => []),
    getStaleSessions: vi.fn(() => []),
    removeStaleSession: vi.fn(),
  };
  return { processManager: pm };
});

// ── Imports (after mocks) ──

import { processManager } from '../../src/lib/process-manager';
import { Orchestrator } from '../../src/lib/orchestrator';

// ── Helpers ──

function createTestProject() {
  const root = join(tmpdir(), `teamai-pl-${randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });
  mkdirSync(join(root, '.teamai'), { recursive: true });

  const taskId = randomUUID();
  const slug = 'test-task';
  const taskDir = join(root, '.teamai', slug);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    title: 'Test Task',
    description: 'Test task description',
    phase: 'backlog',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  return {
    root,
    taskDir,
    taskId,
    slug,
    clean: () => {
      vi.clearAllMocks();
      onHandlers.clear();
      (globalThis as any).__pmSessionCount = 0;
      try { rmSync(root, { recursive: true, force: true }); } catch { /* ignore */ }
    },
  };
}

// ── Tests ──

describe('Orchestrator pipeline — full flow through implement phase', () => {
  let project: ReturnType<typeof createTestProject>;
  let orch: Orchestrator;

  beforeEach(() => {
    project = createTestProject();
    (globalThis as any).__pmSessionCount = 0;
    orch = new Orchestrator(project.root);

    // Pre-create spec.md and plan.json so pipeline can start at 'implement'
    writeFileSync(join(project.taskDir, 'spec.md'), '# Feature X\n\nImplement the feature.');
    writeFileSync(join(project.taskDir, 'plan.json'), JSON.stringify({
      subtasks: [
        {
          id: 1,
          title: 'Add feature',
          description: 'Implement the feature',
          files: ['src/feature.ts'],
          acceptance_criteria: ['Feature works'],
        },
      ],
    }));
  });

  afterEach(() => {
    project.clean();
  });

  it('runs implement → qa-review → awaiting-review when QA passes', async () => {
    // Move task to 'implement' phase — this will:
    // 1. clearArtifacts('qa') → delete qa_report.json if it exists
    // 2. start at 'implement' (spec.md + plan.json exist → hasPlan = true)
    // 3. runImplement reads plan.json, creates session for subtask
    // 4. createSession auto-emits 'result' via nextTick → waitForCompletion resolves
    // 5. advancePhase('qa-review') → runQaReview creates session
    // 6. qaReview session starts → we write qa_report.json in the createSession mock
    //    Wait — our mock is at module level and can't access project.taskDir
    //
    // Instead, provide qa_report.json from the start (clearArtifacts('qa') only
    // deletes it, but we write it again before runQaReview runs).
    // Actually, clearArtifacts('qa') runs during moveTaskToPhase, so we need
    // to write it AFTER that but BEFORE runQaReview.
    //
    // Since createSession auto-emits 'result', the pipeline will run:
    // implement (session-1) → qa-review (session-2)
    //
    // Between session-1 and session-2, we write qa_report.json
    // The nextTick for session-1 fires, implement completes.
    // Then runQaReview runs and writes specPath... 
    // We add a hook in the mock: after implement completes, create qa_report.json

    // Override createSession to write qa_report.json on the 2nd call (qa-review)
    (processManager.createSession as any).mockImplementation(async () => {
      const cnt = ++(globalThis as any).__pmSessionCount;
      const sid = `session-${cnt}`;

      // On 2nd session (qa-review), write qa_report.json before it reads it
      if (cnt === 2) {
        writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
          overall: 'PASS',
          issues: [],
        }));
      }

      process.nextTick(() => {
        const handlers = onHandlers.get('event') || [];
        for (const h of handlers) {
          h({ sessionId: sid, event: { type: 'result' } });
        }
      });
      return sid;
    });

    await orch.moveTaskToPhase(project.taskId, 'implement');

    // Pipeline should have progressed through implement, qa-review → awaiting-review
    expect(processManager.sendMessage).toHaveBeenCalled();
    expect(processManager.killSession).toHaveBeenCalled();
  });

  it('runs implement → qa-review → implement (with feedback) when QA fails and retries', async () => {
    (processManager.createSession as any).mockImplementation(async () => {
      const cnt = ++(globalThis as any).__pmSessionCount;
      const sid = `session-${cnt}`;

      // On 2nd session (qa-review), write failing QA report
      if (cnt === 2) {
        writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
          overall: 'FAIL',
          criteria: [{ name: 'Error handling', status: 'FAIL', notes: 'Missing error handling for edge case' }],
          issues: [{ severity: 'error', message: 'Missing error handling' }],
        }));
      }

      // On 4th session (2nd qa-review), write passing QA report so pipeline completes
      if (cnt === 4) {
        writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
          overall: 'PASS',
          criteria: [{ name: 'Error handling', status: 'PASS', notes: '' }],
        }));
      }

      process.nextTick(() => {
        const handlers = onHandlers.get('event') || [];
        for (const h of handlers) {
          h({ sessionId: sid, event: { type: 'result' } });
        }
      });
      return sid;
    });

    await orch.moveTaskToPhase(project.taskId, 'implement');

    // Pipeline should have gone: implement → qa-review → implement (with qa_feedback.md) → qa-review → awaiting-review
    // (since maxQaAttempts is 3, QA fails on 1st attempt, bounces to implement, then passes on 2nd attempt)
    // 4 sessions total: 1=implement, 2=qa-review(fail), 3=implement(bounce), 4=qa-review(pass), then awaiting-review (no session)
    // Note: qa_feedback.md is created after session-2 but then deleted during the implement bounce (session-3)
    // to clean up. By the time the pipeline completes, qa_feedback.md no longer exists.
    expect((globalThis as any).__pmSessionCount).toBe(4);

    // The implement prompt on the bounce (session-3) includes qa_feedback content.
    // Since sendMessage was called for all 4 sessions, and sessions 2-4 used the
    // mock that writes qa_report.json, the pipeline must have read the feedback.

    // Verify sendMessage was called 4 times (implement, qa-review, implement, qa-review)
    expect(processManager.sendMessage).toHaveBeenCalledTimes(4);
    expect(processManager.killSession).toHaveBeenCalled();

    // Verify the pipeline advanced to awaiting-review (QA passed on 2nd attempt)
    const task = JSON.parse(readFileSync(join(project.taskDir, 'task.json'), 'utf-8'));
    expect(task.phase).toBe('awaiting-review');
  }, 10000);

  it('marks task as failed when max QA attempts reached', async () => {
    // Override maxQaAttempts to 2 for this test
    writeFileSync(
      join(project.root, '.teamai', 'pipeline.json'),
      JSON.stringify({ phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'], maxQaAttempts: 2, parallelSubtasks: true }),
    );
    // Re-create orchestrator to pick up new config
    orch = new (Orchestrator as any)(project.root);

    (processManager.createSession as any).mockImplementation(async () => {
      const cnt = ++(globalThis as any).__pmSessionCount;
      const sid = `session-${cnt}`;

      // Always write failing QA report (every qa-review session)
      if (cnt === 2 || cnt === 4) {
        writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
          overall: 'FAIL',
          criteria: [{ name: 'Error handling', status: 'FAIL', notes: 'Not fixed yet' }],
          issues: [{ severity: 'error', message: 'Missing error handling' }],
        }));
      }

      process.nextTick(() => {
        const handlers = onHandlers.get('event') || [];
        for (const h of handlers) {
          h({ sessionId: sid, event: { type: 'result' } });
        }
      });
      return sid;
    });

    await orch.moveTaskToPhase(project.taskId, 'implement');

    // Pipeline should have gone: implement → qa-review(fail) → implement(bounce) → qa-review(fail) → failed
    // 4 sessions total: implement, qa-review, implement, qa-review
    // Note: qa_feedback.md was created after session-2 but deleted during the implement
    // bounce (session-3) cleanup. Only completion_summary.md persists.
    expect((globalThis as any).__pmSessionCount).toBe(4);

    // Verify sendMessage was called 4 times
    expect(processManager.sendMessage).toHaveBeenCalledTimes(4);

    // verify completion_summary.md was written (this persists, unlike qa_feedback.md)
    const summaryPath = join(project.taskDir, 'completion_summary.md');
    expect(existsSync(summaryPath)).toBe(true);
    const summaryContent = readFileSync(summaryPath, 'utf-8');
    expect(summaryContent).toContain('Completion Summary');
    expect(summaryContent).toContain('2 QA attempts');
    expect(summaryContent).toContain('Add feature');

    // verify task is marked as failed
    const task = JSON.parse(readFileSync(join(project.taskDir, 'task.json'), 'utf-8'));
    expect(task.phase).toBe('failed');
    expect(task.completionSummary).toBeDefined();
    expect(task.completionSummary).toContain('2 QA attempts');
  }, 10000);

  it('handles moveTaskToPhase for backlog phase without sessions', async () => {
    await orch.moveTaskToPhase(project.taskId, 'backlog');
    expect(processManager.createSession).not.toHaveBeenCalled();
  });

  it('handles moveTaskToPhase for done phase without sessions', async () => {
    await orch.moveTaskToPhase(project.taskId, 'done');
    expect(processManager.createSession).not.toHaveBeenCalled();
  });
});
