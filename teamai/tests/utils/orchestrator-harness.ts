/**
 * Shared Orchestrator Test Harness
 *
 * Provides reusable helpers and types for orchestrator test suites.
 *
 * **vitest hoisting rule:** vi.mock() and vi.hoisted() blocks MUST stay
 * per-file — vitest hoists them at the AST level per-file, and sharing
 * mock factories across modules causes execution-order issues. Per-file
 * vi.mock() preambles are an intentional pattern, not duplication to
 * eliminate.
 *
 * Shared exports:
 *   - createFireEvent(onHandlers) — bound fireEvent closure
 *   - makePipeline(overrides) — test pipeline factory
 *   - setupTestProject(options?) — temp project with git repo + task
 *   - makeOrch(root) — orchestrator with cleared state
 *   - AnyOrch — convenience type alias for `any`
 */

import { mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { execFileSync } from 'child_process';

// ── Types ────────────────────────────────────────────────────────────────────

/** Convenience type for accessing private orchestrator members in tests. */
export type AnyOrch = any;

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a fireEvent closure bound to the given onHandlers map.
 * Usage in test files (after hoisted mocks):
 *   const fireEvent = createFireEvent(onHandlers);
 * All existing `fireEvent(...)` call sites work unchanged.
 */
export function createFireEvent(onHandlers: Map<string, Array<(...args: any[]) => void>>) {
  return (event: string, data: any) => {
    const handlers = onHandlers.get(event);
    if (handlers) {
      for (const h of [...handlers]) {
        try { h(data); } catch { /* ignore */ }
      }
    }
  };
}

/** Make a minimal pipeline object for testing. */
export function makePipeline(overrides: Record<string, any> = {}): any {
  return {
    taskId: 'task-id',
    description: 'test',
    phase: 'spec',
    specPath: '/test/spec',
    worktreePath: '/test/wt',
    branch: 'feat/test',
    qaAttempt: 0,
    maxQaAttempts: 3,
    specRevision: 1,
    qaRevision: 0,
    ...overrides,
  };
}

/**
 * Create a temp test project with git repo, .teamai/ dir, and a task.
 * Shared by orchestrator.test.ts and orchestrator-workflow-improvements.test.ts.
 *
 * Returns { root, taskId, taskDir, branchName, slug, clean }.
 * Call `clean(onHandlers)` to clean up temp dir and optionally clear handlers.
 */
export function setupTestProject(options?: {
  initGit?: boolean;
  containerEnabled?: boolean;
  tmpPrefix?: string;
}) {
  const prefix = options?.tmpPrefix ?? 'teamai-ocrh';
  const root = join(tmpdir(), `${prefix}-${randomUUID().slice(0, 8)}`);
  mkdirSync(root, { recursive: true });

  if (options?.initGit !== false) {
    try {
      execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.email', 'test@teamai.dev'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['config', 'user.name', 'TeamAI Test'], { cwd: root, stdio: 'ignore' });
      writeFileSync(join(root, '.gitkeep'), '');
      execFileSync('git', ['add', '.gitkeep'], { cwd: root, stdio: 'ignore' });
      execFileSync('git', ['commit', '-m', 'initial'], { cwd: root, stdio: 'ignore' });
    } catch { /* git might not be available in test env */ }
  }

  mkdirSync(join(root, '.teamai'), { recursive: true });

  if (options?.containerEnabled) {
    writeFileSync(join(root, '.teamai', 'container.json'), JSON.stringify({ enabled: true }));
  }

  const taskId = randomUUID();
  const taskDir = join(root, '.teamai', taskId);
  mkdirSync(taskDir, { recursive: true });

  writeFileSync(join(taskDir, 'task.json'), JSON.stringify({
    id: taskId,
    title: 'Test Task',
    description: 'A test task for full coverage',
    phase: 'backlog',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  const slug = randomUUID().slice(0, 8);
  const branchName = `feat-${slug}`;

  const clean = (onHandlers?: Map<string, any[]>) => {
    if (onHandlers) onHandlers.clear();
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  };

  return { root, taskId, taskDir, branchName, slug, clean };
}

/**
 * Create a fresh orchestrator for the given project root with cleared state.
 * Accepts getOrchestrator as a parameter so each test file can pass its own
 * (per-file mocked) import. This avoids dynamic require() issues with vitest ESM.
 */
export function makeOrch(root: string, getOrchestrator: any): any {
  const orch = getOrchestrator(root);
  (orch as AnyOrch).pipelines.clear();
  (orch as AnyOrch).activeTasks.clear();
  return orch;
}
