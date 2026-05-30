/**
 * Vitest global setup/teardown — ensures no test projects are left behind.
 *
 * The teardown scans ~/.teamai/projects.json for any test project entries
 * (directories with the ".teamai-test-" prefix) and removes both the
 * filesystem directory and the store registration.
 *
 * This is a safety net: per-test afterEach hooks should already clean up,
 * but if a test crashes before afterEach runs, the global teardown catches
 * the orphaned artifacts.
 */

import { readFileSync, writeFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

// Safety: refuse to touch the real ~/.teamai/projects.json unless explicitly
// opted in via TEAMAI_TEST_HOME. Operating on the real file can cause silent
// data loss if a crash or filesystem hiccup occurs during the read-modify-write
// cycle. Tests that need project persistence must mock homedir() or use a temp dir.
const HOME_DIR = process.env.TEAMAI_TEST_HOME;
const PROJECTS_FILE = HOME_DIR ? join(HOME_DIR, '.teamai', 'projects.json') : '';
const TEST_PREFIX = '.teamai-test-';

export function setup() {
  // No-op: per-test cleanup is handled by afterEach hooks.
  // The global teardown handles any leftovers from crashed tests.
}

export function teardown() {
  // Safety gate: refuse to touch the real ~/.teamai/projects.json.
  // Set TEAMAI_TEST_HOME env var to a temp directory to enable cleanup.
  if (!HOME_DIR) {
    console.log('[test-teardown] Skipping — TEAMAI_TEST_HOME not set (refusing to touch real projects.json)');
    return;
  }

  let cleaned = 0;

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
      cleaned++;
      return false; // Remove from the array
    });

    if (cleaned > 0) {
      writeFileSync(PROJECTS_FILE, JSON.stringify(remaining, null, 2));
      console.log(`[test-teardown] Cleaned up ${cleaned} leftover test project(s)`);
    }
  } catch (err) {
    console.warn('[test-teardown] Cleanup error (non-fatal):', err);
  }
}
