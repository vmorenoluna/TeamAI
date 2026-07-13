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
import { existsSync, rmSync, cpSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

// Default matches playwright.config.ts: CI uses 2, local uses os.cpus().length
const MAX_WORKERS = parseInt(process.env.E2E_MAX_WORKERS || '4', 10);

// Ensure at least 1 worker copy exists even if MAX_WORKERS is 0
const WORKER_COUNT = Math.max(MAX_WORKERS, 1);

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
    console.log(`[playwright-setup] Seed complete.`);
  } catch (err) {
    console.error('[playwright-setup] Seed failed — aborting test run.');
    // Clean up before throwing so no leftover state leaks into the next run.
    try { rmSync(tempConfigDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    try { rmSync(seedDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }

  // ── Per-worker seed copies (T31) ────────────────────────────────────
  // Copy the base seed for each parallel worker so tests that mutate
  // seed data don't race on a shared directory. Workers read their
  // seed dir from process.env.TEST_WORKER_INDEX (set by Playwright).
  const configDir = join(tempConfigDir, '.teamai');
  const projectsPath = join(configDir, 'projects.json');
  const projects = JSON.parse(readFileSync(projectsPath, 'utf-8')) as Array<{ name: string; path: string }>;

  for (let w = 0; w < WORKER_COUNT; w++) {
    const workerSeedDir = join(cwd, `.teamai-e2e-seed-w${w}`);
    if (w === 0) {
      // Worker 0 reuses the base seed (already at .teamai-e2e-seed)
      if (seedDir !== workerSeedDir) {
        if (existsSync(workerSeedDir)) rmSync(workerSeedDir, { recursive: true, force: true });
        cpSync(seedDir, workerSeedDir, { recursive: true });
      }
    } else {
      if (existsSync(workerSeedDir)) rmSync(workerSeedDir, { recursive: true, force: true });
      cpSync(seedDir, workerSeedDir, { recursive: true });
    }
    projects.push({ name: `E2E Test Project (w${w})`, path: workerSeedDir });
    console.log(`[playwright-setup] Worker ${w} seed ready at ${workerSeedDir}`);
  }

  // Write updated projects.json with all worker entries
  writeFileSync(projectsPath, JSON.stringify(projects, null, 2));
  console.log(`[playwright-setup] Registered ${WORKER_COUNT} per-worker projects`);

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
