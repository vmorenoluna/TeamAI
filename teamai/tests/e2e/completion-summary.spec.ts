import { test, expect } from '@playwright/test';
import { ensureProjectSelected, ensureTaskCardVisible, requireSeedTaskId, scrollKanbanRight } from './helpers';

let isSeeded = false;

// ── Seed slugs (must match seed.ts slugify) ────────────────────────────
const SEARCH_CRASH_SLUG = 'fix-search-bar-crashes-on-empty-input';
const LOGIN_BUTTON_SLUG = 'fix-login-button-not-visible-on-mobile';
const DARK_MODE_SLUG = 'implement-dark-mode-toggle';
const SHARED_TYPES_SLUG = 'refactor-extract-shared-types-to-common-package';

test.describe('QA Failure Banner & Completion Summary', () => {
  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    if (ok) isSeeded = true;
    else isSeeded = false;
  });

  test('shows completion summary banner for failed tasks', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(SEARCH_CRASH_SLUG);
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    await expect(page.locator('h3:has-text("Task Failed")')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Max QA attempts reached')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Add empty guard clause')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=No user-facing message shown')).toBeVisible({ timeout: 5_000 });
  });

  test('completed subtasks show checkmarks and progress bar', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(LOGIN_BUTTON_SLUG);
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    // Navigate to Plan tab directly via URL hash — wait for useEffect to sync
    await page.goto(`/task/${taskId}#plan`);
    await page.waitForTimeout(500);

    // Plan subtasks should render
    await expect(page.locator('[data-testid="plan-subtask"]').first()).toBeVisible({ timeout: 15_000 });

    // Progress text
    await expect(page.locator('text=1 / 2 subtasks completed')).toBeVisible({ timeout: 5_000 });

    // First subtask should be completed with checkmark
    const completedSubtask = page.locator('[data-testid="plan-subtask"]').first();
    await expect(completedSubtask.locator('text=✓')).toBeVisible({ timeout: 5_000 });
    await expect(completedSubtask.locator('text=Fix CSS z-index')).toBeVisible({ timeout: 5_000 });

    // Progress bar should be visible (partial completion)
    await expect(page.locator('[data-testid="subtask-progress-bar"]')).toBeVisible({ timeout: 5_000 });
  });

  test('failed task shows QA report with FAIL overall', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(SEARCH_CRASH_SLUG);
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    // Click the QA tab directly — hash navigation (#qa) doesn't reliably
    // trigger React's useEffect/hashchange on headless CI Chromium, leaving
    // the Overview tab visible. Clicking the button forces an immediate state
    // update that renders QAReportView with the full criteria notes.
    await page.locator('button').filter({ hasText: /^QA/ }).click();

    await expect(page.locator('text=FAIL').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=Empty input handled without crash')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Shows helpful error message to user')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Edge cases covered (whitespace, special chars)')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=No user-facing message shown').first()).toBeAttached({ timeout: 15_000 });
  });

  test('done task shows all subtasks completed', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(SHARED_TYPES_SLUG);
    await page.goto(`/task/${taskId}#plan`);
    await expect(page.locator('body')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.locator('[data-testid="plan-subtask"]').first()).toBeVisible({ timeout: 15_000 });

    await expect(page.locator('text=3 / 3 subtasks completed')).toBeVisible({ timeout: 5_000 });

    const subtasks = page.locator('[data-testid="plan-subtask"]');
    const count = await subtasks.count();
    expect(count).toBe(3);

    for (let i = 0; i < count; i++) {
      await expect(subtasks.nth(i).locator('text=✓')).toBeVisible({ timeout: 3_000 });
    }
  });

  test('backlog task shows "no plan generated yet" message', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}#plan`);
    await expect(page.locator('body')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.locator('text=No plan generated yet')).toBeVisible({ timeout: 10_000 });
  });

  test('failure indicator shows on kanban task card for failed tasks', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await scrollKanbanRight(page);

    if (!await ensureTaskCardVisible(page, 'search bar crashes')) {
      test.skip(true, 'Failed task not seeded');
      return;
    }

    const failedCard = page.locator('[data-testid="task-card"]', { hasText: 'search bar crashes' });
    const failureIndicator = failedCard.locator('[data-testid="failure-indicator"]');
    await expect(failureIndicator).toBeVisible({ timeout: 5_000 });
    await expect(failureIndicator).toHaveAttribute('title', 'Task failed');
  });

  test('kanban card shows subtask progress badge for tasks with plans', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');

    if (!await ensureTaskCardVisible(page, 'login button')) {
      test.skip(true, 'Task with plan not seeded');
      return;
    }

    const taskCard = page.locator('[data-testid="task-card"]', { hasText: 'login button' });
    const progressBadge = taskCard.locator('[data-testid="subtask-progress-badge"]');
    await expect(progressBadge).toBeVisible({ timeout: 5_000 });
    await expect(progressBadge).toHaveText('1/2 ✓');
    await expect(progressBadge).toHaveAttribute('title', '1 / 2 subtasks completed');
  });

  test('kanban card shows green subtask badge when all subtasks completed', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');

    if (!await ensureTaskCardVisible(page, 'Extract shared types')) {
      test.skip(true, 'Done task with plan not seeded');
      return;
    }

    const taskCard = page.locator('[data-testid="task-card"]', { hasText: 'Extract shared types' });
    const progressBadge = taskCard.locator('[data-testid="subtask-progress-badge"]');
    await expect(progressBadge).toBeVisible({ timeout: 5_000 });
    await expect(progressBadge).toHaveText('3/3 ✓');
    await expect(progressBadge).toHaveAttribute('title', '3 / 3 subtasks completed');
  });

  test('backlog kanban cards without plans have no subtask progress badge', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

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
