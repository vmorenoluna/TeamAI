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

const { mockMoveTaskToPhase, mockCancelPipeline, mockRunTask } = vi.hoisted(() => ({
  mockMoveTaskToPhase: vi.fn().mockResolvedValue(undefined),
  mockCancelPipeline: vi.fn(),
  mockRunTask: vi.fn().mockResolvedValue(undefined),
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
    runTask: mockRunTask,
    // Stub out other methods used by other actions
    resumeTask: vi.fn(),
    cleanupTaskArtifacts: vi.fn(),
    approveTask: vi.fn(),
    rejectTask: vi.fn(),
    getWorktreePath: vi.fn(),
  })),
  detectDefaultBranch: vi.fn(() => 'main'),
}));

// ── Real imports ──

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
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

describe('restartCurrentPhase — valid phases (spec / plan)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectPath = TEST_DIR;
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  const moveToPhasePhases = ['spec', 'plan'] as const;

  for (const phase of moveToPhasePhases) {
    it(`succeeds for "${phase}" phase and calls moveTaskToPhase`, async () => {
      const slug = `restart-${phase}`;
      const task = seedTask(TEST_DIR, slug, { phase, id: slug });

      const { restartCurrentPhase } = await import('@/app/actions/tasks');
      const result = await restartCurrentPhase(task.id);

      expect(result.success).toBe(true);
      expect(result.error).toBeUndefined();

      // spec/plan use moveTaskToPhase for correct start-phase detection
      expect(mockMoveTaskToPhase).toHaveBeenCalledTimes(1);
      expect(mockMoveTaskToPhase).toHaveBeenCalledWith(task.id, phase);
      expect(mockRunTask).not.toHaveBeenCalled();

      // Verify revalidatePath was called
      expect(mockRevalidatePath).toHaveBeenCalledWith('/');
      expect(mockRevalidatePath).toHaveBeenCalledWith(`/task/${task.id}`);
    });
  }
});

describe('restartCurrentPhase — qa-review (uses runTask directly)', () => {
  let clearArtifactsSpy: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockProjectPath = TEST_DIR;
    // Lazy-import TaskStore and spy on clearArtifacts so we can verify it's called
    const { TaskStore } = await import('@/lib/task-store');
    clearArtifactsSpy = vi.spyOn(TaskStore.prototype, 'clearArtifacts').mockImplementation(vi.fn());
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  it('succeeds for qa-review, clears QA artifacts, and calls runTask (not moveTaskToPhase)', async () => {
    const slug = 'restart-qa-review';
    const task = seedTask(TEST_DIR, slug, { phase: 'qa-review', id: slug });

    const { restartCurrentPhase } = await import('@/app/actions/tasks');
    const result = await restartCurrentPhase(task.id);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // qa-review uses runTask with startPhase='qa-review', NOT moveTaskToPhase
    expect(mockMoveTaskToPhase).not.toHaveBeenCalled();
    expect(mockRunTask).toHaveBeenCalledTimes(1);
    expect(mockRunTask).toHaveBeenCalledWith(task.id, task.description, 'qa-review');

    // QA artifacts must be cleared before re-running QA
    expect(clearArtifactsSpy).toHaveBeenCalledWith(task.id, 'qa');

    // Verify revalidatePath was called
    expect(mockRevalidatePath).toHaveBeenCalledWith('/');
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/task/${task.id}`);
  });
});

describe('restartCurrentPhase — implement (uses moveTaskToPhase + resets subtask completions)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectPath = TEST_DIR;
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  it('succeeds for implement, calls moveTaskToPhase, and resets subtask completions in plan.json', async () => {
    const slug = 'restart-implement';
    seedTask(TEST_DIR, slug, { phase: 'implement', id: slug });

    // Create a plan.json with completed subtasks to verify reset
    const planPath = join(TEST_DIR, '.teamai', slug, 'plan.json');
    writeFileSync(planPath, JSON.stringify({
      subtasks: [
        { id: 1, title: 'Subtask 1', description: 'desc', files: ['a.ts'], acceptance_criteria: [], completed: true },
        { id: 2, title: 'Subtask 2', description: 'desc', files: ['b.ts'], acceptance_criteria: [], completed: true },
        { id: 3, title: 'Subtask 3', description: 'desc', files: ['c.ts'], acceptance_criteria: [], completed: false },
      ],
    }, null, 2));

    const { restartCurrentPhase } = await import('@/app/actions/tasks');
    const result = await restartCurrentPhase(slug);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // implement uses moveTaskToPhase
    expect(mockMoveTaskToPhase).toHaveBeenCalledTimes(1);
    expect(mockMoveTaskToPhase).toHaveBeenCalledWith(slug, 'implement');

    // Verify all subtask completions were reset to false
    const updatedPlan = JSON.parse(readFileSync(planPath, 'utf-8'));
    expect(updatedPlan.subtasks).toHaveLength(3);
    for (const s of updatedPlan.subtasks) {
      expect(s.completed).toBe(false);
    }

    // Verify revalidatePath was called
    expect(mockRevalidatePath).toHaveBeenCalledWith('/');
    expect(mockRevalidatePath).toHaveBeenCalledWith(`/task/${slug}`);
  });

  it('handles missing plan.json gracefully on implement restart', async () => {
    const slug = 'restart-impl-no-plan';
    seedTask(TEST_DIR, slug, { phase: 'implement', id: slug });

    const { restartCurrentPhase } = await import('@/app/actions/tasks');
    const result = await restartCurrentPhase(slug);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();
    expect(mockMoveTaskToPhase).toHaveBeenCalledTimes(1);
    expect(mockMoveTaskToPhase).toHaveBeenCalledWith(slug, 'implement');
  });
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

  it('verifies correct method is used for each phase when multiple tasks exist', async () => {
    // Create mixed tasks — implement task needs a plan.json for subtask reset to exercise that code path
    seedTask(TEST_DIR, 'task-a', { phase: 'implement', id: 'id-a' });
    writeFileSync(join(TEST_DIR, '.teamai', 'task-a', 'plan.json'), JSON.stringify({
      subtasks: [{ id: 1, title: 'S1', description: 'd', files: ['a.ts'], acceptance_criteria: [], completed: true }],
    }, null, 2));

    seedTask(TEST_DIR, 'task-b', { phase: 'qa-review', id: 'id-b' });
    seedTask(TEST_DIR, 'task-c', { phase: 'spec', id: 'id-c' });

    const { restartCurrentPhase } = await import('@/app/actions/tasks');

    // Restart task A (implement) — uses moveTaskToPhase + subtask reset
    await restartCurrentPhase('id-a');
    expect(mockMoveTaskToPhase).toHaveBeenLastCalledWith('id-a', 'implement');
    expect(mockRunTask).not.toHaveBeenCalled();
    // Verify subtasks were reset
    const plan = JSON.parse(readFileSync(join(TEST_DIR, '.teamai', 'task-a', 'plan.json'), 'utf-8'));
    expect(plan.subtasks[0].completed).toBe(false);

    // Restart task B (qa-review) — uses runTask with startPhase='qa-review'
    await restartCurrentPhase('id-b');
    expect(mockRunTask).toHaveBeenLastCalledWith('id-b', expect.any(String), 'qa-review');

    // Restart task C (spec) — uses moveTaskToPhase
    await restartCurrentPhase('id-c');
    expect(mockMoveTaskToPhase).toHaveBeenLastCalledWith('id-c', 'spec');
  });
});
