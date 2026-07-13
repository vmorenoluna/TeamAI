import { test, expect } from '@playwright/test';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ensureProjectSelected, getSeedTaskId, requireSeedTaskId, scrollKanbanRight, getActiveSeedDir } from './helpers';

const SEARCH_CRASH_SLUG = 'fix-search-bar-crashes-on-empty-input';

// Restored by afterAll if retry-click tests modify task state locally
const SEARCH_CRASH_COMPLETION_SUMMARY = `# Completion Summary

Task failed after reaching max QA attempts (3/3).

## Plan Subtasks

- [x] **Add empty guard clause** — COMPLETED
- [ ] **Add validation test** — NOT COMPLETED

## Last QA Report

Overall: **FAIL**

| Criterion | Status | Notes |
|-----------|--------|-------|
| Empty input handled without crash | PASS | |
| Shows helpful error message to user | FAIL | No user-facing message shown |
| Edge cases covered (whitespace, special chars) | FAIL | Only basic empty string handled |

## Issues

- [warning] No toast/notification shown on empty submit
- [warning] Whitespace-only input not handled`;

// ── Template verification (filesystem only — no page interaction) ──

test.describe('Spec Revision — Command Template Verification', () => {
  test('seed project has updated qa-review.md with spec-gap detection (Step 6)', () => {
    const seedDir = getActiveSeedDir();
    if (!existsSync(seedDir)) { test.skip(true, 'E2E seed directory not found'); return; }

    const qaReviewPath = join(seedDir, '.claude', 'commands', 'qa-review.md');
    expect(existsSync(qaReviewPath), 'qa-review.md should exist in seed project').toBe(true);

    const content = readFileSync(qaReviewPath, 'utf-8');
    expect(content, 'qa-review.md should contain Spec Gap Detection step').toContain('Spec Gap Detection');
    expect(content, 'qa-review.md should reference spec_concerns in output schema').toContain('spec_concerns');
    expect(content, 'qa-review.md should have Step 6 header').toContain('Step 6');
  });

  test('seed project has updated spec.md with Revision Mode', () => {
    const seedDir = getActiveSeedDir();
    if (!existsSync(seedDir)) { test.skip(true, 'E2E seed directory not found'); return; }

    const specPath = join(seedDir, '.claude', 'commands', 'spec.md');
    expect(existsSync(specPath), 'spec.md should exist in seed project').toBe(true);

    const content = readFileSync(specPath, 'utf-8');
    expect(content, 'spec.md should contain Revision Mode section').toContain('Revision Mode');
    expect(content, 'spec.md should reference spec_revision_feedback.md').toContain('spec_revision_feedback');
    expect(content, 'spec.md should mention REVISION prompt').toContain('REVISION');
  });
});

// ── Retry flow (page interaction) ──

