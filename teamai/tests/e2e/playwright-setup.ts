/**
 * Playwright global setup — seeds a test project in an isolated temp directory.
 *
 * Creates a temporary config directory so the E2E test run never touches the
 * user's real ~/.teamai/projects.json. Writes the temp path to a file that
 * project-store.ts reads as a fallback (belt-and-suspenders for the env var).
 *
 * If any step fails, the error is thrown and Playwright aborts the test run
 * before any tests execute.
 */

import { execFileSync } from 'child_process';
import { existsSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

async function globalSetup() {
  const seedDir = join(process.cwd(), '.teamai-e2e-seed');

  // Always clean and re-seed for a deterministic baseline
  if (existsSync(seedDir)) {
    try { rmSync(seedDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  }

  // ── Create isolated config directory ──────────────────────────────────
  const tempConfigDir = join(tmpdir(), `teamai-e2e-config-${randomUUID().slice(0, 8)}`);
  mkdirSync(tempConfigDir, { recursive: true });
  console.log(`[playwright-setup] Created temp config dir: ${tempConfigDir}`);

  // Write path to a well-known file so project-store.ts can discover it
  // even if the dev server doesn't inherit the env var from the setup process
  const pathFile = join(process.cwd(), '.teamai-e2e-config-path');
  writeFileSync(pathFile, tempConfigDir);
  console.log(`[playwright-setup] Wrote config path file: ${pathFile}`);

  // ── Seed the test project ────────────────────────────────────────────
  console.log('[playwright-setup] Seeding E2E test project…');
  try {
    execFileSync('npx', ['tsx', 'tests/e2e/seed.ts', '--with-plans', '--with-qa-report', '--yes'], {
      cwd: join(process.cwd()),
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
    // Clean up before throwing so the path file doesn't linger
    try { rmSync(pathFile); } catch { /* best-effort */ }
    try { rmSync(tempConfigDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    throw err;
  }

  // Verify the seed created the expected data
  if (!existsSync(seedDir)) {
    throw new Error(`[playwright-setup] Seed directory was not created: ${seedDir}`);
  }
  if (!existsSync(join(seedDir, '.teamai'))) {
    throw new Error(`[playwright-setup] Seed .teamai/ directory missing — cannot run E2E tests`);
  }

  console.log('[playwright-setup] Setup complete — tests will use isolated config.');
}

export default globalSetup;
