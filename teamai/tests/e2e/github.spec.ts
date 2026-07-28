/**
 * E2E tests for the GitHub Issues page (/github).
 *
 * Covers: page load, heading, description text, List Open Issues button,
 * empty state prompt, sidebar navigation, page refresh survival.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

test.describe('GitHub Issues Page', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  test('sidebar navigation: clicking GitHub link navigates to /github and shows heading', async ({ page }) => {
    await page.goto('/');

    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    const link = sidebar.locator('a[href="/github"]');
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/github/);
    await expect(page.locator('h1:has-text("GitHub Issues")')).toBeVisible({ timeout: 10_000 });
  });

  test('collapsed sidebar: clicking GitHub icon navigates to /github and shows heading', async ({ page }) => {
    await page.goto('/');
    await page.waitForTimeout(1500);

    const sidebar = page.locator('aside');
    await expect(sidebar).toHaveClass(/w-60/);

    // Collapse
    await sidebar.evaluate((el) => {
      const btn = el.querySelector('button');
      if (btn instanceof HTMLElement) btn.click();
    });
    await page.waitForTimeout(500);
    await expect(sidebar).toHaveClass(/w-12/);

    // Click icon-only link
    const link = sidebar.locator('a[href="/github"]');
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/github/);
    await expect(page.locator('h1:has-text("GitHub Issues")')).toBeVisible({ timeout: 10_000 });
  });

  test('page loads and shows GitHub Issues heading', async ({ page }) => {

    await page.goto('/github');

    await expect(page.locator('h1:has-text("GitHub Issues")')).toBeVisible({ timeout: 10_000 });
  });

  test('shows MCP configuration description', async ({ page }) => {

    await page.goto('/github');

    await expect(page.locator('text=Import open GitHub issues')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=GitHub MCP server')).toBeVisible({ timeout: 5_000 });
  });

  test('shows List Open Issues button', async ({ page }) => {

    await page.goto('/github');

    const listBtn = page.locator('button:has-text("List Open Issues")');
    await expect(listBtn).toBeVisible({ timeout: 10_000 });
    await expect(listBtn).toBeEnabled();
  });

  test('shows empty state prompt', async ({ page }) => {

    await page.goto('/github');

    await expect(page.locator('text=Click "List Open Issues" to fetch GitHub issues')).toBeVisible({ timeout: 10_000 });
  });

  test('page survives refresh', async ({ page }) => {

    await page.goto('/github');
    await expect(page.locator('h1:has-text("GitHub Issues")')).toBeVisible({ timeout: 10_000 });

    await page.reload();

    await expect(page.locator('h1:has-text("GitHub Issues")')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('button:has-text("List Open Issues")')).toBeVisible({ timeout: 5_000 });
  });
});


