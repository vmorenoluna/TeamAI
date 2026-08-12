/**
 * Kills any process listening on port 3001 (the E2E test server port).
 *
 * Two-pronged approach:
 *   1. PID file — server.ts writes its PID to a known temp file on startup.
 *      If the file exists and the PID is alive, kill it directly (fast and
 *      precise — no netstat scan needed).  This handles zombies from
 *      force-killed Playwright runs where SIGTERM never reached the node
 *      grandchild.
 *   2. Netstat scan — scans for any process listening on port 3001 and
 *      kills it.  This handles edge cases where the PID file was deleted
 *      but the process survived (e.g. filesystem races).
 *
 * After killing, waits briefly and re-checks — on Windows, the port can
 * remain in TIME_WAIT for a few seconds after taskkill, preventing the
 * next server from binding.  Retries up to 3 times.
 *
 * Best-effort — does not fail if the port is already free.
 *
 * Exports a `clearPort()` function for programmatic use, and supports
 * direct CLI invocation (`node scripts/clear-port-3001.mjs`).
 */

import { execSync } from 'child_process';
import { platform } from 'os';
import { existsSync, readFileSync, unlinkSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { setTimeout } from 'timers/promises';

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

/** Return the PID file path for a given port so prod (3000) and test (3001)
 *  servers never collide on the same file. */
function getPidFile(port) {
  return join(tmpdir(), `teamai-server-${port}.pid`);
}

function isPidAlive(pid) {
  try {
    if (platform() === 'win32') {
      // On Windows, `tasklist /fi "PID eq X"` returns "INFO: No tasks..." if dead
      const out = execSync(`tasklist /fi "PID eq ${pid}" /fo csv /nh`, {
        encoding: 'utf-8',
        stdio: 'pipe',
      });
      return out.includes(String(pid));
    } else {
      // Signal 0 checks existence without actually sending a signal
      process.kill(pid, 0);
      return true;
    }
  } catch {
    return false;
  }
}

function killPid(pid) {
  try {
    if (platform() === 'win32') {
      console.log(`[clear-port] Killing PID ${pid}…`);
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
      console.log(`[clear-port] Killed PID ${pid}`);
    } else {
      process.kill(pid, 'SIGKILL');
      console.log(`[clear-port] Killed PID ${pid}`);
    }
    return true;
  } catch (err) {
    console.warn(`[clear-port] Failed to kill PID ${pid}: ${err.message}`);
    return false;
  }
}

/** Kill a zombie by reading its port-specific PID file, then clean up the file. */
function killFromPidFile(port) {
  const pidFile = getPidFile(port);
  if (!existsSync(pidFile)) return false;

  try {
    const raw = readFileSync(pidFile, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    if (!pid || isNaN(pid)) {
      console.warn(`[clear-port] PID file ${pidFile} has invalid content: "${raw}"`);
      try { unlinkSync(pidFile); } catch { /* best-effort */ }
      return false;
    }

    if (!isPidAlive(pid)) {
      console.log(`[clear-port] PID ${pid} from PID file is not alive — removing stale file`);
      try { unlinkSync(pidFile); } catch { /* best-effort */ }
      return false;
    }

    console.log(`[clear-port] Found zombie PID ${pid} from ${pidFile}`);
    const killed = killPid(pid);
    try { unlinkSync(pidFile); } catch { /* best-effort */ }
    return killed;
  } catch (err) {
    console.warn(`[clear-port] Error reading PID file: ${err.message}`);
    try { unlinkSync(pidFile); } catch { /* best-effort */ }
    return false;
  }
}

function isPortFree(port) {
  try {
    if (platform() === 'win32') {
      execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: 'utf-8', stdio: 'pipe' },
      );
      return false; // netstat found LISTENING → port occupied
    } else {
      execSync(`lsof -ti:${port}`, { stdio: 'pipe' });
      return false; // lsof found a process → port occupied
    }
  } catch {
    return true; // command failed → nothing listening → port free
  }
}

function killProcessOnPort(port) {
  if (platform() === 'win32') {
    try {
      const result = execSync(
        `netstat -ano | findstr :${port} | findstr LISTENING`,
        { encoding: 'utf-8', stdio: 'pipe' },
      );
      const lines = result.trim().split('\n').filter(Boolean);
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        const pid = parts[parts.length - 1];
        if (pid && /^\d+$/.test(pid)) {
          killPid(parseInt(pid, 10));
        }
      }
      return lines.length > 0;
    } catch {
      return false; // netstat errored → nothing to kill
    }
  } else {
    try {
      execSync(`lsof -ti:${port} | xargs -r kill -9 2>/dev/null`, {
        stdio: 'pipe',
      });
      console.log(`[clear-port] Port ${port} cleared`);
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Programmatic API — call from server.ts or other modules.
 * @param {string} port — the port to clear (required, caller must specify).
 */
export async function clearPort(port) {
  // ── Step 1: PID file (precise zombie detection, port-specific) ─────
  killFromPidFile(port);

  // ── Step 2: Quick netstat check ────────────────────────────────────
  if (isPortFree(port)) {
    console.log(`[clear-port] Port ${port} is free`);
    return;
  }

  // ── Step 3: Netstat scan + retry ───────────────────────────────────
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[clear-port] Port ${port} occupied — attempt ${attempt}/${MAX_RETRIES}`);
    const killed = killProcessOnPort(port);

    if (killed) {
      // Wait for the OS to release the port (handles Windows TIME_WAIT)
      console.log(`[clear-port] Waiting ${RETRY_DELAY_MS / 1000}s for port release…`);
      await setTimeout(RETRY_DELAY_MS);
    }

    if (isPortFree(port)) {
      console.log(`[clear-port] Port ${port} is free`);
      return;
    }

    if (attempt < MAX_RETRIES) {
      await setTimeout(RETRY_DELAY_MS);
    }
  }

  console.warn(`[clear-port] Port ${port} still occupied after ${MAX_RETRIES} attempts — continuing anyway`);
}

// Standalone CLI support — run with `node scripts/clear-port-3001.mjs <port>`
const isMain = process.argv[1] && (
  process.argv[1].endsWith('clear-port-3001.mjs') ||
  process.argv[1].endsWith('clear-port-3001')
);

if (isMain) {
  const port = process.argv[2];
  if (!port) {
    console.error('[clear-port] Usage: node scripts/clear-port-3001.mjs <port>');
    process.exit(1);
  }
  await clearPort(port);
}