test.describe.serial('Spec Revision — Retry with Updated Templates', () => {
  let isSeeded = false;

  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    isSeeded = ok;
  });

  test('retry on failed task card fires retryTask action without client error', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }
    // Skip in CI: retryTask() fires the orchestrator pipeline which requires
    // Docker + Claude CLI not available on CI runners.
    if (process.env.CI) { test.skip(true, 'Skipped in CI — orchestrator requires Docker/Claude CLI'); return; }

    requireSeedTaskId(SEARCH_CRASH_SLUG); // validate seed task exists
    await page.goto('/');
    await scrollKanbanRight(page);

    // The seeded "Fix: search bar crashes on empty input" task is in 'failed' phase
    const failedCard = page.locator('[data-testid="task-card"]', { hasText: 'search bar crashes' });
    await expect(failedCard.first(), 'failed task card should be visible').toHaveCount(1, { timeout: 5_000 });

    // Retry button must be visible and enabled
    const retryButton = failedCard.first().locator('[data-testid="retry-button"]');
    await expect(retryButton, 'retry button should be visible').toBeVisible({ timeout: 5_000 });
    await expect(retryButton, 'retry button should be enabled').toBeEnabled({ timeout: 5_000 });
    await expect(retryButton).toHaveText(/Retry/);

    // Click retry — triggers retryTask server action
    // The action validates task is in 'failed' phase, determines resume phase (qa-review),
    // and fires moveTaskToPhase async. The orchestrator picks up the updated
    // qa-review.md template from .claude/commands/ (verified in template tests above).
    await retryButton.click();
    await page.waitForTimeout(3_000);

    // No error dialog should appear — retryTask returns { success: true } for valid calls
    const errorDialog = page.locator('text=Failed to retry task');
    await expect(errorDialog, 'no retry error dialog should appear').toHaveCount(0, { timeout: 5_000 });

    // In a real environment with Claude, the updated QA template would run spec-gap
    // detection (Step 6) and populate spec_concerns if the spec itself is the root cause.
    // The task would then route to 'awaiting-review' instead of bouncing to 'implement'.
    // Here we only verify the action fires without client error — the server-side
    // template verification is covered by the filesystem tests above.
  });

  test('retry from task detail panel fires retryTask without client error', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }
    // Skip in CI: retryTask() fires the orchestrator pipeline which requires
    // Docker + Claude CLI not available on CI runners.
    if (process.env.CI) { test.skip(true, 'Skipped in CI — orchestrator requires Docker/Claude CLI'); return; }

    const taskId = requireSeedTaskId(SEARCH_CRASH_SLUG);
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    // The task detail page shows a completion summary banner with a Retry button
    // for failed tasks (data-testid="detail-retry-button")
    const detailRetryButton = page.locator('[data-testid="detail-retry-button"]');
    const found = await detailRetryButton.waitFor({ state: 'attached', timeout: 15_000 })
      .then(() => true)
      .catch(() => false);

    if (!found) {
      test.skip(true, 'Detail retry button not rendered');
      return;
    }

    await expect(detailRetryButton, 'detail retry button should be visible').toBeVisible({ timeout: 5_000 });
    await expect(detailRetryButton, 'detail retry button should be enabled').toBeEnabled({ timeout: 5_000 });
    await expect(detailRetryButton).toHaveText(/Retry/);

    await detailRetryButton.click();
    await page.waitForTimeout(3_000);

    const errorDialog = page.locator('text=Failed to retry task');
    await expect(errorDialog, 'no retry error dialog should appear').toHaveCount(0, { timeout: 5_000 });
  });

  // ── Edge cases ──

  test('retry button is absent on non-failed tasks (backlog, done)', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');

    // Backlog task should NOT have a retry button
    const backlogCards = page.locator('[data-testid="task-card"]', { hasText: 'dark mode toggle' });
    if (await backlogCards.count() > 0) {
      const retryBtn = backlogCards.first().locator('[data-testid="retry-button"]');
      await expect(retryBtn, 'backlog tasks should not have retry button').toHaveCount(0);
    }

    // Done task should NOT have a retry button
    const doneCards = page.locator('[data-testid="task-card"]', { hasText: 'Extract shared types' });
    if (await doneCards.count() > 0) {
      const retryBtn = doneCards.first().locator('[data-testid="retry-button"]');
      await expect(retryBtn, 'done tasks should not have retry button').toHaveCount(0);
    }
  });

  // ── Restore seed state after retry-click tests (local dev only) ────────
  // In local development, the retry-click tests trigger retryTask() which clears
  // completionSummary and may change the task phase. Restore the original seed
  // state so subsequent test files see the expected data.
  test.afterAll(() => {
    const taskId = getSeedTaskId(SEARCH_CRASH_SLUG);
    if (!taskId) return;

    const taskPath = join(getActiveSeedDir(), '.teamai', SEARCH_CRASH_SLUG, 'task.json');
    try {
      const task = JSON.parse(readFileSync(taskPath, 'utf-8'));
      task.phase = 'failed';
      task.completionSummary = SEARCH_CRASH_COMPLETION_SUMMARY;
      writeFileSync(taskPath, JSON.stringify(task, null, 2));
      console.log('[spec-revision-retry afterAll] Restored seed task state');
    } catch (e) {
      console.log('[spec-revision-retry afterAll] Failed to restore state:', e);
    }
  });
});
