import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 30_000,
  retries: 0,
  globalSetup: require.resolve('./tests/e2e/playwright-setup.ts'),
  globalTeardown: require.resolve('./tests/e2e/playwright-teardown.ts'),
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    headless: true,
  },
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
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
