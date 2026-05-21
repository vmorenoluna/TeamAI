/**
 * Tests for restartCurrentPhase server action.
 * Verifies it:
 *   - Rejects invalid phases: backlog, done, failed, awaiting-review
 *   - Accepts valid phases: spec, plan, implement, qa-review
 *   - Calls orchestrator.moveTaskToPhase(taskId, task.phase)
 *   - Returns success: false for nonexistent tasks
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted shared mocks (must be at top level, before any vi.mock) ──

const mockRevalidatePath = vi.fn();

const { mockMoveTaskToPhase, mockCancelPipeline } = vi.hoisted(() => ({
  mockMoveTaskToPhase: vi.fn().mockResolvedValue(undefined),
  mockCancelPipeline: vi.fn(),
}));

let mockProjectPath = '/test/project';

// Mock next/headers cookies() to return the active project path
vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: vi.fn((name: string) => {
      if (name === 'activeProject') return { value: mockProjectPath };
      return undefined;
    }),
    set: vi.fn(),
    delete: vi.fn(),
  })),
}));

// Mock next/cache
vi.mock('next/cache', () => ({
  revalidatePath: mockRevalidatePath,
}));

// Mock process-manager (imported via orchestrator)
vi.mock('@/lib/process-manager', () => ({
  processManager: {
    on: vi.fn().mockReturnThis(),
    off: vi.fn().mockReturnThis(),
    emit: vi.fn(),
    sendMessage: vi.fn(),
    killSession: vi.fn(),
    createSession: vi.fn(),
  },
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock orchestrator — uses the hoisted shared mocks so tests can assert on them
vi.mock('@/lib/orchestrator', () => ({
  getOrchestrator: vi.fn(() => ({
    moveTaskToPhase: mockMoveTaskToPhase,
    cancelPipeline: mockCancelPipeline,
    // Stub out other methods used by other actions
    resumeTask: vi.fn(),
    cleanupTaskArtifacts: vi.fn(),
    runTask: vi.fn(),
    approveTask: vi.fn(),
    rejectTask: vi.fn(),
    getWorktreePath: vi.fn(),
  })),
  detectDefaultBranch: vi.fn(() => 'main'),
}));

// ── Real imports ──

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

const TEST_DIR = join(
  process.cwd(),
  '.teamai-test-restart-' + Math.random().toString(36).slice(2, 10),
);

/** Create a minimal task.json in the test directory with the given phase. */
function seedTask(
  dir: string,
  slug: string,
  overrides: Partial<{
    id: string;
    phase: string;
    branch: string;
    title: string;
  }> = {},
) {
  const taskDir = join(dir, '.teamai', slug);
  mkdirSync(taskDir, { recursive: true });

  const task = {
    id: overrides.id ?? `task-${slug}`,
    title: overrides.title ?? `Test ${slug}`,
    description: 'test task for restart',
    phase: overrides.phase ?? 'spec',
    branch: overrides.branch ?? `feat/${slug}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify(task, null, 2));
  return task;
}

// ── Tests ──

describe('restartCurrentPhase — valid phases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectPath = TEST_DIR;
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  const validPhases = ['spec', 'plan', 'implement', 'qa-review'] as const;

  for (const phase of validPhases) {
    it(`succeeds for "${phase}" phase and calls moveTaskToPhase`, async () => {
      const slug = `restart-${phase}`;
      const task = seedTask(TEST_DIR, slug, { phase, id: slug });

      const { restartCurrentPhase } = await import('@/app/actions/tasks');
      const result = await restartCurrentPhase(task.id);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      // Verify moveTaskToPhase was called with the task ID and current phase
      expect(mockMoveTaskToPhase).toHaveBeenCalledTimes(1);
      expect(mockMoveTaskToPhase).toHaveBeenCalledWith(task.id, phase);

      // Verify revalidatePath was called
      expect(mockRevalidatePath).toHaveBeenCalledWith('/');
      expect(mockRevalidatePath).toHaveBeenCalledWith(`/task/${task.id}`);
    });
  }
});

describe('restartCurrentPhase — invalid phases rejected', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectPath = TEST_DIR;
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  const invalidPhases = [
    { phase: 'backlog', why: 'idle state' },
    { phase: 'done', why: 'finished state' },
    { phase: 'failed', why: 'terminal state' },
    { phase: 'awaiting-review', why: 'paused for human review' },
  ] as const;

  for (const { phase, why } of invalidPhases) {
    it(`rejects "${phase}" phase (${why})`, async () => {
      const slug = `invalid-${phase}`;
      const task = seedTask(TEST_DIR, slug, { phase, id: slug });

      const { restartCurrentPhase } = await import('@/app/actions/tasks');
      const result = await restartCurrentPhase(task.id);

      expect(result.success).toBe(false);
      expect(result.error).toContain(phase);
      expect(result.error).toContain('Cannot restart');

      // moveTaskToPhase should NOT be called for invalid phases
      expect(mockMoveTaskToPhase).not.toHaveBeenCalled();
    });
  }
});

describe('restartCurrentPhase — edge cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectPath = TEST_DIR;
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  it('returns error for nonexistent task', async () => {
    const { restartCurrentPhase } = await import('@/app/actions/tasks');
    const result = await restartCurrentPhase('nonexistent-task-id');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Task not found');
    expect(mockMoveTaskToPhase).not.toHaveBeenCalled();
  });

  it('handles an unknown/unexpected phase gracefully', async () => {
    // A phase that isn't in the restartable set and isn't explicitly listed as invalid
    const slug = 'weird-phase';
    const task = seedTask(TEST_DIR, slug, { phase: 'merge', id: slug });

    const { restartCurrentPhase } = await import('@/app/actions/tasks');
    const result = await restartCurrentPhase(task.id);

    expect(result.success).toBe(false);
    expect(result.error).toContain('merge');
    expect(mockMoveTaskToPhase).not.toHaveBeenCalled();
  });

  it('verifies moveTaskToPhase is called with the correct taskId even when multiple tasks exist', async () => {
    // Create two tasks in the same project
    seedTask(TEST_DIR, 'task-a', { phase: 'implement', id: 'id-a' });
    seedTask(TEST_DIR, 'task-b', { phase: 'spec', id: 'id-b' });

    const { restartCurrentPhase } = await import('@/app/actions/tasks');

    // Restart task A
    await restartCurrentPhase('id-a');
    expect(mockMoveTaskToPhase).toHaveBeenLastCalledWith('id-a', 'implement');

    // Restart task B
    await restartCurrentPhase('id-b');
    expect(mockMoveTaskToPhase).toHaveBeenLastCalledWith('id-b', 'spec');
  });
});
