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
  // Per-worker seed isolation (T31): each worker gets its own copy of the
  // seed data, so tests that mutate state don't race.
  // Defaults to 2 workers.  The dev server (a single Next.js process) can't
  // reliably handle 4 concurrent browser sessions making heavy SSR requests
  // (xterm pages with dynamic imports + WebSocket), which causes the
  // terminal-live-labels test to time out with an empty buffer.  Override
  // with E2E_MAX_WORKERS=4 for faster local runs when the terminal test
  // isn't required, or when running a single spec file.
  workers: process.env.CI ? 2 : parseInt(process.env.E2E_MAX_WORKERS || '2', 10),
  fullyParallel: true,
  globalSetup: require.resolve('./tests/e2e/playwright-setup.ts'),
  globalTeardown: require.resolve('./tests/e2e/playwright-teardown.ts'),
  use: {
    baseURL: 'http://localhost:3001',
    trace: 'on-first-retry',
    headless: true,
    testIdAttribute: 'data-component',
  },
  webServer: {
    // Single process (no shell && chaining) so Playwright can kill it
    // cleanly.  On Windows, shell && chains create orphaned grandchild
    // processes because SIGTERM doesn't propagate through the tree.
    // Port cleanup is handled inside server.ts itself.
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
