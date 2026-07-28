/**
 * E2E tests for the Ideation page (/ideation).
 *
 * Covers: page load, heading, Run Scan button, empty state message,
 * sidebar navigation, page refresh survival.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

test.describe('Ideation Page', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  test('sidebar navigation: clicking Ideation link navigates to /ideation and shows heading', async ({ page }) => {
    await page.goto('/');

    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    const link = sidebar.locator('a[href="/ideation"]');
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/ideation/);
    await expect(page.locator('h1:has-text("Ideation")')).toBeVisible({ timeout: 10_000 });
  });

  test('collapsed sidebar: clicking Ideation icon navigates to /ideation and shows heading', async ({ page }) => {
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
    const link = sidebar.locator('a[href="/ideation"]');
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/ideation/);
    await expect(page.locator('h1:has-text("Ideation")')).toBeVisible({ timeout: 10_000 });
  });

  test('page loads and shows Ideation heading', async ({ page }) => {

    await page.goto('/ideation');

    await expect(page.locator('h1:has-text("Ideation")')).toBeVisible({ timeout: 10_000 });
  });

  test('shows description subtext', async ({ page }) => {

    await page.goto('/ideation');

    await expect(page.locator('text=Scan the codebase')).toBeVisible({ timeout: 5_000 });
  });

  test('shows Run Scan button', async ({ page }) => {

    await page.goto('/ideation');

    const scanBtn = page.locator('button:has-text("Run Scan")');
    await expect(scanBtn).toBeVisible({ timeout: 10_000 });
    await expect(scanBtn).toBeEnabled();
  });

  test('shows empty state prompt before scan', async ({ page }) => {

    await page.goto('/ideation');

    await expect(page.locator('text=Click "Run Scan" to analyse the codebase')).toBeVisible({ timeout: 10_000 });
  });

  test('page survives refresh', async ({ page }) => {

    await page.goto('/ideation');
    await expect(page.locator('h1:has-text("Ideation")')).toBeVisible({ timeout: 10_000 });

    await page.reload();

    await expect(page.locator('h1:has-text("Ideation")')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('button:has-text("Run Scan")')).toBeVisible({ timeout: 5_000 });
  });
});


