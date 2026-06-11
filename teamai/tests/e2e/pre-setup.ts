/**
 * Pre-setup — runs BEFORE the dev server starts (as part of Playwright's
 * webServer command chain). Ensures .teamai-e2e-config-path exists before
 * server.ts imports project-store.ts, which resolves CONFIG_DIR at module
 * load time. Without this, the server defaults to ~/.teamai/ on cold start.
 */

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';

const seedDir = join(process.cwd(), '.teamai-e2e-seed');

// Always clean before seeding for a fresh start
if (existsSync(seedDir)) {
  try { rmSync(seedDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

// ── Create isolated config directory ──────────────────────────────────
const tempConfigDir = join(tmpdir(), `teamai-e2e-config-${randomUUID().slice(0, 8)}`);
mkdirSync(tempConfigDir, { recursive: true });
console.log(`[pre-setup] Created temp config dir: ${tempConfigDir}`);

// Write path file BEFORE server.ts imports project-store.ts.
// project-store.ts resolveConfigDir() checks for this file at module load time.
const pathFile = join(process.cwd(), '.teamai-e2e-config-path');
writeFileSync(pathFile, tempConfigDir);
console.log(`[pre-setup] Wrote config path file: ${pathFile}`);

// ── Seed the test project ────────────────────────────────────────────
console.log('[pre-setup] Seeding E2E test project…');
try {
  execFileSync('npx', ['tsx', 'tests/e2e/seed.ts', '--with-plans', '--with-qa-report', '--yes'], {
    cwd: process.cwd(),
    stdio: 'inherit',
    timeout: 30_000,
    shell: true,
    env: {
      ...process.env,
      TEAMAI_CONFIG_DIR: tempConfigDir,
    },
  });
  console.log('[pre-setup] Seed complete.');
} catch (err) {
  console.error('[pre-setup] Seed failed — aborting.');
  try { rmSync(pathFile); } catch { /* best-effort */ }
  try { rmSync(tempConfigDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  throw err;
}

// Verify the seed created the expected data
if (!existsSync(seedDir)) {
  throw new Error(`[pre-setup] Seed directory was not created: ${seedDir}`);
}
console.log('[pre-setup] Ready — server will start next.');
