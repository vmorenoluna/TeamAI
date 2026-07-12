/**
 * Shared Orchestrator Test Harness
 *
 * Provides reusable helpers and types for orchestrator test suites.
 * Vitest's vi.hoisted() cannot be shared across files (each file processes its
 * own hoisted context), so mock objects stay per-file.
 *
 * Shared exports:
 *   - createFireEvent(onHandlers) — creates a fireEvent closure bound to the
 *     given handlers map. Usage: `const fireEvent = createFireEvent(onHandlers);`
 *     All existing `fireEvent(...)` calls continue working unchanged.
 *   - makePipeline(overrides) — test pipeline factory with canonical defaults
 *   - AnyOrch — convenience type alias for `any`
 */

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
    specRevision: 0,
    ...overrides,
  };
}
