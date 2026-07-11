/**
 * Resolves the Playwright test server port from the single source of truth
 * (teamai/playwright.config.ts).
 *
 * Why: the test port currently appears in three places inside the config
 * (baseURL, webServer.url, webServer.env.PORT) and is also re-stated in
 * dev tooling that wants to talk to the test server (cookies, manual
 * curl, etc.). If the port ever changes, every consumer must be updated
 * in lockstep. This script makes "read it from the config" the only
 * contract, so any consumer that imports from here picks up the new
 * value automatically.
 *
 * Usage (CLI):
 *   npx tsx scripts/get-test-port.ts            # prints "3001"
 *   npx tsx scripts/get-test-port.ts --url      # prints "http://localhost:3001"
 *
 * Programmatic:
 *   import { getTestPort, getTestServerUrl } from './get-test-port';
 *   const port = getTestPort();
 *   const url  = getTestServerUrl();
 *
 * Why parse rather than import: importing playwright.config.ts would
 * trigger its module-load side effect (it assigns
 * `process.env.TEAMAI_CONFIG_DIR`) and require tsx at runtime. Parsing
 * the literal `PORT: '3001'` is side-effect-free, runnable with plain
 * node, and a config refactor that replaces the literal produces a
 * clear error here rather than a silent wrong-port fallback.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const CONFIG_PATH = join(__dirname, '..', 'playwright.config.ts');

/**
 * Reads `teamai/playwright.config.ts` and returns the literal port
 * declared in `webServer.env.PORT`.
 *
 * Throws if the config can't be read or the literal is missing — both
 * indicate the config has been refactored and this script needs an
 * update, which is the right failure mode (drift detected loudly).
 */
export function getTestPort(): number {
  if (!existsSync(CONFIG_PATH)) {
    throw new Error(
      `playwright.config.ts not found at ${CONFIG_PATH}. ` +
      `Cannot resolve test server port.`,
    );
  }
  const source = readFileSync(CONFIG_PATH, 'utf-8');
  // Match `PORT: '3001'` or `PORT: "3001"` — the only places the port
  // currently appears in the config. The pattern is intentionally
  // narrow so a refactor that introduces `PORT: process.env.PORT`
  // (no literal) fails here with a clear message rather than falling
  // back to a wrong value.
  const match = source.match(/PORT:\s*['"](\d+)['"]/);
  if (!match) {
    throw new Error(
      `Could not find a literal \`PORT: '<digits>'\` in ${CONFIG_PATH}. ` +
      `Either restore the literal in webServer.env, or update ` +
      `teamai/scripts/get-test-port.ts to handle the new format.`,
    );
  }
  return Number(match[1]);
}

/**
 * Returns the full test server URL (e.g. http://localhost:3001).
 *
 * Assumes the test server always runs on `localhost` — the config
 * hardcodes this in `baseURL` and `webServer.url`. If the test ever
 * moves to a non-localhost host (e.g. CI), update this helper to
 * read the host from the config too.
 */
export function getTestServerUrl(): string {
  return `http://localhost:${getTestPort()}`;
}

// CLI entry: `npx tsx scripts/get-test-port.ts [--url]`
if (require.main === module) {
  const urlFlag = process.argv.includes('--url');
  // eslint-disable-next-line no-console
  console.log(urlFlag ? getTestServerUrl() : String(getTestPort()));
}
