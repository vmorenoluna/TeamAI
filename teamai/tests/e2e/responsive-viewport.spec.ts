/**
 * E2E tests for responsive layout at different viewport sizes.
 *
 * Covers: sidebar collapse at tablet/mobile, kanban board at small widths,
 * task detail layout at narrow viewports, settings sections at tablet size.
 *
 * The app uses Tailwind responsive prefixes (lg:, md:):
 *   - Sidebar: w-48 lg:w-60 (expanded), w-12 (collapsed)
 *   - Analytics: grid-cols-1 lg:grid-cols-2, grid-cols-2 lg:grid-cols-4
 *   - Dep picker: sm:w-72
 */
import { test, expect, type Page } from '@playwright/test';
import { ensureProjectSelected, requireSeedTaskId } from './helpers';

const DARK_MODE_SLUG = 'implement-dark-mode-toggle';
const SEARCH_CRASH_SLUG = 'fix-search-bar-crashes-on-empty-input';

// ── Viewport presets ────────────────────────────────────────────────────

const MOBILE = { width: 375, height: 812 };   // iPhone X
const TABLET = { width: 768, height: 1024 };   // iPad
const DESKTOP = { width: 1440, height: 900 };  // Standard desktop

// ── Helpers ─────────────────────────────────────────────────────────────

async function setupSeeded(page: Page) {
  await ensureProjectSelected(page);

}

// ── Tests ──────────────────────────────────────────────────────────────

test.describe('Responsive — Sidebar', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await setupSeeded(page);
  });

  test('sidebar is visible at desktop width', async ({ page }) => {
    await page.setViewportSize(DESKTOP);
    await page.goto('/');

    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    // At desktop width (~1440px > 1024px lg breakpoint), the lg:w-60 class applies
    const classes = await sidebar.getAttribute('class');
    expect(classes).toMatch(/lg:w-60/);
  });

  test('sidebar is still visible at tablet width', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await page.goto('/');

    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });
  });

  test('kanban board renders at mobile width', async ({ page }) => {

    await page.setViewportSize(MOBILE);
    await page.goto('/');

    // At mobile width, the board should still render task cards
    await expect(page.locator('[data-component="task-card"]').first()).toBeVisible({ timeout: 10_000 });

    // The kanban should be scrollable horizontally at narrow widths
    await expect(page.locator('.overflow-x-auto').first()).toBeAttached({ timeout: 5_000 });
  });

  test('collapsing sidebar works at tablet width', async ({ page }) => {
    await page.setViewportSize(TABLET);
    await page.goto('/');

    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    // Click the collapse toggle button (first button inside the aside)
    const collapseBtn = sidebar.locator('button').first();
    await expect(collapseBtn).toBeVisible({ timeout: 5_000 });
    await collapseBtn.click();
    await page.waitForTimeout(500);
    // Click again in case the first click didn't register (hydration timing)
    await collapseBtn.click();
    await page.waitForTimeout(1000);

    // After collapse, sidebar should have w-12 class
    await expect(sidebar).toHaveClass(/w-12/);
  });
});

test.describe('Responsive — Task Detail', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await setupSeeded(page);
  });

  test('task detail tabs are visible at tablet width', async ({ page }) => {

    await page.setViewportSize(TABLET);
    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);

    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    // All 5 tabs should be visible
    for (const tab of ['Overview', 'Terminal', 'Spec', 'Plan', 'QA']) {
      await expect(page.locator(`button:has-text("${tab}")`).first()).toBeVisible({ timeout: 5_000 });
    }
  });

  test('task detail is readable at mobile width', async ({ page }) => {

    await page.setViewportSize(MOBILE);
    const taskId = requireSeedTaskId(SEARCH_CRASH_SLUG);
    await page.goto(`/task/${taskId}`);

    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    // The completion summary should still render at narrow width
    await expect(page.locator('h3:has-text("Task Failed")')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Responsive — Settings', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await setupSeeded(page);
  });

  test('settings sections render at tablet width', async ({ page }) => {

    await page.setViewportSize(TABLET);
    await page.goto('/settings');

    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    // All major sections should still be present
    for (const section of ['Container Isolation', 'Pipeline Configuration', 'Agent Roles']) {
      await expect(page.locator(`text=${section}`)).toBeVisible({ timeout: 5_000 });
    }
  });

  test('provider config select dropdowns work at mobile width', async ({ page }) => {

    await page.setViewportSize(MOBILE);
    await page.goto('/settings');

    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    // Model selects should be present even at narrow widths
    const selects = page.locator('select');
    await expect(selects.first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Responsive — Page Refresh Survivability', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await setupSeeded(page);
  });

  test('kanban survives refresh at mobile width', async ({ page }) => {

    await page.setViewportSize(MOBILE);
    await page.goto('/');
    await expect(page.locator('[data-component="task-card"]').first()).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.locator('[data-component="task-card"]').first()).toBeVisible({ timeout: 10_000 });
  });

  test('kanban survives refresh at tablet width', async ({ page }) => {

    await page.setViewportSize(TABLET);
    await page.goto('/');
    await expect(page.locator('[data-component="task-card"]').first()).toBeVisible({ timeout: 10_000 });

    await page.reload();
    await expect(page.locator('[data-component="task-card"]').first()).toBeVisible({ timeout: 10_000 });
  });
});
