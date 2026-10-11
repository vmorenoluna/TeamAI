/**
 * Playwright global teardown — removes the isolated temp config directory,
 * which also holds the seeded E2E projects.
 *
 * The temp config dir is read from TEAMAI_CONFIG_DIR env var, which was set
 * by playwright.config.ts webServer.env and flowed through to globalTeardown
 * via process.env.
 */

import { rmSync, existsSync } from 'fs';

async function globalTeardown() {
  console.log('[playwright-teardown] Cleaning up E2E artifacts…');

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
