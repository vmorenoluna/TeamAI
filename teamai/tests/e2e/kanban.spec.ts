import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

test.describe('Kanban Board', () => {
  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);
  });

  test('page loads and shows kanban columns', async ({ page }) => {
    await expect(page.locator('body')).toBeVisible();

    const columnHeaders = page.locator('text=Backlog');
    await expect(columnHeaders.first()).toBeVisible({ timeout: 10_000 });
  });

  test('kanban board shows task cards', async ({ page }) => {
    const cards = page.locator('[data-testid="task-card"]');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('kanban board renders task cards from seed data', async ({ page }) => {
    // With the seed project active, task cards should be present
    const cards = page.locator('[data-testid="task-card"]');
    await expect(cards.first()).toBeVisible({ timeout: 10_000 });
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('page has expected title', async ({ page }) => {
    await expect(page).toHaveTitle(/TeamAI/);
  });
});
