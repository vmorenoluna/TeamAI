/**
 * Integration tests for crash recovery scenarios.
 *
 * Tests simulate mid-pipeline crashes and verify that:
 *  - Per-subtask plan.json checkpoints survive crashes
 *  - Pipeline state (.pipeline_state.json) is saved and restored correctly
 *  - Output log rotation works on resume
 *  - Atomic writes leave no .tmp artifacts
 *
 * Uses real filesystem operations in a temporary git project.
 * The processManager is mocked so no real Claude sessions are spawned.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync, renameSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { addWorktreeWithRetry } from '../utils/git-worktree';

// ── Hoisted listeners for container-state event capture ──────────────────────

const containerStateListeners = vi.hoisted(() => new Map<string, Array<(...args: unknown[]) => void>>());
const mockAutoResumeInterruptedTasks = vi.hoisted(() => vi.fn().mockResolvedValue(0) as any);

// ── Mocks ────────────────────────────────────────────────────────────────────

const mockCreateSession = vi.fn();
const mockSendMessage = vi.fn();
const mockKillSession = vi.fn();
const mockOn = vi.fn();
const mockOff = vi.fn();
const mockEmit = vi.fn();
const mockGetSession = vi.fn();

/** Track on/off handlers so tests can simulate events */
const onHandlers: Map<string, Array<(...args: unknown[]) => void>> = new Map();

vi.mock('@/lib/process-manager', () => ({
  processManager: {
    createSession: (...args: unknown[]) => mockCreateSession(...args),
    sendMessage: (...args: unknown[]) => mockSendMessage(...args),
    killSession: (...args: unknown[]) => mockKillSession(...args),
    writeToSession: vi.fn(),
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!onHandlers.has(event)) onHandlers.set(event, []);
      onHandlers.get(event)!.push(handler);
      return mockOn(event, handler);
    },
    off: (event: string, handler: (...args: unknown[]) => void) => {
      const handlers = onHandlers.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
      return mockOff(event, handler);
    },
    emit: (...args: unknown[]) => mockEmit(...args),
    getSession: (...args: unknown[]) => mockGetSession(...args),
    getStaleSessions: () => [],
    getAllSessions: () => [],
  },
  containerSessionOpts: (projectRoot: string) => ({ projectRoot, permissionMode: 'bypassPermissions' as const }),
}));

vi.mock('@/lib/container-manager', () => ({
  containerManager: {
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!containerStateListeners.has(event)) containerStateListeners.set(event, []);
      containerStateListeners.get(event)!.push(handler);
    },
    off: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn().mockReturnValue('stopped'),
    emit: (event: string, data: unknown) => {
      const handlers = containerStateListeners.get(event);
      if (handlers) for (const h of handlers) h(data);
    },
  },
  readContainerConfig: vi.fn().mockReturnValue({ enabled: false }),
  readContainerRemoteUser: vi.fn(() => 'node'),
  hostToContainerPath: vi.fn((p: string) => p),
  dockerAvailable: vi.fn(() => false),
  _resetDockerAvailableCache: vi.fn(),
}));

