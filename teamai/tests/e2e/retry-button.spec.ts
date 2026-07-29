import { test, expect, type Page } from '@playwright/test';
import { ensureProjectSelected, requireSeedTaskId, scrollKanbanRight } from './helpers';


const SEARCH_CRASH_SLUG = 'fix-search-bar-crashes-on-empty-input';

test.describe.serial('Retry Button on Failed Tasks', () => {
  test.beforeEach(async ({ page }) => {
  await ensureProjectSelected(page);
});

  async function logAllTaskCards(page: Page) {
    const cards = page.locator('[data-component="task-card"]');
    const count = await cards.count();
    const titles: string[] = [];
    for (let i = 0; i < count; i++) {
      const text = await cards.nth(i).innerText();
      titles.push(text.split('\n')[0]);
    }
    console.log(`[debug] Found ${count} cards:`, titles.join(', '));
  }

  test('shows retry button on failed task card', async ({ page }) => {
    await page.goto('/');
    await logAllTaskCards(page);
    await scrollKanbanRight(page);

    const failedCard = page.locator('[data-component="task-card"]', { hasText: 'search bar crashes' });
    await expect(failedCard.first()).toHaveCount(1, { timeout: 5_000 });

    const retryButton = failedCard.first().locator('[data-component="retry-button"]');
    await expect(retryButton).toBeVisible({ timeout: 5_000 });
    await expect(retryButton).toHaveText(/Retry/);
    await expect(retryButton).toHaveAttribute('title', 'Retry task — restart pipeline from the phase it failed at');
  });

  test('shows failure indicator alongside retry button on failed task', async ({ page }) => {
    await page.goto('/');
    await logAllTaskCards(page);
    await scrollKanbanRight(page);

    const failedCard = page.locator('[data-component="task-card"]', { hasText: 'search bar crashes' });
    await expect(failedCard.first()).toHaveCount(1, { timeout: 5_000 });

    const failureIndicator = failedCard.first().locator('[data-component="failure-indicator"]');
    const retryButton = failedCard.first().locator('[data-component="retry-button"]');
    await expect(failureIndicator).toBeVisible({ timeout: 5_000 });
    await expect(retryButton).toBeVisible({ timeout: 5_000 });
  });

  test('does not show retry button on non-failed tasks', async ({ page }) => {
    await page.goto('/');
    await logAllTaskCards(page);

    const nonFailedCards = [
      'dark mode toggle',
      'Extract shared types',
      'keyboard shortcuts',
    ];

    for (const title of nonFailedCards) {
      const card = page.locator('[data-component="task-card"]', { hasText: title });
      if (await card.count() > 0) {
        const retryButton = card.first().locator('[data-component="retry-button"]');
        await expect(retryButton).toHaveCount(0);
      }
    }
  });

  test('shows retry button in task detail panel for failed tasks', async ({ page }) => {
    const taskId = requireSeedTaskId(SEARCH_CRASH_SLUG);
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    // Wait for the detail retry button to appear (panel loads async data)
    const detailRetryButton = page.locator('[data-component="detail-retry-button"]');
    await expect(detailRetryButton).toBeAttached({ timeout: 15_000 });

    await expect(detailRetryButton).toBeVisible({ timeout: 5_000 });
    await expect(detailRetryButton).toHaveText(/Retry/);
  });


});
