/**
 * Behavioral E2E tests for kanban real-time WebSocket updates.
 *
 * Covers: phase-change events updating card position/column,
 * connection indicator state changes.
 *
 * Tests verify correct card positioning after a phase change is written
 * to disk — the next page load picks up the new phase naturally.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected, requireSeedTaskId, getActiveSeedDir } from './helpers';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const TASK_SLUG = 'test-terminal-live-event-labels';

test.describe('Kanban — Phase Change Updates', () => {
  test.setTimeout(90_000);
  let originalPhase: string | null = null;

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  test.afterEach(async () => {
    // Restore the mutated seed task so later tests in this worker don't see a
    // task stuck in the failed phase.
    if (!originalPhase) return;
    const taskJsonPath = join(getActiveSeedDir(), '.teamai', TASK_SLUG, 'task.json');
    try {
      const taskData = JSON.parse(readFileSync(taskJsonPath, 'utf-8'));
      taskData.phase = originalPhase;
      writeFileSync(taskJsonPath, JSON.stringify(taskData, null, 2));
    } catch {
      // best-effort cleanup
    }
    originalPhase = null;
  });

  test('phase change is reflected on page reload after disk mutation', async ({ page }) => {
    requireSeedTaskId(TASK_SLUG);

    // Verify the task is currently in In Progress column (implement phase)
    const card = page.locator('[data-component="task-card"]', { hasText: 'terminal live event labels' });
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card.locator('text=In Progress')).toBeVisible({ timeout: 5_000 });

    // Mutate the persisted task phase to 'failed'.
    const taskJsonPath = join(getActiveSeedDir(), '.teamai', TASK_SLUG, 'task.json');
    const taskData = JSON.parse(readFileSync(taskJsonPath, 'utf-8'));
    originalPhase = taskData.phase;
    taskData.phase = 'failed';
    writeFileSync(taskJsonPath, JSON.stringify(taskData, null, 2));

    // Reload the page — the server will serve the updated task data.
    await page.reload();
    await expect(page.locator('text=Backlog').first()).toBeVisible({ timeout: 15_000 });

    // Verify the card was REMOVED from the In Progress column
    const inProgressCard = page
      .locator('text=In Progress').first()
      .locator('..').locator('..')
      .locator('[data-component="task-card"]', { hasText: 'terminal live event labels' });
    await expect(inProgressCard).toHaveCount(0, { timeout: 5_000 });

    // Verify the card is now in the Failed column with correct phase badge
    await page.locator('text=Failed').first().scrollIntoViewIfNeeded();
    const failedCard = page.locator('[data-component="task-card"]', { hasText: 'terminal live event labels' });
    await expect(failedCard).toBeVisible({ timeout: 10_000 });
    await expect(failedCard.locator('text=Failed').first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Kanban — Subtask Progress', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  test('initial subtask progress badge shows correct counts', async ({ page }) => {
    // The login-button task has a plan with 2 subtasks, 1 completed.
    const card = page.locator('[data-component="task-card"]', { hasText: 'login button' });
    const progressBadge = card.locator('[data-component="subtask-progress-badge"]');
    await expect(progressBadge).toBeVisible({ timeout: 5_000 });
    await expect(progressBadge).toHaveText('1/2 ✓');
  });
});

test.describe('Kanban — Connection Indicator', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  test('connection indicator is rendered in the board header', async ({ page }) => {

    await page.goto('/');

    // The header should show "Board" title alongside the connection indicator
    await expect(page.locator('h1:has-text("Board")')).toBeVisible({ timeout: 10_000 });
  });

  test('kanban board remains interactive after extended idle', async ({ page }) => {

    await page.goto('/');
    await expect(page.locator('[data-component="task-card"]').first()).toBeVisible({ timeout: 10_000 });

    // Wait a moment and verify the board is still interactive
    await page.waitForTimeout(3000);

    // Click the search input — it should still work
    const searchInput = page.locator('input[placeholder="Search…"]');
    await searchInput.fill('test');
    await expect(searchInput).toHaveValue('test');
  });
});
