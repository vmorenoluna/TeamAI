/**
 * Playwright global teardown — removes the seeded E2E test project and the
 * isolated temp config directory.
 *
 * Since the seed and tests now use an isolated TEAMAI_CONFIG_DIR, there is
 * no need to manipulate the user's real ~/.teamai/projects.json. This
 * teardown only cleans up temp files created during setup.
 */

import { rmSync, existsSync, readFileSync } from 'fs';
import { join } from 'path';

async function globalTeardown() {
  const cwd = process.cwd();
  const seedDir = join(cwd, '.teamai-e2e-seed');
  const pathFile = join(cwd, '.teamai-e2e-config-path');

  console.log('[playwright-teardown] Cleaning up E2E artifacts…');

  // ── Remove the seed directory ────────────────────────────────────────
  if (existsSync(seedDir)) {
    try {
      rmSync(seedDir, { recursive: true, force: true });
      console.log('[playwright-teardown] Removed seed directory');
    } catch (err) {
      console.warn('[playwright-teardown] Failed to remove seed directory (non-fatal):', err);
    }
  }

  // ── Remove the temp config directory ─────────────────────────────────
  if (existsSync(pathFile)) {
    try {
      const tempConfigDir = readFileSync(pathFile, 'utf-8').trim();
      if (tempConfigDir && existsSync(tempConfigDir)) {
        rmSync(tempConfigDir, { recursive: true, force: true });
        console.log('[playwright-teardown] Removed temp config directory');
      }
    } catch (err) {
      console.warn('[playwright-teardown] Failed to remove temp config directory (non-fatal):', err);
    }

    // Always remove the path file itself
    try { rmSync(pathFile); } catch { /* best-effort */ }
  }

  console.log('[playwright-teardown] Cleanup complete.');
}

export default globalTeardown;
