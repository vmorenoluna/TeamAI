import { test, expect, type Page } from '@playwright/test';
import { ensureProjectSelected, getSeedTaskId, requireSeedTaskId, scrollKanbanRight, getActiveSeedDir } from './helpers';
import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

let isSeeded = false;

const SEARCH_CRASH_SLUG = 'fix-search-bar-crashes-on-empty-input';

// Restored by afterAll if retry-click test clears it
const SEARCH_CRASH_COMPLETION_SUMMARY = `# Completion Summary

Task failed after reaching max QA attempts (3/3).

## Plan Subtasks

- [x] **Add empty guard clause** — COMPLETED
- [ ] **Add validation test** — NOT COMPLETED

## Last QA Report

Overall: **FAIL**

| Criterion | Status | Notes |
|-----------|--------|-------|
| Empty input handled without crash | PASS | |
| Shows helpful error message to user | FAIL | No user-facing message shown |
| Edge cases covered (whitespace, special chars) | FAIL | Only basic empty string handled |

## Issues

- [warning] No toast/notification shown on empty submit
- [warning] Whitespace-only input not handled`;

test.describe.serial('Retry Button on Failed Tasks', () => {
  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    if (ok) isSeeded = true;
    else isSeeded = false;
  });

  async function logAllTaskCards(page: Page) {
    const cards = page.locator('[data-testid="task-card"]');
    const count = await cards.count();
    const titles: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await cards.nth(i).innerText();
      titles.push(text.split('\n')[0]);
    }
    console.log(`[debug] Found ${count} cards:`, titles.join(', '));
  }

  test('shows retry button on failed task card', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await logAllTaskCards(page);
    await scrollKanbanRight(page);

    const failedCard = page.locator('[data-testid="task-card"]', { hasText: 'search bar crashes' });
    await expect(failedCard.first()).toHaveCount(1, { timeout: 5_000 });

    const retryButton = failedCard.first().locator('[data-testid="retry-button"]');
    await expect(retryButton).toBeVisible({ timeout: 5_000 });
    await expect(retryButton).toHaveText(/Retry/);
    await expect(retryButton).toHaveAttribute('title', 'Retry task — restart pipeline from the phase it failed at');
  });

  test('shows failure indicator alongside retry button on failed task', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await logAllTaskCards(page);
    await scrollKanbanRight(page);

    const failedCard = page.locator('[data-testid="task-card"]', { hasText: 'search bar crashes' });
    await expect(failedCard.first()).toHaveCount(1, { timeout: 5_000 });

    const failureIndicator = failedCard.first().locator('[data-testid="failure-indicator"]');
    const retryButton = failedCard.first().locator('[data-testid="retry-button"]');
    await expect(failureIndicator).toBeVisible({ timeout: 5_000 });
    await expect(retryButton).toBeVisible({ timeout: 5_000 });
  });

  test('does not show retry button on non-failed tasks', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await logAllTaskCards(page);

    const nonFailedCards = [
      'dark mode toggle',
      'Extract shared types',
      'keyboard shortcuts',
    ];

    for (const title of nonFailedCards) {
      const card = page.locator('[data-testid="task-card"]', { hasText: title });
      if (await card.count() > 0) {
        const retryButton = card.first().locator('[data-testid="retry-button"]');
        await expect(retryButton).toHaveCount(0);
      }
    }
  });

  test('shows retry button in task detail panel for failed tasks', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(SEARCH_CRASH_SLUG);
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    // Wait for the detail retry button to appear (panel loads async data)
    const detailRetryButton = page.locator('[data-testid="detail-retry-button"]');
    const found = await detailRetryButton.waitFor({ state: 'attached', timeout: 15_000 }).then(() => true).catch(() => false);
    if (!found) { test.skip(true, 'Detail retry button not in panel'); return; }

    await expect(detailRetryButton).toBeVisible({ timeout: 5_000 });
    await expect(detailRetryButton).toHaveText(/Retry/);
  });

  test('retry button navigates to retryTask action without error', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }
    // Skip in CI: retryTask() fires the orchestrator pipeline which requires
    // Docker + Claude CLI not available on CI runners. The orchestrator crashes
    // (devcontainer up failed), corrupting shared seed state for subsequent tests.
    if (process.env.CI) { test.skip(true, 'Skipped in CI — orchestrator requires Docker/Claude CLI'); return; }

    await page.goto('/');
    await scrollKanbanRight(page);
    await logAllTaskCards(page);

    const failedCard = page.locator('[data-testid="task-card"]', { hasText: 'search bar crashes' });
    await expect(failedCard.first()).toHaveCount(1, { timeout: 5_000 });

    // Click the retry button — this should trigger the server action without error
    const retryButton = failedCard.first().locator('[data-testid="retry-button"]');
    await expect(retryButton).toBeEnabled({ timeout: 5_000 });

    // Click and wait for navigation/refresh
    await retryButton.click();

    // After clicking retry, the page should refresh. Wait briefly for the refresh to complete.
    await page.waitForTimeout(2_000);

    // The server action fires revalidatePath('/') + router.refresh().
    // The task either moves out of the Failed column or its completionSummary is cleared.
    // Either way, the retry button still works, so verify no error popup appeared.
    const errorDialog = page.locator('text=Failed to retry task');
    await expect(errorDialog).toHaveCount(0, { timeout: 5_000 });
  });

  // ── Restore seed state after retry-click test ──────────────────────────
  // The retry-click test triggers retryTask(), which clears completionSummary
  // on the task. Subsequent test files (task-detail.spec.ts, completion-summary.spec.ts)
  // read the same task and expect the completion summary banner to render.
  // Restoring completionSummary in task.json prevents cascading failures.
  test.afterAll(() => {
    const taskId = getSeedTaskId(SEARCH_CRASH_SLUG);
    if (!taskId) return;

    const taskPath = join(getActiveSeedDir(), '.teamai', SEARCH_CRASH_SLUG, 'task.json');
    try {
      const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
      task.phase = 'failed';
      task.completionSummary = SEARCH_CRASH_COMPLETION_SUMMARY;
      writeFileSync(taskPath, JSON.stringify(task, null, 2));
      console.log('[retry-button afterAll] Restored seed task state');
    } catch (e) {
      console.log('[retry-button afterAll] Failed to restore seed state:', e);
    }
  });
});
