/**
 * Playwright global setup — seeds a test project before E2E tests run.
 *
 * Runs the seed.ts script to create a temporary project with sample tasks
 * and registers it, so model dropdown and other seeded-data tests work.
 *
 * Skips re-seeding if the seed directory already exists (idempotent).
 */

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

async function globalSetup() {
  const seedDir = join(__dirname, '..', '..', '.teamai-e2e-seed');

  if (existsSync(seedDir)) {
    console.log('[playwright-setup] Seed directory already exists, skipping.');
    return;
  }

  console.log('[playwright-setup] Seeding E2E test project...');
  try {
    execFileSync('npx', ['tsx', 'tests/e2e/seed.ts', '--with-plans', '--with-qa-report', '--yes'], {
      cwd: join(__dirname, '..', '..'),
      stdio: 'inherit',
      timeout: 30_000,
      shell: true,
    });
    console.log('[playwright-setup] Seed complete.');
  } catch (err) {
    console.error('[playwright-setup] Seed failed:', err);
    throw err;
  }
}

export default globalSetup;
