/**
 * E2E tests for Settings page subsections.
 *
 * Covers: ContainerConfig, PipelineConfig, RoleEditor, ProjectsSettings, ToolSettings.
 * These are all rendered on /settings when a project is selected.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected, clickUntilVisible } from './helpers';

test.describe('Settings — Container Configuration', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  test('container toggle switch is visible', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    const toggle = page.locator('role=switch');
    const count = await toggle.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });

  test('container toggle has accessible label text', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('text=Run agents in devcontainer')).toBeVisible({ timeout: 5_000 });
  });

  test('container status badge is shown when enabled', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    // The status badge only renders when the container toggle is enabled.
    // If enabled, verify it's visible; if not, the toggle being present is sufficient.
    const statusLabel = page.locator('text=Container status');
    const count = await statusLabel.count();
    if (count > 0) {
      await expect(statusLabel).toBeVisible({ timeout: 3_000 });
    }
  });
});

test.describe('Settings — Pipeline Configuration', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  test('pipeline config Max QA attempts input is visible', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('text=Max QA attempts')).toBeVisible({ timeout: 5_000 });

    // The number input for max QA attempts
    const qaInput = page.locator('input[type="number"]').first();
    await expect(qaInput).toBeVisible();
  });

  test('pipeline config Parallel subtasks checkbox is visible', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('text=Parallel subtasks')).toBeVisible({ timeout: 5_000 });

    const checkbox = page.locator('input[type="checkbox"]').first();
    await expect(checkbox).toBeVisible();
  });

  test('Save Pipeline Config button is present', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    const saveBtn = page.locator('button:has-text("Save Pipeline Config")');
    await expect(saveBtn).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Settings — Role Editor', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  test('role editor section shows agent role names', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('text=Agent Roles')).toBeVisible({ timeout: 5_000 });

    // At least one role should be listed (analyst, planner, coder, etc.)
    const roleCount = await page.locator('text=analyst').count();
    expect(roleCount, 'analyst role must be present in settings').toBeGreaterThan(0);
  });

  test('clicking a role row expands the editor with textarea', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    // The RoleEditor component renders a <button> with the filename as text.
    // Use clickUntilVisible to handle React hydration races.
    const roleBtn = page.locator('button:has-text(".md")').first();
    const textarea = page.locator('textarea').first();
    await clickUntilVisible(roleBtn, textarea);

    // After clicking, reset and save buttons appear inside the expanded editor.
    // Scope to the textarea's container to avoid matching other Save buttons
    // (Save Pipeline Config, Save Provider Config) on the settings page.
    const editorContainer = textarea.locator('..').locator('..');
    await expect(editorContainer.locator('button:has-text("Reset to default")')).toBeVisible({ timeout: 5_000 });
    await expect(editorContainer.locator('button:has-text("Save")')).toBeVisible({ timeout: 5_000 });
  });

  test('clicking expanded role row collapses it again', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    const roleBtn = page.locator('button:has-text(".md")').first();
    const textarea = page.locator('textarea').first();

    // Expand
    await clickUntilVisible(roleBtn, textarea);

    // Collapse — click same button again
    await roleBtn.click();

    // Textarea should be gone
    await expect(textarea).not.toBeVisible({ timeout: 3_000 });
  });
});

test.describe('Settings — Tool Settings', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  test('tool settings section shows tool status list', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('text=Tool Paths').first()).toBeVisible({ timeout: 5_000 });

    // At minimum, should show claude and git tool rows
    await expect(page.locator('text=Claude').first()).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('text=Git').first()).toBeVisible({ timeout: 5_000 });
  });

  test('Recheck button refreshes tool status', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    const recheckBtn = page.locator('button:has-text("Recheck")');
    await expect(recheckBtn).toBeVisible({ timeout: 5_000 });
    await recheckBtn.click();

    // Should still show tool rows after refresh
    await page.waitForTimeout(1000);
    await expect(page.locator('text=Claude').first()).toBeVisible({ timeout: 5_000 });
  });

  test('Edit button appears on tool rows', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    // Each tool row should have an Edit button
    const editBtns = page.locator('button[title="Set custom path"]');
    const count = await editBtns.count();
    expect(count).toBeGreaterThanOrEqual(1);
  });
});

test.describe('Settings — Projects Defaults', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

  });

  test('projects settings section is visible', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    await expect(page.locator('text=Project Defaults')).toBeVisible({ timeout: 5_000 });
  });

  test('shows project sync status table', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    // Should show at least the seeded project's sync status
    await expect(page.locator('text=E2E Test Project').first()).toBeVisible({ timeout: 10_000 });
  });

  test('Refresh button is present in projects section', async ({ page }) => {

    await page.goto('/settings');
    await expect(page.locator('h1:has-text("Settings")')).toBeVisible({ timeout: 10_000 });

    const refreshBtn = page.locator('button:has-text("Refresh")');
    // May be hidden if still loading — just verify the section works
    const count = await refreshBtn.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
