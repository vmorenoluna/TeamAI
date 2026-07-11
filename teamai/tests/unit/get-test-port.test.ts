/**
 * Drift detector for the Playwright test server port.
 *
 * Reads teamai/playwright.config.ts (the single source of truth) via
 * scripts/get-test-port.ts and verifies the script exposes the same
 * port the test runner actually uses. If the port changes in the
 * config, this test breaks — which is the whole point.
 */

import { describe, it, expect } from 'vitest';
import { getTestPort, getTestServerUrl } from '../../scripts/get-test-port';

describe('get-test-port', () => {
  it('returns the full test server URL', () => {
    expect(getTestServerUrl()).toBe(`http://localhost:${getTestPort()}`);
  });

  it('returns 3001 today (regression: documenting the current value)', () => {
    // If this test breaks, the port has changed in playwright.config.ts.
    // Update this assertion, then audit every consumer (dev tooling,
    // cookies, manual curl examples) for the new port. The whole point
    // of scripts/get-test-port.ts is to keep that audit scoped to a
    // single config-file change.
    expect(getTestPort()).toBe(3001);
    expect(getTestServerUrl()).toBe('http://localhost:3001');
  });
});
