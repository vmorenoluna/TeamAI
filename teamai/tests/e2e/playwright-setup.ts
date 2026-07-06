/**
 * Playwright global setup — seeds a test project in an isolated temp directory.
 *
 * Playwright starts `webServer` BEFORE `globalSetup`, so the temp config dir
 * is generated in `playwright.config.ts` and passed to both server.ts (via
 * webServer.env.TEAMAI_CONFIG_DIR) and this setup script (via process.env).
 *
 * This script:
 *   1. Reads TEAMAI_CONFIG_DIR from env (set by playwright.config.ts)
 *   2. Runs `tests/e2e/seed.ts` with that config dir so the project
 *      registry + scaffolded files live in the isolated config
 *
 * If any step fails, the temp config dir + seed dir are cleaned up before
 * throwing so leftover state never leaks between runs.
 */

import { execFileSync } from 'child_process';
import { existsSync, rmSync } from 'fs';
import { join } from 'path';

async function globalSetup() {
  const cwd = process.cwd();
  const seedDir = join(cwd, '.teamai-e2e-seed');

  // TEAMAI_CONFIG_DIR must be set by playwright.config.ts webServer.env
  // (also inherited by globalSetup via process.env passthrough).
  const tempConfigDir = process.env.TEAMAI_CONFIG_DIR;
  if (!tempConfigDir) {
    throw new Error(
      '[playwright-setup] TEAMAI_CONFIG_DIR env var not set — ' +
      'the playwright.config.ts webServer.env must pass it so project-store.ts ' +
      'resolves the correct config dir at module-load time.'
    );
  }

  // Always clean before seeding for a fresh, deterministic baseline
  if (existsSync(seedDir)) {
    try { rmSync(seedDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  if (existsSync(tempConfigDir)) {
    try { rmSync(tempConfigDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  console.log(`[playwright-setup] Using temp config dir: ${tempConfigDir}`);

  // ── Seed the test project ────────────────────────────────────────────
  console.log('[playwright-setup] Seeding E2E test project…');
  try {
    execFileSync('npx', ['tsx', 'tests/e2e/seed.ts', '--with-plans', '--with-qa-report', '--yes'], {
      cwd,
      stdio: 'inherit',
      timeout: 30_000,
      shell: true,
      env: {
        ...process.env,
        TEAMAI_CONFIG_DIR: tempConfigDir,
      },
    });
    console.log('[playwright-setup] Seed complete.');
  } catch (err) {
    console.error('[playwright-setup] Seed failed — aborting test run.');
    // Clean up before throwing so no leftover state leaks into the next run.
    try { rmSync(tempConfigDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(seedDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }

  // Verify the seed created the expected data
  if (!existsSync(seedDir)) {
    throw new Error(`[playwright-setup] Seed directory was not created: ${seedDir}`);
  }
  if (!existsSync(join(seedDir, '.teamai'))) {
    throw new Error(`[playwright-setup] Seed .teamai/ directory missing — cannot run E2E tests`);
  }

  console.log('[playwright-setup] Setup complete.');
}

export default globalSetup;