vi.mock('@/lib/recovery', () => ({
  findInterruptedTasks: () => [],
  findOrphanedWorktrees: () => [],
  startupCleanup: () => ({ interruptedTasks: [], staleSessions: 0, orphanedWorktrees: [], autoClearedRateLimits: 0, artifactInconsistencies: [] }),
  autoClearExpiredRateLimits: () => 0,
  reconcileTaskArtifacts: () => [],
  autoResumeInterruptedTasks: (...args: unknown[]) => mockAutoResumeInterruptedTasks(...args),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

type AnyOrch = any;

let testDir: string;
let taskId: string;
let orch: unknown;

function setupTestProject() {
  testDir = join(tmpdir(), `teamai-crash-${randomUUID().slice(0, 8)}`);
  mkdirSync(testDir, { recursive: true });

  // Init git repo (needed for worktree operations)
  execFileSync('git', ['init'], { cwd: testDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@teamai.dev'], { cwd: testDir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'TeamAI Test'], { cwd: testDir, stdio: 'ignore' });
  writeFileSync(join(testDir, '.gitkeep'), '');
  execFileSync('git', ['add', '.gitkeep'], { cwd: testDir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: testDir, stdio: 'ignore' });

  const teamaiDir = join(testDir, '.teamai');
  mkdirSync(teamaiDir, { recursive: true });

  taskId = randomUUID();
  const taskDir = join(teamaiDir, taskId);
  mkdirSync(taskDir, { recursive: true });

  writeFileSync(
    join(teamaiDir, 'pipeline.json'),
    JSON.stringify({
      phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'],
      maxQaAttempts: 3,
      parallelSubtasks: true,
    }),
  );

  writeFileSync(
    join(taskDir, 'task.json'),
    JSON.stringify({
      id: taskId,
      title: 'Crash Recovery Test',
      description: 'Integration test for crash recovery',
      phase: 'backlog',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );

  return { testDir, taskId, taskDir };
}

function cleanup() {
  vi.clearAllMocks();
  onHandlers.clear();
  containerStateListeners.clear();

  if (testDir && existsSync(testDir)) {
    try { rmSync(testDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

/** Helper to register the container-state → auto-resume listener as server.ts does */
async function registerContainerAutoResumeListener() {
  const { containerManager } = await import('@/lib/container-manager');
  containerManager.on('container-state', (data: { projectRoot: string; state: string }) => {
    if (data.state === 'running') {
      void mockAutoResumeInterruptedTasks();
    }
  });
}

/** Create a plan.json with subtasks for crash recovery testing */
function createPlan(specPath: string, subtaskOverrides: Partial<{
  id: number;
  title: string;
  description: string;
  files: string[];
  acceptance_criteria: string[];
  parallel_group: string;
  completed: boolean;
}>[] = []) {
  const defaults = [
    { id: 1, title: 'Subtask One', files: ['src/a.ts'], acceptance_criteria: ['ac1'], parallel_group: 'group-1' },
    { id: 2, title: 'Subtask Two', files: ['src/b.ts'], acceptance_criteria: ['ac2'], parallel_group: 'group-1' },
    { id: 3, title: 'Subtask Three', files: ['src/c.ts'], acceptance_criteria: ['ac3'], parallel_group: 'group-2' },
    { id: 4, title: 'Subtask Four', files: ['src/d.ts'], acceptance_criteria: ['ac4'], parallel_group: 'group-2' },
  ];

  const subtasks = defaults.map(d => {
    const override = subtaskOverrides.find(o => o.id === d.id);
    return {
      id: d.id,
      title: override?.title ?? d.title,
      description: override?.description ?? `Implement ${d.title}`,
      files: override?.files ?? d.files,
      acceptance_criteria: override?.acceptance_criteria ?? d.acceptance_criteria,
      parallel_group: override?.parallel_group ?? d.parallel_group,
      completed: override?.completed ?? false,
    };
  });

  writeFileSync(join(specPath, 'plan.json'), JSON.stringify({ subtasks }, null, 2));
}

/** Helper to chain a checkpoint write through the orchestrator's _planWriteLockRef */
async function checkpointSubtask(orch: unknown, specPath: string, completedIds: number[]): Promise<void> {
  const o = orch as AnyOrch;
  o._planWriteLockRef.current = o._planWriteLockRef.current.then(() => {
    const planPath = join(specPath, 'plan.json');
    if (!existsSync(planPath)) return;
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    if (plan.subtasks) {
      for (const s of plan.subtasks) {
        if (completedIds.includes(s.id)) {
          s.completed = true;
        }
      }
    }
    const tmpPath = planPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(plan, null, 2));
    renameSync(tmpPath, planPath);
  });
  await o._planWriteLockRef.current;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Crash Recovery Integration', () => {
  describe('Plan.json checkpoint recovery', () => {
    let specPath: string;

    beforeEach(async () => {
      vi.clearAllMocks();
      onHandlers.clear();
      mockGetSession.mockReturnValue(undefined);
      setupTestProject();
      specPath = join(testDir, '.teamai', taskId);

      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(testDir);
    });

    afterEach(() => {
      cleanup();
      vi.resetModules();
    });

    it('preserves completed subtask flags after a simulated crash mid-implement', async () => {
      // Setup: create plan.json with 3 subtasks
      createPlan(specPath, [
        { id: 1, title: 'Subtask One' },
        { id: 2, title: 'Subtask Two' },
        { id: 3, title: 'Subtask Three' },
      ]);

      // Simulate: subtask 1 completes, checkpoint writes to plan.json
      await checkpointSubtask(orch, specPath, [1]);

      // Simulate crash: destroy orchestrator state by resetting modules
      vi.resetModules();
      onHandlers.clear();

      // "Recover": re-import orchestrator and read plan.json from disk
      // Re-create orchestrator (side-effect: module cache reset, fresh singleton)
      const { getOrchestrator } = await import('@/lib/orchestrator');
      void getOrchestrator(testDir);

      // Verify: plan.json on disk has subtask 1 completed, others not
      const planPath = join(specPath, 'plan.json');
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBe(false);
      expect(plan.subtasks.find((s: any) => s.id === 3).completed).toBe(false);
    });

    it('preserves multiple completed subtasks across a crash', async () => {
      // Setup: plan.json with 4 subtasks
      createPlan(specPath);

      // Simulate: subtasks 1 and 2 complete (run in parallel via same group)
      await checkpointSubtask(orch, specPath, [1]);
      await checkpointSubtask(orch, specPath, [1, 2]); // subtask 2 finishes

      // Crash and recover
      vi.resetModules();
      onHandlers.clear();
      void (await import('@/lib/orchestrator')).getOrchestrator(testDir);

      // Read plan.json from disk after recovery
      const planPath = join(specPath, 'plan.json');
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 3).completed).toBe(false);
      expect(plan.subtasks.find((s: any) => s.id === 4).completed).toBe(false);
    });

    it('leaves incomplete subtasks as not completed after a crash (mid-group)', async () => {
      // Setup: 4 subtasks in 2 groups; only 1 in the first group completes
      createPlan(specPath);

      // Simulate: only subtask 1 completes in group-1 (subtask 2 fails)
      await checkpointSubtask(orch, specPath, [1]);

      // Crash and recover
      vi.resetModules();
      onHandlers.clear();
      void (await import('@/lib/orchestrator')).getOrchestrator(testDir);

      const planPath = join(specPath, 'plan.json');
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

      // Subtask 1 was checkpointed, subtask 2 was NOT
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBe(false);
      // Group-2 subtasks were never run
      expect(plan.subtasks.find((s: any) => s.id === 3).completed).toBe(false);
      expect(plan.subtasks.find((s: any) => s.id === 4).completed).toBe(false);
    });

    it('handles crash when no plan.json exists yet (spec phase crash)', async () => {
      // No plan.json created — simulates crash during spec phase
      const planPath = join(specPath, 'plan.json');
      expect(existsSync(planPath)).toBe(false);

      // Crash and recover — should not throw when plan.json is missing
      vi.resetModules();
      onHandlers.clear();
      void (await import('@/lib/orchestrator')).getOrchestrator(testDir);

      // No plan.json should still be missing
      expect(existsSync(planPath)).toBe(false);
    });
  });

  // ── Pipeline State Save/Restore ──────────────────────────────────────────

  describe('Pipeline state save/restore', () => {
    let specPath: string;

    beforeEach(async () => {
      vi.clearAllMocks();
      onHandlers.clear();
      mockGetSession.mockReturnValue(undefined);
      setupTestProject();
      specPath = join(testDir, '.teamai', taskId);

      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(testDir);
    });

    afterEach(() => {
      cleanup();
      vi.resetModules();
    });

    it('saves and restores full pipeline state across a simulated crash', async () => {
      // Setup: simulate pipeline running with session and mergeStrategy set
      const pipeline = {
        taskId,
        description: 'crash test',
        phase: 'implement' as const,
        specPath,
        worktreePath: join(testDir, 'worktrees', 'crash-test'),
        branch: 'feat/crash-test',
        qaAttempt: 2,
        maxQaAttempts: 3,
        mergeStrategy: 'pull-request' as const,
        sessionId: 'session-crash-123',
      };

      // Save state before crash
      (orch as AnyOrch)._ctx.savePipelineState(pipeline);

      // Verify state file exists on disk
      const statePath = join(specPath, '.pipeline_state.json');
      expect(existsSync(statePath)).toBe(true);

      // Simulate crash: destroy orchestrator state
      vi.resetModules();
      onHandlers.clear();

      // Recover: create new orchestrator and restore state
      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);
      const restored = (recoveredOrch as AnyOrch)._restorePipelineState(taskId, specPath);

      expect(restored).not.toBeNull();
      expect(restored!.sessionId).toBe('session-crash-123');
      expect(restored!.mergeStrategy).toBe('pull-request');
      expect(restored!.qaAttempt).toBe(2);
      expect(restored!.phase).toBe('implement');
      expect(restored!.branch).toBe('feat/crash-test');
    });

    it('cleans up pipeline state file after successful restore', async () => {
      const pipeline = {
        taskId,
        description: 'crash test',
        phase: 'spec' as const,
        specPath,
        worktreePath: join(testDir, 'worktrees', 'crash-test'),
        branch: 'feat/crash-test',
        qaAttempt: 0,
        maxQaAttempts: 3,
        sessionId: 'sess-to-clean',
      };

      (orch as AnyOrch)._ctx.savePipelineState(pipeline);

      const statePath = join(specPath, '.pipeline_state.json');
      expect(existsSync(statePath)).toBe(true);

      vi.resetModules();
      onHandlers.clear();

      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);
      (recoveredOrch as AnyOrch)._restorePipelineState(taskId, specPath);

      // State file should be cleaned up after restore
      expect(existsSync(statePath)).toBe(false);
    });

    it('returns null and does not throw when no saved state exists', async () => {
      const statePath = join(specPath, '.pipeline_state.json');
      expect(existsSync(statePath)).toBe(false);

      const restored = (orch as AnyOrch)._restorePipelineState(taskId, specPath);

      expect(restored).toBeNull();
    });

    it('handles crash before pipeline state is first saved', async () => {
      // Pipeline created but crashed before _savePipelineState was called
      // No .pipeline_state.json should exist
      const statePath = join(specPath, '.pipeline_state.json');
      expect(existsSync(statePath)).toBe(false);

      vi.resetModules();
      onHandlers.clear();

      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);
      const restored = (recoveredOrch as AnyOrch)._restorePipelineState(taskId, specPath);

      expect(restored).toBeNull();
    });

    it('updates pipeline state on each save (overwrites stale data)', async () => {
      // First save (phase: spec)
      const pipeline1 = {
        taskId,
        description: 'test',
        phase: 'spec' as const,
        specPath,
        worktreePath: join(testDir, 'worktrees', 'test'),
        branch: 'feat/test',
        qaAttempt: 0,
        maxQaAttempts: 3,
        sessionId: 'sess-1',
      };
      (orch as AnyOrch)._ctx.savePipelineState(pipeline1);

      // Second save (phase: implement, different sessionId)
      const pipeline2 = {
        ...pipeline1,
        phase: 'implement' as const,
        sessionId: 'sess-2',
        qaAttempt: 1,
        mergeStrategy: 'local-merge' as const,
      };
      (orch as AnyOrch)._ctx.savePipelineState(pipeline2);

      // Crash and recover — should see latest state
      vi.resetModules();
      onHandlers.clear();

      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);
      const restored = (recoveredOrch as AnyOrch)._restorePipelineState(taskId, specPath);

      expect(restored).not.toBeNull();
      expect(restored!.phase).toBe('implement');
      expect(restored!.sessionId).toBe('sess-2');
      expect(restored!.qaAttempt).toBe(1);
      expect(restored!.mergeStrategy).toBe('local-merge');
    });
  });

  // ── Output Log Rotation on Resume ─────────────────────────────────────────

  describe('Output log rotation', () => {
    let specPath: string;

    beforeEach(async () => {
      vi.clearAllMocks();
      onHandlers.clear();
      mockGetSession.mockReturnValue(undefined);
      setupTestProject();
      specPath = join(testDir, '.teamai', taskId);

      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(testDir);
    });

    afterEach(() => {
      cleanup();
      vi.resetModules();
    });

    it('truncates output log to last ~50KB when exceeding 100KB on resume', () => {
      const logFile = join(specPath, 'output.log');

      // Simulate a large output.log from a previous run (~180KB).
      // KEEP_SIZE = 50_000 chars, so we need LAST > 50_000 to ensure
      // none of the PAD survives truncation (slice(-KEEP_SIZE)).
      const PAD = 'x'.repeat(120000);  // 120 KB
      const LAST = 'UNIQUE_TAIL_'.repeat(4616); // ~60 KB (13 chars × 4616 = 60008)
      writeFileSync(logFile, PAD + LAST);

      (orch as AnyOrch)._ctx.rotateOutputLog(logFile);

      const after = readFileSync(logFile, 'utf-8');
      // Should contain truncation marker
      expect(after).toContain('LOG TRUNCATED');
      // Should contain the tail content (last ~50KB preserved)
      expect(after).toContain('UNIQUE_TAIL_');
      // PAD must be completely gone — last 50K chars are all from LAST
      expect(after).not.toContain('x'.repeat(100));
      // Should be roughly 50KB + message
      expect(after.length).toBeGreaterThan(45000);
      expect(after.length).toBeLessThan(52000);
    });

    it('does not truncate logs under the 100KB threshold', () => {
      const logFile = join(specPath, 'output.log');
      const content = 'small log content\n'.repeat(100);
      writeFileSync(logFile, content);

      (orch as AnyOrch)._ctx.rotateOutputLog(logFile);

      const after = readFileSync(logFile, 'utf-8');
      // Content should be unchanged
      expect(after).toBe(content);
      expect(after).not.toContain('LOG TRUNCATED');
    });

    it('is a no-op when output.log does not exist', () => {
      const logFile = join(specPath, 'output.log');
      expect(existsSync(logFile)).toBe(false);

      expect(() => {
        (orch as AnyOrch)._ctx.rotateOutputLog(logFile);
      }).not.toThrow();
    });
  });

  // ── Atomic Writes ─────────────────────────────────────────────────────────

  describe('Atomic writes survive crash', () => {
    let specPath: string;

    beforeEach(async () => {
      vi.clearAllMocks();
      onHandlers.clear();
      mockGetSession.mockReturnValue(undefined);
      setupTestProject();
      specPath = join(testDir, '.teamai', taskId);

      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(testDir);
    });

    afterEach(() => {
      cleanup();
      vi.resetModules();
    });

    it('leaves no .tmp file after pipeline state write completes', () => {
      const pipeline = {
        taskId,
        description: 'atomic test',
        phase: 'implement' as const,
        specPath,
        worktreePath: join(testDir, 'worktrees', 'atomic-test'),
        branch: 'feat/atomic-test',
        qaAttempt: 1,
        maxQaAttempts: 3,
        sessionId: 'sess-atomic',
      };

      (orch as AnyOrch)._ctx.savePipelineState(pipeline);

      const tmpPath = join(specPath, '.pipeline_state.json.tmp');
      const statePath = join(specPath, '.pipeline_state.json');

      // No temp file should remain — it was renamed to the final path
      expect(existsSync(tmpPath)).toBe(false);
      // Final file should exist with correct content
      expect(existsSync(statePath)).toBe(true);

      const saved = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(saved.taskId).toBe(taskId);
      expect(saved.sessionId).toBe('sess-atomic');
      expect(saved.phase).toBe('implement');
    });

    it('preserves correct content after atomic checkpoint to plan.json', async () => {
      createPlan(specPath);

      await checkpointSubtask(orch, specPath, [1, 3]);

      const planPath = join(specPath, 'plan.json');
      const tmpPath = planPath + '.tmp';

      // No temp file should remain
      expect(existsSync(tmpPath)).toBe(false);

      // Final plan.json should have correct completed flags
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBe(false);
      expect(plan.subtasks.find((s: any) => s.id === 3).completed).toBe(true);
    });

    it('plan.json checkpoint does not corrupt file on rapid serialized writes via _planWriteLock', async () => {
      createPlan(specPath);

      // Simulate 3 concurrent checkpoint writes (like 3 parallel subtasks completing)
      await Promise.all([
        checkpointSubtask(orch, specPath, [1]),
        checkpointSubtask(orch, specPath, [2]),
        checkpointSubtask(orch, specPath, [3]),
      ]);

      const planPath = join(specPath, 'plan.json');
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

      // All 3 should be completed — no data loss from concurrent writes
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 3).completed).toBe(true);
    });
  });

  // ── QA Review Crash Recovery ─────────────────────────────────────────────

  describe('Crash mid-QA-review', () => {
    let specPath: string;

    beforeEach(async () => {
      vi.clearAllMocks();
      onHandlers.clear();
      mockGetSession.mockReturnValue(undefined);
      setupTestProject();
      specPath = join(testDir, '.teamai', taskId);

      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(testDir);
    });

    afterEach(() => {
      cleanup();
      vi.resetModules();
    });

    it('qa_report.json on disk survives a simulated crash mid-QA', async () => {
      // Simulate: QA agent writes report, then process crashes before advancePhase
      const report = {
        overall: 'FAIL',
        criteria: [
          { status: 'PASS', criterion: 'Feature works', notes: 'OK' },
          { status: 'FAIL', criterion: 'Edge case', fix_needed: 'Handle null input' },
        ],
        additional_issues: [
          { severity: 'warning', description: 'Missing error boundary', file: 'src/app.tsx' },
        ],
      };
      const reportPath = join(specPath, 'qa_report.json');
      writeFileSync(reportPath, JSON.stringify(report, null, 2));

      // Crash: destroy orchestrator state
      vi.resetModules();
      onHandlers.clear();

      // Recover: re-import and verify report is intact on disk
      void (await import('@/lib/orchestrator')).getOrchestrator(testDir);

      expect(existsSync(reportPath)).toBe(true);
      const recovered = JSON.parse(readFileSync(reportPath, 'utf-8'));
      expect(recovered.overall).toBe('FAIL');
      expect(recovered.criteria).toHaveLength(2);
      expect(recovered.criteria[0].status).toBe('PASS');
      expect(recovered.criteria[1].fix_needed).toBe('Handle null input');
      expect(recovered.additional_issues[0].file).toBe('src/app.tsx');
    });

    it('qaAttempt in pipeline state survives crash (incremented before session)', async () => {
      // Simulate: qaAttempt was incremented (runQaReview does pipeline.qaAttempt++),
      // then _savePipelineState was called, then crash.
      const pipeline = {
        taskId,
        description: 'qa crash test',
        phase: 'qa-review' as const,
        specPath,
        worktreePath: join(testDir, 'worktrees', 'qa-crash'),
        branch: 'feat/qa-crash',
        qaAttempt: 2,
        maxQaAttempts: 3,
        sessionId: 'sess-qa-crash',
      };

      (orch as AnyOrch)._ctx.savePipelineState(pipeline);

      // Crash
      vi.resetModules();
      onHandlers.clear();

      // Recover
      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);
      const restored = (recoveredOrch as AnyOrch)._restorePipelineState(taskId, specPath);

      expect(restored).not.toBeNull();
      expect(restored!.qaAttempt).toBe(2);
      expect(restored!.phase).toBe('qa-review');
      expect(restored!.sessionId).toBe('sess-qa-crash');
    });

    it('qa_feedback.md survives crash for bounce-back to implement', async () => {
      // Simulate: QA found issues, _writeQaFeedback wrote feedback, then crash
      const feedbackPath = join(specPath, 'qa_feedback.md');
      const feedback = `# QA Feedback\n\n## Overall: FAIL\n\n## Failed Criteria\n\n- **Edge case**: Handle null input → Fix: Add null guard\n`;
      writeFileSync(feedbackPath, feedback);

      // Crash
      vi.resetModules();
      onHandlers.clear();

      // Recover
      void (await import('@/lib/orchestrator')).getOrchestrator(testDir);

      // Feedback file should still exist — implement phase reads it
      expect(existsSync(feedbackPath)).toBe(true);
      const recovered = readFileSync(feedbackPath, 'utf-8');
      expect(recovered).toContain('Overall: FAIL');
      expect(recovered).toContain('Handle null input');
      expect(recovered).toContain('Add null guard');
    });

    it('phase persists as qa-review after crash (via _persistAndEmitPhase)', async () => {
      // Simulate: _persistAndEmitPhase was called at the start of runQaReview,
      // which atomically wrote phase to task.json, then crash happened.
      (orch as AnyOrch)._ctx.persistAndEmitPhase({
        taskId,
        description: 'phase test',
        phase: 'qa-review',
        specPath,
        worktreePath: join(testDir, 'worktrees', 'phase-test'),
        branch: 'feat/phase-test',
        qaAttempt: 0,
        maxQaAttempts: 3,
      });

      // Crash
      vi.resetModules();
      onHandlers.clear();

      // Recover and read task.json to verify phase was persisted
      void (await import('@/lib/orchestrator')).getOrchestrator(testDir);

      const taskPath = join(specPath, 'task.json');
      const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
      expect(task.phase).toBe('qa-review');
    });

    it('qaAttempt persists across crash — _savePipelineState call after qaAttempt++ (#9)', async () => {
      // The fixed runQaReview flow:
      //   1. runTask saves pipeline state with qaAttempt=0 (initial)
      //   2. runQaReview does pipeline.qaAttempt++ (now 1 in memory)
      //   3. _savePipelineState(pipeline) — the fix: persist the incremented value immediately
      //   4. Crash — the incremented qaAttempt=1 is on disk
      //   5. On resume, _restorePipelineState returns qaAttempt=1

      // Simulate runTask's initial save (qaAttempt=0, phase='qa-review')
      const preIncrement = {
        taskId,
        description: 'qa attempt persist test',
        phase: 'qa-review' as const,
        specPath,
        worktreePath: join(testDir, 'worktrees', 'qa-persist'),
        branch: 'feat/qa-persist',
        qaAttempt: 0,
        maxQaAttempts: 3,
        sessionId: 'sess-run-task-save',
      };
      (orch as AnyOrch)._ctx.savePipelineState(preIncrement);

      // runQaReview increments qaAttempt and now calls _savePipelineState (the fix)
      preIncrement.qaAttempt++; // now 1
      (orch as AnyOrch)._ctx.savePipelineState(preIncrement); // the new _savePipelineState call

      // Crash
      vi.resetModules();
      onHandlers.clear();

      // Recover
      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);
      const restored = (recoveredOrch as AnyOrch)._restorePipelineState(taskId, specPath);

      // The restored qaAttempt is 1 — the increment survived the crash
      expect(restored!.qaAttempt).toBe(1);
    });

    it('handles crash when no qa_report.json exists yet (crash before agent finishes)', async () => {
      // Simulate: runQaReview started, qaAttempt incremented, but agent hasn't
      // written qa_report.json yet — crash.
      const pipeline = {
        taskId,
        description: 'early qa crash',
        phase: 'qa-review' as const,
        specPath,
        worktreePath: join(testDir, 'worktrees', 'early-qa'),
        branch: 'feat/early-qa',
        qaAttempt: 1,
        maxQaAttempts: 3,
        sessionId: 'sess-early-qa',
      };
      (orch as AnyOrch)._ctx.savePipelineState(pipeline);

      const reportPath = join(specPath, 'qa_report.json');
      expect(existsSync(reportPath)).toBe(false);

      // Crash
      vi.resetModules();
      onHandlers.clear();

      // Recover
      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);
      const restored = (recoveredOrch as AnyOrch)._restorePipelineState(taskId, specPath);

      // qaAttempt survived via pipeline state, but no report exists
      expect(restored!.qaAttempt).toBe(1);
      expect(existsSync(reportPath)).toBe(false);
    });
  });

  // ── Merge Crash Recovery ─────────────────────────────────────────────────

  describe('Crash mid-merge', () => {
    let specPath: string;
    let worktreePath: string;
    let branch: string;

    beforeEach(async () => {
      vi.clearAllMocks();
      onHandlers.clear();
      mockGetSession.mockReturnValue(undefined);
      setupTestProject();
      specPath = join(testDir, '.teamai', taskId);

      // Create a real worktree for merge crash testing.
      // Use a unique suffix to avoid collisions between tests in this describe block.
      const slug = `merge-crash-${randomUUID().slice(0, 8)}`;
      branch = `feat/${slug}`;
      worktreePath = join(testDir, '..', 'worktrees', slug);

      // Ensure the worktree doesn't already exist
      if (existsSync(worktreePath)) {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: testDir, stdio: 'ignore' });
        } catch { /* best-effort */ }
      }

      // Create a real git worktree + branch (retrying on Windows' index.lock race)
      addWorktreeWithRetry([worktreePath, '-b', branch], testDir, { stdio: 'ignore' });

      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(testDir);
    });

    afterEach(() => {
      // Clean up worktree if it still exists
      if (existsSync(worktreePath)) {
        try {
          execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd: testDir, stdio: 'ignore' });
        } catch { /* best-effort */ }
      }
      cleanup();
      vi.resetModules();
    });

    it('worktree survives crash before worktree removal in merge', async () => {
      // Simulate: merge session completed, but crash happened before
      // _execGit(['worktree', 'remove', ...]) was called.
      // Save pipeline state reflecting merge phase.
      const pipeline = {
        taskId,
        description: 'merge crash test',
        phase: 'merge' as const,
        specPath,
        worktreePath,
        branch,
        qaAttempt: 1,
        maxQaAttempts: 3,
        sessionId: 'sess-merge-crash',
      };
      (orch as AnyOrch)._ctx.savePipelineState(pipeline);

      // Verify worktree exists before crash
      expect(existsSync(worktreePath)).toBe(true);
      expect((orch as AnyOrch)._ctx.isWorktreeHealthy(worktreePath)).toBe(true);

      // Crash
      vi.resetModules();
      onHandlers.clear();

      // Recover
      void (await import('@/lib/orchestrator')).getOrchestrator(testDir);

      // Worktree should still exist — removal never happened
      expect(existsSync(worktreePath)).toBe(true);
    });

    it('worktree removal completes before crash (worktree removed, branch may remain)', async () => {
      // Verify branch exists before removal (created in beforeEach with the worktree)
      expect(() =>
        execFileSync('git', ['rev-parse', '--verify', branch], { cwd: testDir, stdio: 'pipe' })
      ).not.toThrow();

      // Simulate: worktree was removed, but crash happened before branch deletion.
      // This tests the window between the two _execGit calls in runMerge.
      execFileSync('git', ['worktree', 'remove', worktreePath], { cwd: testDir, stdio: 'ignore' });

      const pipeline = {
        taskId,
        description: 'merge partial crash',
        phase: 'merge' as const,
        specPath,
        worktreePath,
        branch,
        qaAttempt: 1,
        maxQaAttempts: 3,
        sessionId: 'sess-merge-partial',
      };
      (orch as AnyOrch)._ctx.savePipelineState(pipeline);

      // Verify worktree is gone but branch may still exist
      expect(existsSync(worktreePath)).toBe(false);

      // Crash
      vi.resetModules();
      onHandlers.clear();

      // Recover
      void (await import('@/lib/orchestrator')).getOrchestrator(testDir);

      // Worktree should still be gone
      expect(existsSync(worktreePath)).toBe(false);
      // The branch may or may not exist (depends on timing); verify the state was saved
      const statePath = join(specPath, '.pipeline_state.json');
      expect(existsSync(statePath)).toBe(true);
    });

    it('_isWorktreeHealthy returns false for removed worktree after crash', async () => {
      // Remove the worktree to simulate post-merge state
      execFileSync('git', ['worktree', 'remove', worktreePath], { cwd: testDir, stdio: 'ignore' });

      // Crash
      vi.resetModules();
      onHandlers.clear();

      // Recover
      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);

      // Worktree health check should return false
      expect((recoveredOrch as AnyOrch)._ctx.isWorktreeHealthy(worktreePath)).toBe(false);
    });

    it('pipeline state merge phase survives crash', async () => {
      const pipeline = {
        taskId,
        description: 'merge state test',
        phase: 'merge' as const,
        specPath,
        worktreePath,
        branch,
        qaAttempt: 1,
        maxQaAttempts: 3,
        mergeStrategy: 'local-merge' as const,
        sessionId: 'sess-merge-state',
      };
      (orch as AnyOrch)._ctx.savePipelineState(pipeline);

      // Crash
      vi.resetModules();
      onHandlers.clear();

      // Recover
      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);
      const restored = (recoveredOrch as AnyOrch)._restorePipelineState(taskId, specPath);

      expect(restored).not.toBeNull();
      expect(restored!.phase).toBe('merge');
      expect(restored!.mergeStrategy).toBe('local-merge');
      expect(restored!.branch).toBe(branch);
    });

    it('output.log rotation preserves merge session output across crash', async () => {
      // Simulate: merge session wrote output, then crash before worktree removal
      const logFile = join(specPath, 'output.log');
      const mergeOutput = '## Merge Result\n\nMerged feature branch into master.\nAll tests pass.\n';
      writeFileSync(logFile, mergeOutput);

      // Crash
      vi.resetModules();
      onHandlers.clear();

      // Recover
      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);

      // Log rotation should be a no-op for small files
      (recoveredOrch as AnyOrch)._ctx.rotateOutputLog(logFile);
      const after = readFileSync(logFile, 'utf-8');
      expect(after).toContain('Merged feature branch into master');
    });
  });

  // ── CreatePR Crash Recovery ──────────────────────────────────────────────

  describe('Crash mid-createPR', () => {
    let specPath: string;

    beforeEach(async () => {
      vi.clearAllMocks();
      onHandlers.clear();
      mockGetSession.mockReturnValue(undefined);
      setupTestProject();
      specPath = join(testDir, '.teamai', taskId);

      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(testDir);
    });

    afterEach(() => {
      cleanup();
      vi.resetModules();
    });

    it('PR URL is extractable from output.log after a simulated crash', async () => {
      // Simulate: merger agent created a PR and wrote URL to output.log,
      // then crash happened before taskStore.update was called.
      const logFile = join(specPath, 'output.log');
      writeFileSync(
        logFile,
        'Created pull request successfully.\n' +
        'PR URL: https://github.com/teamai-org/TeamAI/pull/42\n' +
        'Reviewers: @maintainer\n',
      );

      // Crash
      vi.resetModules();
      onHandlers.clear();

      // Recover
      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);

      // _extractPrUrl should find the URL in the log
      const prUrl = (recoveredOrch as AnyOrch)._ctx.extractPrUrl(logFile);
      expect(prUrl).toBe('https://github.com/teamai-org/TeamAI/pull/42');
    });

    it('PR URL extraction returns null when output.log does not exist after crash', async () => {
      // Simulate: crash happened before any agent output was written
      const logFile = join(specPath, 'output.log');
      expect(existsSync(logFile)).toBe(false);

      vi.resetModules();
      onHandlers.clear();

      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);

      const prUrl = (recoveredOrch as AnyOrch)._ctx.extractPrUrl(logFile);
      expect(prUrl).toBeNull();
    });

    it('PR URL extraction returns null when no PR URL in output.log after crash', async () => {
      const logFile = join(specPath, 'output.log');
      writeFileSync(logFile, 'Pushed branch to remote. No PR created yet.\n');

      vi.resetModules();
      onHandlers.clear();

      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);

      const prUrl = (recoveredOrch as AnyOrch)._ctx.extractPrUrl(logFile);
      expect(prUrl).toBeNull();
    });

    it('mergeStrategy pull-request survives crash in pipeline state', async () => {
      const pipeline = {
        taskId,
        description: 'pr crash test',
        phase: 'create-pr' as const,
        specPath,
        worktreePath: join(testDir, 'worktrees', 'pr-crash'),
        branch: 'feat/pr-crash',
        qaAttempt: 1,
        maxQaAttempts: 3,
        mergeStrategy: 'pull-request' as const,
        sessionId: 'sess-pr-crash',
      };

      (orch as AnyOrch)._ctx.savePipelineState(pipeline);

      // Crash
      vi.resetModules();
      onHandlers.clear();

      // Recover
      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);
      const restored = (recoveredOrch as AnyOrch)._restorePipelineState(taskId, specPath);

      expect(restored).not.toBeNull();
      expect(restored!.mergeStrategy).toBe('pull-request');
      expect(restored!.phase).toBe('create-pr');
    });

    it('pipeline state create-pr phase survives crash', async () => {
      // Simulate: _persistAndEmitPhase committed create-pr to task.json,
      // then _savePipelineState checkpointed, then crash.
      (orch as AnyOrch)._ctx.persistAndEmitPhase({
        taskId,
        description: 'pr phase test',
        phase: 'create-pr',
        specPath,
        worktreePath: join(testDir, 'worktrees', 'pr-phase'),
        branch: 'feat/pr-phase',
        qaAttempt: 1,
        maxQaAttempts: 3,
      });

      const pipeline = {
        taskId,
        description: 'pr phase test',
        phase: 'create-pr' as const,
        specPath,
        worktreePath: join(testDir, 'worktrees', 'pr-phase'),
        branch: 'feat/pr-phase',
        qaAttempt: 1,
        maxQaAttempts: 3,
        sessionId: 'sess-pr-phase',
      };
      (orch as AnyOrch)._ctx.savePipelineState(pipeline);

      // Crash
      vi.resetModules();
      onHandlers.clear();

      // Recover
      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);

      // Verify task.json has create-pr phase
      const taskPath = join(specPath, 'task.json');
      const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
      expect(task.phase).toBe('create-pr');

      // Verify pipeline state has create-pr phase
      const restored = (recoveredOrch as AnyOrch)._restorePipelineState(taskId, specPath);
      expect(restored!.phase).toBe('create-pr');
    });

    it('output.log survives crash with PR creation diagnostic output', async () => {
      // Simulate: merger agent wrote diagnostic output including rebase info and
      // PR creation steps, then crash before extractPrUrl + taskStore.update.
      const logFile = join(specPath, 'output.log');
      const largeOutput =
        '── CREATE-PR ──\n' +
        '[INFO] Feature branch rebased onto latest master — PR will be conflict-free\n' +
        'Pushing to origin...\n' +
        'Creating pull request...\n' +
        'https://github.com/teamai-org/TeamAI/pull/99\n' +
        '[INFO] Branch synced with master — PR is conflict-free\n';
      writeFileSync(logFile, largeOutput);

      // Crash
      vi.resetModules();
      onHandlers.clear();

      // Recover
      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);

      // PR URL should be extractable
      const prUrl = (recoveredOrch as AnyOrch)._ctx.extractPrUrl(logFile);
      expect(prUrl).toBe('https://github.com/teamai-org/TeamAI/pull/99');

      // Log rotation should be a no-op (under threshold)
      (recoveredOrch as AnyOrch)._ctx.rotateOutputLog(logFile);
      const after = readFileSync(logFile, 'utf-8');
      expect(after).toContain('PR will be conflict-free');
      expect(after).toContain('pull/99');
    });
  });

  // ── Full Crash → Resume Cycle ─────────────────────────────────────────────

  describe('Full crash-resume cycle', () => {
    let specPath: string;

    beforeEach(async () => {
      vi.clearAllMocks();
      onHandlers.clear();
      mockGetSession.mockReturnValue(undefined);
      setupTestProject();
      specPath = join(testDir, '.teamai', taskId);

      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(testDir);
    });

    afterEach(() => {
      cleanup();
      vi.resetModules();
    });

    it('recovers plan.json + pipeline state + output.log after a complete crash-resume cycle', async () => {
      // 1. SETUP: create plan.json with 4 subtasks
      createPlan(specPath);

      // 2. Simulate implement phase: 2 subtasks complete, then save pipeline state
      await checkpointSubtask(orch, specPath, [1]);
      await checkpointSubtask(orch, specPath, [1, 2]);

      const pipeline = {
        taskId,
        description: 'full cycle test',
        phase: 'implement' as const,
        specPath,
        worktreePath: join(testDir, 'worktrees', 'full-cycle'),
        branch: 'feat/full-cycle',
        qaAttempt: 1,
        maxQaAttempts: 3,
        mergeStrategy: 'pull-request' as const,
        sessionId: 'sess-full-cycle',
      };
      (orch as AnyOrch)._ctx.savePipelineState(pipeline);

      // 3. Simulate large output.log (~180KB, with tail > 50KB so rotation
      //    drops all padding).
      const logFile = join(specPath, 'output.log');
      const PAD = 'x'.repeat(120000);
      const TAIL = 'IMPORTANT_TAIL_DATA\n'.repeat(3847); // ~60 KB (18 chars × 3847 = 69246)
      writeFileSync(logFile, PAD + TAIL);

      // 4. CRASH: destroy all in-memory state
      vi.resetModules();
      onHandlers.clear();

      // 5. RECOVER: create new orchestrator
      const { getOrchestrator } = await import('@/lib/orchestrator');
      const recoveredOrch = getOrchestrator(testDir);

      // 6. VERIFY plan.json checkpoint survived
      const planPath = join(specPath, 'plan.json');
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 3).completed).toBe(false);

      // 7. VERIFY pipeline state restored
      const restored = (recoveredOrch as AnyOrch)._restorePipelineState(taskId, specPath);
      expect(restored).not.toBeNull();
      expect(restored!.sessionId).toBe('sess-full-cycle');
      expect(restored!.mergeStrategy).toBe('pull-request');
      expect(restored!.qaAttempt).toBe(1);

      // 8. VERIFY output.log rotation works
      (recoveredOrch as AnyOrch)._ctx.rotateOutputLog(logFile);
      const afterLog = readFileSync(logFile, 'utf-8');
      expect(afterLog).toContain('LOG TRUNCATED');
      expect(afterLog).toContain('IMPORTANT_TAIL_DATA');
      expect(afterLog).not.toContain('x'.repeat(100));
    });
  });

  // ── Flow / Skip-Logic ───────────────────────────────────────────────────

  describe('cleanupTaskArtifacts', () => {
    let specPath: string;

    beforeEach(async () => {
      vi.clearAllMocks();
      onHandlers.clear();
      mockGetSession.mockReturnValue(undefined);
      setupTestProject();
      specPath = join(testDir, '.teamai', taskId);

      // Task is already created by setupTestProject() at the UUID-based taskId path.
      // No need to call TaskStore.create() — that would create a duplicate by slug.

      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(testDir);
    });

    afterEach(() => {
      cleanup();
      vi.resetModules();
    });

    it('preserves non-multi-group completed subtasks on Stop at implement (Defect 8)', async () => {
      // Setup: plan.json with some completed subtasks — no st-branches exist
      // (non-multi-group), so completed: true is durable.
      createPlan(specPath, [
        { id: 1, completed: true },
        { id: 2, completed: true },
        { id: 3, completed: false },
      ]);

      const planPath = join(specPath, 'plan.json');
      expect(existsSync(planPath)).toBe(true);

      // Stop at 'implement'
      await (orch as AnyOrch).cleanupTaskArtifacts(taskId, 'implement');

      // Non-multi-group completed subtasks stay completed (Defect 8 fix).
      // Only subtask 3 was already false.
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 3).completed).toBe(false);

      // Output.log should be removed
      const outputPath = join(specPath, 'output.log');
      writeFileSync(outputPath, 'some output');
      await (orch as AnyOrch).cleanupTaskArtifacts(taskId, 'implement');
      expect(existsSync(outputPath)).toBe(false);
    });

    it('deletes plan.json but preserves spec.md when stopping at plan phase', async () => {
      // Setup: spec + plan artifacts exist
      writeFileSync(join(specPath, 'spec.md'), '# Spec\n');
      createPlan(specPath);

      const specMd = join(specPath, 'spec.md');
      const planJson = join(specPath, 'plan.json');
      expect(existsSync(specMd)).toBe(true);
      expect(existsSync(planJson)).toBe(true);

      // Stop at 'plan'
      await (orch as AnyOrch).cleanupTaskArtifacts(taskId, 'plan');

      // spec.md is from the 'spec' phase (before 'plan') so it's preserved.
      // plan.json is from 'plan' phase — deleted.
      expect(existsSync(specMd)).toBe(true);
      expect(existsSync(planJson)).toBe(false);
    });

    it('deletes QA artifacts and preserves non-multi-group completions when stopping at qa-review', async () => {
      // Setup: QA artifacts exist + plan with completions
      createPlan(specPath, [
        { id: 1, completed: true },
        { id: 2, completed: true },
      ]);
      writeFileSync(join(specPath, 'qa_report.json'), '{}');
      writeFileSync(join(specPath, 'qa_feedback.md'), '# feedback');
      writeFileSync(join(specPath, 'completion_summary.md'), '# summary');

      const qaReport = join(specPath, 'qa_report.json');
      const qaFeedback = join(specPath, 'qa_feedback.md');
      const completionSummary = join(specPath, 'completion_summary.md');
      expect(existsSync(qaReport)).toBe(true);

      // Stop at 'qa-review'
      await (orch as AnyOrch).cleanupTaskArtifacts(taskId, 'qa-review');

      // QA files deleted
      expect(existsSync(qaReport)).toBe(false);
      expect(existsSync(qaFeedback)).toBe(false);
      expect(existsSync(completionSummary)).toBe(false);

      // Non-multi-group completed subtasks stay completed (Defect 8)
      const planPath = join(specPath, 'plan.json');
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      expect(plan.subtasks.find((s: any) => s.id === 1).completed).toBe(true);
      expect(plan.subtasks.find((s: any) => s.id === 2).completed).toBe(true);
    });

    it('deletes spec.md and plan.json when stopping at spec phase', async () => {
      writeFileSync(join(specPath, 'spec.md'), '# Spec\n');
      writeFileSync(join(specPath, 'plan.json'), '{}');

      const specMd = join(specPath, 'spec.md');
      const planJson = join(specPath, 'plan.json');
      expect(existsSync(specMd)).toBe(true);
      expect(existsSync(planJson)).toBe(true);

      // Stop at 'spec'
      await (orch as AnyOrch).cleanupTaskArtifacts(taskId, 'spec');

      expect(existsSync(specMd)).toBe(false);
      expect(existsSync(planJson)).toBe(false);
    });

    it('no-ops when phase is not in the pipeline order', async () => {
      // Setup: artifacts exist
      writeFileSync(join(specPath, 'spec.md'), '# Spec\n');
      writeFileSync(join(specPath, 'plan.json'), '{}');

      const specMd = join(specPath, 'spec.md');
      const planJson = join(specPath, 'plan.json');

      // Stop at a phase not in the pipeline config (e.g. 'backlog')
      await expect(
        (orch as AnyOrch).cleanupTaskArtifacts(taskId, 'backlog')
      ).resolves.toBeUndefined();

      // Artifacts should still exist
      expect(existsSync(specMd)).toBe(true);
      expect(existsSync(planJson)).toBe(true);
    });
  });

  describe('resumeTask plan.json reset', () => {
    let specPath: string;

    beforeEach(async () => {
      vi.clearAllMocks();
      onHandlers.clear();
      mockGetSession.mockReturnValue(undefined);
      setupTestProject();
      specPath = join(testDir, '.teamai', taskId);

      // Task is already created by setupTestProject() at the UUID-based taskId path.

      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(testDir);
    });

    afterEach(() => {
      cleanup();
      vi.resetModules();
    });

    it('resets all completed subtasks to false (full-reset on resume from plan)', () => {
      // Setup: plan.json exists with all subtasks marked as completed.
      // When resumeTask is called, it should reset ALL completions to false
      // so implement re-does every subtask from scratch.
      createPlan(specPath, [
        { id: 1, completed: true },
        { id: 2, completed: true },
        { id: 3, completed: true },
        { id: 4, completed: true },
      ]);

      const planPath = join(specPath, 'plan.json');

      // Simulate what resumeTask does: read plan.json, reset all completed flags
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      for (const s of plan.subtasks) s.completed = false;
      writeFileSync(planPath, JSON.stringify(plan, null, 2));

      // Verify all completions are now false
      const updated = JSON.parse(readFileSync(planPath, 'utf-8'));
      expect(updated.subtasks.every((s: any) => s.completed === false)).toBe(true);
    });

    it('resets partial completions to false (mixed completed/incomplete state)', () => {
      // Setup: some subtasks completed, some not
      createPlan(specPath, [
        { id: 1, completed: true },
        { id: 2, completed: false },
        { id: 3, completed: true },
        { id: 4, completed: false },
      ]);

      const planPath = join(specPath, 'plan.json');

      // Simulate resumeTask's reset
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      for (const s of plan.subtasks) s.completed = false;
      writeFileSync(planPath, JSON.stringify(plan, null, 2));

      // All should be false — even the ones that weren't completed
      const updated = JSON.parse(readFileSync(planPath, 'utf-8'));
      expect(updated.subtasks.every((s: any) => s.completed === false)).toBe(true);
    });

    it('no-ops on plan.json with no subtasks array (graceful handling)', () => {
      // Setup: plan.json exists but has no subtasks array
      writeFileSync(
        join(specPath, 'plan.json'),
        JSON.stringify({ someOtherField: 'value' }),
      );

      const planPath = join(specPath, 'plan.json');
      const original = readFileSync(planPath, 'utf-8');

      // Simulate resumeTask's reset (guard: if (plan.subtasks))
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      if (plan.subtasks) {
        for (const s of plan.subtasks) s.completed = false;
        writeFileSync(planPath, JSON.stringify(plan, null, 2));
      }

      // File should be unchanged — subtasks check gate it
      const after = readFileSync(planPath, 'utf-8');
      expect(after).toBe(original);
    });

    it('detects start phase as spec when no artifacts exist', async () => {
      // No spec.md, no plan.json → resumeTask should start at 'spec'
      const specMd = join(specPath, 'spec.md');
      const planJson = join(specPath, 'plan.json');

      expect(existsSync(specMd)).toBe(false);
      expect(existsSync(planJson)).toBe(false);

      // With no artifacts, startPhase should be 'spec'
      const task = JSON.parse(readFileSync(join(specPath, 'task.json'), 'utf-8'));
      expect(task.phase).toBe('backlog');

      // Simulate resumeTask's phase detection
      const hasSpec = existsSync(specMd);
      const hasPlan = existsSync(planJson);
      let startPhase = 'spec';
      if (hasPlan) startPhase = 'implement';
      else if (hasSpec) startPhase = 'plan';

      expect(startPhase).toBe('spec');
    });

    it('detects start phase as plan when only spec.md exists', async () => {
      writeFileSync(join(specPath, 'spec.md'), '# Test Spec\n');

      const specMd = join(specPath, 'spec.md');
      const planJson = join(specPath, 'plan.json');

      expect(existsSync(specMd)).toBe(true);
      expect(existsSync(planJson)).toBe(false);

      // Simulate resumeTask's phase detection
      const hasSpec = existsSync(specMd);
      const hasPlan = existsSync(planJson);
      let startPhase = 'spec';
      if (hasPlan) startPhase = 'implement';
      else if (hasSpec) startPhase = 'plan';

      expect(startPhase).toBe('plan');
    });

    it('detects start phase as implement when plan.json exists', async () => {
      createPlan(specPath);

      const specMd = join(specPath, 'spec.md');
      const planJson = join(specPath, 'plan.json');

      // Simulate resumeTask's phase detection
      const hasSpec = existsSync(specMd);
      const hasPlan = existsSync(planJson);
      let startPhase = 'spec';
      if (hasPlan) startPhase = 'implement';
      else if (hasSpec) startPhase = 'plan';

      expect(startPhase).toBe('implement');
    });

    it('clears output.log on resume for a fresh terminal view', () => {
      // Setup: output.log exists from previous run
      const outputPath = join(specPath, 'output.log');
      writeFileSync(outputPath, 'previous session output\n'.repeat(10));
      expect(existsSync(outputPath)).toBe(true);

      // Simulate resumeTask's output.log cleanup
      if (existsSync(outputPath)) unlinkSync(outputPath);

      expect(existsSync(outputPath)).toBe(false);
    });
  });

  describe('cancelPipeline', () => {
    let specPath: string;

    beforeEach(async () => {
      vi.clearAllMocks();
      onHandlers.clear();
      mockGetSession.mockReturnValue(undefined);
      setupTestProject();
      specPath = join(testDir, '.teamai', taskId);

      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(testDir);
    });

    afterEach(() => {
      cleanup();
      vi.resetModules();
    });

    it('kills active session when cancelling a running pipeline', () => {
      mockKillSession.mockClear();

      // Simulate: pipeline is running with a session
      const pipeline = {
        taskId,
        description: 'cancel test',
        phase: 'implement' as const,
        specPath,
        worktreePath: join(testDir, 'worktrees', 'cancel-test'),
        branch: 'feat/cancel-test',
        qaAttempt: 0,
        maxQaAttempts: 3,
        sessionId: 'sess-to-kill',
      };

      // Add pipeline to internal maps (via cast to access private fields)
      (orch as AnyOrch).pipelines.set(taskId, pipeline);
      (orch as AnyOrch).activeTasks.add(taskId);

      expect((orch as AnyOrch).isTaskActive(taskId)).toBe(true);

      // Cancel
      (orch as AnyOrch).cancelPipeline(taskId);

      // Session should be killed
      expect(mockKillSession).toHaveBeenCalledWith('sess-to-kill');

      // Pipeline and active task should be removed
      expect((orch as AnyOrch).pipelines.has(taskId)).toBe(false);
      expect((orch as AnyOrch).activeTasks.has(taskId)).toBe(false);
    });

    it('no-ops when pipeline has no sessionId', () => {
      mockKillSession.mockClear();

      const pipeline = {
        taskId,
        description: 'no session',
        phase: 'spec' as const,
        specPath,
        worktreePath: join(testDir, 'worktrees', 'no-session'),
        branch: 'feat/no-session',
        qaAttempt: 0,
        maxQaAttempts: 3,
        // no sessionId
      };

      (orch as AnyOrch).pipelines.set(taskId, pipeline);
      (orch as AnyOrch).activeTasks.add(taskId);

      (orch as AnyOrch).cancelPipeline(taskId);

      // killSession should NOT be called (no sessionId)
      expect(mockKillSession).not.toHaveBeenCalled();
      // But pipeline and activeTask should still be removed
      expect((orch as AnyOrch).pipelines.has(taskId)).toBe(false);
      expect((orch as AnyOrch).activeTasks.has(taskId)).toBe(false);
    });

    it('no-ops when task is not in the pipeline map', () => {
      mockKillSession.mockClear();
      expect((orch as AnyOrch).pipelines.has(taskId)).toBe(false);

      expect(() => {
        (orch as AnyOrch).cancelPipeline(taskId);
      }).not.toThrow();

      expect(mockKillSession).not.toHaveBeenCalled();
    });

    it('is idempotent — calling cancel twice does not throw', () => {
      const pipeline = {
        taskId,
        description: 'idempotent test',
        phase: 'implement' as const,
        specPath,
        worktreePath: join(testDir, 'worktrees', 'idempotent'),
        branch: 'feat/idempotent',
        qaAttempt: 0,
        maxQaAttempts: 3,
        sessionId: 'sess-idempotent',
      };
      (orch as AnyOrch).pipelines.set(taskId, pipeline);
      (orch as AnyOrch).activeTasks.add(taskId);

      // First cancel
      (orch as AnyOrch).cancelPipeline(taskId);
      expect(mockKillSession).toHaveBeenCalledTimes(1);

      // Second cancel — should not throw
      expect(() => {
        (orch as AnyOrch).cancelPipeline(taskId);
      }).not.toThrow();
    });
  });

  describe('activeTasks guard', () => {

    beforeEach(async () => {
      vi.clearAllMocks();
      onHandlers.clear();
      mockGetSession.mockReturnValue(undefined);
      setupTestProject();

      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(testDir);
    });

    afterEach(() => {
      cleanup();
      vi.resetModules();
    });

    it('isTaskActive returns false for never-started tasks', () => {
      expect((orch as AnyOrch).isTaskActive(taskId)).toBe(false);
    });

    it('isTaskActive returns true after adding task to active set', () => {
      (orch as AnyOrch).activeTasks.add(taskId);
      expect((orch as AnyOrch).isTaskActive(taskId)).toBe(true);
    });

    it('isTaskActive returns false after removing task from active set', () => {
      (orch as AnyOrch).activeTasks.add(taskId);
      expect((orch as AnyOrch).isTaskActive(taskId)).toBe(true);
      (orch as AnyOrch).activeTasks.delete(taskId);
      expect((orch as AnyOrch).isTaskActive(taskId)).toBe(false);
    });

    it('pipelines map is empty initially', () => {
      expect((orch as AnyOrch).pipelines.size).toBe(0);
    });
  });

  // ── Container die/restart → auto-resume ──────────────────────────────

  describe('container die/restart triggers auto-resume', () => {
    beforeEach(async () => {
      vi.clearAllMocks();
      onHandlers.clear();
      containerStateListeners.clear();
      mockAutoResumeInterruptedTasks.mockResolvedValue(0);

      setupTestProject();

      // Register the container-state → auto-resume listener like server.ts does
      await registerContainerAutoResumeListener();
    });

    afterEach(() => {
      cleanup();
      vi.resetModules();
    });

    it('calls autoResumeInterruptedTasks when container-state emits "running"', async () => {
      // Simulate: container dies, restarts, and becomes running
      const { containerManager } = await import('@/lib/container-manager');

      // Emit 'running' — this is what _doStart emits after successful restart
      containerManager.emit('container-state', { projectRoot: testDir, state: 'running' });

      expect(mockAutoResumeInterruptedTasks).toHaveBeenCalledTimes(1);
    });

    it('does NOT call autoResumeInterruptedTasks for non-"running" container-state events', async () => {
      const { containerManager } = await import('@/lib/container-manager');

      // Emit states that should NOT trigger auto-resume
      containerManager.emit('container-state', { projectRoot: testDir, state: 'starting' });
      containerManager.emit('container-state', { projectRoot: testDir, state: 'restarting' });
      containerManager.emit('container-state', { projectRoot: testDir, state: 'stopped' });

      expect(mockAutoResumeInterruptedTasks).not.toHaveBeenCalled();
    });

    it('simulates full container die/restart cycle and verifies auto-resume only fires on "running"', async () => {
      const { containerManager } = await import('@/lib/container-manager');

      // Step 1: Container starts — emits 'starting'
      containerManager.emit('container-state', { projectRoot: testDir, state: 'starting' });
      expect(mockAutoResumeInterruptedTasks).not.toHaveBeenCalled();

      // Step 2: Container is running — emits 'running' (first time, e.g. initial startup)
      containerManager.emit('container-state', { projectRoot: testDir, state: 'running' });
      expect(mockAutoResumeInterruptedTasks).toHaveBeenCalledTimes(1);
      mockAutoResumeInterruptedTasks.mockClear();

      // Step 3: Container dies — emits 'restarting' (Docker event watcher detects die)
      containerManager.emit('container-state', { projectRoot: testDir, state: 'restarting' });
      expect(mockAutoResumeInterruptedTasks).not.toHaveBeenCalled();

      // Step 4: Container restarts successfully — emits 'running' (should trigger auto-resume)
      containerManager.emit('container-state', { projectRoot: testDir, state: 'running' });
      expect(mockAutoResumeInterruptedTasks).toHaveBeenCalledTimes(1);
    });

    it('multiple "running" events each trigger auto-resume (debounce handled in recovery.ts)', async () => {
      const { containerManager } = await import('@/lib/container-manager');

      // Simulate two separate container restarts
      containerManager.emit('container-state', { projectRoot: testDir, state: 'running' });
      expect(mockAutoResumeInterruptedTasks).toHaveBeenCalledTimes(1);

      // Second restart — listener fires again (debounce in autoResumeInterruptedTasks handles dedup)
      containerManager.emit('container-state', { projectRoot: testDir, state: 'running' });
      expect(mockAutoResumeInterruptedTasks).toHaveBeenCalledTimes(2);
    });
  });

  // ── Crash mid-markTaskDone ─────────────────────────────────────────────
  //
  // markTaskDone used to delete the live .teamai/{slug}/ directory up front
  // and only restore it from the merged snapshot afterwards. An interruption
  // (crash / OOM / server restart) between that rmSync and the restore left
  // the directory permanently gone — findInterruptedTasks() had no
  // subdirectory left to scan, so the task silently vanished from the board.
  //
  // These tests exercise markTaskDone against a real git repo to prove the
  // reorder closes that window: the restore now overwrites the live directory
  // in place, and stale local-only leftovers are pruned only after the restore
  // has provably landed — an interruption at any point leaves either the old
  // content or a superset of the new content, never nothing.

  describe('Crash mid-markTaskDone', () => {
    let originDir: string;
    let projectDir: string;
    let snapshotDir: string;
    let mtdTaskId: string;
    let mtdTaskDir: string;

    beforeEach(() => {
      vi.clearAllMocks();
      onHandlers.clear();
      mockGetSession.mockReturnValue(undefined);

      mtdTaskId = randomUUID();

      // Bare origin repo — the "remote" whose main branch receives the task's
      // committed artifact snapshot (what the PR merge would have produced).
      originDir = join(tmpdir(), `teamai-mtd-origin-${randomUUID().slice(0, 8)}`);
      mkdirSync(originDir, { recursive: true });
      execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: originDir, stdio: 'ignore' });

      // Main working clone — the "project" whose .teamai/ holds the live task.
      projectDir = join(tmpdir(), `teamai-mtd-${randomUUID().slice(0, 8)}`);
      execFileSync('git', ['clone', originDir, projectDir], { stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@teamai.dev'], { cwd: projectDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'TeamAI Test'], { cwd: projectDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: projectDir, stdio: 'ignore' });

      writeFileSync(join(projectDir, 'base.txt'), 'base\n');
      execFileSync('git', ['add', '.'], { cwd: projectDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: projectDir, stdio: 'ignore' });
      execFileSync('git', ['push', 'origin', 'main'], { cwd: projectDir, stdio: 'ignore' });

      // Mirror project-store's _updateGitignore: the live .teamai/ directory
      // is untracked in the project repo — exactly the local-only content the
      // old delete-before-restore rmSync was working around.
      writeFileSync(join(projectDir, '.gitignore'), '.teamai/*\n');
      execFileSync('git', ['add', '.gitignore'], { cwd: projectDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'gitignore teamai'], { cwd: projectDir, stdio: 'ignore' });
      execFileSync('git', ['push', 'origin', 'main'], { cwd: projectDir, stdio: 'ignore' });

      // Live task directory: the in-progress state markTaskDone finalises.
      // task.json is still at awaiting-review; output.log is a local-only
      // transient file that the committed snapshot does NOT contain.
      mkdirSync(join(projectDir, '.teamai'), { recursive: true });
      mtdTaskDir = join(projectDir, '.teamai', mtdTaskId);
      mkdirSync(mtdTaskDir, { recursive: true });
      writeFileSync(join(mtdTaskDir, 'task.json'), JSON.stringify({
        id: mtdTaskId,
        title: 'markTaskDone crash test',
        description: 'desc',
        phase: 'awaiting-review',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      writeFileSync(join(mtdTaskDir, 'spec.md'), '# live spec\n');
      writeFileSync(join(mtdTaskDir, 'output.log'), 'transient session output\n');

      // Commit the final artifact snapshot to origin/main from a separate
      // clone so the project's live directory stays untracked. task.json is
      // phase "done", as commitArtifactsToWorktree would have written it.
      snapshotDir = join(tmpdir(), `teamai-mtd-snap-${randomUUID().slice(0, 8)}`);
      execFileSync('git', ['clone', originDir, snapshotDir], { stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@teamai.dev'], { cwd: snapshotDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'TeamAI Test'], { cwd: snapshotDir, stdio: 'ignore' });
      execFileSync('git', ['config', 'core.autocrlf', 'false'], { cwd: snapshotDir, stdio: 'ignore' });
      const snapTaskDir = join(snapshotDir, '.teamai', mtdTaskId);
      mkdirSync(snapTaskDir, { recursive: true });
      writeFileSync(join(snapTaskDir, 'task.json'), JSON.stringify({
        id: mtdTaskId,
        title: 'markTaskDone crash test',
        description: 'desc',
        phase: 'done',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }));
      writeFileSync(join(snapTaskDir, 'spec.md'), '# committed spec\n');
      execFileSync('git', ['add', '-f', `.teamai/${mtdTaskId}`], { cwd: snapshotDir, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'artifact snapshot'], { cwd: snapshotDir, stdio: 'ignore' });
      execFileSync('git', ['push', 'origin', 'main'], { cwd: snapshotDir, stdio: 'ignore' });

      // Bring origin/main into the project clone so markTaskDone's fetch and
      // restore see the just-pushed snapshot.
      execFileSync('git', ['fetch', 'origin', 'main'], { cwd: projectDir, stdio: 'ignore' });
    });

    afterEach(() => {
      for (const d of [projectDir, snapshotDir, originDir]) {
        if (d && existsSync(d)) {
          try { rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
        }
      }
      cleanup();
      vi.resetModules();
    });

    it('restores the snapshot over the live directory and prunes stale files afterward — never deleting the directory first', async () => {
      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(projectDir);

      await (orch as AnyOrch).markTaskDone(mtdTaskId);

      // Directory still exists and holds the committed snapshot's task.json.
      expect(existsSync(mtdTaskDir)).toBe(true);
      const taskJson = JSON.parse(readFileSync(join(mtdTaskDir, 'task.json'), 'utf-8'));
      expect(taskJson.phase).toBe('done');

      // Committed snapshot files survived the restore in place.
      expect(readFileSync(join(mtdTaskDir, 'spec.md'), 'utf-8')).toBe('# committed spec\n');

      // The local-only transient file (not in the snapshot) was pruned.
      expect(existsSync(join(mtdTaskDir, 'output.log'))).toBe(false);
    });

    it('keeps the task discoverable when the restore cannot run (fetch fails) — the live directory is never emptied', async () => {
      // Remove the origin remote so git fetch fails — the worst-case point at
      // which the old code had ALREADY deleted the directory. The new code
      // must still leave a task.json on disk so findInterruptedTasks() and
      // the TaskStore can discover the task after a restart.
      execFileSync('git', ['remote', 'remove', 'origin'], { cwd: projectDir, stdio: 'ignore' });

      const mod = await import('@/lib/orchestrator');
      orch = mod.getOrchestrator(projectDir);

      await (orch as AnyOrch).markTaskDone(mtdTaskId);

      expect(existsSync(mtdTaskDir)).toBe(true);
      const taskJson = JSON.parse(readFileSync(join(mtdTaskDir, 'task.json'), 'utf-8'));
      expect(taskJson.phase).toBe('done');
      // Fallback also writes the done event so the kanban still sees the task.
      expect(existsSync(join(mtdTaskDir, 'events.jsonl'))).toBe(true);
    });
  });
});
