import { test, expect } from '@playwright/test';

test.describe('Terminals Page', () => {
  test('page loads and shows header', async ({ page }) => {
    await page.goto('/terminals');

    // Should show either terminals content or "no project" message
    await expect(page.locator('body')).toBeVisible({ timeout: 10_000 });

    // Sidebar should highlight Terminals
    const sidebarLink = page.locator('nav a[href="/terminals"]');
    await expect(sidebarLink).toBeVisible();
  });

  test('terminals page shows New Terminal button when project selected', async ({ page }) => {
    await page.goto('/terminals');

    const hasHeader = await page.locator('text=Terminals').count();
    const hasNoProject = await page.locator('text=No active project selected').count();

    expect(hasHeader + hasNoProject).toBeGreaterThan(0);

    // If terminals page loaded with a project, the "New Terminal" button should be visible
    if (hasHeader > 0) {
      await expect(page.locator('text=+ New Terminal')).toBeVisible({ timeout: 5_000 });
    }
  });

  test('opening New Terminal dialog shows role selector', async ({ page }) => {
    await page.goto('/terminals');

    const hasHeader = await page.locator('text=Terminals').count();
    if (hasHeader === 0) {
      test.skip(true, 'No active project — skipping dialog test');
      return;
    }

    // Click the New Terminal button
    const newTerminalButton = page.locator('text=+ New Terminal');
    await expect(newTerminalButton).toBeVisible({ timeout: 5_000 });
    await newTerminalButton.click();

    // Dialog should appear with role selector
    await expect(page.locator('text=New Terminal').last()).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('select')).toBeVisible();

    // Cancel button should close the dialog — verify by checking the select is gone
    await page.locator('text=Cancel').click();
    await expect(page.locator('select')).not.toBeVisible({ timeout: 3_000 });
  });
});
