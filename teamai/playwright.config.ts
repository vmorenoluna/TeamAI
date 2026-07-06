import { defineConfig, devices } from '@playwright/test';

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
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    headless: true,
  },
  webServer: {
    command: 'npx tsx server.ts',
    url: 'http://localhost:3000',
    reuseExistingServer: true,
    timeout: 120_000,
    cwd: __dirname,
    env: {
      NODE_ENV: 'test',
    },
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
