/**
 * Kills any process listening on port 3001 (the E2E test server port).
 *
 * Used as a `pretest:e2e` hook to clean up orphaned servers from crashed
 * or force-killed test runs, so the next Playwright webServer can bind.
 *
 * After killing, waits briefly and re-checks — on Windows, the port can
 * remain in TIME_WAIT for a few seconds after taskkill, preventing the
 * next server from binding.  Retries up to 3 times.
 *
 * Best-effort — does not fail if the port is already free.
 */

import { execSync } from 'child_process';
import { platform } from 'os';
import { setTimeout } from 'timers/promises';

const PORT = '3001';
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 2_000;

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
          console.log(`[clear-port] Killing PID ${pid} on port ${PORT}...`);
          execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
          console.log(`[clear-port] Killed PID ${pid}`);
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

async function main() {
  // Quick check first — if free, exit immediately
  if (isPortFree()) {
    console.log(`[clear-port] Port ${PORT} is free`);
    return;
  }

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

await main();
