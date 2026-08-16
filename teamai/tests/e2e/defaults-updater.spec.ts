/**
 * E2E smoke test for the defaults auto-sync banner.
 *
 * Default command templates are force-synced at server startup and surfaced as
 * an informational banner. The full banner render/dismiss behavior is covered
 * by unit tests (tests/unit/defaults-updater.test.tsx) because the E2E seed
 * runs after server startup — so no startup sync report is produced in E2E.
 * This spec only asserts the banner stays absent when nothing was synced.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

test.describe('Defaults auto-sync banner', () => {
  const BANNER = 'TeamAI defaults auto-synced';

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);
  });

  test('no banner when no sync report exists', async ({ page }) => {
    await expect(page.locator(`text=${BANNER}`)).not.toBeVisible({ timeout: 5_000 });
  });
});
