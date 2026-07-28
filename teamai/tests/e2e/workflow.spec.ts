/**
 * E2E tests for the Workflow page (/workflow).
 *
 * Covers: page load, heading, legend items (bounce, request changes,
 * spec revision, failure), pipeline phase nodes, SVG diagram rendering,
 * empty state when no tasks, sidebar navigation, page refresh survival.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

test.describe('Workflow Page', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  test('sidebar navigation: clicking Workflow link navigates to /workflow and shows heading', async ({ page }) => {
    await page.goto('/');

    const sidebar = page.locator('aside');
    await expect(sidebar).toBeVisible({ timeout: 10_000 });

    const link = sidebar.locator('a[href="/workflow"]');
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/workflow/);
    await expect(page.locator('h1:has-text("Workflow")')).toBeVisible({ timeout: 10_000 });
  });

  test('collapsed sidebar: clicking Workflow icon navigates to /workflow and shows heading', async ({ page }) => {
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
    const link = sidebar.locator('a[href="/workflow"]');
    await expect(link).toBeVisible();
    await link.click();

    await expect(page).toHaveURL(/\/workflow/);

    // Workflow page shows heading with project, or no-project prompt without
    const hasHeading = await page.locator('h1:has-text("Workflow")').isVisible({ timeout: 5_000 }).catch(() => false);
    const hasNoProject = await page.locator('text=Select or add a project').isVisible({ timeout: 5_000 }).catch(() => false);
    expect(hasHeading || hasNoProject).toBe(true);
  });

  test('page loads and shows Workflow heading', async ({ page }) => {

    await page.goto('/workflow');

    await expect(page.locator('h1:has-text("Workflow")')).toBeVisible({ timeout: 10_000 });
  });

  test('shows legend with all transition types', async ({ page }) => {

    await page.goto('/workflow');

    for (const label of ['bounce', 'request changes', 'spec revision', 'failure']) {
      await expect(page.locator(`text=${label}`).first()).toBeVisible({ timeout: 5_000 });
    }
  });

  test('shows description subtext', async ({ page }) => {

    await page.goto('/workflow');

    await expect(page.locator('text=Pipeline state diagram')).toBeVisible({ timeout: 5_000 });
  });

  test('renders SVG pipeline diagram', async ({ page }) => {

    await page.goto('/workflow');

    // SVG element should be present in the diagram when tasks exist
    const svg = page.locator('svg');
    await expect(svg.first()).toBeVisible({ timeout: 5_000 });
  });

  test('page survives refresh', async ({ page }) => {

    await page.goto('/workflow');
    await expect(page.locator('h1:has-text("Workflow")')).toBeVisible({ timeout: 10_000 });

    await page.reload();

    await expect(page.locator('h1:has-text("Workflow")')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Pipeline state diagram')).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Workflow — Diagram Interaction', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  test('phase nodes render with labels and count badges', async ({ page }) => {

    await page.goto('/workflow');

    // All 11 pipeline phase labels should be visible
    for (const label of ['Backlog', 'Spec', 'Plan', 'Implement', 'QA Review',
      'Awaiting Review', 'Merge', 'Create PR', 'PR Open', 'Failed', 'Done']) {
      await expect(page.locator(`text=${label}`).first()).toBeVisible({ timeout: 10_000 });
    }
  });

  test('hovering on a phase node shows popover with ticket count', async ({ page }) => {

    // networkidle ensures React hydration is complete before we hover
    await page.goto('/workflow', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    // Hover the inner cursor-pointer div — React's onMouseEnter uses
    // mouseover delegation on the root, so we must target the interactive child.
    const backlogInner = page.locator('[data-testid="phase-node-backlog"] div.cursor-pointer').first();
    await expect(backlogInner).toBeAttached({ timeout: 5_000 });
    await backlogInner.hover({ force: true });
    // Allow the 180ms debounce timer in handlePhaseEnter to fire
    await page.waitForTimeout(300);

    // Backlog has 3 tasks → popover shows "3 tickets"
    await expect(page.getByText(/\d+ tickets?/).first()).toBeVisible({ timeout: 10_000 });
  });

  test('hovering on Done phase shows completed task cards in popover', async ({ page }) => {

    await page.goto('/workflow', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    // Hover the inner cursor-pointer div of the Done phase node
    const doneInner = page.locator('[data-testid="phase-node-done"] div.cursor-pointer').first();
    await expect(doneInner).toBeAttached({ timeout: 5_000 });
    await doneInner.hover({ force: true });
    await page.waitForTimeout(300);

    // Done has "Refactor: Extract shared types to common package" — partial match
    await expect(page.locator('text=Extract shared types')).toBeVisible({ timeout: 10_000 });
  });

  test('hovering on a single-task phase shows popover with one ticket', async ({ page }) => {

    await page.goto('/workflow', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    // "Failed" phase has exactly 1 task in the seed
    const failedInner = page.locator('[data-testid="phase-node-failed"] div.cursor-pointer').first();
    await expect(failedInner).toBeAttached({ timeout: 5_000 });
    await failedInner.hover({ force: true });
    await page.waitForTimeout(300);

    // Popover should appear with "1 ticket" text
    await expect(page.locator('text=1 ticket')).toBeVisible({ timeout: 10_000 });

    // And the popover should show the failed task card
    await expect(page.locator('text=search bar crashes')).toBeVisible({ timeout: 10_000 });
  });

  test('popover header shows phase label as h3', async ({ page }) => {

    await page.goto('/workflow', { waitUntil: 'networkidle' });
    await page.waitForTimeout(500);

    // Hover the inner cursor-pointer div of the Backlog phase node
    const backlogInner = page.locator('[data-testid="phase-node-backlog"] div.cursor-pointer').first();
    await expect(backlogInner).toBeAttached({ timeout: 5_000 });
    await backlogInner.hover({ force: true });
    await page.waitForTimeout(300);

    // The popover has a visible h3 for the phase label
    const popover = page.locator('h3:has-text("Backlog")');
    await expect(popover).toBeVisible({ timeout: 10_000 });
  });
});
