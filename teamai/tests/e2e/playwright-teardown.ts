/**
 * Playwright global teardown — removes the seeded E2E test project and the
 * isolated temp config directory.
 *
 * The temp config dir is read from TEAMAI_CONFIG_DIR env var, which was set
 * by playwright.config.ts webServer.env and flowed through to globalTeardown
 * via process.env.
 */

import { rmSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';

async function globalTeardown() {
  const cwd = process.cwd();

  console.log('[playwright-teardown] Cleaning up E2E artifacts…');

  // ── Remove ALL .teamai-e2e-seed* directories ────────────────────────
  // The base seed is .teamai-e2e-seed; parallel workers clone it as
  // .teamai-e2e-seed-w{N}. Remove every variant so a crashed or
  // force-killed run doesn't leave stale directories behind.
  let removed = 0;
  try {
    for (const entry of readdirSync(cwd)) {
      if (!entry.startsWith('.teamai-e2e-seed')) continue;
      const full = join(cwd, entry);
      try {
        rmSync(full, { recursive: true, force: true });
        removed++;
      } catch { /* best-effort per directory */ }
    }
  } catch { /* readdir itself can fail — nothing to clean */ }
  if (removed > 0) {
    console.log(`[playwright-teardown] Removed ${removed} seed director${removed === 1 ? 'y' : 'ies'}`);
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
