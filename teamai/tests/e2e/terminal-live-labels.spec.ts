/**
 * E2E test: verify that terminal tab renders parsed log content with
 * correct agent role labels.
 *
 * Regression test for the bug where `formatLiveEvent` lacked the `[Role]`
 * prefix that `parseRoleLog` always includes for disk-based logs.
 *
 * Content verification reads from the xterm.js DOM (`.xterm-rows`). The
 * terminal uses the DOM renderer so text nodes are accessible to Playwright
 * assertions.
 */
import { test, expect } from '@playwright/test';
import { getTestServerUrl } from '../../scripts/servers';
import {
  getActiveSeedDir,
  requireSeedTaskId,
  writeTestSessionMap,
  writeTestLogFile,
} from './helpers';

const TASK_SLUG = 'test-terminal-live-event-labels';
const TEST_SESSION_ID = 'test-coder-session-42';

test.setTimeout(90_000);

test('terminal renders SSR log labels with correct role prefixes', async ({ page }) => {
  const taskId = requireSeedTaskId(TASK_SLUG);

  // Write files then set the active-project cookie directly.
  writeTestSessionMap(TASK_SLUG, { '1': TEST_SESSION_ID });
  writeTestLogFile(TASK_SLUG, 'output.log',
    '[2026-07-25T10:00:01] ◆ Session started — claude-sonnet-4\n' +
    '[2026-07-25T10:00:05] Hello from the coder\n'
  );

  const seedDir = getActiveSeedDir();
  await page.context().addCookies([{
    name: 'activeProject',
    value: seedDir,
    url: getTestServerUrl(),
  }]);

  // ── Navigate and wait for the terminal to initialise ──────────────
  await page.goto(`/task/${taskId}#terminal`);
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-component="terminal-container"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('terminal-empty-state')).not.toBeVisible({ timeout: 10_000 });

  const xtermRows = page.locator('[data-component="terminal-container"] .xterm-rows');

  // Verify SSR-rendered log content shows correct role labels.
  await expect(xtermRows).toContainText('Session started', { timeout: 30_000 });
  const content = await xtermRows.textContent();
  expect(content).toContain('[Orchestrator]');
});
