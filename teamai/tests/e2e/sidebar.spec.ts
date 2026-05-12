import { test, expect } from '@playwright/test';

test.describe('Sidebar Navigation', () => {
  test('sidebar is visible with all navigation links', async ({ page }) => {
    await page.goto('/');

    // Sidebar should be visible
    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    // All navigation links should be present
    const navLinks = [
      { href: '/', label: 'Kanban' },
      { href: '/insights', label: 'Insights' },
      { href: '/ideation', label: 'Ideation' },
      { href: '/terminals', label: 'Terminals' },
      { href: '/roadmap', label: 'Roadmap' },
      { href: '/settings', label: 'Settings' },
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

    const sidebar = page.locator('aside');
    const toggleButton = sidebar.locator('button[title*="Collapse"]');
    await expect(toggleButton).toBeVisible();

    // Get initial width (expanded ~240px)
    const initialWidth = (await sidebar.boundingBox())?.width ?? 0;
    expect(initialWidth).toBeGreaterThan(100);

    // Click to collapse
    await toggleButton.click();

    // Sidebar should shrink
    const collapsedWidth = (await sidebar.boundingBox())?.width ?? 0;
    expect(collapsedWidth).toBeLessThan(60);
  });
});
