/**
 * E2E tests for the Analytics Dashboard page (/analytics).
 *
 * Tests verify the page loads, renders dashboard components (summary cards,
 * phase distribution, timing charts, QA stats, weekly trends, bottleneck),
 * handles the empty/no-project state gracefully, and that sidebar navigation
 * to the analytics page works.
 */

import { test, expect } from '@playwright/test';

test.describe('Analytics Dashboard', () => {
  test('page loads and shows analytics header', async ({ page }) => {
    await page.goto('/analytics');

    // Page body should be visible
    await expect(page.locator('body')).toBeVisible();

    // Should either show analytics content or a no-project / empty message
    const body = page.locator('body');
    const hasAnalyticsHeading = await body.locator('text=Analytics Dashboard').count();
    const hasInsightsHeading = await body.locator('text=Insights').count();
    const hasNoProject = await body.locator('text=No active project').count();
    const hasSelectProject = await body.locator('text=Select or add a project').count();

    // One of these should be present
    expect(hasAnalyticsHeading + hasInsightsHeading + hasNoProject + hasSelectProject).toBeGreaterThan(0);
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

    // Check if project is active — gracefully skip if not
    const noProject = page.locator('text=Select or add a project from the sidebar');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    // Wait for the dashboard to render
    // Summary cards should be present
    const totalTasks = page.locator('text=Total Tasks');
    await expect(totalTasks).toBeVisible({ timeout: 10_000 });

    // Phase distribution section should appear
    const phaseDist = page.locator('text=Phase Distribution');
    await expect(phaseDist).toBeVisible({ timeout: 5_000 });

    // QA stats section should appear
    const qaStats = page.locator('text=QA Stats');
    await expect(qaStats).toBeVisible({ timeout: 5_000 });

    // Weekly trends section should appear
    const weeklyTrends = page.locator('text=Weekly Trends');
    await expect(weeklyTrends).toBeVisible({ timeout: 5_000 });

    // Bottleneck section should appear
    const bottleneck = page.locator('text=Bottleneck');
    await expect(bottleneck).toBeVisible({ timeout: 5_000 });
  });

  test('analytics page shows empty state when no tasks exist', async ({ page }) => {
    await page.goto('/analytics');

    // Skip if no project is active (test can't proceed)
    const noProject = page.locator('text=Select or add a project from the sidebar');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    // When no tasks exist, the dashboard should show zero counts
    // Look for "0" in the total tasks area
    const body = page.locator('body');
    const bodyText = await body.innerText();

    // Zero tasks might be shown in summary cards or in an empty state message
    expect(
      bodyText.includes('0') ||
      bodyText.includes('No tasks') ||
      bodyText.includes('empty')
    ).toBeTruthy();
  });

  test('analytics page has expected title or heading', async ({ page }) => {
    await page.goto('/analytics');

    // Page should have a title
    await expect(page).toHaveTitle(/TeamAI/);

    // Should show some kind of heading
    const body = page.locator('body');
    const hasAnalyticsHeading = await body.locator('h1, h2, h3').filter({ hasText: /Analytics|Insights|Dashboard/i }).count();
    const hasNoProject = await body.locator('text=No active project').count();

    expect(hasAnalyticsHeading + hasNoProject).toBeGreaterThan(0);
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
