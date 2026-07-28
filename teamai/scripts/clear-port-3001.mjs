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

const PORT = '3001';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;
const PID_FILE = join(tmpdir(), 'teamai-e2e-server.pid');

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

/** Kill a zombie by reading its PID file, then clean up the file. */
function killFromPidFile() {
  if (!existsSync(PID_FILE)) return false;

  try {
    const raw = readFileSync(PID_FILE, 'utf-8').trim();
    const pid = parseInt(raw, 10);
    if (!pid || isNaN(pid)) {
      console.warn(`[clear-port] PID file ${PID_FILE} has invalid content: "${raw}"`);
      try { unlinkSync(PID_FILE); } catch { /* best-effort */ }
      return false;
    }

    if (!isPidAlive(pid)) {
      console.log(`[clear-port] PID ${pid} from PID file is not alive — removing stale file`);
      try { unlinkSync(PID_FILE); } catch { /* best-effort */ }
      return false;
    }

    console.log(`[clear-port] Found zombie PID ${pid} from ${PID_FILE}`);
    const killed = killPid(pid);
    try { unlinkSync(PID_FILE); } catch { /* best-effort */ }
    return killed;
  } catch (err) {
    console.warn(`[clear-port] Error reading PID file: ${err.message}`);
    try { unlinkSync(PID_FILE); } catch { /* best-effort */ }
    return false;
  }
}

function isPortFree() {
  try {
    if (platform() === 'win32') {
      execSync(
        `netstat -ano | findstr :${PORT} | findstr LISTENING`,
        { encoding: 'utf-8', stdio: 'pipe' },
      );
      return false; // netstat found LISTENING → port occupied
    } else {
      execSync(`lsof -ti:${PORT}`, { stdio: 'pipe' });
      return false; // lsof found a process → port occupied
    }
  } catch {
    return true; // command failed → nothing listening → port free
  }
}

function killProcessOnPort() {
  if (platform() === 'win32') {
    try {
      const result = execSync(
        `netstat -ano | findstr :${PORT} | findstr LISTENING`,
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
      execSync(`lsof -ti:${PORT} | xargs -r kill -9 2>/dev/null`, {
        stdio: 'pipe',
      });
      console.log(`[clear-port] Port ${PORT} cleared`);
      return true;
    } catch {
      return false;
    }
  }
}

/** Programmatic API — call from server.ts or other modules. */
export async function clearPort() {
  // ── Step 1: PID file (precise zombie detection) ────────────────────
  killFromPidFile();

  // ── Step 2: Quick netstat check ────────────────────────────────────
  if (isPortFree()) {
    console.log(`[clear-port] Port ${PORT} is free`);
    return;
  }

  // ── Step 3: Netstat scan + retry ───────────────────────────────────
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    console.log(`[clear-port] Port ${PORT} occupied — attempt ${attempt}/${MAX_RETRIES}`);
    const killed = killProcessOnPort();

    if (killed) {
      // Wait for the OS to release the port (handles Windows TIME_WAIT)
      console.log(`[clear-port] Waiting ${RETRY_DELAY_MS / 1000}s for port release…`);
      await setTimeout(RETRY_DELAY_MS);
    }

    if (isPortFree()) {
      console.log(`[clear-port] Port ${PORT} is free`);
      return;
    }

    if (attempt < MAX_RETRIES) {
      await setTimeout(RETRY_DELAY_MS);
    }
  }

  console.warn(`[clear-port] Port ${PORT} still occupied after ${MAX_RETRIES} attempts — continuing anyway`);
}

// Standalone CLI support — run with `node scripts/clear-port-3001.mjs`
const isMain = process.argv[1] && (
  process.argv[1].endsWith('clear-port-3001.mjs') ||
  process.argv[1].endsWith('clear-port-3001')
);

if (isMain) {
  await clearPort();
}
