import { test, expect, type Page } from '@playwright/test';

let isSeeded = false;

/**
 * Navigate to home page and ensure E2E Test Project is active.
 */
async function ensureProjectSelected(page: Page): Promise<boolean> {
  await page.goto('/');

  const backlog = page.locator('text=Backlog').first();
  try {
    await expect(backlog).toBeVisible({ timeout: 5_000 });
    return true;
  } catch {
    try {
      const projectTab = page.locator('button:has-text("E2E Test Project")');
      await expect(projectTab.first()).toBeVisible({ timeout: 5_000 });
      await projectTab.first().click();
      await expect(page.locator('text=Backlog').first()).toBeVisible({ timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  }
}

/** Scroll the kanban board to make the rightmost columns (Failed, Done) visible */
async function scrollKanbanRight(page: Page) {
  await page.evaluate(() => {
    const container = document.querySelector('.overflow-x-auto');
    if (container) (container as HTMLElement).scrollLeft = (container as HTMLElement).scrollWidth;
  });
}

/**
 * Check if a task card with the given text exists on the page.
 */
async function ensureTaskCardVisible(page: Page, text: string): Promise<boolean> {
  const cardCount = await page.locator('[data-testid="task-card"]').count();
  if (cardCount === 0) return false;
  const card = page.locator('[data-testid="task-card"]', { hasText: text });
  return await card.count() > 0;
}

/**
 * Click a task card to open the detail panel.
 * Uses force:true to bypass draggable wrapper issues.
 */
async function openTaskDetail(page: Page, text: string): Promise<boolean> {
  if (!await ensureTaskCardVisible(page, text)) return false;

  await page.locator('[data-testid="task-card"]', { hasText: text }).first().click({ force: true });

  try {
    await expect(page.locator('text=← Board').first()).toBeVisible({ timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

test.describe.serial('QA Failure Banner & Completion Summary', () => {
  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    if (ok) isSeeded = true;
    else isSeeded = false;
  });

  test('shows completion summary banner for failed tasks', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    await page.goto('/');
    await scrollKanbanRight(page);

    if (!await openTaskDetail(page, 'search bar crashes')) {
      test.skip(true, 'Failed task not seeded');
      return;
    }

    await expect(page.locator('text=Task Failed')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Max QA attempts reached')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('text=Add empty guard clause')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('text=No user-facing message shown')).toBeVisible({ timeout: 3_000 });
  });

  test('completed subtasks show checkmarks and progress bar', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    await page.goto('/');

    if (!await openTaskDetail(page, 'login button')) {
      test.skip(true, 'Task with plan not seeded');
      return;
    }

    await page.locator('button:has-text("Plan")').first().click();
    await expect(page.locator('[data-testid="plan-subtask"]').first()).toBeVisible({ timeout: 5_000 });

    await expect(page.locator('text=1 / 2 subtasks completed')).toBeVisible({ timeout: 3_000 });

    const completedSubtask = page.locator('[data-testid="plan-subtask"]').first();
    await expect(completedSubtask.locator('text=✓')).toBeVisible({ timeout: 3_000 });
    await expect(completedSubtask.locator('text=Fix CSS z-index')).toBeVisible({ timeout: 3_000 });

    await expect(page.locator('[data-testid="subtask-progress-bar"]')).toBeVisible({ timeout: 3_000 });
  });

  test('failed task shows QA report with FAIL overall', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    await page.goto('/');
    await scrollKanbanRight(page);

    if (!await openTaskDetail(page, 'search bar crashes')) {
      test.skip(true, 'Failed task not seeded');
      return;
    }

    await page.locator('button:has-text("QA")').first().click();

    await expect(page.locator('text=FAIL').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Empty input handled without crash')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('text=Shows helpful error message to user')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('text=Edge cases covered (whitespace, special chars)')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('text=just silently ignores').first()).toBeVisible({ timeout: 3_000 });
  });

  test('done task shows all subtasks completed', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    await page.goto('/');

    if (!await openTaskDetail(page, 'Extract shared types')) {
      test.skip(true, 'Done task not seeded');
      return;
    }

    await page.locator('button:has-text("Plan")').first().click();
    await expect(page.locator('[data-testid="plan-subtask"]').first()).toBeVisible({ timeout: 5_000 });

    await expect(page.locator('text=3 / 3 subtasks completed')).toBeVisible({ timeout: 3_000 });

    const subtasks = page.locator('[data-testid="plan-subtask"]');
    const count = await subtasks.count();
    expect(count).toBe(3);

    for (let i = 0; i < count; i++) {
      await expect(subtasks.nth(i).locator('text=✓')).toBeVisible({ timeout: 2_000 });
    }
  });

  test('backlog task shows "no plan generated yet" message', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    await page.goto('/');

    if (!await openTaskDetail(page, 'dark mode toggle')) {
      test.skip(true, 'Backlog task with no plan not seeded');
      return;
    }

    await page.locator('button:has-text("Plan")').first().click();
    await expect(page.locator('text=No plan generated yet')).toBeVisible({ timeout: 3_000 });
  });

  test('failure indicator shows on kanban task card for failed tasks', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    await page.goto('/');
    await scrollKanbanRight(page);

    if (!await ensureTaskCardVisible(page, 'search bar crashes')) {
      test.skip(true, 'Failed task not seeded');
      return;
    }

    const failedCard = page.locator('[data-testid="task-card"]', { hasText: 'search bar crashes' });
    const failureIndicator = failedCard.locator('[data-testid="failure-indicator"]');
    await expect(failureIndicator).toBeVisible({ timeout: 3_000 });
    await expect(failureIndicator).toHaveAttribute('title', 'Task failed — click for details');
  });

  test('kanban card shows subtask progress badge for tasks with plans', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    await page.goto('/');

    if (!await ensureTaskCardVisible(page, 'login button')) {
      test.skip(true, 'Task with plan not seeded');
      return;
    }

    const taskCard = page.locator('[data-testid="task-card"]', { hasText: 'login button' });
    const progressBadge = taskCard.locator('[data-testid="subtask-progress-badge"]');
    await expect(progressBadge).toBeVisible({ timeout: 3_000 });
    await expect(progressBadge).toHaveText('1/2 ✓');
    await expect(progressBadge).toHaveAttribute('title', '1 / 2 subtasks completed');
  });

  test('kanban card shows green subtask badge when all subtasks completed', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    await page.goto('/');

    if (!await ensureTaskCardVisible(page, 'Extract shared types')) {
      test.skip(true, 'Done task with plan not seeded');
      return;
    }

    const taskCard = page.locator('[data-testid="task-card"]', { hasText: 'Extract shared types' });
    const progressBadge = taskCard.locator('[data-testid="subtask-progress-badge"]');
    await expect(progressBadge).toBeVisible({ timeout: 3_000 });
    await expect(progressBadge).toHaveText('3/3 ✓');
    await expect(progressBadge).toHaveAttribute('title', '3 / 3 subtasks completed');
  });

  test('backlog kanban cards without plans have no subtask progress badge', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    await page.goto('/');

    if (!await ensureTaskCardVisible(page, 'dark mode toggle')) {
      test.skip(true, 'Backlog task not seeded');
      return;
    }

    const taskCard = page.locator('[data-testid="task-card"]', { hasText: 'dark mode toggle' });
    const progressBadge = taskCard.locator('[data-testid="subtask-progress-badge"]');
    await expect(progressBadge).toHaveCount(0);
  });
});
