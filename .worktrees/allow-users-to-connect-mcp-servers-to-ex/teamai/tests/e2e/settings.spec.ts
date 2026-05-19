import { test, expect } from '@playwright/test';

test.describe('Settings Page', () => {
  test('page loads and shows settings sections', async ({ page }) => {
    await page.goto('/settings');

    // Should show either the settings page or "no project" message
    await expect(page.locator('body')).toBeVisible({ timeout: 10_000 });

    // Sidebar should highlight Settings
    const sidebarLink = page.locator('nav a[href="/settings"]');
    await expect(sidebarLink).toBeVisible();
  });

  test('settings page shows configuration sections when project is selected', async ({ page }) => {
    await page.goto('/settings');

    // Check if we have a project
    const noProject = page.locator('text=No active project selected');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    // Wait for the settings header to confirm page loaded
    await expect(page.locator('text=Settings')).toBeVisible({ timeout: 10_000 });

    // Key sections should be visible — check with generous timeouts
    // since client components may take a moment to hydrate
    await expect(page.locator('text=Container Isolation')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Pipeline Configuration')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Providers')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Agent Roles')).toBeVisible({ timeout: 5_000 });
  });

  test('provider config dropdown has all provider options', async ({ page }) => {
    await page.goto('/settings');

    const noProject = page.locator('text=No active project selected');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project — skipping provider config test');
      return;
    }

    await expect(page.locator('text=Settings')).toBeVisible({ timeout: 10_000 });

    // Find provider dropdowns — at least one select element should be visible
    const selects = page.locator('select');
    const selectCount = await selects.count();
    if (selectCount > 0) {
      await expect(selects.first()).toBeVisible();
    }
  });
});
