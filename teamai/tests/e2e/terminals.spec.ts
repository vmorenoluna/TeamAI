import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

test.describe('Terminals Page', () => {
  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);
  });

  test('page loads and shows header', async ({ page }) => {
    await page.goto('/terminals');
    await expect(page.locator('body')).toBeVisible({ timeout: 10_000 });

    const sidebarLink = page.locator('nav a[href="/terminals"]');
    await expect(sidebarLink).toBeVisible();
  });

  test('terminals page shows New Terminal button when project selected', async ({ page }) => {
    await page.goto('/terminals');
    await expect(page.getByTestId('new-terminal-btn')).toBeVisible({ timeout: 10_000 });
  });

  test('opening New Terminal dialog shows role selector', async ({ page }) => {
    await page.goto('/terminals');
    await expect(page.locator('body')).toBeVisible({ timeout: 10_000 });

    // Let the page fully hydrate before interacting
    await page.waitForTimeout(1000);

    // Click the New Terminal button using its test id
    await page.getByTestId('new-terminal-btn').click({ force: true });

    // Dialog should appear - wait for backdrop to confirm it opened
    await expect(page.getByTestId('dialog-backdrop')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('h2:has-text("New Terminal")')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('select').first()).toBeVisible({ timeout: 3_000 });

    // Cancel should close the dialog
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('h2:has-text("New Terminal")')).not.toBeVisible({ timeout: 3_000 });
  });
});
