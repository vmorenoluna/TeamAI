/**
 * Build version + git SHA, computed once per server process.
 *
 * The root layout renders on every navigation; shelling out to `git rev-parse`
 * there costs a process spawn per render. The result is memoised on globalThis
 * (same sharing pattern as auto-mode-state.ts) so it survives module
 * re-evaluation, and server.ts warms it at boot before the server listens.
 */
import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join } from 'path';

export interface BuildInfo {
  version: string;
  sha: string;
}

const SHA_FALLBACK = 'unknown';

declare global {
  var __teamaiBuildInfo: BuildInfo | undefined;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));
    return String(pkg.version ?? '');
  } catch {
    return '';
  }
}

function readSha(): string {
  try {
    const sha = execSync('git rev-parse HEAD', {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim().slice(0, 7);
    return sha || SHA_FALLBACK;
  } catch {
    return SHA_FALLBACK;
  }
}

/** Never throws: a missing package.json yields version '', a git failure yields sha 'unknown'. */
export function getBuildInfo(): BuildInfo {
  if (!globalThis.__teamaiBuildInfo) {
    globalThis.__teamaiBuildInfo = { version: readVersion(), sha: readSha() };
  }
  return globalThis.__teamaiBuildInfo;
}
