/**
 * E2E tests for the DefaultsUpdater component.
 *
 * Verifies the amber "Defaults update available" banner appears when a
 * registered project has outdated default files, and that the Sync button
 * updates uncustomized files and dismisses the banner.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected, SEED_DIR } from './helpers';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';

test.describe('DefaultsUpdater', () => {
  const defaultImplSrc = join(process.cwd(), 'defaults', 'commands', 'implement.md');
  const MARKER = '\n\n<!-- E2E defaults-updater test marker -->\n';

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);
  });

  test.afterEach(() => {
    if (!existsSync(defaultImplSrc)) return;
    const content = readFileSync(defaultImplSrc, 'utf-8');
    if (content.includes('E2E defaults-updater test marker')) {
      writeFileSync(defaultImplSrc, content.replace(MARKER, ''));
    }
  });

  test('no banner when defaults are up to date', async ({ page }) => {
    const banner = page.locator('text=Defaults update available');
    await expect(banner).not.toBeVisible({ timeout: 5_000 });
  });

  test('banner appears when a default is stale, sync updates the file, and banner disappears', async ({ page }) => {
    const backup = readFileSync(defaultImplSrc, 'utf-8');
    writeFileSync(defaultImplSrc, backup + MARKER);

    try {
      await page.reload();

      const bannerSection = page.locator('text=Defaults update available');
      await expect(bannerSection).toBeVisible({ timeout: 10_000 });

      // Brief wait for React hydration to complete before clicking.
      await page.waitForTimeout(1000);

      // Click the Sync button to trigger handleSync → syncProjectDefaults.
      const syncButton = page.locator('button:has-text("Sync"):not(:has-text("All"))').first();
      await syncButton.click();

      // The button text should change to "Updating…" while the server
      // action runs, confirming handleSync was triggered.
      const updatingLocator = page.locator('button:has-text("Updating…")').first();
      await expect(updatingLocator).toBeVisible({ timeout: 5_000 });

      // Wait for sync to complete: "Updating…" disappears.
      await expect(updatingLocator).not.toBeVisible({ timeout: 15_000 });

      // Verify the file on disk was updated.
      const implPath = join(SEED_DIR, '.claude', 'commands', 'implement.md');
      expect(readFileSync(implPath, 'utf-8')).toContain('E2E defaults-updater test marker');

      // Full page reload: server re-computes with updated manifest.
      await page.reload();

      // Banner should be gone.
      await expect(bannerSection).not.toBeVisible({ timeout: 10_000 });
    } finally {
      writeFileSync(defaultImplSrc, backup);
    }
  });
});
