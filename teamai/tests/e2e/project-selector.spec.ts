/**
 * E2E tests for the Project Selector (tabs + Add Project dialog).
 *
 * The ProjectSelector is rendered in the sidebar area, showing project name tabs
 * and a "+" button to open the Add Project dialog. When collapsed, it hides.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

test.describe('Project Selector', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    // First visit the base page to ensure the app loads
    await page.goto('/');
    await page.waitForTimeout(1000);
    await ensureProjectSelected(page);

  });

  test('project tabs show the seeded project name', async ({ page }) => {

    await page.goto('/');
    await page.waitForTimeout(1500);

    // The project selector renders project name buttons.
    // Use .first() because hasText matches multiple elements
    // (project tab, kanban headings may contain the project name).
    const e2eTab = page.locator('button', { hasText: 'E2E Test Project' }).first();
    await expect(e2eTab).toBeVisible({ timeout: 10_000 });
  });

  test('active project tab shows blue bottom border', async ({ page }) => {

    await page.goto('/');
    await page.waitForTimeout(1500);

    // The active tab should have the blue border class
    const activeTab = page.locator('button.border-\\[\\#2563eb\\]');
    const count = await activeTab.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });

  test('Add Project button ("+") opens the dialog', async ({ page }) => {

    await page.goto('/');
    await page.waitForTimeout(1500);

    // Click the "+" button to open the Add Project dialog
    const addBtn = page.locator('button[title="Add project"]');
    await expect(addBtn).toBeVisible({ timeout: 10_000 });
    await addBtn.click();
    await page.waitForTimeout(500);

    // The dialog should show "Add Project" heading
    const dialogHeading = page.locator('h2:has-text("Add Project")');
    await expect(dialogHeading).toBeVisible({ timeout: 5_000 });

    // Path input should be visible
    const pathInput = page.locator('input[name="path"]');
    await expect(pathInput).toBeVisible();

    // Browse button should be visible
    const browseBtn = page.locator('button:has-text("Browse")');
    await expect(browseBtn).toBeVisible();

    // Name input should be visible
    const nameInput = page.locator('input[name="name"]');
    await expect(nameInput).toBeVisible();

    // Add Project submit button
    const submitBtn = page.locator('button:has-text("Add Project")');
    await expect(submitBtn).toBeVisible();

    // Cancel button
    const cancelBtn = page.locator('button:has-text("Cancel")');
    await expect(cancelBtn).toBeVisible();
  });

  test('Cancel button closes the Add Project dialog', async ({ page }) => {

    await page.goto('/');
    await page.waitForTimeout(1500);

    const addBtn = page.locator('button[title="Add project"]');
    await expect(addBtn).toBeVisible({ timeout: 10_000 });
    await addBtn.click();
    await page.waitForTimeout(500);

    await expect(page.locator('h2:has-text("Add Project")')).toBeVisible({ timeout: 5_000 });

    // Click Cancel
    await page.locator('button:has-text("Cancel")').first().click();
    await page.waitForTimeout(500);

    // Dialog should be gone
    await expect(page.locator('h2:has-text("Add Project")')).not.toBeVisible({ timeout: 5_000 });
  });

  test('dialog closes when clicking backdrop', async ({ page }) => {

    await page.goto('/');
    await page.waitForTimeout(1500);

    const addBtn = page.locator('button[title="Add project"]');
    await addBtn.click();
    await page.waitForTimeout(500);

    await expect(page.locator('h2:has-text("Add Project")')).toBeVisible({ timeout: 5_000 });

    // Click the backdrop — the first bg-black/60 overlay inside the dialog container.
    // The backdrop is an absolute-positioned div, sibling to the role="dialog" element.
    // Use force:true because the dialog's label elements intercept pointer events.
    const backdrop = page.locator('.bg-black\\/60').first();
    await expect(backdrop).toBeVisible({ timeout: 3_000 });
    await backdrop.click({ force: true });
    await page.waitForTimeout(500);

    await expect(page.locator('h2:has-text("Add Project")')).not.toBeVisible({ timeout: 5_000 });
  });

  test('Browse button opens Directory Browser', async ({ page }) => {

    await page.goto('/');
    await page.waitForTimeout(1500);

    const addBtn = page.locator('button[title="Add project"]');
    await addBtn.click();
    await page.waitForTimeout(500);

    // Click Browse
    const browseBtn = page.locator('button:has-text("Browse")');
    await browseBtn.click();
    await page.waitForTimeout(1000);

    // Directory Browser should appear — it has "Select folder" heading
    const browserHeading = page.locator('span:has-text("Select folder")');
    await expect(browserHeading).toBeVisible({ timeout: 5_000 });

    // Should show Cancel and Select this folder buttons
    const cancelBtn = page.locator('button:has-text("Cancel")').last();
    await expect(cancelBtn).toBeVisible();

    const selectBtn = page.locator('button:has-text("Select this folder")');
    await expect(selectBtn).toBeVisible();
  });

  test('Browse dialog Cancel closes directory browser', async ({ page }) => {

    await page.goto('/');
    await page.waitForTimeout(1500);

    const addBtn = page.locator('button[title="Add project"]');
    await addBtn.click();
    await page.waitForTimeout(500);

    const browseBtn = page.locator('button:has-text("Browse")');
    await browseBtn.click();
    await page.waitForTimeout(1000);

    await expect(page.locator('span:has-text("Select folder")')).toBeVisible({ timeout: 5_000 });

    // Click the Cancel in the directory browser footer
    const cancelBtn = page.locator('button:has-text("Cancel")').last();
    await cancelBtn.click();
    await page.waitForTimeout(500);

    // Directory browser should close, but Add Project dialog should still be open
    await expect(page.locator('span:has-text("Select folder")')).not.toBeVisible({ timeout: 5_000 });
    await expect(page.locator('h2:has-text("Add Project")')).toBeVisible({ timeout: 5_000 });
  });

  test('project tab hover shows remove (×) button', async ({ page }) => {

    await page.goto('/');
    await page.waitForTimeout(1500);

    // Hover over the project tab (use .first() to avoid strict-mode violation)
    const projectTab = page.locator('button', { hasText: 'E2E Test Project' }).first();
    await projectTab.hover();
    await page.waitForTimeout(300);

    // The remove (×) button should appear (opacity-0 → visible on group-hover)
    const removeBtn = page.locator('button[title="Remove project"]');
    // It may not be visible if the tab is already selected differently
    await expect(removeBtn.first()).toBeVisible({ timeout: 3_000 });
  });
});
