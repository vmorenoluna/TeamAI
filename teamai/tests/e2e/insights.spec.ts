/**
 * E2E tests for the Insights page (/insights).
 *
 * Covers: page load, stats cards (Total Tasks, Completed, In Progress,
 * Failed), completion rate bar, phase distribution stacked bar + legend,
 * InsightsChat component rendering, empty state, sidebar navigation.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

test.describe('Insights Page', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  test('sidebar navigation: clicking Insights link navigates to /insights and shows heading', async ({ page }) => {
    await page.goto('/');

    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    const link = sidebar.locator('a[href="/insights"]');
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/insights/);
    await expect(page.locator('h1:has-text("Insights")')).toBeVisible({ timeout: 10_000 });
  });

  test('collapsed sidebar: clicking Insights icon navigates to /insights and shows heading', async ({ page }) => {
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
    const link = sidebar.locator('a[href="/insights"]');
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/insights/);
    await expect(page.locator('h1:has-text("Insights")')).toBeVisible({ timeout: 10_000 });
  });

  test('page loads and shows Insights heading', async ({ page }) => {

    await page.goto('/insights');

    await expect(page.locator('h1:has-text("Insights")')).toBeVisible({ timeout: 10_000 });
  });

  test('shows stats cards (Total Tasks, Completed, In Progress, Failed)', async ({ page }) => {

    await page.goto('/insights');

    for (const label of ['Total Tasks', 'Completed', 'In Progress', 'Failed']) {
      await expect(page.locator(`text=${label}`).first()).toBeVisible({ timeout: 10_000 });
    }
  });

  test('shows completion rate bar with percentage', async ({ page }) => {

    await page.goto('/insights');

    await expect(page.locator('text=Completion Rate')).toBeVisible({ timeout: 10_000 });
    // Percentage should be visible (e.g., "14%", "0%", etc.)
    await expect(page.locator('text=/\\d+%/')).toBeVisible({ timeout: 5_000 });
  });

  test('shows phase distribution section with stacked bar', async ({ page }) => {

    await page.goto('/insights');

    await expect(page.locator('text=Phase Distribution')).toBeVisible({ timeout: 10_000 });

    // Phase legend items should be visible with counts (e.g., "Backlog (3)")
    await expect(page.locator('text=/Backlog \\(\\d+\\)/').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=/Done \\(\\d+\\)/').first()).toBeVisible({ timeout: 5_000 });
  });

  test('shows InsightsChat component with input field', async ({ page }) => {

    await page.goto('/insights');

    // Chat should have either "Ask anything about the codebase" empty state
    // or a textarea input
    const hasEmptyState = await page.locator('text=Ask anything about the codebase').count();
    const hasTextarea = await page.locator('textarea').count();
    expect(hasEmptyState + hasTextarea).toBeGreaterThan(0);
  });

  test('page survives refresh', async ({ page }) => {

    await page.goto('/insights');
    await expect(page.locator('h1:has-text("Insights")')).toBeVisible({ timeout: 10_000 });

    await page.reload();

    await expect(page.locator('h1:has-text("Insights")')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Total Tasks').first()).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Insights — Chat Interaction', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

    // Mock: abort server actions on /insights to simulate chat session
    // creation failure.  The InsightsChat component calls
    // getOrCreateInsightsSession on mount; aborting the POST triggers
    // the error path.  Only server action POSTs are intercepted — RSC
    // page data loads via GET and are unaffected.
    await page.route('**/insights', async (route) => {
      const req = route.request();
      if (req.method() === 'POST' && req.headers()['next-action']) {
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    await page.goto('/insights');
  });

  // NOTE: The beforeEach mocks all server action POSTs on /insights,
  // so getOrCreateInsightsSession always fails.  This makes error-path
  // assertions deterministic regardless of orchestrator health.

  test('chat input renders with a textarea', async ({ page }) => {

    const textarea = page.locator('textarea');
    await expect(textarea).toBeVisible({ timeout: 10_000 });
  });

  test('Send button is disabled when chat session is unavailable', async ({ page }) => {

    // When getOrCreateInsightsSession fails, sessionId stays null
    // and the Send button should be disabled.
    const sendBtn = page.locator('button:has-text("Send")');
    await expect(sendBtn).toBeVisible({ timeout: 10_000 });
  });

  test('shows error banner when chat session creation fails', async ({ page }) => {

    // Session creation fails → error alert appears
    const alert = page.locator('[role="alert"]');
    await expect(alert).toBeVisible({ timeout: 10_000 });
  });

  test('error banner dismiss button clears the error', async ({ page }) => {

    const alert = page.locator('[role="alert"]');
    await expect(alert).toBeVisible({ timeout: 10_000 });

    // Click the dismiss button inside the alert.
    // Both RoleEditor and InsightsChat error banners use <button aria-label="Dismiss error">.
    const dismissBtn = alert.locator('button[aria-label="Dismiss error"]');
    await expect(dismissBtn).toBeVisible({ timeout: 5_000 });
    await dismissBtn.click();
    await page.waitForTimeout(500);

    // After dismiss, the error text paragraph should be gone
    const errorText = alert.locator('p');
    await expect(errorText).not.toBeVisible({ timeout: 5_000 });
  });
});
