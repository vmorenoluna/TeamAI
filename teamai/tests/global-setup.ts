/**
 * Vitest global setup/teardown — ensures no test projects are left behind.
 *
 * The teardown performs two independent cleanup passes:
 *   1. Catch-all: scans process.cwd() for .teamai-test-* directories and
 *      removes them.  This handles createTestProject() leftovers from
 *      crashed unit/integration tests (their afterEach → clean() never ran).
 *   2. Registered-project cleanup: if TEAMAI_TEST_HOME is set, prunes test
 *      project entries from ~/.teamai/projects.json and removes their
 *      physical directories.  This is a safety net for tests that register
 *      projects via ProjectStore.add().
 */

import { readFileSync, writeFileSync, existsSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';

// Safety: refuse to touch the real ~/.teamai/projects.json unless explicitly
// opted in via TEAMAI_TEST_HOME. Operating on the real file can cause silent
// data loss if a crash or filesystem hiccup occurs during the read-modify-write
// cycle. Tests that need project persistence must mock homedir() or use a temp dir.
const HOME_DIR = process.env.TEAMAI_TEST_HOME;
const PROJECTS_FILE = HOME_DIR ? join(HOME_DIR, '.teamai', 'projects.json') : '';
const TEST_PREFIX = '.teamai-test-';

/** Remove stale git lock files from the main repo's .git directory. */
function cleanStaleGitLocks() {
  // Tests run from teamai/, so .git is ../.git
  const repoRoot = join(process.cwd(), '..');
  const gitDir = join(repoRoot, '.git');
  if (!existsSync(gitDir)) return;

  try {
    const entries = readdirSync(gitDir);
    let removed = 0;
    for (const entry of entries) {
      // Match index.lock, next-index-*.lock.lock, and any other git lock files
      if (!entry.includes('.lock')) continue;
      const full = join(gitDir, entry);
      try {
        rmSync(full, { force: true });
        removed++;
      } catch { /* best-effort per file */ }
    }
    if (removed > 0) {
      console.log(`[test-setup] Removed ${removed} stale git lock file(s) from .git/`);
    }
  } catch { /* readdir can fail — nothing to clean */ }
}

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
  // ── Clean stale git lock files from the main repo ──────────────────
  // When a basher agent times out during git commit, it leaves stale
  // .git/index.lock (and .git/next-index-*.lock.lock) files that block
  // ALL subsequent git operations — including test repo init.
  // The cwd during tests is teamai/, so .git is one level up.
  cleanStaleGitLocks();
  stripInheritedGitEnv();

  // Per-test cleanup is handled by afterEach hooks.
  // The global teardown handles any leftovers from crashed tests.
}

export function teardown() {
  // Clean stale git lock files — if tests themselves left any behind
  // (e.g. a git command was killed mid-flight), don't let them poison
  // the next run. The setup() also does this, but teardown catches locks
  // from the current run before anything else touches the repo.
  cleanStaleGitLocks();

  let cleaned = 0;

  // ── Catch-all: remove leftover .teamai-test-* dirs from cwd ──────────
  // createTestProject() creates temp dirs in process.cwd(). If a test
  // crashes before its afterEach → clean() runs, the directory lingers.
  // Scan cwd and remove any that match the prefix.
  const cwd = process.cwd();
  try {
    for (const entry of readdirSync(cwd)) {
      if (!entry.startsWith(TEST_PREFIX)) continue;
      const full = join(cwd, entry);
      try {
        rmSync(full, { recursive: true, force: true });
        cleaned++;
      } catch { /* best-effort per directory */ }
    }
  } catch { /* readdir can fail — nothing to clean */ }

  if (cleaned > 0) {
    console.log(`[test-teardown] Removed ${cleaned} leftover test director${cleaned === 1 ? 'y' : 'ies'} from cwd`);
  }

  // ── Registered-project cleanup (requires TEAMAI_TEST_HOME) ───────────
  if (!HOME_DIR) {
    console.log('[test-teardown] Skipping projects.json cleanup — TEAMAI_TEST_HOME not set');
    return;
  }

  let prCleaned = 0;

  try {
    if (!existsSync(PROJECTS_FILE)) return;

    const projects: Array<{ name: string; path: string; addedAt: string }> =
      JSON.parse(readFileSync(PROJECTS_FILE, 'utf-8'));

    const remaining = projects.filter((p) => {
      const dirName = p.path.split(/[\\/]/).pop() || '';
      if (!dirName.startsWith(TEST_PREFIX)) return true;

      // Remove the physical directory
      if (existsSync(p.path)) {
        rmSync(p.path, { recursive: true, force: true });
      }
      prCleaned++;
      return false; // Remove from the array
    });

    if (prCleaned > 0) {
      writeFileSync(PROJECTS_FILE, JSON.stringify(remaining, null, 2));
      console.log(`[test-teardown] Cleaned up ${prCleaned} leftover test project(s) from projects.json`);
    }
  } catch (err) {
    console.warn('[test-teardown] Cleanup error (non-fatal):', err);
  }
}
