/**
 * Playwright global setup — seeds a test project in an isolated temp directory.
 *
 * Consolidates what was previously split across two scripts:
 *   - `playwright-setup.ts` (this file): read path file, run seed, validate
 *   - `tests/e2e/pre-setup.ts` (deleted): create temp config dir, write path file, run seed
 *
 * Playwright runs `globalSetup` BEFORE `webServer.command`, so this script
 * must:
 *   1. Create a fresh temp config dir + a unique seed dir cleanup
 *   2. Write `.teamai-e2e-config-path` so `project-store.ts` resolves
 *      `CONFIG_DIR` correctly at server.ts module-load time
 *   3. Run `tests/e2e/seed.ts` with `TEAMAI_CONFIG_DIR=tempConfigDir` so the
 *      project registry + scaffolded files live in the isolated config
 *
 * After this completes, `webServer.command` (now just `npx tsx server.ts`)
 * boots the dev server, which reads the path file via project-store.ts and
 * picks up the same temp config dir.
 *
 * If any step fails, the temp config dir + path file + seed dir are cleaned
 * up before throwing so leftover state never leaks between runs.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { join } from 'path';

async function globalSetup() {
  const cwd = process.cwd();
  const seedDir = join(cwd, '.teamai-e2e-seed');
  const pathFile = join(cwd, '.teamai-e2e-config-path');

  // Always clean before seeding for a fresh, deterministic baseline
  if (existsSync(seedDir)) {
    try { rmSync(seedDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
  if (existsSync(pathFile)) {
    try { rmSync(pathFile, { force: true }); } catch { /* best-effort */ }
  }

  // ── Create isolated temp config dir ─────────────────────────────────
  const tempConfigDir = join(tmpdir(), `teamai-e2e-config-${randomUUID().slice(0, 8)}`);
  mkdirSync(tempConfigDir, { recursive: true });
  console.log(`[playwright-setup] Created temp config dir: ${tempConfigDir}`);

  // ── Write path file BEFORE server.ts starts ──────────────────────────
  // server.ts imports project-store.ts at module-load time, which resolves
  // CONFIG_DIR via this file as fallback #2 (after TEAMAI_CONFIG_DIR env).
  // The path file MUST be on disk before server.ts boots.
  writeFileSync(pathFile, tempConfigDir);
  console.log(`[playwright-setup] Wrote config path file: ${pathFile}`);

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
    // seedDir may have been only partially populated by a mid-failure seed.ts.
    try { rmSync(pathFile); } catch { /* best-effort */ }
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

  console.log('[playwright-setup] Setup complete — server will start and read the path file.');
}

export default globalSetup;
