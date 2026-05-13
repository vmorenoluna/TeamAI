import { test, expect } from '@playwright/test';

test.describe('Roadmap Page', () => {
  test('page loads and shows header', async ({ page }) => {
    await page.goto('/roadmap');

    // Should show roadmap content — either the roadmap view or "no project" message
    await expect(page.locator('body')).toBeVisible();

    // Look for the Roadmap link in sidebar to confirm we're on the right page
    const sidebarLink = page.locator('nav a[href="/roadmap"]');
    await expect(sidebarLink).toBeVisible({ timeout: 10_000 });
  });

  test('roadmap view renders cards or empty state', async ({ page }) => {
    await page.goto('/roadmap');

    // The page should contain either roadmap cards or an empty-state message
    const body = page.locator('body');
    const hasCards = await body.locator('[class*="rounded"]').count();
    const hasEmptyMessage = await body.locator('text=No active project').count();

    expect(hasCards + hasEmptyMessage).toBeGreaterThan(0);
  });
});
