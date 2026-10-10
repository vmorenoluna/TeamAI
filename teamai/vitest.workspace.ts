import { defineWorkspace } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';
import { forceTestNodeEnv } from './tests/node-env';

// Must run before vite resolves its config — see tests/node-env.ts.
forceTestNodeEnv();

/**
 * Tests that create real `git worktree add` processes on Windows, where a
 * transient `.git/index.lock: No such file or directory` race can occur
 * (see tests/utils/git-worktree.ts for the retry-with-cleanup mitigation).
 * That retry loop alone is not sufficient under full-suite parallel load —
 * empirically, even 5 attempts with ramping backoff exhaust when many worker
 * threads fire `git worktree add` at once. Isolating these files into their
 * own single-worker project removes the concurrent-git-subprocess pressure
 * that's actually triggering the race, rather than trying to out-retry it.
 * Reproduction attempts (200+ concurrent `git worktree add` calls, with and
 * without artificial CPU load) could not trigger the race through raw git
 * concurrency alone — the trigger is specific to the full vitest/Node run,
 * so this targets vitest's own scheduling rather than git itself.
 */
const WORKTREE_RACE_TESTS = [
  'tests/integration/worktree-commondir-patching.test.ts',
  'tests/integration/worktree-unpushed-commits.test.ts',
  'tests/integration/create-pr-conflict.test.ts',
  'tests/integration/crash-recovery.test.ts',
];

// Settings are duplicated across projects rather than factored into a
// shared base config loaded via `extends`: vitest/vite's config merge
// CONCATENATES array fields (include/exclude) instead of replacing them, so
// an extended project's own `include` ends up unioned with the base
// config's broad globs — silently matching the whole suite again. Vitest
// still applies its own built-in default excludes (node_modules, dist,
// etc.) underneath either way.
const sharedPlugins = [
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  react() as any, // type incompatibility between vitest 1.x and @vitejs/plugin-react 4.x vite types
];
const sharedResolve = { alias: { '@': path.resolve(__dirname, 'src') } };
const sharedTest = {
  environment: 'node' as const,
  globals: true,
  testTimeout: 30_000,
  globalSetup: ['./tests/global-setup.ts'],
  setupFiles: ['./tests/vitest-setup.ts'],
  server: { deps: { inline: ['@/lib/utils', '@/lib/task-store'] } },
  coverage: {
    provider: 'v8' as const,
    include: ['src/lib/**/*.ts'],
    reporter: ['text', 'text-summary', 'html'] as const,
  },
};

export default defineWorkspace([
  {
    plugins: sharedPlugins,
    resolve: sharedResolve,
    test: {
      ...sharedTest,
      name: 'default',
      include: ['tests/unit/**/*.test.{ts,tsx}', 'tests/integration/**/*.test.{ts,tsx}'],
      exclude: WORKTREE_RACE_TESTS,
    },
  },
  {
    plugins: sharedPlugins,
    resolve: sharedResolve,
    test: {
      ...sharedTest,
      name: 'worktree-serial',
      include: WORKTREE_RACE_TESTS,
      // Single worker: files in this project run one at a time, so no two
      // `git worktree add` invocations from this group are ever in flight
      // together.
      poolOptions: {
        threads: { singleThread: true },
      },
    },
  },
]);
