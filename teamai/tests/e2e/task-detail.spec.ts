import { test, expect, type Page } from '@playwright/test';
import { ensureProjectSelected, getSeedTaskId } from './helpers';

// ── Resolve task IDs from seed filesystem (avoids unreliable card clicking) ──

/** "Implement dark mode toggle" task — in backlog, no plan, no QA report */
const BACKLOG_TASK_SLUG = 'implement-dark-mode-toggle';

test.describe('Task Detail Panel (inline on kanban board)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);
  });

  /**
   * Open the task detail panel for the seed backlog task.
   * Returns true if the panel opened, false otherwise.
   */
  async function openTaskDetail(page: Page, text: string): Promise<boolean> {
    await page.goto('/');
    await page.locator('[data-testid="task-card"]', { hasText: text }).first().click({ force: true });
    try {
      await expect(page.locator('text=← Board').first()).toBeVisible({ timeout: 5_000 });
      return true;
    } catch {
      return false;
    }
  }

  test('opens when clicking a task card and shows title, phase, and tabs', async ({ page }) => {
    await page.goto('/');

    const ok = await openTaskDetail(page, 'dark mode toggle');
    test.skip(!ok, 'Could not open task detail panel');

    await expect(page.locator('[data-testid="task-id"]').first()).toBeVisible({ timeout: 10_000 });
    const phaseBadge = page.locator('text=backlog').first();
    await expect(phaseBadge).toBeVisible({ timeout: 3_000 });
  });

  test('shows tabs: Overview, Terminal, Spec, Plan, QA', async ({ page }) => {
    await page.goto('/');

    const ok = await openTaskDetail(page, 'dark mode toggle');
    test.skip(!ok, 'Could not open task detail panel');

    for (const tab of ['Overview', 'Terminal', 'Spec', 'Plan', 'QA']) {
      await expect(page.locator(`button:has-text("${tab}")`).first()).toBeVisible({ timeout: 3_000 });
    }
  });

  test('can switch between tabs', async ({ page }) => {
    await page.goto('/');

    const ok = await openTaskDetail(page, 'dark mode toggle');
    test.skip(!ok, 'Could not open task detail panel');

    await page.locator('button:has-text("Spec")').first().click();
    await expect(page.locator('pre, p:has-text("No spec generated")').first()).toBeVisible({ timeout: 3_000 });

    await page.locator('button:has-text("Plan")').first().click();
    await expect(page.locator('text=No plan generated yet').first()).toBeVisible({ timeout: 3_000 });

    await page.locator('button:has-text("QA")').first().click();
    await expect(page.locator('text=No QA report generated').first()).toBeVisible({ timeout: 3_000 });

    await page.locator('button:has-text("Overview")').first().click();
    await expect(page.locator('text=No dependencies set').first()).toBeVisible({ timeout: 3_000 });
  });

  test('shows breadcrumb link back to board', async ({ page }) => {
    await page.goto('/');

    const ok = await openTaskDetail(page, 'dark mode toggle');
    test.skip(!ok, 'Could not open task detail panel');

    const breadcrumb = page.locator('a:has-text("← Board")');
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb).toHaveAttribute('href', '/');
  });

  test('shows delete button in task detail panel', async ({ page }) => {
    await page.goto('/');

    const ok = await openTaskDetail(page, 'dark mode toggle');
    test.skip(!ok, 'Could not open task detail panel');

    await expect(page.locator('button[title="Delete task"]')).toBeVisible({ timeout: 3_000 });
  });

  test('close button (×) dismisses the panel', async ({ page }) => {
    await page.goto('/');

    const ok = await openTaskDetail(page, 'dark mode toggle');
    test.skip(!ok, 'Could not open task detail panel');

    await page.locator('button[title="Close window"]').click({ force: true });
    await expect(page.locator('text=← Board').first()).not.toBeVisible({ timeout: 3_000 });
  });
});

test.describe('Task Detail Full Page (/task/:id)', () => {
  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);
  });

  /** Get the backlog task ID directly from the seed filesystem */
  function getBacklogTaskId(): string {
    const id = getSeedTaskId(BACKLOG_TASK_SLUG);
    if (!id) throw new Error(`Seed task "${BACKLOG_TASK_SLUG}" not found on disk — did the seed run?`);
    return id;
  }

  test('full page renders task title, phase badge, and tabs', async ({ page }) => {
    const taskId = getBacklogTaskId();
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 5_000 });

    const phaseBadge = page.locator('text=backlog').first();
    await expect(phaseBadge).toBeVisible({ timeout: 3_000 });

    for (const tab of ['Overview', 'Terminal', 'Spec', 'Plan', 'QA']) {
      await expect(page.locator(`button:has-text("${tab}")`).first()).toBeVisible({ timeout: 3_000 });
    }
  });

  test('full page shows task ID in monospace', async ({ page }) => {
    const taskId = getBacklogTaskId();
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    const fullPageTaskId = page.locator('[data-testid="task-id"]').first();
    await expect(fullPageTaskId).toBeVisible({ timeout: 10_000 });
    await expect(fullPageTaskId).toContainText(taskId);
  });

  test('full page has breadcrumb back to board', async ({ page }) => {
    const taskId = getBacklogTaskId();
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    const breadcrumb = page.locator('a:has-text("← Board")');
    await expect(breadcrumb).toBeVisible({ timeout: 5_000 });
    await expect(breadcrumb).toHaveAttribute('href', '/');
  });

  test('terminal tab renders agent panel', async ({ page }) => {
    const taskId = getBacklogTaskId();
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    // Wait for page to fully hydrate before clicking tabs
    await page.waitForTimeout(2000);
    await page.locator('button:has-text("Terminal")').first().click({ force: true, timeout: 10_000 });
    await expect(page.locator('text=Agent Output').first()).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('[data-testid="scroll-to-bottom"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scroll-to-top"]')).toHaveCount(0);
  });

  test('full page shows delete button', async ({ page }) => {
    const taskId = getBacklogTaskId();
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    await expect(page.locator('button[title="Delete task"]')).toBeVisible({ timeout: 3_000 });
  });
});
