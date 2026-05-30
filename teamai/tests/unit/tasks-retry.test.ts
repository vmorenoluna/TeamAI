/**
 * Tests for retryTask server action — Gap 5: qa_report.json snapshot.
 * Verifies that when retrying a failed task, the qa_report.json is
 * copied to qa_report_before_failed.json before re-running.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Hoisted shared mocks ──

const mockRevalidatePath = vi.fn();

const { mockMoveTaskToPhase } = vi.hoisted(() => ({
  mockMoveTaskToPhase: vi.fn().mockResolvedValue(undefined),
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
    getSession: vi.fn(),
    getStaleSessions: vi.fn(() => []),
  },
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  warn: vi.fn(),
  error: vi.fn(),
}));

// Mock orchestrator — uses the hoisted shared mocks
vi.mock('@/lib/orchestrator', () => ({
  getOrchestrator: vi.fn(() => ({
    moveTaskToPhase: mockMoveTaskToPhase,
    cancelPipeline: vi.fn(),
    runTask: vi.fn(),
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
  '.teamai-test-retry-' + Math.random().toString(36).slice(2, 10),
);

/** Seed a failed task with optional qa_report.json */
function seedFailedTask(
  dir: string,
  slug: string,
  options: { qaReport?: Record<string, unknown> } = {},
) {
  const taskDir = join(dir, '.teamai', slug);
  mkdirSync(taskDir, { recursive: true });

  const taskId = `task-${slug}`;
  const task = {
    id: taskId,
    title: `Failed Task ${slug}`,
    description: 'a failed task for retry testing',
    phase: 'failed',
    branch: `feat/${slug}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeFileSync(join(taskDir, 'task.json'), JSON.stringify(task, null, 2));

  // Write events.jsonl so getResumePhaseForFailedTask has data
  writeFileSync(join(taskDir, 'events.jsonl'),
    JSON.stringify({ phase: 'backlog', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ phase: 'spec', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ phase: 'plan', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ phase: 'implement', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ phase: 'qa-review', timestamp: new Date().toISOString() }) + '\n' +
    JSON.stringify({ phase: 'failed', timestamp: new Date().toISOString() }) + '\n',
  );

  if (options.qaReport) {
    writeFileSync(
      join(taskDir, 'qa_report.json'),
      JSON.stringify(options.qaReport, null, 2),
    );
  }

  return { taskId, taskDir };
}

// ── Tests ──

describe('retryTask — Gap 5: qa_report.json snapshot', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockProjectPath = TEST_DIR;
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    vi.resetModules();
  });

  it('snapshots qa_report.json to qa_report_before_failed.json before retrying', async () => {
    const slug = 'retry-with-report';
    const { taskId } = seedFailedTask(TEST_DIR, slug, {
      qaReport: {
        overall: 'FAIL',
        criteria: [
          { name: 'Security check', status: 'FAIL', notes: 'XSS vulnerability' },
          { name: 'Performance', status: 'PASS' },
        ],
        additional_issues: [
          { severity: 'critical', description: 'Memory leak in auth module' },
        ],
      },
    });

    const { retryTask } = await import('@/app/actions/tasks');
    const result = await retryTask(taskId);

    expect(result.success).toBe(true);
    expect(result.error).toBeUndefined();

    // Verify snapshot exists
    const snapshotPath = join(TEST_DIR, '.teamai', slug, 'qa_report_before_failed.json');
    expect(existsSync(snapshotPath)).toBe(true);

    // Verify snapshot content matches original
    const snapshot = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
    expect(snapshot.overall).toBe('FAIL');
    expect(snapshot.criteria).toHaveLength(2);
    expect(snapshot.criteria[0].name).toBe('Security check');
    expect(snapshot.criteria[0].notes).toBe('XSS vulnerability');
    expect(snapshot.additional_issues).toHaveLength(1);
    expect(snapshot.additional_issues[0].description).toBe('Memory leak in auth module');

    // Verify orchestrator.moveTaskToPhase was called
    expect(mockMoveTaskToPhase).toHaveBeenCalledWith(taskId, 'qa-review');

    // Verify revalidatePath was called
    expect(mockRevalidatePath).toHaveBeenCalledWith('/');
  });

  it('does not create snapshot when qa_report.json does not exist', async () => {
    const slug = 'retry-no-report';
    const { taskId } = seedFailedTask(TEST_DIR, slug); // no qaReport

    const { retryTask } = await import('@/app/actions/tasks');
    const result = await retryTask(taskId);

    expect(result.success).toBe(true);

    // No snapshot should be created
    const snapshotPath = join(TEST_DIR, '.teamai', slug, 'qa_report_before_failed.json');
    expect(existsSync(snapshotPath)).toBe(false);

    // Should still proceed with retry
    expect(mockMoveTaskToPhase).toHaveBeenCalledWith(taskId, 'qa-review');
  });

  it('overwrites existing snapshot on subsequent retry (latest state wins)', async () => {
    const slug = 'retry-snapshot-overwrite';
    const { taskId } = seedFailedTask(TEST_DIR, slug, {
      qaReport: { overall: 'FAIL', criteria: [{ name: 'Original check', status: 'FAIL' }] },
    });

    // First retry — creates snapshot
    const { retryTask } = await import('@/app/actions/tasks');
    const result1 = await retryTask(taskId);
    expect(result1.success).toBe(true);

    const snapshotPath = join(TEST_DIR, '.teamai', slug, 'qa_report_before_failed.json');
    const snapshot1 = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
    expect(snapshot1.criteria[0].name).toBe('Original check');

    // Rewrite task.json phase back to 'failed' so we can retry again
    const taskPath = join(TEST_DIR, '.teamai', slug, 'task.json');
    writeFileSync(taskPath, JSON.stringify({
      id: taskId,
      title: 'Failed Task ' + slug,
      description: 'a failed task for retry testing',
      phase: 'failed',
      branch: `feat/${slug}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2));

    // Update qa_report.json with new content (simulating a re-run)
    writeFileSync(join(TEST_DIR, '.teamai', slug, 'qa_report.json'), JSON.stringify({
      overall: 'FAIL',
      criteria: [{ name: 'Updated check after retry', status: 'FAIL' }],
    }, null, 2));

    // Second retry — should overwrite snapshot with latest state
    const result2 = await retryTask(taskId);
    expect(result2.success).toBe(true);

    const snapshot2 = JSON.parse(readFileSync(snapshotPath, 'utf-8'));
    expect(snapshot2.criteria[0].name).toBe('Updated check after retry');
  });

  it('returns error for nonexistent task', async () => {
    const { retryTask } = await import('@/app/actions/tasks');
    const result = await retryTask('nonexistent-task');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Task not found');
    expect(mockMoveTaskToPhase).not.toHaveBeenCalled();
  });

  it('returns error when task is not in failed phase', async () => {
    const slug = 'retry-wrong-phase';
    // Seed a task that is in 'done' phase, not 'failed'
    const { taskId } = seedFailedTask(TEST_DIR, slug);
    // Overwrite to done phase
    const taskPath = join(TEST_DIR, '.teamai', slug, 'task.json');
    writeFileSync(taskPath, JSON.stringify({
      id: taskId,
      title: 'Done Task',
      description: 'a done task',
      phase: 'done',
      branch: `feat/${slug}`,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2));

    const { retryTask } = await import('@/app/actions/tasks');
    const result = await retryTask(taskId);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not "failed"');
    expect(mockMoveTaskToPhase).not.toHaveBeenCalled();
  });

  it('restores qa_report.json from snapshot when report is missing before retry', async () => {
    const slug = 'retry-restore-before-snapshot';
    const { taskId, taskDir } = seedFailedTask(TEST_DIR, slug);

    // No qa_report.json — only a snapshot from a previous retry
    const snapshotContent = JSON.stringify({
      overall: 'FAIL',
      criteria: [
        { name: 'Auth check', status: 'FAIL', notes: 'Missing validation' },
      ],
    }, null, 2);
    writeFileSync(join(taskDir, 'qa_report_before_failed.json'), snapshotContent);

    const { retryTask } = await import('@/app/actions/tasks');
    const result = await retryTask(taskId);

    expect(result.success).toBe(true);

    // Verify qa_report.json was restored from snapshot
    const reportPath = join(taskDir, 'qa_report.json');
    expect(existsSync(reportPath)).toBe(true);
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('Auth check');

    // Verify the retry's own snapshot (qa_report_before_failed.json) was updated
    // with the restored content (it gets overwritten by the Gap 5 snapshot)
    const snapshotAfter = JSON.parse(readFileSync(join(taskDir, 'qa_report_before_failed.json'), 'utf-8'));
    expect(snapshotAfter.criteria[0].name).toBe('Auth check');
  });

  it('restores qa_report.json from bounce snapshot when retry snapshot is absent', async () => {
    const slug = 'retry-restore-from-bounce';
    const { taskId, taskDir } = seedFailedTask(TEST_DIR, slug);

    // Only the bounce snapshot exists (mid-pipeline QA→implement bounce)
    const bounceContent = JSON.stringify({
      overall: 'FAIL',
      criteria: [
        { name: 'Performance', status: 'FAIL', notes: 'Slow response' },
      ],
    }, null, 2);
    writeFileSync(join(taskDir, 'qa_report_before_bounce.json'), bounceContent);

    // qa_report.json does NOT exist
    expect(existsSync(join(taskDir, 'qa_report.json'))).toBe(false);

    const { retryTask } = await import('@/app/actions/tasks');
    const result = await retryTask(taskId);

    expect(result.success).toBe(true);

    // Verify restoration from bounce snapshot
    const report = JSON.parse(readFileSync(join(taskDir, 'qa_report.json'), 'utf-8'));
    expect(report.overall).toBe('FAIL');
    expect(report.criteria[0].name).toBe('Performance');

    // Now retryTask's Gap 5 snapshot should have the restored content too
    expect(existsSync(join(taskDir, 'qa_report_before_failed.json'))).toBe(true);
  });

  it('does not restore when qa_report.json already exists and no snapshot exists', async () => {
    const slug = 'retry-no-restore-needed';
    const { taskId, taskDir } = seedFailedTask(TEST_DIR, slug, {
      qaReport: { overall: 'PASS', criteria: [{ name: 'Existing', status: 'PASS' }] },
    });

    const { retryTask } = await import('@/app/actions/tasks');
    const result = await retryTask(taskId);

    expect(result.success).toBe(true);

    // qa_report.json should still have the original content (not overwritten)
    const report = JSON.parse(readFileSync(join(taskDir, 'qa_report.json'), 'utf-8'));
    expect(report.overall).toBe('PASS');
    expect(report.criteria[0].name).toBe('Existing');
  });

  it('clears completionSummary when retrying', async () => {
    const slug = 'retry-clear-summary';
    // Seed a task with completionSummary set
    const taskDir = join(TEST_DIR, '.teamai', slug);
    mkdirSync(taskDir, { recursive: true });
    const taskId = `task-${slug}`;
    writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
      id: taskId,
      title: 'Failed with summary',
      description: 'a failed task',
      phase: 'failed',
      branch: `feat/${slug}`,
      completionSummary: 'Task failed after 3 QA attempts.',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }, null, 2));

    writeFileSync(join(taskDir, 'events.jsonl'),
      JSON.stringify({ phase: 'qa-review', timestamp: new Date().toISOString() }) + '\n' +
      JSON.stringify({ phase: 'failed', timestamp: new Date().toISOString() }) + '\n',
    );

    const { retryTask } = await import('@/app/actions/tasks');
    const result = await retryTask(taskId);
    expect(result.success).toBe(true);

    // Verify completionSummary was cleared
    const updatedTask = JSON.parse(readFileSync(join(taskDir, 'task.json'), 'utf-8'));
    expect(updatedTask.completionSummary).toBeUndefined();
  });
});
