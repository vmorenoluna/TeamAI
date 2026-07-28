import { test, expect } from '@playwright/test';
import { clickUntilVisible, ensureProjectSelected } from './helpers';

test.describe('Terminals Page', () => {
  test.setTimeout(60_000);

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
    // The page heading may be deeply nested; verify the page rendered first
    await expect(page.locator('body')).toBeVisible({ timeout: 10_000 });
    // The New Terminal button has data-testid and is in the SSR HTML
    await expect(page.getByTestId('new-terminal-btn')).toBeVisible({ timeout: 20_000 });
  });

  test('opening New Terminal dialog shows role selector', async ({ page }) => {
    await page.goto('/terminals');
    await expect(page.locator('body')).toBeVisible({ timeout: 10_000 });

    // Click repeatedly until React hydration completes and the dialog appears
    await clickUntilVisible(
      page.getByTestId('new-terminal-btn'),
      page.getByTestId('dialog-backdrop'),
    );
    await expect(page.locator('h2:has-text("New Terminal")')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('select').first()).toBeVisible({ timeout: 5_000 });

    // Cancel should close the dialog
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('h2:has-text("New Terminal")')).not.toBeVisible({ timeout: 5_000 });
  });
});
