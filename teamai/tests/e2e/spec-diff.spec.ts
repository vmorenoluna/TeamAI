/**
 * E2E tests for the Spec Diff View component.
 *
 * SpecDiffView renders a side-by-side comparison between spec versions.
 * It appears in the task detail page when viewing a task that has had
 * its spec revised (multiple spec_v{N}.md files exist).
 *
 * The seed script (seed.ts) gives the `docs-update-readme-with-api-reference`
 * task a deterministic revision history: spec_v1.md (pre-revision) on disk
 * plus a revised live spec.md. getTaskFull merges the live spec as v2, so
 * the compare toggle and both selectors are guaranteed to render.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected, requireSeedTaskId } from './helpers';

const TASK_SLUG = 'docs-update-readme-with-api-reference';

test.describe('Spec Diff View', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);
  });

  async function openSpecTab(page: import('@playwright/test').Page) {
    const taskId = requireSeedTaskId(TASK_SLUG);
    await page.goto(`/task/${taskId}`);
    await page.getByRole('button', { name: /^Spec/ }).click();
  }

  test('task detail page shows Compare toggle when spec versions exist', async ({ page }) => {
    await openSpecTab(page);

    await expect(page.locator('[data-component="compare-toggle"]')).toBeVisible();
  });

  test('compare selectors offer the archived version and the live spec', async ({ page }) => {
    await openSpecTab(page);
    await page.locator('[data-component="compare-toggle"]').click();

    const leftSelect = page.locator('[data-component="compare-left-select"]');
    const rightSelect = page.locator('[data-component="compare-right-select"]');
    await expect(leftSelect).toBeVisible();
    await expect(rightSelect).toBeVisible();

    // v1 = archived spec_v1.md snapshot; v2 = the live (revised) spec.md
    // merged in by getTaskFull as the highest version.
    await expect(leftSelect.locator('option')).toHaveText(['v1', 'v2']);
    await expect(rightSelect.locator('option')).toHaveText(['v1', 'v2']);

    // Auto-initialization picks the two most recent versions:
    // predecessor (v1) vs current (v2).
    await expect(leftSelect).toHaveValue('v1');
    await expect(rightSelect).toHaveValue('v2');
  });

  test('diff view shows the pre-revision and revised spec side by side', async ({ page }) => {
    await openSpecTab(page);
    await page.locator('[data-component="compare-toggle"]').click();

    // The revised spec added the DELETE endpoint line — it must appear as an
    // added line on the right side only.
    const addedLine = page.locator('[data-component^="diff-right-"]', { hasText: 'DELETE /api/tasks/:id' });
    await expect(addedLine.first()).toBeVisible();

    const addedText = addedLine.first().locator('.text-green-400');
    await expect(addedText).toHaveText('+ - `DELETE /api/tasks/:id`');
  });

  test('selecting v1 vs v2 shows the changelog only on the right', async ({ page }) => {
    await openSpecTab(page);
    await page.locator('[data-component="compare-toggle"]').click();

    // The changelog section exists only in the revised (v2, live) spec.
    const rightChangelog = page.locator('[data-component^="diff-right-"]', { hasText: '## Changelog' });
    await expect(rightChangelog.first()).toBeVisible();

    const leftChangelog = page.locator('[data-component^="diff-left-"]', { hasText: '## Changelog' });
    await expect(leftChangelog).toHaveCount(0);
  });

  test('spec tab badge counts merged versions (snapshot + live spec = 2)', async ({ page }) => {
    const taskId = requireSeedTaskId(TASK_SLUG);
    await page.goto(`/task/${taskId}`);

    // The badge counts viewable versions — 1 snapshot + 1 live spec — not
    // files (the old 1 + N formula would have shown 3 here).
    const specTab = page.getByRole('button', { name: /^Spec/ });
    await expect(specTab.locator('span')).toHaveText('2');
  });

  test('version chips show v1 and v2 with the live spec shown by default', async ({ page }) => {
    await openSpecTab(page);

    // Version chips render for every merged version entry.
    await expect(page.getByRole('button', { name: 'v1', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'v2', exact: true })).toBeVisible();

    // Default view is the live spec (no version chip selected) — the revised
    // changelog heading proves the right content is on display.
    await expect(page.locator('pre')).toContainText('Revised after QA flagged the missing DELETE endpoint');
  });
});
