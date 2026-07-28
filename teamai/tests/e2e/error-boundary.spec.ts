/**
 * E2E tests for the ErrorBoundary component.
 *
 * ErrorBoundary wraps sections of the app and renders a fallback UI when
 * a child component throws. Testing this in E2E requires triggering a
 * render error, which is not easily done from the browser.
 *
 * These tests verify the ErrorBoundary does NOT interfere with normal
 * rendering (no false-positive crash pages) and that the app survives
 * extreme input scenarios gracefully.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

test.describe('Error Boundary — Normal Operation', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  test('kanban board renders without error boundary fallback', async ({ page }) => {

    await page.goto('/');
    await page.waitForTimeout(1500);

    // The error boundary fallback shows "Render Error" or "Something went wrong"
    // It should NOT be visible under normal operation
    const errorFallback = page.locator('text=Render Error');
    await expect(errorFallback).toHaveCount(0, { timeout: 5_000 });

    const prodFallback = page.locator('text=Something went wrong');
    await expect(prodFallback).toHaveCount(0, { timeout: 5_000 });

    // Kanban should be working
    await expect(page.locator('[data-testid="task-card"]').first()).toBeVisible({ timeout: 10_000 });
  });

  test('task detail page renders without error boundary fallback', async ({ page }) => {

    // Navigate to a known task
    await page.goto('/');
    await page.waitForTimeout(1500);

    const firstCard = page.locator('[data-testid="task-card"]').first();
    await firstCard.click();
    await page.waitForTimeout(1500);

    // Error boundary fallback should not be visible
    const errorFallback = page.locator('text=Render Error');
    await expect(errorFallback).toHaveCount(0, { timeout: 5_000 });

    // Task detail should have loaded content
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });
  });

  test('settings page renders without error boundary fallback', async ({ page }) => {

    await page.goto('/settings');
    await page.waitForTimeout(1500);

    const errorFallback = page.locator('text=Render Error');
    await expect(errorFallback).toHaveCount(0, { timeout: 5_000 });

    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });
  });

  test('navigating between pages rapidly does not trigger error boundary', async ({ page }) => {

    const pages = ['/', '/settings', '/workflow', '/insights', '/'];

    for (const path of pages) {
      await page.goto(path);
      await page.waitForTimeout(500);

      // Check no error boundary
      const errorFallback = page.locator('text=Render Error');
      await expect(errorFallback).toHaveCount(0, { timeout: 3_000 });
    }
  });

  test('page survives refresh without error boundary fallback', async ({ page }) => {

    // Refresh multiple pages
    await page.goto('/');
    await page.waitForTimeout(1000);
    await page.reload();
    await page.waitForTimeout(1000);

    const errorFallback = page.locator('text=Render Error');
    await expect(errorFallback).toHaveCount(0, { timeout: 5_000 });

    await expect(page.locator('[data-testid="task-card"]').first()).toBeVisible({ timeout: 10_000 });
  });
});
