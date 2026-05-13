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

import { readFileSync, writeFileSync, existsSync, mkdirSync, rmSync, readdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const HOME_DIR = homedir();
const PROJECTS_FILE = join(HOME_DIR, '.teamai', 'projects.json');
const TEST_PREFIX = '.teamai-test-';

export function setup() {
  // No-op: per-test cleanup is handled by afterEach hooks.
  // The global teardown handles any leftovers from crashed tests.
}

export function teardown() {
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
