/**
 * Shared Task-Store Test Harness
 *
 * Provides reusable helpers for TaskStore test suites.
 *
 * **vitest hoisting rule:** vi.mock() blocks MUST stay per-file — vitest
 * hoists them at the AST level per-file, and sharing mock factories across
 * modules causes execution-order issues. Per-file vi.mock() preambles are
 * an intentional pattern, not duplication to eliminate (same design as
 * the orchestrator harness).
 *
 * Shared exports:
 *   - setupTaskStoreTest() — temp project + TaskStore instance + counter
 *   - makeTask(store, nextId, ...) — task creation shorthand
 */

import { mkdirSync } from 'fs';
import { join } from 'path';
import { TaskStore } from '@/lib/task-store';
import { createTestProject } from './test-project';

// ── Types ────────────────────────────────────────────────────────────────────

export interface TaskStoreTestEnv {
  store: TaskStore;
  root: string;
  clean: () => void;
  nextId: () => string;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a temp project with a real TaskStore instance.
 * Combines createTestProject() + .teamai/ dir creation + TaskStore instantiation
 * + auto-incrementing task ID counter.
 *
 * Usage in beforeEach/afterEach:
 *   let env: TaskStoreTestEnv;
 *   beforeEach(() => { env = setupTaskStoreTest(); });
 *   afterEach(() => env.clean());
 */
export function setupTaskStoreTest(): TaskStoreTestEnv {
  const { root, clean } = createTestProject();
  mkdirSync(join(root, '.teamai'), { recursive: true });
  const store = new TaskStore(root);
  let counter = 0;
  const nextId = () => `task-${++counter}`;

  return { store, root, clean, nextId };
}

/**
 * Create a task through the store with default title/description.
 * Wraps `store.create(nextId(), title, description, source, competitiveContext)`.
 */
export function makeTask(
  store: TaskStore,
  nextId: () => string,
  title = 'Test task',
  description = 'Description',
  source?: string,
  competitiveContext?: string,
) {
  return store.create(nextId(), title, description, source, competitiveContext);
}
