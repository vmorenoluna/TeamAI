/**
 * E2E tests for the GitHub Issues page (/github).
 *
 * Covers: page load, heading, description text, List Open Issues button,
 * empty state prompt, page refresh survival. The sidebar link to this page
 * is currently hidden (f1073700) — reachable only via direct URL.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

test.describe('GitHub Issues Page', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  // Sidebar-navigation tests for /github were removed: the sidebar link was
  // deliberately hidden in f1073700 ("hide untested sections") — GitHub Issues
  // is still a live route (tested via direct page.goto below), just not
  // reachable through the sidebar UI right now. Clicking a nonexistent
  // `aside a[href="/github"]` was leaving these tests hanging.

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


