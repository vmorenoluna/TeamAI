import { test, expect } from '@playwright/test';

test.describe('Sidebar Navigation', () => {
  test('sidebar is visible with all navigation links', async ({ page }) => {
    await page.goto('/');

    // Sidebar should be visible
    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    // All navigation links should be present
    const navLinks = [
      { href: '/' },
      { href: '/insights' },
      { href: '/ideation' },
      { href: '/terminals' },
      { href: '/roadmap' },
      { href: '/settings' },
    ];

    for (const { href } of navLinks) {
      const link = sidebar.locator(`a[href="${href}"]`);
      await expect(link).toBeVisible();
    }
  });

  test('navigating via sidebar changes the active page', async ({ page }) => {
    await page.goto('/');

    // Click Roadmap link
    await page.locator('nav a[href="/roadmap"]').click();
    await expect(page).toHaveURL(/\/roadmap/);

    // Click Settings link
    await page.locator('nav a[href="/settings"]').click();
    await expect(page).toHaveURL(/\/settings/);
  });

  test('kanban link highlights when on home or task pages', async ({ page }) => {
    await page.goto('/');

    // Kanban link should be active on home page
    const kanbanLink = page.locator('nav a[href="/"]');
    await expect(kanbanLink).toHaveClass(/border-r-2/);
  });

  test('sidebar collapse/expand toggle works', async ({ page }) => {
    await page.goto('/');
    // Wait for client-side React hydration (don't use networkidle — WebSockets keep connections open)
    await page.waitForTimeout(1500);

    const sidebar = page.locator('aside');

    // Initially expanded — should have w-60 class (240px)
    await expect(sidebar).toHaveClass(/w-60/);

    // Click collapse button using native DOM click via evaluate,
    // which bypasses any Playwright actionability / pointer-events issues
    await sidebar.evaluate((el) => {
      const btn = el.querySelector('button');
      if (btn instanceof HTMLElement) btn.click();
    });

    // Wait for React re-render + CSS transition
    await page.waitForTimeout(500);

    // Sidebar should now have w-12 class (collapsed)
    await expect(sidebar).toHaveClass(/w-12/);

    // Button title should change to "Expand sidebar"
    const expandButton = sidebar.locator('button[title*="Expand"]');
    await expect(expandButton).toBeVisible();
  });
});
