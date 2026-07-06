/**
 * Playwright global teardown — removes the seeded E2E test project and the
 * isolated temp config directory.
 *
 * The temp config dir is read from TEAMAI_CONFIG_DIR env var, which was set
 * by playwright.config.ts webServer.env and flowed through to globalTeardown
 * via process.env.
 */

import { rmSync, existsSync } from 'fs';
import { join } from 'path';

async function globalTeardown() {
  const cwd = process.cwd();
  const seedDir = join(cwd, '.teamai-e2e-seed');

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
  const tempConfigDir = process.env.TEAMAI_CONFIG_DIR;
  if (tempConfigDir && existsSync(tempConfigDir)) {
    try {
      rmSync(tempConfigDir, { recursive: true, force: true });
      console.log('[playwright-teardown] Removed temp config directory');
    } catch (err) {
      console.warn('[playwright-teardown] Failed to remove temp config directory (non-fatal):', err);
    }
  }

  console.log('[playwright-teardown] Cleanup complete.');
}

export default globalTeardown;
