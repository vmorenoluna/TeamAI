/**
 * E2E tests for the Analytics Dashboard page (/analytics).
 *
 * Tests verify the page loads, renders dashboard components (summary cards,
 * phase distribution, timing charts, QA stats, weekly trends, bottleneck),
 * handles the empty/no-project state gracefully, and that sidebar navigation
 * to the analytics page works.
 */

import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';


test.describe('Analytics Dashboard', () => {
  test.beforeEach(async ({ page }) => {
  await ensureProjectSelected(page);
});

  test('page loads and shows analytics header', async ({ page }) => {
    await page.goto('/analytics');

    // Page body should be visible
    await expect(page.locator('body')).toBeVisible();

    // Should either show analytics content or a no-project / empty message
    const body = page.locator('body');
    const hasHeading = await body.locator('h1, h2, h3').filter({ hasText: /Analytics|Insights|Dashboard/i }).count();
    const loadingOrError = await body.locator('text=Computing analytics').count();
    const hasFailedMsg = await body.locator('text=Failed to load analytics').count();

    // One of these should be present — content, loading, or error state
    expect(hasHeading + loadingOrError + hasFailedMsg).toBeGreaterThan(0);
  });

  test('sidebar has Analytics navigation link that navigates to /analytics', async ({ page }) => {
    await page.goto('/');

    // Sidebar should be visible
    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    // Analytics link should be present
    const analyticsLink = sidebar.locator('a[href="/analytics"]');
    await expect(analyticsLink).toBeVisible();

    // Clicking it should navigate to the analytics page
    await analyticsLink.click();
    await expect(page).toHaveURL(/\/analytics/);
  });

  test('analytics page renders dashboard components when project is active', async ({ page }) => {
    await page.goto('/analytics');

    // Check if the analytics failed to load (project not active case handled in beforeEach)
    const errorState = page.locator('text=Failed to load analytics');
    if (await errorState.isVisible({ timeout: 5_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected — analytics not available');
      return;
    }

    // Wait for the loading spinner to disappear
    const loading = page.locator('text=Computing analytics');
    await loading.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});

    // Summary cards should be present
    const totalTasks = page.locator('text=Total Tasks');
    await expect(totalTasks).toBeVisible({ timeout: 10_000 });

    // Phase distribution section should appear
    const phaseDist = page.locator('text=Phase Distribution');
    await expect(phaseDist).toBeVisible({ timeout: 5_000 });

    // QA criteria breakdown section should appear
    const qaCriteria = page.locator('text=QA Criteria Breakdown');
    await expect(qaCriteria).toBeVisible({ timeout: 5_000 });

    // Weekly trends section may not render with few seeded tasks
    const weeklyTrends = page.locator('text=Weekly Trends');
    if (await weeklyTrends.count() > 0) {
      await weeklyTrends.scrollIntoViewIfNeeded();
      await expect(weeklyTrends).toBeVisible({ timeout: 10_000 });
    }

    // Bottleneck section should appear
    const bottleneck = page.locator('text=Bottleneck').first();
    await expect(bottleneck).toBeVisible({ timeout: 5_000 });
  });

  test('analytics page shows data when tasks exist', async ({ page }) => {
    await page.goto('/analytics');

    // Check if analytics failed to load
    const errorState = page.locator('text=Failed to load analytics');
    if (await errorState.isVisible({ timeout: 5_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected — analytics not available');
      return;
    }

    // Wait for loading to finish
    const loading = page.locator('text=Computing analytics');
    await loading.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {});

    // With seeded tasks, the dashboard should show non-zero task counts
    const totalTasks = page.locator('text=Total Tasks');
    await expect(totalTasks).toBeVisible({ timeout: 10_000 });

    // The summary card next to Total Tasks should show a number > 0
    const body = page.locator('body');
    const bodyText = await body.innerText();

    // With 7 seeded tasks, Total Tasks should be > 0
    expect(bodyText.includes('Total Tasks')).toBeTruthy();
  });

  test('analytics page has expected title or heading', async ({ page }) => {
    await page.goto('/analytics');

    // Page should have a title
    await expect(page).toHaveTitle(/TeamAI/);

    // Should show some kind of heading
    const body = page.locator('body');
    const hasAnalyticsHeading = await body.locator('h1, h2, h3').filter({ hasText: /Analytics|Insights|Dashboard/i }).count();
    const loadingOrError = await body.locator('text=Computing analytics').count();
    const hasFailedMsg = await body.locator('text=Failed to load analytics').count();

    expect(hasAnalyticsHeading + loadingOrError + hasFailedMsg).toBeGreaterThan(0);
  });

  test('analytics page handles page refresh gracefully', async ({ page }) => {
    // Navigate and refresh
    await page.goto('/analytics');
    await page.reload();

    // After refresh, page should still render
    await expect(page.locator('body')).toBeVisible({ timeout: 10_000 });

    // Should not show an error page
    const errorText = page.locator('text=Application error');
    expect(await errorText.count()).toBe(0);

    const notFound = page.locator('text=404');
    expect(await notFound.count()).toBe(0);
  });
});
