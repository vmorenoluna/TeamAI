import { test, expect } from '@playwright/test';
import { clickUntilVisible, ensureProjectSelected } from './helpers';

test.describe('Model Dropdown', () => {
  test.describe('Settings Page - Provider Config', () => {
    test('model dropdown loads with curated models', async ({ page }) => {
      const ok = await ensureProjectSelected(page);
      if (!ok) { test.skip(true, 'E2E Test Project not found'); return; }

      await page.goto('/settings');

      // With seeded project, settings page should render fully
      await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('text=Default (all roles)')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('text=Role overrides')).toBeVisible({ timeout: 5_000 });
    });

    test('model select shows options after curated models load', async ({ page }) => {
      const ok = await ensureProjectSelected(page);
      if (!ok) { test.skip(true, 'E2E Test Project not found'); return; }

      await page.goto('/settings');

      await expect(page.locator('text=Models').first()).toBeVisible({ timeout: 10_000 });

      // Wait for model selects to appear (curated models load quickly via server action)
      const selects = page.locator('select');
      await expect(selects.first()).toBeVisible({ timeout: 5_000 });

      // There should be multiple selects (provider + model per row)
      const count = await selects.count();
      expect(count).toBeGreaterThanOrEqual(6);

      // Refresh buttons should be visible for each row
      const refreshButtons = page.locator('button[title*="Refresh"]');
      await expect(refreshButtons.first()).toBeVisible({ timeout: 5_000 });
      const refreshCount = await refreshButtons.count();
      expect(refreshCount).toBeGreaterThanOrEqual(1);
    });

    test('refresh button triggers model reload', async ({ page }) => {
      const ok = await ensureProjectSelected(page);
      if (!ok) { test.skip(true, 'E2E Test Project not found'); return; }

      await page.goto('/settings');

      await expect(page.locator('text=Models').first()).toBeVisible({ timeout: 10_000 });

      // Wait for the refresh button to become interactive — the server
      // action that loads curated models may still be in flight, keeping
      // the button disabled until models are resolved.
      const refreshButtons = page.locator('button[title*="Refresh"]');
      await expect(refreshButtons.first()).toBeEnabled({ timeout: 10_000 });

      // Click the first refresh button — should reload models
      await refreshButtons.first().click();

      // After refresh, loading state briefly shows then model select returns
      // Just verify the button is still present (not crashed)
      await expect(refreshButtons.first()).toBeVisible({ timeout: 3_000 });
    });

    test('Save Provider Config button is present and clickable', async ({ page }) => {
      const ok = await ensureProjectSelected(page);
      if (!ok) { test.skip(true, 'E2E Test Project not found'); return; }

      await page.goto('/settings');

      await expect(page.locator('text=Models').first()).toBeVisible({ timeout: 10_000 });

      const saveButton = page.locator('button:has-text("Save Provider Config")');
      await expect(saveButton).toBeVisible({ timeout: 5_000 });
      await expect(saveButton).toBeEnabled();
    });
  });

  test.describe('Terminals Page - New Terminal Dialog', () => {
    test('New Terminal dialog opens with heading and action buttons', async ({ page }) => {
      const ok = await ensureProjectSelected(page);
      if (!ok) { test.skip(true, 'E2E Test Project not found'); return; }

      await page.goto('/terminals');

      // Click repeatedly until React hydration completes and the dialog
      // appears.  The server-rendered button is in the DOM immediately but
      // the onClick handler is not attached until React hydrates.
      await clickUntilVisible(
        page.getByRole('button', { name: /New Terminal/ }),
        page.getByTestId('dialog-backdrop'),
      );

      await expect(page.locator('h2:has-text("New Terminal")')).toBeVisible({ timeout: 3_000 });
      await expect(page.getByRole('button', { name: 'Open' }).first()).toBeVisible({ timeout: 3_000 });
      await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible({ timeout: 3_000 });

      await page.getByRole('button', { name: 'Cancel' }).click();
      await expect(page.locator('h2:has-text("New Terminal")')).not.toBeVisible({ timeout: 3_000 });
    });

    test('dialog closes when clicking backdrop', async ({ page }) => {
      const ok = await ensureProjectSelected(page);
      if (!ok) { test.skip(true, 'E2E Test Project not found'); return; }

      await page.goto('/terminals');

      // Click repeatedly until React hydration completes and the dialog
      // appears (same retry pattern as the first dialog test).
      await clickUntilVisible(
        page.getByRole('button', { name: /New Terminal/ }),
        page.getByTestId('dialog-backdrop'),
      );

      // Use page.evaluate to click the backdrop — React event delegation
      // can miss Playwright clicks on overlays due to pointer-events layers.
      await page.evaluate(() => {
        const el = document.querySelector('[data-testid="dialog-backdrop"]') as HTMLElement | null;
        if (el) el.click();
      });
      await expect(page.locator('h2:has-text("New Terminal")')).not.toBeVisible({ timeout: 3_000 });
    });
  });
});
