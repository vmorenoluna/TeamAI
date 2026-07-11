/**
 * Drift detector for the dev server port.
 *
 * Reads teamai/package.json (the single source of truth) via
 * scripts/get-dev-port.ts and verifies the script exposes the same
 * port `npm run dev` actually uses. If the port changes in the
 * package.json dev script, this test breaks — which is the whole
 * point.
 */

import { describe, it, expect } from 'vitest';
import { getDevPort, getDevServerUrl } from '../../scripts/get-dev-port';

describe('get-dev-port', () => {
  it('returns the full dev server URL', () => {
    expect(getDevServerUrl()).toBe(`http://localhost:${getDevPort()}`);
  });

  it('returns 3002 today (regression: documenting the current value)', () => {
    // If this test breaks, the dev port has changed in package.json's
    // dev script. Update this assertion, then audit every consumer
    // (dev tooling, manual curl, the existing playwright.config.ts
    // comment that mentions the dev port, the CLAUDE.md note) for
    // the new port. The whole point of scripts/get-dev-port.ts is
    // to keep that audit scoped to a single config-file change.
    expect(getDevPort()).toBe(3002);
    expect(getDevServerUrl()).toBe('http://localhost:3002');
  });
});
