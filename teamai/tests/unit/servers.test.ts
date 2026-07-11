/**
 * Drift detector for the two project server ports.
 *
 * Reads teamai/playwright.config.ts (test server) and teamai/package.json
 * (dev server) — each is the single source of truth for one server's
 * port — via scripts/servers.ts. If either port changes in its config,
 * the corresponding test breaks, which is the whole point.
 *
 * Replaces the two separate get-test-port.test.ts and get-dev-port.test.ts
 * files that existed before scripts/servers.ts consolidated the helpers.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import {
  getTestPort,
  getTestServerUrl,
  getDevPort,
  getDevServerUrl,
} from '../../scripts/servers';

// ── Test server (Playwright) ────────────────────────────────────────────────

describe('servers — test port (Playwright)', () => {
  it('returns the full test server URL', () => {
    expect(getTestServerUrl()).toBe(`http://localhost:${getTestPort()}`);
  });

  it('returns 3001 today (regression: documenting the current value)', () => {
    // If this test breaks, the test port has changed in
    // playwright.config.ts. Update this assertion, then audit every
    // consumer (dev tooling, cookies, manual curl, the comment in
    // playwright.config.ts itself, the CLAUDE.md note) for the new
    // port. The whole point of scripts/servers.ts is to keep that
    // audit scoped to a single config-file change.
    expect(getTestPort()).toBe(3001);
    expect(getTestServerUrl()).toBe('http://localhost:3001');
  });
});

// ── Dev server ──────────────────────────────────────────────────────────────

describe('servers — dev port (npm run dev)', () => {
  it('returns the full dev server URL', () => {
    expect(getDevServerUrl()).toBe(`http://localhost:${getDevPort()}`);
  });

  it('returns 3002 today (regression: documenting the current value)', () => {
    // If this test breaks, the dev port has changed in package.json's
    // dev script. Update this assertion, then audit every consumer
    // (dev tooling, the comment in playwright.config.ts that mentions
    // the dev port, the CLAUDE.md note) for the new port. The whole
    // point of scripts/servers.ts is to keep that audit scoped to a
    // single config-file change.
    expect(getDevPort()).toBe(3002);
    expect(getDevServerUrl()).toBe('http://localhost:3002');
  });
});

// ── Collision guard ─────────────────────────────────────────────────────────
// Locks in CI that the runtime guard in scripts/servers.ts fires when a
// future typo makes dev and test share a port. Backup-write-restore the
// real config so other tests aren't affected; vi.resetModules() forces the
// dynamic import to re-evaluate the module and re-run the guard.

const REAL_CONFIG = join(__dirname, '..', '..', 'playwright.config.ts');
const BACKUP = `${REAL_CONFIG}.test-backup`;

// Reads REAL_CONFIG, returns its contents with the PORT literal rewritten
// to '3002' (matching the dev port) to force the collision-guard to fire.
function collidingConfig(): string {
  return readFileSync(REAL_CONFIG, 'utf-8')
    .replace(/PORT:\s*['"]\d+['"]/, "PORT: '3002'");
}

describe('servers — collision guard', () => {
  // Self-heal: if a prior run crashed mid-test (SIGKILL, OOM, CI
  // eviction), the backup file would still exist. Restore the real
  // config from it before any new test runs, so the test is safe to
  // re-run after a crash.
  beforeAll(() => {
    if (existsSync(BACKUP)) {
      copyFileSync(BACKUP, REAL_CONFIG);
      unlinkSync(BACKUP);
    }
  });

  it('throws at module load when dev and test ports match', async () => {
    copyFileSync(REAL_CONFIG, BACKUP);
    try {
      // Overwrite the test port to match the dev port (3002). The
      // guard at the bottom of scripts/servers.ts fires on the next
      // module load. vi.resetModules() forces a fresh evaluation.
      writeFileSync(REAL_CONFIG, collidingConfig());
      vi.resetModules();
      await expect(import('../../scripts/servers')).rejects.toThrow(
        /Dev and test ports are both 3002/,
      );
    } finally {
      // Always restore — even if the assertion failed — so other
      // tests aren't affected.
      copyFileSync(BACKUP, REAL_CONFIG);
      unlinkSync(BACKUP);
      vi.resetModules();
    }
  });
});
