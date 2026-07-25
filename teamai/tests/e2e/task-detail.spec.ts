import { test, expect } from '@playwright/test';
import { ensureProjectSelected, requireSeedTaskId } from './helpers';

const DARK_MODE_SLUG = 'implement-dark-mode-toggle';
const SEARCH_CRASH_SLUG = 'fix-search-bar-crashes-on-empty-input';

test.describe('Task Detail Page (/task/:id)', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);
  });

  test('renders task title, phase badge, and all tabs', async ({ page }) => {
    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    const phaseBadge = page.locator('text=backlog').first();
    await expect(phaseBadge).toBeVisible({ timeout: 5_000 });

    for (const tab of ['Overview', 'Terminal', 'Spec', 'Plan', 'QA']) {
      await expect(page.locator(`button:has-text("${tab}")`).first()).toBeVisible({ timeout: 5_000 });
    }
  });

  test('shows task ID in monospace', async ({ page }) => {
    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    const fullPageTaskId = page.locator('[data-testid="task-id"]').first();
    await expect(fullPageTaskId).toBeVisible({ timeout: 15_000 });
    await expect(fullPageTaskId).toContainText(taskId);
  });

  test('can switch between tabs', async ({ page }) => {
    const taskId = requireSeedTaskId(DARK_MODE_SLUG);

    // Navigate directly to each tab via URL hash — avoids click unreliability
    await page.goto(`/task/${taskId}#spec`);
    await page.waitForTimeout(500);
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('text=No spec generated').first()).toBeVisible({ timeout: 10_000 });

    await page.goto(`/task/${taskId}#plan`);
    await page.waitForTimeout(500);
    await expect(page.locator('text=No plan generated yet').first()).toBeVisible({ timeout: 10_000 });

    await page.goto(`/task/${taskId}#qa`);
    await page.waitForTimeout(500);
    await expect(page.locator('text=No QA report generated').first()).toBeVisible({ timeout: 10_000 });

    await page.goto(`/task/${taskId}#overview`);
    await page.waitForTimeout(500);
    await expect(page.locator('text=No dependencies set').first()).toBeVisible({ timeout: 10_000 });
  });

  test('has breadcrumb link back to board', async ({ page }) => {
    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    const breadcrumb = page.locator('a:has-text("← Board")');
    await expect(breadcrumb).toBeVisible({ timeout: 5_000 });
    await expect(breadcrumb).toHaveAttribute('href', '/');
  });

  test('shows delete button', async ({ page }) => {
    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    await expect(page.locator('button[title="Delete task"]')).toBeVisible({ timeout: 5_000 });
  });

  test('terminal tab renders agent panel', async ({ page }) => {
    const taskId = requireSeedTaskId(DARK_MODE_SLUG);

    // Use hash-based navigation to go directly to the Terminal tab — avoids
    // click unreliability when the page hasn't fully hydrated.
    await page.goto(`/task/${taskId}#terminal`);
    await expect(page.locator('body')).toBeVisible();

    // Wait for React hydration (h1 visible), then verify the terminal
    // container is mounted. Generous timeouts account for cumulative
    // resource pressure when many tests run in the full suite.
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="terminal-container"]')).toBeVisible({ timeout: 20_000 });

    await expect(page.locator('[data-testid="scroll-to-bottom"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scroll-to-top"]')).toHaveCount(0);
  });

  test('failed task shows completion summary banner on Overview tab', async ({ page }) => {
    const taskId = requireSeedTaskId(SEARCH_CRASH_SLUG);
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    await expect(page.locator('h3:has-text("Task Failed")')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Max QA attempts reached')).toBeVisible({ timeout: 5_000 });
  });
});
