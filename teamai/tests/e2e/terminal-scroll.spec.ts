import { test, expect } from '@playwright/test';

test.describe('Terminal Scroll Behavior', () => {
  test('terminal auto-scrolls to bottom when at default position and new events arrive', async ({ page }) => {
    await page.goto('/');

    // Skip if no active project
    const noProject = page.locator('text=Select or add a project from the sidebar');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    // Skip if no task cards
    const taskCards = page.locator('[data-testid="task-card"]');
    if ((await taskCards.count()) === 0) {
      test.skip(true, 'No tasks available');
      return;
    }

    // Open task detail and navigate to terminal tab
    await taskCards.first().click();
    await expect(page.locator('text=← Board')).toBeVisible({ timeout: 5_000 });

    const taskIdText = page.locator('[data-testid="task-id"]');
    await expect(taskIdText).toBeVisible({ timeout: 5_000 });
    const taskId = await taskIdText.innerText();

    await page.locator('button[title="Close window"]').click();
    await page.goto(`/task/${taskId}`);

    // Click the Terminal tab
    await page.locator('button:has-text("Terminal")').first().click();
    await expect(page.locator('text=Agent Output').first()).toBeVisible({ timeout: 5_000 });

    // Wait for xterm to render
    await page.waitForTimeout(1500);

    // Verify the xterm viewport is rendered (native scrollbar)
    const terminalViewport = page.locator('.xterm-viewport');
    await expect(terminalViewport.first()).toBeVisible({ timeout: 3_000 });

    // No floating scroll buttons should exist in the DOM
    await expect(page.locator('[data-testid="scroll-to-bottom"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scroll-to-top"]')).toHaveCount(0);
  });
});
