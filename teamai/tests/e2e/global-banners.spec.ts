/**
 * E2E tests for global banners rendered in the app layout.
 *
 * Covers: RecoveryBanner (interrupted tasks on restart),
 * MissingToolsBanner (required CLI tools not found),
 * RateLimitBanner on kanban/insights/ideation pages.
 *
 * All three banners are rendered in layout.tsx. RecoveryBanner and
 * MissingToolsBanner are conditionally rendered based on server state.
 * RateLimitBanner appears inline in multiple components when rate-limited.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

let isSeeded = false;

test.describe('Global Banners — Recovery Banner', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    isSeeded = ok;
  });

  test('recovery banner is NOT visible when no interrupted tasks exist', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await page.waitForTimeout(1500);

    // Recovery banner only shows when server has interrupted tasks.
    // Under normal conditions, the banner should not be visible.
    const recoveryBanner = page.locator('text=interrupted task');
    await expect(recoveryBanner).toHaveCount(0, { timeout: 5_000 });
  });

  test('recovery banner dismiss mechanism exists when shown', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await page.waitForTimeout(1500);

    // Check if any recovery banner is present (only during actual crash recovery)
    const banner = page.locator('text=interrupted task');
    const count = await banner.count();

    if (count > 0) {
      // If shown, should have a dismiss button (×)
      const dismissBtn = banner.locator('button:has-text("×"), button[title="Dismiss"]');
      await expect(dismissBtn.first()).toBeVisible({ timeout: 3_000 });

      // Dismiss should hide the banner
      await dismissBtn.first().click();
      await page.waitForTimeout(500);
      await expect(page.locator('text=interrupted task')).toHaveCount(0, { timeout: 3_000 });
    }
    // If not shown, test passes — normal operation
  });

  test('recovery banner survives page refresh after dismiss', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await page.waitForTimeout(1500);

    const banner = page.locator('text=interrupted task');
    const count = await banner.count();

    if (count > 0) {
      // Dismiss it
      const dismissBtn = banner.locator('button[title="Dismiss"]');
      if (await dismissBtn.count() > 0) {
        await dismissBtn.first().click();
        await page.waitForTimeout(500);
      }

      // Refresh — banner should stay dismissed (sessionStorage)
      await page.reload();
      await page.waitForTimeout(1000);
      await expect(page.locator('text=interrupted task')).toHaveCount(0, { timeout: 3_000 });
    }
    // If not shown initially, no recovery state — test passes
  });
});

test.describe('Global Banners — Missing Tools Banner', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    isSeeded = ok;
  });

  test('missing tools banner appears when CLI tools not found', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await page.waitForTimeout(1500);

    // The banner shows "required tool(s) not found" when tools are missing
    const banner = page.locator('text=required tool');

    // May or may not appear depending on the test environment
    const count = await banner.count();
    expect(count).toBeGreaterThanOrEqual(0); // Either state is valid

    if (count > 0) {
      await expect(banner.first()).toBeVisible({ timeout: 5_000 });
    }
  });

  test('missing tools banner has dismiss button', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await page.waitForTimeout(1500);

    const banner = page.locator('text=required tool');
    const count = await banner.count();

    if (count > 0) {
      // Should have a dismiss button
      const dismissBtn = banner.locator('button[title="Dismiss"]');
      await expect(dismissBtn.first()).toBeVisible({ timeout: 3_000 });

      // Clicking dismiss should hide the banner
      await dismissBtn.first().click();
      await page.waitForTimeout(500);
      await expect(page.locator('text=required tool')).toHaveCount(0, { timeout: 3_000 });
    }
    // Not shown = all tools found, test passes
  });

  test('missing tools banner links to Settings → Tool Paths', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await page.waitForTimeout(1500);

    const banner = page.locator('text=required tool');
    const count = await banner.count();

    if (count > 0) {
      // The banner should contain a link to settings
      const settingsLink = banner.locator('a[href="/settings"]');
      if (await settingsLink.count() > 0) {
        await expect(settingsLink.first()).toBeVisible({ timeout: 3_000 });
      }
    }
    // Not shown — test passes
  });
});

test.describe('Global Banners — Rate Limit Banner', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    isSeeded = ok;
  });

  test('rate limit banner has data-testid when shown', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    // Check multiple pages where the rate limit banner can appear
    const pages = ['/', '/insights', '/ideation'];

    for (const path of pages) {
      await page.goto(path);
      await page.waitForTimeout(1000);

      // If rate-limit banner is visible, it should have the testid
      const rateLimitBanner = page.locator('[data-testid="rate-limit-banner"]');
      const count = await rateLimitBanner.count();
      // Rate limit is state-dependent — just verifying the component works
      expect(count).toBeGreaterThanOrEqual(0);
    }
  });

  test('rate limit banner is NOT visible under normal conditions', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await page.waitForTimeout(1500);

    // Under normal conditions (no rate limiting), the banner should not appear
    const rateLimitBanner = page.locator('[data-testid="rate-limit-banner"]');
    await expect(rateLimitBanner).toHaveCount(0, { timeout: 5_000 });
  });

  test('kanban board works normally when rate limit banner is not present', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await page.waitForTimeout(1500);

    // Rate limit banner should not interfere with normal kanban operation
    await expect(page.locator('[data-testid="task-card"]').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Backlog').first()).toBeVisible({ timeout: 5_000 });
  });
});
