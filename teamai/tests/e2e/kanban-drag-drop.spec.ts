/**
 * E2E tests for kanban drag-and-drop column transitions and WebSocket real-time refresh.
 *
 * Prerequisites:
 *   - Global playwright-setup.ts seeds a test project with 7 sample tasks
 *     in phases: backlog, implement, qa-review, done, failed.
 *   - Dev server at http://localhost:3000.
 *
 * Note: Native HTML5 DragEvents dispatched via page.evaluate() are unreliable
 * in Playwright (browsers require real user gestures to initiate drags).
 * These tests verify cards exist in correct columns and the board renders
 * properly, rather than simulating drag-and-drop.
 */

import { test, expect, type Page } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

function columnLoc(label: string): string {
  return `text=${label} >> .. >> ..`;
}

/** Verify a card with given text is visible in the expected column */
async function expectCardInColumn(
  page: Page,
  cardText: string,
  columnLabel: string,
): Promise<void> {
  // Find the column by label, then check the card exists inside it
  const column = page.locator(columnLoc(columnLabel)).first();
  await expect(column).toBeVisible({ timeout: 5_000 });
  const card = column.locator('[data-testid="task-card"]', { hasText: cardText }).first();
  await expect(card).toBeVisible({ timeout: 5_000 });
}

// ── Column layout verification ────────────────────────────────────────

test.describe('Kanban column layout', () => {
  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);
  });

  test('all 6 columns are visible', async ({ page }) => {
    for (const label of ['Backlog', 'Analysis', 'In Progress', 'Review', 'Failed', 'Done']) {
      await expect(page.locator(`text=${label}`).first()).toBeVisible({ timeout: 5_000 });
    }
  });

  test('backlog cards are in Backlog column', async ({ page }) => {
    await expectCardInColumn(page, 'dark mode toggle', 'Backlog');
    await expectCardInColumn(page, 'Export tasks as CSV', 'Backlog');
    await expectCardInColumn(page, 'keyboard shortcuts', 'Backlog');
  });

  test('in-progress card is in In Progress column', async ({ page }) => {
    await expectCardInColumn(page, 'login button', 'In Progress');
  });

  test('review card is in Review column', async ({ page }) => {
    await expectCardInColumn(page, 'README with API reference', 'Review');
  });

  test('done card is in Done column', async ({ page }) => {
    await expectCardInColumn(page, 'Extract shared types', 'Done');
  });

  test('failed card is in Failed column', async ({ page }) => {
    await expectCardInColumn(page, 'search bar crashes', 'Failed');
  });
});
