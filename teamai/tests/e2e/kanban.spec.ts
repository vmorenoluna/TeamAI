import { test, expect } from '@playwright/test';

test.describe('Kanban Board', () => {
  test('page loads and shows kanban columns', async ({ page }) => {
    await page.goto('/');

    // Page should have the app title or board visible
    await expect(page.locator('body')).toBeVisible();

    // Column headers should be present
    const columnHeaders = page.locator('text=Backlog');
    await expect(columnHeaders.first()).toBeVisible({ timeout: 10_000 });
  });

  test('kanban board shows task cards', async ({ page }) => {
    await page.goto('/');

    // Wait for task cards to render
    const cards = page.locator('[data-testid="task-card"]');
    const count = await cards.count();
    expect(count).toBeGreaterThan(0);
  });

  test('clicking a task card opens the detail panel', async ({ page }) => {
    await page.goto('/');

    // Find and click the first task card
    const firstCard = page.locator('[data-testid="task-card"]').first();
    await firstCard.click();

    // Task detail panel should appear
    const detailPanel = page.locator('text=Board').first();
    await expect(detailPanel).toBeVisible({ timeout: 5_000 });
  });

  test('kanban columns are visible: Backlog, Spec, Plan, Implement, QA Review, Done', async ({ page }) => {
    await page.goto('/');

    const expectedColumns = ['Backlog', 'Spec', 'Plan', 'Implement', 'QA Review', 'Done'];
    for (const col of expectedColumns) {
      const colHeader = page.locator(`text=${col}`).first();
      await expect(colHeader).toBeVisible({ timeout: 10_000 });
    }
  });

  test('shows project prompt or kanban content', async ({ page }) => {
    await page.goto('/');

    // Check we see a project selector or the main kanban content
    const bodyText = await page.locator('body').innerText();
    expect(
      bodyText.includes('Select or add a project') ||
      bodyText.includes('Backlog')
    ).toBeTruthy();
  });

  test('page has expected title', async ({ page }) => {
    await page.goto('/');
    await expect(page).toHaveTitle(/TeamAI/);
  });
});
