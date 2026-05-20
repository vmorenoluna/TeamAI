/**
 * Playwright global teardown — removes the seeded E2E test project and cleans
 * up the entry from ~/.teamai/projects.json so user projects are not polluted.
 *
 * Uses fs.rmSync for cross-platform compatibility (Windows, macOS, Linux).
 */

import { rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

async function globalTeardown() {
  const seedDir = join(__dirname, '..', '..', '.teamai-e2e-seed');
  console.log(`[playwright-teardown] Cleaning up E2E seed project at ${seedDir}...`);

  // Remove the seed directory
  try {
    if (existsSync(seedDir)) {
      rmSync(seedDir, { recursive: true, force: true });
    }
  } catch (err) {
    console.warn('[playwright-teardown] Failed to remove seed directory (non-fatal):', err);
  }

  // Also clean up the ~/.teamai/projects.json entry so user projects aren't polluted
  try {
    const projectsFile = join(homedir(), '.teamai', 'projects.json');
    if (existsSync(projectsFile)) {
      const projects: Array<{ name: string; path: string }> = JSON.parse(readFileSync(projectsFile, 'utf-8'));
      const filtered = projects.filter((p) => p.path !== seedDir);
      if (filtered.length < projects.length) {
        writeFileSync(projectsFile, JSON.stringify(filtered, null, 2));
        console.log('[playwright-teardown] Removed E2E seed project from projects.json');
      }
    }
  } catch (err) {
    console.warn('[playwright-teardown] Failed to clean up projects.json (non-fatal):', err);
  }

  console.log('[playwright-teardown] Cleanup complete.');
}

export default globalTeardown;
