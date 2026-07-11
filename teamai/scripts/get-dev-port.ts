/**
 * Resolves the dev server port from the single source of truth
 * (the `dev` script in teamai/package.json).
 *
 * Why: the dev port currently appears as a `PORT=...` literal inside
 * the `dev` script in package.json. If the port ever changes, every
 * consumer (dev tooling, manual curl, helper functions) must be
 * updated in lockstep. This script makes "read it from package.json"
 * the only contract, so any consumer that imports from here picks up
 * the new value automatically.
 *
 * Usage (CLI):
 *   npx tsx scripts/get-dev-port.ts            # prints "3002"
 *   npx tsx scripts/get-dev-port.ts --url      # prints "http://localhost:3002"
 *
 * Programmatic:
 *   import { getDevPort, getDevServerUrl } from './get-dev-port';
 *   const port = getDevPort();
 *   const url  = getDevServerUrl();
 *
 * Why parse rather than import: importing package.json from a TS
 * file works, but the value lives in a string (the `dev` script
 * command), not as a structured key. A regex parse against the
 * `PORT=<digits>` literal is simpler, has no side effects, and a
 * refactor that changes the literal produces a clear error here
 * rather than a silent wrong-port fallback.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PACKAGE_JSON_PATH = join(__dirname, '..', 'package.json');

/**
 * Reads `teamai/package.json` and returns the literal port
 * declared in the `dev` script (e.g. `cross-env PORT=3002 tsx ...`).
 *
 * Throws if the script can't be read or the literal is missing —
 * both indicate a refactor that this script needs an update for,
 * which is the right failure mode (drift detected loudly).
 */
export function getDevPort(): number {
  if (!existsSync(PACKAGE_JSON_PATH)) {
    throw new Error(
      `package.json not found at ${PACKAGE_JSON_PATH}. ` +
      `Cannot resolve dev server port.`,
    );
  }
  const source = readFileSync(PACKAGE_JSON_PATH, 'utf-8');
  // Match the `PORT=<digits>` literal inside the `dev` script's
  // command string. The pattern handles the common `cross-env` form
  // (`"dev": "cross-env PORT=3002 tsx watch server.ts"`) and the
  // bare form (`"dev": "PORT=3002 tsx watch server.ts"`) — both
  // embed the literal `PORT=<digits>` token, which is what we
  // match on. A refactor that switches to a template literal
  // (e.g. `PORT=${DEV_PORT:-3002}`) intentionally fails here
  // rather than falling back to a wrong value.
  const match = source.match(/"dev":\s*"[^"]*PORT=(\d+)[^"]*"/);
  if (!match) {
    throw new Error(
      `Could not find a literal 'PORT=<digits>' in the dev script in ${PACKAGE_JSON_PATH}. ` +
      `Either restore the literal in the dev script, or update ` +
      `teamai/scripts/get-dev-port.ts to handle the new format.`,
    );
  }
  return Number(match[1]);
}

/**
 * Returns the full dev server URL (e.g. http://localhost:3002).
 *
 * Assumes the dev server always runs on `localhost` — the dev
 * script doesn't override HOST, so `server.ts` uses its default
 * `0.0.0.0` (which is reachable via localhost). If the dev server
 * ever binds to a non-loopback host, update this helper to read
 * the HOST from package.json too.
 */
export function getDevServerUrl(): string {
  return `http://localhost:${getDevPort()}`;
}

// CLI entry: `npx tsx scripts/get-dev-port.ts [--url]`
if (require.main === module) {
  const urlFlag = process.argv.includes('--url');
  // eslint-disable-next-line no-console
  console.log(urlFlag ? getDevServerUrl() : String(getDevPort()));
}
