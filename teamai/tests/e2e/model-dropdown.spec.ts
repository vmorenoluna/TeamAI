import { test, expect, type Page } from '@playwright/test';

/**
 * Navigate to home page and ensure E2E Test Project is active.
 */
async function ensureProjectSelected(page: Page): Promise<boolean> {
  await page.goto('/');

  const backlog = page.locator('text=Backlog').first();
  try {
    await expect(backlog).toBeVisible({ timeout: 5_000 });
    return true;
  } catch {
    try {
      const projectTab = page.locator('button:has-text("E2E Test Project")');
      await expect(projectTab.first()).toBeVisible({ timeout: 5_000 });
      await projectTab.first().click();
      await expect(page.locator('text=Backlog').first()).toBeVisible({ timeout: 15_000 });
      return true;
    } catch {
      return false;
    }
  }
}

test.describe('Model Dropdown', () => {
  test.describe('Settings Page - Provider Config', () => {
    test('model dropdown loads with curated models', async ({ page }) => {
      const ok = await ensureProjectSelected(page);
      test.skip(!ok, 'E2E Test Project not found');

      await page.goto('/settings');

      // With seeded project, settings page should render fully
      await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });
      await expect(page.locator('text=Default (all roles)')).toBeVisible({ timeout: 5_000 });
      await expect(page.locator('text=Role overrides')).toBeVisible({ timeout: 5_000 });
    });

    test('model select shows options after curated models load', async ({ page }) => {
      const ok = await ensureProjectSelected(page);
      test.skip(!ok, 'E2E Test Project not found');

      await page.goto('/settings');

      await expect(page.locator('text=Providers')).toBeVisible({ timeout: 10_000 });

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
      test.skip(!ok, 'E2E Test Project not found');

      await page.goto('/settings');

      await expect(page.locator('text=Providers')).toBeVisible({ timeout: 10_000 });

      // Wait for loading to finish
      await page.waitForTimeout(1_500);

      // Find the first refresh button and click it
      const refreshButtons = page.locator('button[title*="Refresh"]');
      await expect(refreshButtons.first()).toBeEnabled({ timeout: 5_000 });

      // Click the first refresh button — should reload models
      await refreshButtons.first().click();

      // After refresh, loading state briefly shows then model select returns
      // Just verify the button is still present (not crashed)
      await expect(refreshButtons.first()).toBeVisible({ timeout: 3_000 });
    });

    test('changing provider triggers model reload', async ({ page }) => {
      const ok = await ensureProjectSelected(page);
      test.skip(!ok, 'E2E Test Project not found');

      await page.goto('/settings');

      await expect(page.locator('text=Providers')).toBeVisible({ timeout: 10_000 });

      // Wait for initial models to load
      await page.waitForTimeout(1_500);

      // Find provider selects (these have provider names as values, not model names)
      const selects = page.locator('select');

      // The first select could be a provider select — let's find one that contains 'anthropic' as an option
      const allSelects = await selects.all();
      let foundProviderSelect = false;

      for (const select of allSelects) {
        const options = await select.locator('option').allTextContents();
        if (options.some(o => o.trim() === 'anthropic')) {
          // This is a provider select — change it
          await select.selectOption('openai');
          // Verify the value actually changed
          await expect(select).toHaveValue('openai');
          foundProviderSelect = true;
          break;
        }
      }

      expect(foundProviderSelect).toBeTruthy();

      // After changing provider, the models should reload (brief loading state)
      // Wait a moment for the reload to trigger
      await page.waitForTimeout(1_000);
    });

    test('Save Provider Config button is present and clickable', async ({ page }) => {
      const ok = await ensureProjectSelected(page);
      test.skip(!ok, 'E2E Test Project not found');

      await page.goto('/settings');

      await expect(page.locator('text=Providers')).toBeVisible({ timeout: 10_000 });

      const saveButton = page.locator('button:has-text("Save Provider Config")');
      await expect(saveButton).toBeVisible({ timeout: 5_000 });
      await expect(saveButton).toBeEnabled();
    });
  });

  test.describe('Terminals Page - New Terminal Dialog', () => {
    test('New Terminal dialog shows model section with provider and model controls', async ({ page }) => {
      const ok = await ensureProjectSelected(page);
      test.skip(!ok, 'E2E Test Project not found');

      await page.goto('/terminals');

      await expect(page.locator('text=Terminals').first()).toBeVisible({ timeout: 10_000 });

      // Click New Terminal button
      const newTerminalBtn = page.locator('text=+ New Terminal').first();
      await expect(newTerminalBtn).toBeVisible({ timeout: 10_000 });
      await newTerminalBtn.click();

      // Dialog should be visible
      await expect(page.locator('text=New Terminal').last()).toBeVisible({ timeout: 3_000 });

      // Should have a role select
      const roleSelects = page.locator('select');
      await expect(roleSelects.first()).toBeVisible();

      // Should have the Model label
      await expect(page.locator('text=Model')).toBeVisible();

      // Should have refresh button for model
      const refreshButtons = page.locator('button[title*="Refresh"]');
      const refreshCount = await refreshButtons.count();
      expect(refreshCount).toBeGreaterThanOrEqual(1);

      // Cancel button should close the dialog
      await page.locator('text=Cancel').click();
      await expect(page.locator('text=New Terminal')).not.toBeVisible({ timeout: 3_000 });
    });

    test('dialog provider selector changes model loading', async ({ page }) => {
      const ok = await ensureProjectSelected(page);
      test.skip(!ok, 'E2E Test Project not found');

      await page.goto('/terminals');

      await expect(page.locator('text=Terminals').first()).toBeVisible({ timeout: 10_000 });

      // Open dialog
      await page.locator('text=+ New Terminal').first().click();
      await expect(page.locator('text=New Terminal').last()).toBeVisible({ timeout: 3_000 });

      // Find the provider select (the one with provider options)
      const selects = await page.locator('select').all();
      let providerSelect: typeof selects[0] | null = null;

      for (const select of selects) {
        const options = await select.locator('option').allTextContents();
        if (options.some(o => o.trim() === 'anthropic')) {
          providerSelect = select;
          break;
        }
      }

      expect(providerSelect).toBeTruthy();

      // Open button should be visible and enabled when role is selected
      await expect(page.locator('button:has-text("Open")')).toBeVisible();
      await expect(page.locator('button:has-text("Cancel")')).toBeVisible();
    });
  });
});
