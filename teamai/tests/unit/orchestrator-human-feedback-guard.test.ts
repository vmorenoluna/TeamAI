/**
 * Tests for human_feedback.md snapshot guard (Gap 4b for human feedback).
 *
 * Coverage:
 *   - rejectTask() creates human_feedback_before_bounce.md snapshot
 *   - _restoreHumanFeedbackFromSnapshot() restores human_feedback.md when deleted
 *   - Safety guard creates snapshot in runImplement if missing but .md exists
 *   - Pipeline integration with retryTask
 *   - No crash when snapshot is absent
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
} from 'fs';
import { join } from 'path';
import { mkdtempSync } from 'fs';
import { randomUUID } from 'crypto';

// ── Helpers ────────────────────────────────────────────────────────────────

type AnyOrch = Orchestrator & Record<string, any>;

// Hoisted mock for processManager so createSession is usable in tests
const { mockCreateSession, onHandlers } = vi.hoisted(() => {
  const handlers = new Map<string, Set<(...args: any[]) => void>>();
  return {
    mockCreateSession: vi.fn().mockResolvedValue('sess-1'),
    onHandlers: handlers,
  };
});

vi.mock('@/lib/process-manager', () => ({
  processManager: {
    createSession: mockCreateSession,
    sendMessage: vi.fn(),
    killSession: vi.fn(),
    emit: vi.fn(),
    on: vi.fn((event: string, handler: (...args: any[]) => void) => {
      if (!onHandlers.has(event)) onHandlers.set(event, new Set());
      onHandlers.get(event)!.add(handler);
    }),
    off: vi.fn((event: string, handler: (...args: any[]) => void) => {
      onHandlers.get(event)?.delete(handler);
    }),
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('@/lib/container-manager', () => ({
  readContainerConfig: vi.fn(() => ({ enabled: false, explicit: false })),
  readContainerRemoteUser: vi.fn(() => 'root'),
  containerManager: { ensureContainer: vi.fn(), getRunningContainer: vi.fn() },
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => true),
  _resetDockerAvailableCache: vi.fn(),
}));

vi.mock('@/lib/task-store', () => {
  const TaskStore = vi.fn();
  TaskStore.prototype.getDirById = vi.fn((id: string) => join(testDir, id));
  TaskStore.prototype.getById = vi.fn(() => ({ branch: `feat/${worktreeName}`, phase: 'implement' }));
  TaskStore.prototype.updatePhase = vi.fn();
  TaskStore.prototype.update = vi.fn();
  TaskStore.prototype.getAll = vi.fn(() => []);
  TaskStore.prototype.getEvents = vi.fn(() => []);
  TaskStore.prototype.clearArtifacts = vi.fn();
  return { TaskStore };
});

vi.mock('@/lib/logger', () => ({ warn: vi.fn() }));

vi.mock('@/lib/providers', () => ({ resolveProvider: vi.fn(), providerToSessionOpts: vi.fn() }));

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { Orchestrator } from '@/lib/orchestrator';

let testDir: string;
let orch: Orchestrator;
let worktreeName: string;

beforeEach(() => {
  testDir = mkdtempSync('human-feedback-test-');
  worktreeName = randomUUID().slice(0, 8);
  vi.clearAllMocks();
  onHandlers.clear();
  orch = new Orchestrator(testDir);
});

afterEach(() => {
  try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
});

vi.mock('@/app/actions/projects', () => ({
  getActiveProjectPath: vi.fn(() => testDir),
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeProject(phase: string = 'awaiting-review') {
  const taskId = 'task-1';
  const taskDir = join(testDir, taskId);
  mkdirSync(taskDir, { recursive: true });

  // Make a minimal valid plan.json
  writeFileSync(join(taskDir, 'plan.json'), JSON.stringify({
    subtasks: [{ id: 1, title: 'Test', description: 'Do test', files: ['test.ts'], acceptance_criteria: ['works'] }],
  }));

  // Mock taskStore.getDirById to return our taskDir
  const store = (orch as any).taskStore;
  store.getDirById.mockImplementation((id: string) => join(testDir, id));
  store.getById.mockImplementation(() => ({
    id: taskId,
    title: 'Test task',
    description: 'Test task',
    branch: `feat/${worktreeName}`,
    phase,
  }));

  // Mock restorePipeline to return a valid pipeline
  vi.spyOn(orch as any, 'restorePipeline').mockReturnValue({
    taskId,
    description: 'Test task',
    phase,
    specPath: taskDir,
    worktreePath: join(testDir, 'worktrees', worktreeName),
    branch: `feat/${worktreeName}`,
    qaAttempt: 0,
    maxQaAttempts: 3,
  });

  return { taskId, taskDir };
}

function makePipeline(taskId: string, taskDir: string) {
  return {
    taskId,
    description: 'Test task',
    phase: 'implement' as const,
    specPath: taskDir,
    worktreePath: join(testDir, 'worktrees', worktreeName),
    branch: `feat/${worktreeName}`,
    qaAttempt: 0,
    maxQaAttempts: 3,
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('rejectTask — human_feedback_before_bounce.md snapshot', () => {
  it('creates human_feedback_before_bounce.md snapshot when rejecting a task', async () => {
    const { taskId, taskDir } = makeProject();
    // Write a qa_report.json so rejectTask doesn't fail
    writeFileSync(join(taskDir, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      criteria: [{ name: 'Test', status: 'FAIL', notes: 'issue' }],
    }));

    // Spy on executePhase to prevent actually running subprocesses
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    try {
      const feedbackText = 'Fix the header alignment on mobile devices';
      await orch.rejectTask(taskId, feedbackText);

      // Assert: human_feedback.md created
      const feedbackPath = join(taskDir, 'human_feedback.md');
      expect(existsSync(feedbackPath)).toBe(true);
      const content = readFileSync(feedbackPath, 'utf-8');
      expect(content).toContain(feedbackText);

      // Assert: human_feedback_before_bounce.md snapshot created
      const snapshotPath = join(taskDir, 'human_feedback_before_bounce.md');
      expect(existsSync(snapshotPath)).toBe(true);
      const snapshotContent = readFileSync(snapshotPath, 'utf-8');
      expect(snapshotContent).toBe(content);
    } finally {
      executeSpy.mockRestore();
    }
  });

  it('does not crash when qa_report.json is missing', async () => {
    const { taskId, taskDir } = makeProject();
    const executeSpy = vi.spyOn(orch as AnyOrch, 'executePhase').mockResolvedValue(undefined);

    try {
      await expect(orch.rejectTask(taskId, 'Some feedback')).resolves.toBeUndefined();

      // Snapshot should still be created even without qa_report.json
      const snapshotPath = join(taskDir, 'human_feedback_before_bounce.md');
      expect(existsSync(snapshotPath)).toBe(true);
    } finally {
      executeSpy.mockRestore();
    }
  });
});

describe('_restoreHumanFeedbackFromSnapshot', () => {
  it('restores human_feedback.md from snapshot when it is missing', () => {
    const { taskDir } = makeProject();    const snapshotContent = '# Human Review Feedback\n\nFix alignment on mobile';
  writeFileSync(join(taskDir, 'human_feedback_before_bounce.md'), snapshotContent);

    (orch as any)._restoreHumanFeedbackFromSnapshot(taskDir);

    const feedbackPath = join(taskDir, 'human_feedback.md');
    expect(existsSync(feedbackPath)).toBe(true);
    expect(readFileSync(feedbackPath, 'utf-8')).toBe(snapshotContent);
  });

  it('does not overwrite existing human_feedback.md', () => {
    const { taskDir } = makeProject();
    const existingContent = '# Human Review Feedback\n\nExisting feedback';
    writeFileSync(join(taskDir, 'human_feedback.md'), existingContent);
    writeFileSync(join(taskDir, 'human_feedback_before_bounce.md'), '# Human Review Feedback\n\nSnapshot content');

    (orch as any)._restoreHumanFeedbackFromSnapshot(taskDir);

    // Original file should be unchanged
    expect(readFileSync(join(taskDir, 'human_feedback.md'), 'utf-8')).toBe(existingContent);
  });

  it('does nothing when snapshot does not exist', () => {
    const { taskDir } = makeProject();

    (orch as any)._restoreHumanFeedbackFromSnapshot(taskDir);

    expect(existsSync(join(taskDir, 'human_feedback.md'))).toBe(false);
  });

  it('does not throw when specPath is empty/missing', () => {
    const emptyDir = join(testDir, 'nonexistent');

    expect(() => (orch as any)._restoreHumanFeedbackFromSnapshot(emptyDir)).not.toThrow();
  });
});

describe('runImplement — safety guard creates missing snapshot', () => {
  it('creates human_feedback_before_bounce.md if human_feedback.md exists but snapshot is missing', async () => {
    const { taskId, taskDir } = makeProject();

    // Write human_feedback.md but no snapshot
    writeFileSync(join(taskDir, 'human_feedback.md'), '# Human Review Feedback\n\nFix the colors');

    // Mock git/worktree operations so runImplement doesn't actually run git commands
    vi.spyOn(orch as any, '_execGit').mockReturnValue(undefined);
    vi.spyOn(orch as any, 'waitForCompletion').mockResolvedValue(undefined);
    vi.spyOn(orch as any, '_persistAndEmitPhase').mockReturnValue(undefined);
    vi.spyOn(orch as any, 'advancePhase').mockReturnValue(undefined);
    vi.spyOn(orch as any, '_savePipelineState').mockReturnValue(undefined);
    vi.spyOn(orch as any, '_phaseHeader').mockReturnValue(undefined);
    vi.spyOn(orch as any, 'executePhase').mockResolvedValue(undefined);
    mockCreateSession.mockResolvedValue('sess-impl');

    const pipeline = makePipeline(taskId, taskDir);
    await (orch as any).runImplement(pipeline);

    const snapshotPath = join(taskDir, 'human_feedback_before_bounce.md');
    expect(existsSync(snapshotPath)).toBe(true);
  });
});

describe('retryTask — restores human_feedback.md from snapshot', () => {
  it('restores human_feedback.md from human_feedback_before_bounce.md when file is deleted', async () => {
    const { taskId, taskDir } = makeProject();

    // Create snapshot (as if rejectTask created it)
    const snapshotContent = '# Human Review Feedback\n\nFix the alignment';
    writeFileSync(join(taskDir, 'human_feedback_before_bounce.md'), snapshotContent);

    // Mock task as failed
    const store = (orch as any).taskStore;
    store.getById.mockImplementation(() => ({
      id: taskId,
      title: 'Test task',
      description: 'Test task',
      branch: `feat/${worktreeName}`,
      phase: 'failed',
    }));
    store.getEvents.mockReturnValue([]);
    store.getDirById.mockReturnValue(taskDir);

    // Import retryTask from actions
    const { retryTask } = await import('@/app/actions/tasks');

    // Spy on moveTaskToPhase so the pipeline doesn't actually run
    const moveSpy = vi.spyOn(orch, 'moveTaskToPhase').mockResolvedValue(undefined);

    await retryTask(taskId);

    // human_feedback.md should be restored from snapshot
    expect(existsSync(join(taskDir, 'human_feedback.md'))).toBe(true);
    expect(readFileSync(join(taskDir, 'human_feedback.md'), 'utf-8')).toBe(snapshotContent);

    moveSpy.mockRestore();
  });

  it('does not crash when no snapshot exists', async () => {
    const { taskId, taskDir } = makeProject();

    const store = (orch as any).taskStore;
    store.getById.mockImplementation(() => ({
      id: taskId,
      title: 'Test task',
      description: 'Test task',
      branch: `feat/${worktreeName}`,
      phase: 'failed',
    }));
    store.getEvents.mockReturnValue([]);
    store.getDirById.mockReturnValue(taskDir);

    const { retryTask } = await import('@/app/actions/tasks');
    const moveSpy = vi.spyOn(orch, 'moveTaskToPhase').mockResolvedValue(undefined);

    await retryTask(taskId);

    // No crash, and no human_feedback.md was created (since no snapshot)
    expect(existsSync(join(taskDir, 'human_feedback.md'))).toBe(false);

    moveSpy.mockRestore();
  });
});
