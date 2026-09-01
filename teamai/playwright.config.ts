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
    // Production build+start (not dev mode): Next.js dev mode compiles routes
    // on-demand on first hit and does dev-only work (HMR, on-demand
    // compilation) that is slow and unpredictable under concurrent SSR load —
    // the direct cause of the suite-wide E2E flakiness (210/260 failures on
    // CI, 0 failures per-spec in isolation). The production bundle serves
    // precompiled routes with no per-request compilation cost.
    // The build runs in the pretest:e2e / pretest:e2e:smoke npm hooks
    // (npm run build:electron), NOT here — a `command` of
    // `npm run build && npm run start` would be a shell chain, which the
    // single-process rule below forbids (orphaned grandchildren on Windows).
    command: 'npm run start',
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
      // Must be 'production': server.ts boots next({ dev: NODE_ENV !== 'production' }).
      // This env overrides the start script's `cross-env NODE_ENV=production`
      // (Playwright merges webServer.env on top of the command's env), so a value
      // of 'test' here silently re-enabled dev mode and reproduced the
      // dev-server flakiness across the whole suite (197/260 failed).
      NODE_ENV: 'production',
      // Next's build marks native-addon deps (e.g. node-pty) as server
      // externals resolved by bare specifier at runtime (node-pty-<hash>).
      // scripts/fix-external-symlinks.mjs (run by build:electron in the
      // pretest hook) places a portable proxy for each under external-shims/
      // instead of node_modules — see that script for why — so Node needs
      // NODE_PATH to find them (same mechanism electron/main.js uses).
      NODE_PATH: join(__dirname, 'external-shims'),
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
