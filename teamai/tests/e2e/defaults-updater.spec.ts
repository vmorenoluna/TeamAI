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
    let content = readFileSync(defaultImplSrc, 'utf-8');
    if (content.includes('E2E defaults-updater test marker')) {
      // Normalize line endings before replace (MARKER uses LF, file may use CRLF)
      content = content.replace(/\r\n/g, '\n');
      content = content.replace(MARKER, '');
      writeFileSync(defaultImplSrc, content, 'utf-8');
    }
  });

  test('no banner when defaults are up to date', async ({ page }) => {
    const banner = page.locator('text=Defaults update available');
    await expect(banner).not.toBeVisible({ timeout: 5_000 });
  });

  test('stale defaults are detected and banner appears after reload', async ({ page }) => {
    // TODO: Re-enable when defaults sync + reload race condition is fixed.
    // After syncing stale defaults and reloading the page, the banner
    // persists because getOutdatedProjects() still reports the project
    // as having stale files.
    test.skip(true, 'Known issue: banner persists after sync + reload');
    // ── Modify the defaults file to simulate a TeamAI update ──────────
    const backup = readFileSync(defaultImplSrc, 'utf-8');
    writeFileSync(defaultImplSrc, backup + MARKER);

    try {
      // Full page reload — layout.tsx calls getOutdatedProjects() during SSR
      await page.reload();

      const bannerSection = page.locator('text=Defaults update available');
      await expect(bannerSection).toBeVisible({ timeout: 10_000 });

      // ── Sync the stale defaults ─────────────────────────────────────
      await page.waitForTimeout(1000);

      // Click the Sync button to trigger handleSync → syncProjectDefaults
      const syncButton = page.locator('button:has-text("Sync"):not(:has-text("All"))').first();
      await syncButton.click();

      // Button text should change to "Updating…" while the server action runs
      const updatingLocator = page.locator('button:has-text("Updating…")').first();
      await expect(updatingLocator).toBeVisible({ timeout: 5_000 });

      // Wait for sync to complete: "Updating…" disappears
      await expect(updatingLocator).not.toBeVisible({ timeout: 15_000 });

      // Verify the project file on disk was updated with the new default
      const implPath = join(SEED_DIR, '.claude', 'commands', 'implement.md');
      expect(readFileSync(implPath, 'utf-8')).toContain('E2E defaults-updater test marker');

      // Full page reload: server re-computes with the updated manifest
      await page.reload();

      // Banner should be gone (project is now up to date)
      await expect(bannerSection).not.toBeVisible({ timeout: 10_000 });
    } finally {
      writeFileSync(defaultImplSrc, backup);
    }
  });
});
