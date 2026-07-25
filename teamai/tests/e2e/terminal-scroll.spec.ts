import { test, expect } from '@playwright/test';
import { ensureProjectSelected, getSeedTaskId } from './helpers';

test.describe('Terminal Scroll Behavior', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);
  });

  test('terminal tab renders agent panel on full page', async ({ page }) => {
    const taskId = getSeedTaskId('implement-dark-mode-toggle');
    if (!taskId) {
      test.skip(true, 'Seed task not found on disk');
      return;
    }

    // Use hash-based navigation to go directly to the Terminal tab — avoids
    // click unreliability when the page hasn't fully hydrated in parallel mode.
    await page.goto(`/task/${taskId}#terminal`);
    await expect(page.locator('body')).toBeVisible();

    // Wait for React hydration, then verify the terminal container is mounted.
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="terminal-container"]')).toBeVisible({ timeout: 20_000 });

    // Wait for any xterm instances to initialise (terminal emulator + WebGL
    // renderer). Not all tasks have terminal output — if none rendered, skip.
    await page.waitForTimeout(2000);

    const terminalViewport = page.locator('.xterm-viewport');
    if (await terminalViewport.count() > 0) {
      await expect(terminalViewport.first()).toBeVisible({ timeout: 10_000 });
    }

    // No floating scroll buttons
    await expect(page.locator('[data-testid="scroll-to-bottom"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scroll-to-top"]')).toHaveCount(0);
  });
});
