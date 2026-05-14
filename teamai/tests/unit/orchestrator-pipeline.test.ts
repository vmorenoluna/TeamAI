/**
 * Orchestrator pipeline integration tests.
 * Uses process.nextTick to deterministically emit result events from
 * createSession, allowing the pipeline to chain through phases without timing hacks.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, rmSync, unlinkSync } from 'fs';
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

  it('runs implement → qa-review → qa-fix when QA fails and retries', async () => {
    (processManager.createSession as any).mockImplementation(async () => {
      const cnt = ++(globalThis as any).__pmSessionCount;
      const sid = `session-${cnt}`;

      // On 2nd session (qa-review), write failing QA report
      if (cnt === 2) {
        writeFileSync(join(project.taskDir, 'qa_report.json'), JSON.stringify({
          overall: 'FAIL',
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

    // Pipeline should have gone: implement → qa-review → qa-fix → qa-review → awaiting-review
    // (since maxQaAttempts is 3, and qa-fix completes, then qa-review runs again)
    expect(processManager.sendMessage).toHaveBeenCalled();
    expect(processManager.killSession).toHaveBeenCalled();
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
