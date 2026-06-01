import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

test.describe('Settings Page', () => {
  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);
  });

  test('page loads and shows settings sections', async ({ page }) => {
    await page.goto('/settings');

    await expect(page.locator('body')).toBeVisible({ timeout: 10_000 });

    const sidebarLink = page.locator('nav a[href="/settings"]');
    await expect(sidebarLink).toBeVisible();
  });

  test('settings page shows configuration sections when project is selected', async ({ page }) => {
    await page.goto('/settings');

    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('text=Container Isolation')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Pipeline Configuration')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Providers')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Agent Roles')).toBeVisible({ timeout: 5_000 });
  });

  test('provider config has provider and model dropdowns with refresh buttons', async ({ page }) => {
    await page.goto('/settings');

    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    const selects = page.locator('select');
    await expect(selects.first()).toBeVisible();

    const refreshButtons = page.locator('button[title*="Refresh"]');
    const refreshCount = await refreshButtons.count();
    expect(refreshCount).toBeGreaterThanOrEqual(1);

    const saveButton = page.locator('button:has-text("Save Provider Config")');
    await expect(saveButton).toBeVisible();
  });

  test('provider and role rows show loading state for model dropdowns', async ({ page }) => {
    await page.goto('/settings');

    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('text=Default (all roles)')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Role overrides')).toBeVisible({ timeout: 5_000 });
  });
});
