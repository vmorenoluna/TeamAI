/**
 * Kills any process listening on port 3001 (the E2E test server port).
 *
 * Used as a `pretest:e2e` hook to clean up orphaned servers from crashed
 * or force-killed test runs, so the next Playwright webServer can bind.
 *
 * Best-effort — does not fail if the port is already free.
 */

import { execSync } from 'child_process';
import { platform } from 'os';

const PORT = '3001';

function main() {
  if (platform() === 'win32') {
    // Windows: find LISTENING PID on port via netstat, kill with taskkill
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
          try {
            execSync(`taskkill /PID ${pid} /F`, { stdio: 'pipe' });
            console.log(`[clear-port] Killed PID ${pid}`);
          } catch {
            console.warn(`[clear-port] Failed to kill PID ${pid} (may require admin)`);
          }
        }
      }
      if (lines.length === 0) {
        console.log(`[clear-port] Port ${PORT} is free`);
      }
    } catch {
      // netstat returned nothing → port is free
      console.log(`[clear-port] Port ${PORT} is free`);
    }
  } else {
    // Linux / macOS: kill via lsof
    try {
      execSync(`lsof -ti:${PORT} | xargs -r kill -9 2>/dev/null`, {
        stdio: 'pipe',
      });
      console.log(`[clear-port] Port ${PORT} cleared`);
    } catch {
      console.log(`[clear-port] Port ${PORT} is free`);
    }
  }
}

main();
