/**
 * Vitest global setup/teardown.
 *
 * Setup gives the whole run a private TeamAI config dir (TEAMAI_CONFIG_DIR, a
 * fresh dir under the OS temp dir). Workers inherit it, and vitest-setup.ts
 * refuses to start a test file without it, so no test can ever read or write
 * the real ~/.teamai/projects.json. Teardown deletes that dir and sweeps stale
 * .teamai-test-* directories that crashed tests (afterEach never ran) left in
 * the OS temp dir.
 */

import { mkdtempSync, rmSync, readdirSync, statSync, realpathSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { restoreNodeEnv } from './node-env';

const TEST_PREFIX = '.teamai-test-';
let configRoot: string | undefined;

/**
 * When vitest runs inside a git hook (e.g. the pre-commit hook running
 * `npx vitest run`), git sets GIT_INDEX_FILE/GIT_DIR/etc. pointing at the
 * OUTER repo's .git so hook scripts can inspect the commit-in-progress
 * state. Those variables are inherited by every child process this test
 * run spawns — including `git init`/`git worktree add` in unrelated temp
 * repos created by integration tests — and cause git to resolve the wrong
 * repository, producing errors like "Unable to create '.../index.lock':
 * No such file or directory" that look like a Windows filesystem race but
 * are actually a plain environment leak. Strip them before any worker
 * spawns (also done in vitest-setup.ts, which runs per test file, as a
 * second layer in case a pool type doesn't propagate this early mutation).
 */
function stripInheritedGitEnv() {
  for (const key of ['GIT_INDEX_FILE', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX']) {
    delete process.env[key];
  }
}

export function setup() {
  stripInheritedGitEnv();

  // The per-run config dir. Always overwritten: a TEAMAI_CONFIG_DIR already in
  // the caller's environment (possibly the real one) is never adopted.
  const tmpRoot = realpathSync(tmpdir());
  configRoot = mkdtempSync(join(tmpRoot, 'teamai-vitest-config-'));
  process.env.TEAMAI_CONFIG_DIR = configRoot;
  // Lets src/lib/project-store.ts throw, under vitest, if it ever resolves to the
  // real user config dir (e.g. a test that clears TEAMAI_CONFIG_DIR and forgets to
  // mock homedir).
  process.env.TEAMAI_TEST_FORBIDDEN_CONFIG = join(homedir(), '.teamai');

  // Per-test cleanup is handled by afterEach hooks.
  // The global teardown handles any leftovers from crashed tests.
}

export function teardown() {
  // Put back the NODE_ENV that vitest.workspace.ts overrode (see node-env.ts).
  restoreNodeEnv();

  let cleaned = 0;

  // ── Catch-all: remove leftover .teamai-test-* dirs from the OS temp dir ──
  // createTestProject() creates temp dirs there. If a test crashes before its
  // afterEach → clean() runs, the directory lingers. Only dirs older than an
  // hour are swept, so a concurrent test run's live directories are never hit.
  const cwd = tmpdir();
  try {
    for (const entry of readdirSync(cwd)) {
      if (!entry.startsWith(TEST_PREFIX)) continue;
      const full = join(cwd, entry);
      try {
        if (Date.now() - statSync(full).mtimeMs < 60 * 60 * 1000) continue;
        rmSync(full, { recursive: true, force: true });
        cleaned++;
      } catch { /* best-effort per directory */ }
    }
  } catch { /* readdir can fail — nothing to clean */ }

  if (cleaned > 0) {
    console.log(`[test-teardown] Removed ${cleaned} leftover test director${cleaned === 1 ? 'y' : 'ies'} from the temp dir`);
  }

  if (configRoot) {
    try { rmSync(configRoot, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}
