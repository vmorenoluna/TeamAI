import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

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
    await expect(page.getByTestId('new-terminal-btn')).toBeVisible({ timeout: 10_000 });
  });

  test('opening New Terminal dialog shows role selector', async ({ page }) => {
    await page.goto('/terminals');
    await expect(page.locator('body')).toBeVisible({ timeout: 10_000 });

    // Click repeatedly until React hydration completes and the dialog
    // appears.  The server-rendered button is in the DOM immediately but
    // the onClick handler is not attached until React hydrates — a single
    // click can fire into the void.
    await expect(async () => {
      await page.getByTestId('new-terminal-btn').click();
      await expect(page.getByTestId('dialog-backdrop')).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 15_000 });
    await expect(page.locator('h2:has-text("New Terminal")')).toBeVisible({ timeout: 3_000 });
    await expect(page.locator('select').first()).toBeVisible({ timeout: 3_000 });

    // Cancel should close the dialog
    await page.getByRole('button', { name: 'Cancel' }).click();
    await expect(page.locator('h2:has-text("New Terminal")')).not.toBeVisible({ timeout: 3_000 });
  });
});
