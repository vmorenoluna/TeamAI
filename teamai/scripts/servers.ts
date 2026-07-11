/**
 * Resolves the URLs and ports for the two project servers from their
 * single sources of truth:
 *
 *   - Test server (`npm run test:e2e`) → playwright.config.ts PORT literal
 *   - Dev server (`npm run dev`)       → package.json dev script PORT literal
 *
 * Both servers are intentionally on different ports (3001 vs 3002) so
 * `npm run dev` and `npm run test:e2e` can run side by side on the same
 * machine. Each helper parses its config file as text rather than
 * importing it, which:
 *
 *   1. Avoids side effects from importing the configs (playwright.config.ts
 *      assigns process.env.TEAMAI_CONFIG_DIR at module load).
 *   2. Lets the script run with plain `node` (no `tsx` required).
 *   3. Produces a clear error if the literal is ever refactored away,
 *      rather than silently falling back to a wrong value.
 *
 * Usage (CLI):
 *   npx tsx scripts/servers.ts test          # prints "3001"
 *   npx tsx scripts/servers.ts test --url    # prints "http://localhost:3001"
 *   npx tsx scripts/servers.ts dev           # prints "3002"
 *   npx tsx scripts/servers.ts dev --url     # prints "http://localhost:3002"
 *
 * Programmatic:
 *   import { getTestServerUrl, getDevServerUrl } from './servers';
 *   const testUrl = getTestServerUrl();
 *   const devUrl  = getDevServerUrl();
 *
 * Both URL helpers assume `localhost` — the configs hardcode it (or, in
 * the dev case, don't override HOST, so server.ts uses its `0.0.0.0`
 * default which is reachable via localhost). If either server ever binds
 * to a non-loopback host, update the corresponding helper.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const PROJECT_ROOT = join(__dirname, '..');

/**
 * Shared core: read a config file, regex-match a port literal, return
 * the captured number. Throws clearly if the file or literal is missing.
 *
 * `configLabel` appears in the error message so the user knows which
 * config to fix. `literalHint` is the form the regex expects (e.g.
 * `PORT: '3001'` or `PORT=3002 inside "dev"`).
 */
function readConfigPort(
  relativePath: string,
  regex: RegExp,
  configLabel: string,
  literalHint: string,
): number {
  const absolutePath = join(PROJECT_ROOT, relativePath);
  if (!existsSync(absolutePath)) {
    throw new Error(
      `${configLabel} not found at ${absolutePath}. Cannot resolve port.`,
    );
  }
  const source = readFileSync(absolutePath, 'utf-8');
  const match = source.match(regex);
  if (!match) {
    throw new Error(
      `Could not find a port literal (${literalHint}) in ${configLabel} at ${absolutePath}. ` +
      `Either restore the literal, or update scripts/servers.ts to handle the new format.`,
    );
  }
  return Number(match[1]);
}

// ── Test server (Playwright) ────────────────────────────────────────────────

/** Port for `npm run test:e2e` — read from playwright.config.ts. */
export function getTestPort(): number {
  return readConfigPort(
    'playwright.config.ts',
    /PORT:\s*['"](\d+)['"]/,
    'playwright.config.ts',
    "`PORT: '<digits>'` in webServer.env",
  );
}

export function getTestServerUrl(): string {
  return `http://localhost:${getTestPort()}`;
}

// ── Dev server ──────────────────────────────────────────────────────────────

/** Port for `npm run dev` — read from package.json's `dev` script. */
export function getDevPort(): number {
  return readConfigPort(
    'package.json',
    /"dev":\s*"[^"]*PORT=(\d+)[^"]*"/,
    "package.json's dev script",
    '`PORT=<digits>` in the dev script command',
  );
}

export function getDevServerUrl(): string {
  return `http://localhost:${getDevPort()}`;
}

// ── CLI entry ───────────────────────────────────────────────────────────────
// Usage: npx tsx scripts/servers.ts <test|dev> [--url]

if (require.main === module) {
  const args = process.argv.slice(2);
  const server = args[0];
  const urlFlag = args.includes('--url');

  if (server !== 'test' && server !== 'dev') {
    // eslint-disable-next-line no-console
    console.error('Usage: npx tsx scripts/servers.ts <test|dev> [--url]');
    process.exit(1);
  }

  const port = server === 'test' ? getTestPort() : getDevPort();
  const url  = server === 'test' ? getTestServerUrl() : getDevServerUrl();
  // eslint-disable-next-line no-console
  console.log(urlFlag ? url : String(port));
}
