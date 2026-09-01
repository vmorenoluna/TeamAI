/**
 * E2E tests for the Ideation page (/ideation).
 *
 * Covers: page load, heading, Run Scan button, empty state message, page
 * refresh survival. The sidebar link to this page is currently hidden
 * (f1073700) — reachable only via direct URL.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

test.describe('Ideation Page', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  // Sidebar-navigation tests for /ideation were removed: the sidebar link was
  // deliberately hidden in f1073700 ("hide untested sections") — Ideation is
  // still a live route (tested via direct page.goto below), just not reachable
  // through the sidebar UI right now. Clicking a nonexistent `aside a[href="/ideation"]`
  // was leaving these tests hanging.

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


