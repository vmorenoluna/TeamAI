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

import { describe, it, expect } from 'vitest';
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
