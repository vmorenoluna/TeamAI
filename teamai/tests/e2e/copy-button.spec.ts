/**
 * E2E tests for the CopyButton component used across task detail pages.
 *
 * Covers: copy button renders, click toggles to "✓ Copied" state,
 * copy button on spec tab, copy button on completion summary.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected, requireSeedTaskId } from './helpers';

const LOGIN_BUTTON_SLUG = 'fix-login-button-not-visible-on-mobile';
const SEARCH_CRASH_SLUG = 'fix-search-bar-crashes-on-empty-input';

test.describe('Copy Button — Spec Tab', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    // Grant clipboard permissions — required for navigator.clipboard.writeText()
    // to succeed in headless Chromium.
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await ensureProjectSelected(page);

  });

  test('copy button is visible on spec tab for tasks with specs', async ({ page }) => {

    const taskId = requireSeedTaskId(LOGIN_BUTTON_SLUG);
    await page.goto(`/task/${taskId}#spec`);

    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    // The CopyButton shows "📋 Copy" by default
    const copyBtn = page.locator('button', { hasText: '📋 Copy' });
    await expect(copyBtn.first()).toBeVisible({ timeout: 10_000 });
  });

  test('clicking copy button on spec tab toggles to Copied state', async ({ page }) => {

    const taskId = requireSeedTaskId(LOGIN_BUTTON_SLUG);
    await page.goto(`/task/${taskId}#spec`);

    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    // Click the Copy button
    const copyBtn = page.locator('button', { hasText: '📋 Copy' }).first();
    await copyBtn.click();

    // Should toggle to "✓ Copied"
    await expect(page.locator('button', { hasText: '✓ Copied' }).first()).toBeVisible({ timeout: 5_000 });
  });

  test('copy button reverts to Copy after 2 seconds', async ({ page }) => {

    const taskId = requireSeedTaskId(LOGIN_BUTTON_SLUG);
    await page.goto(`/task/${taskId}#spec`);

    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    // Click copy
    const copyBtn = page.locator('button', { hasText: '📋 Copy' }).first();
    await copyBtn.click();

    // Verify "✓ Copied" appears
    await expect(page.locator('button', { hasText: '✓ Copied' }).first()).toBeVisible({ timeout: 5_000 });

    // Poll for the "📋 Copy" text to reappear (2000ms timeout in CopyButton component).
    // Use a generous timeout to avoid flakiness on slow CI.
    await expect(page.locator('button', { hasText: '📋 Copy' }).first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Copy Button — Completion Summary', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await ensureProjectSelected(page);

  });

  test('copy button visible on failed task completion summary', async ({ page }) => {

    const taskId = requireSeedTaskId(SEARCH_CRASH_SLUG);
    await page.goto(`/task/${taskId}`);

    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    // The completion summary section should have a CopyButton
    const copyBtn = page.locator('button', { hasText: '📋 Copy' });
    await expect(copyBtn.first()).toBeVisible({ timeout: 10_000 });
  });

  test('clicking copy on completion summary toggles to Copied', async ({ page }) => {

    const taskId = requireSeedTaskId(SEARCH_CRASH_SLUG);
    await page.goto(`/task/${taskId}`);

    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    // Wait for React hydration to complete — the Overview tab renders
    // server-side, so the CopyButton HTML is in the initial SSR payload
    // but onClick handlers aren't attached until React hydrates.
    // The task-detail useEffect sets data-hydrated="true" on the root
    // element as a signal that event handlers are attached.
    await page.waitForSelector('[data-hydrated="true"]', { timeout: 10_000 });

    // Click the Copy button on the completion summary (Overview tab)
    const copyBtn = page.locator('button', { hasText: /Copy/ }).first();
    await copyBtn.click();

    // Should toggle to "✓ Copied"
    await expect(page.locator('button', { hasText: /Copied/ }).first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Copy Button — Plan Tab', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await ensureProjectSelected(page);

  });

  test('copy button visible on plan subtasks for tasks with plans', async ({ page }) => {

    const taskId = requireSeedTaskId(LOGIN_BUTTON_SLUG);
    await page.goto(`/task/${taskId}#plan`);

    await expect(page.locator('[data-testid="plan-subtask"]').first()).toBeVisible({ timeout: 15_000 });

    // The PlanSubtasks component renders a CopyButton for the plan text
    const copyBtn = page.locator('button', { hasText: '📋 Copy' }).first();
    await expect(copyBtn).toBeVisible({ timeout: 10_000 });
  });

  test('clicking copy on plan subtasks toggles to Copied', async ({ page }) => {

    const taskId = requireSeedTaskId(LOGIN_BUTTON_SLUG);
    await page.goto(`/task/${taskId}#plan`);

    await expect(page.locator('[data-testid="plan-subtask"]').first()).toBeVisible({ timeout: 15_000 });

    const copyBtn = page.locator('button', { hasText: '📋 Copy' }).first();
    await copyBtn.click();

    await expect(page.locator('button', { hasText: '✓ Copied' }).first()).toBeVisible({ timeout: 5_000 });
  });
});
