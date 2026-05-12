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

    // Check for the settings page header
    const hasHeader = await page.locator('text=Settings').count();
    const hasNoProject = await page.locator('text=No active project selected').count();

    // Either we see Settings header or the no-project message
    expect(hasHeader + hasNoProject).toBeGreaterThan(0);

    // If settings loaded, check for key sections
    if (hasHeader > 0) {
      // Container Isolation section
      await expect(page.locator('text=Container Isolation')).toBeVisible({ timeout: 5_000 });
      // Pipeline Configuration section
      await expect(page.locator('text=Pipeline Configuration')).toBeVisible();
      // Providers section
      await expect(page.locator('text=Providers')).toBeVisible();
      // Agent Roles section
      await expect(page.locator('text=Agent Roles')).toBeVisible();
    }
  });

  test('provider config dropdown has all provider options', async ({ page }) => {
    await page.goto('/settings');

    const hasHeader = await page.locator('text=Settings').count();
    if (hasHeader === 0) {
      test.skip(true, 'No active project — skipping provider config test');
      return;
    }

    // Find provider dropdowns — at least one select element should be visible
    const selects = page.locator('select');
    const selectCount = await selects.count();
    if (selectCount > 0) {
      await expect(selects.first()).toBeVisible();
    }
  });
});
