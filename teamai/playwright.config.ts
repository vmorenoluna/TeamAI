import { defineConfig, devices } from '@playwright/test';
import { randomUUID } from 'crypto';
import { join } from 'path';
import { tmpdir } from 'os';

const TEMP_CONFIG_DIR = join(tmpdir(), `teamai-e2e-config-${randomUUID().slice(0, 8)}`);

// Set in the Playwright process so globalSetup inherits it.
// webServer is a separate process — its env is set in webServer.env below.
process.env.TEAMAI_CONFIG_DIR = TEMP_CONFIG_DIR;

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  workers: 1,
  // ^ Serial execution — retry-button.spec.ts modifies shared seed state
  //   (completionSummary, phase) and would race with completion-summary.spec.ts
  //   and task-detail.spec.ts reading the same failed task in parallel.
  globalSetup: require.resolve('./tests/e2e/playwright-setup.ts'),
  globalTeardown: require.resolve('./tests/e2e/playwright-teardown.ts'),
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
    headless: true,
  },
  webServer: {
    command: 'npx tsx server.ts',
    url: 'http://localhost:3001',
    // Force a fresh dev server per test run. If we allow reuseExistingServer,
    // the running server's projectStore.ts singleton has its CONFIG_DIR frozen
    // at module-load time, so projectStore.getByPath() returns NULL on every lookup
    // and the kanban tests time out at 30s in beforeEach.
    // CI → same behavior (false). Local dev → also false so tests don't
    // silently reuse a `npm run dev` server with stale state.
    reuseExistingServer: false,
    timeout: 120_000,
    cwd: __dirname,
    // Why 3001 (not 3002): avoids the dev server. Dev tooling should
    // import getTestServerUrl() from scripts/servers.ts instead
    // — to avoid drift.
    env: {
      NODE_ENV: 'test',
      // Pass the temp config dir via env var so project-store.ts resolves
      // CONFIG_DIR at module-load time (before globalSetup runs). Playwright
      // starts webServer before globalSetup, so a file-based approach
      // (.teamai-e2e-config-path) creates a race condition.
      TEAMAI_CONFIG_DIR: TEMP_CONFIG_DIR,
      PORT: '3001',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
