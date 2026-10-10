/**
 * NODE_ENV handling for vitest runs.
 *
 * A NODE_ENV=production leaking in from the invoking shell breaks the suite
 * in two ways: React loads its production build, which has no `act` (every
 * @testing-library/react render fails with "React.act is not a function"),
 * and happy-dom test files resolve node builtins such as `util` to a shim
 * ("promisify is not a function"). The second one is decided when vite
 * resolves its config, so the override has to happen when
 * vitest.workspace.ts loads — too early for global-setup.ts.
 *
 * The caller's value is saved on globalThis (the workspace file and the
 * global setup file may be loaded as separate module instances in the same
 * process) and put back, or deleted if it was unset, in teardown.
 */

// Next's type augmentation marks process.env.NODE_ENV read-only; this is the
// one place that legitimately needs to write it.
const env = process.env as Record<string, string | undefined>;
const SAVED_KEY = Symbol.for('teamai.vitest.originalNodeEnv');

type Saved = { value: string | undefined };
const store = globalThis as unknown as Record<symbol, Saved | undefined>;

export function forceTestNodeEnv(): void {
  if (!store[SAVED_KEY]) store[SAVED_KEY] = { value: env.NODE_ENV };
  env.NODE_ENV = 'test';
}

export function restoreNodeEnv(): void {
  const saved = store[SAVED_KEY];
  if (!saved) return;
  store[SAVED_KEY] = undefined;
  if (saved.value === undefined) {
    delete env.NODE_ENV;
  } else {
    env.NODE_ENV = saved.value;
  }
}
