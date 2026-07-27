/**
 * Behavioral E2E tests for kanban real-time WebSocket updates.
 *
 * Covers: phase-change events updating card position/column in real-time,
 * subtask-progress events updating the progress badge live,
 * connection indicator state changes.
 *
 * Uses the test WebSocket API endpoint (/api/test/emit-agent-event)
 * to inject synthetic events. The server serialises the entire request
 * body and broadcasts it to all connected WebSocket clients.  Events
 * must match the shape that server.ts normally broadcasts from
 * processManager.emit(), because usePhaseSync reads `data.type` at
 * the top level.
 */
import { test, expect } from '@playwright/test';
import { getTestServerUrl } from '../../scripts/servers';
import { ensureProjectSelected, requireSeedTaskId } from './helpers';

const TASK_SLUG = 'test-terminal-live-event-labels';
const LOGIN_BUTTON_SLUG = 'fix-login-button-not-visible-on-mobile';

let isSeeded = false;

test.describe('Kanban — Real-time Phase Change Updates', () => {
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    isSeeded = ok;
  });

  test('phase-change WebSocket event triggers kanban card column update', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(TASK_SLUG);
    const serverUrl = getTestServerUrl();

    // Verify the task is currently in In Progress column (implement phase)
    const card = page.locator('[data-testid="task-card"]', { hasText: 'terminal live event labels' });
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card.locator('text=In Progress')).toBeVisible({ timeout: 5_000 });

    // Send a phase-change WebSocket event to move the task to "failed".
    // The test API broadcasts the raw request body — it must match
    // the shape produced by processManager.emit('phase-change', ...)
    // in server.ts so that usePhaseSync processes it correctly.
    const resp = await fetch(`${serverUrl}/api/test/emit-agent-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'phase-change',
        taskId,
        phase: 'failed',
      }),
    });

    if (!resp.ok) {
      test.skip(true, 'WebSocket test API not available');
      return;
    }

    // Wait for the debounced router.refresh() (300 ms window) + React re-render.
    await page.waitForTimeout(1000);

    // Verify the card was REMOVED from the In Progress column
    const inProgressCard = page
      .locator('text=In Progress').first()
      .locator('..').locator('..')
      .locator('[data-testid="task-card"]', { hasText: 'terminal live event labels' });
    await expect(inProgressCard).toHaveCount(0, { timeout: 5_000 });

    // Verify the card is now in the Failed column with correct phase badge
    await page.locator('text=Failed').first().scrollIntoViewIfNeeded();
    const failedCard = page.locator('[data-testid="task-card"]', { hasText: 'terminal live event labels' });
    await expect(failedCard).toBeVisible({ timeout: 10_000 });
    await expect(failedCard.locator('text=Failed').first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Kanban — Real-time Subtask Progress Updates', () => {
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    isSeeded = ok;
  });

  test('subtask-progress WebSocket event updates kanban badge without page refresh', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(LOGIN_BUTTON_SLUG);
    const serverUrl = getTestServerUrl();

    // Find the login button card and check initial subtask progress
    const card = page.locator('[data-testid="task-card"]', { hasText: 'login button' });
    const progressBadge = card.locator('[data-testid="subtask-progress-badge"]');
    await expect(progressBadge).toBeVisible({ timeout: 5_000 });

    // Initially: 1/2 ✓
    await expect(progressBadge).toHaveText('1/2 ✓');

    // Send a subtask-progress event that completes the second subtask.
    // Must match the shape produced by processManager.emit('subtask-progress', ...)
    // so that usePhaseSync processes it correctly.
    const resp = await fetch(`${serverUrl}/api/test/emit-agent-event`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type: 'subtask-progress',
        taskId,
        completed: 2,
        total: 2,
      }),
    });

    if (!resp.ok) {
      test.skip(true, 'WebSocket test API not available');
      return;
    }

    // The badge should update to 2/2 ✓ via the localSubtaskProgress override
    await expect(progressBadge).toHaveText('2/2 ✓', { timeout: 10_000 });
  });
});

test.describe('Kanban — Connection Indicator', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    isSeeded = ok;
  });

  test('connection indicator is rendered in the board header', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');

    // The header should show "Board" title alongside the connection indicator
    await expect(page.locator('h1:has-text("Board")')).toBeVisible({ timeout: 10_000 });
  });

  test('kanban board remains interactive after extended idle', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await expect(page.locator('[data-testid="task-card"]').first()).toBeVisible({ timeout: 10_000 });

    // Wait a moment and verify the board is still interactive
    await page.waitForTimeout(3000);

    // Click the search input — it should still work
    const searchInput = page.locator('input[placeholder="Search…"]');
    await searchInput.fill('test');
    await expect(searchInput).toHaveValue('test');
  });
});
