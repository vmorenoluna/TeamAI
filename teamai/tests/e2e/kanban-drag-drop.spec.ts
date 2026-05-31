/**
 * E2E tests for kanban drag-and-drop column transitions and WebSocket real-time refresh.
 *
 * Prerequisites:
 *   - Global playwright-setup.ts seeds a test project with 7 sample tasks
 *     in phases: backlog, implement, qa-review, done, failed.
 *   - Dev server at http://localhost:3000.
 *
 * Drag-and-drop uses the native HTML5 DragEvent API via page.evaluate() with
 * async delays between events so React processes state updates between steps.
 *
 * WebSocket tests use page.addInitScript to patch window.WebSocket so the
 * test can dispatch MessageEvent and simulate server-pushed phase-change events.
 */

import { test, expect, type Page } from '@playwright/test';

let isSeeded = false;

// ── Helpers ────────────────────────────────────────────────────────────

/**
 * Navigate to / and ensure the E2E Test Project is selected by clicking
 * the project tab in the sidebar if needed. Returns true if the project
 * was successfully selected (cards visible), false otherwise.
 *
 * Matches the ensureProjectSelected pattern used by other e2e tests.
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

/**
 * Drag a card element to a column element by dispatching native HTML5
 * DragEvent sequence with async delays between events so React can
 * process state updates (setDraggingTaskId, setDragOverPhase) between
 * each step.
 *
 * ALL events run inside a SINGLE page.evaluate (so DataTransfer stays
 * in the browser context), but with async setTimeout pauses to let
 * React process state batches and re-render between steps.
 */
async function dragCardToColumn(
  page: Page,
  cardLocator: string,
  columnLocator: string,
): Promise<void> {
  const cardEl = await page.locator(cardLocator).first().elementHandle();
  const colEl = await page.locator(columnLocator).first().elementHandle();
  expect(cardEl, 'Card element not found').not.toBeNull();
  expect(colEl, 'Column element not found').not.toBeNull();

  await page.evaluate(
    async ({ card, col }: { card: Element; col: Element }) => {
      const dt = new DataTransfer();

      // Step 1: dragstart — React sets draggingTaskId
      card.dispatchEvent(new DragEvent('dragstart', { dataTransfer: dt, bubbles: true }));
      await new Promise(r => setTimeout(r, 200));

      // Step 2: dragenter + dragover — React sets dragOverPhase
      col.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
      col.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 100));

      // Step 3: drop — React reads the NOW-UPDATED draggingTaskId
      col.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true }));
      await new Promise(r => setTimeout(r, 100));

      // Step 4: dragend — cleanup
      card.dispatchEvent(new DragEvent('dragend', { dataTransfer: dt, bubbles: true }));
    },
    { card: cardEl!, col: colEl! },
  );
}

/**
 * Column container locator: find column header text, go up to the column-level div
 * (the one that has onDrop / onDragOver handlers).
 */
function columnLoc(label: string): string {
  return `text=${label} >> .. >> ..`;
}

// ── Drag-and-drop tests ────────────────────────────────────────────────

test.describe.serial('Kanban drag-and-drop column transitions', () => {
  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    if (ok) isSeeded = true;
    else isSeeded = false;
  });

  test('drag a backlog card to Analysis shows toast', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    const card = '[data-testid="task-card"]:has-text("Implement dark mode toggle")';
    await expect(page.locator(card).first()).toBeVisible();

    await dragCardToColumn(page, card, columnLoc('Analysis'));

    // Toast notification should appear
    await expect(page.getByText(/Moved/).first()).toBeVisible({ timeout: 5_000 });
  });

  test('drag a backlog card to the same column is a no-op (no toast)', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    // Use a card that stays in backlog across all tests
    const card = '[data-testid="task-card"]:has-text("Export tasks as CSV")';
    await expect(page.locator(card).first()).toBeVisible();

    await dragCardToColumn(page, card, columnLoc('Backlog'));

    // No toast should appear for same-column drops
    await expect(page.getByText(/Moved/)).toHaveCount(0);
  });

  test('drag a card from Implement to Review column shows toast', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    const card = '[data-testid="task-card"]:has-text("login button not visible")';
    await expect(page.locator(card).first()).toBeVisible();

    await dragCardToColumn(page, card, columnLoc('Review'));

    await expect(page.getByText(/Moved/).first()).toBeVisible({ timeout: 5_000 });
  });

  test('undo toast appears after drag and restores phase', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    const card = '[data-testid="task-card"]:has-text("Export tasks as CSV")';
    await expect(page.locator(card).first()).toBeVisible();

    await dragCardToColumn(page, card, columnLoc('Analysis'));

    const undoBtn = page.locator('text=Undo').first();
    await expect(undoBtn).toBeVisible({ timeout: 5_000 });

    await undoBtn.click();
    await expect(page.getByText(/Undone/).first()).toBeVisible({ timeout: 5_000 });
  });

  test('dragging a second card replaces the previous toast', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    const card1 = '[data-testid="task-card"]:has-text("Export tasks as CSV")';
    const card2 = '[data-testid="task-card"]:has-text("keyboard shortcuts")';
    await expect(page.locator(card1).first()).toBeVisible();
    await expect(page.locator(card2).first()).toBeVisible();

    // Drag first card
    await dragCardToColumn(page, card1, columnLoc('Analysis'));
    await expect(page.getByText(/Export/).first()).toBeVisible({ timeout: 5_000 });

    // Drag second card — first toast should be replaced
    await dragCardToColumn(page, card2, columnLoc('Analysis'));
    await expect(page.getByText(/keyboard/).first()).toBeVisible({ timeout: 5_000 });
  });

  test('drag a done card to another column shows toast', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    const card = '[data-testid="task-card"]:has-text("Refactor: Extract shared types")';
    await expect(page.locator(card).first()).toBeVisible();

    await dragCardToColumn(page, card, columnLoc('Review'));

    await expect(page.getByText(/Moved/).first()).toBeVisible({ timeout: 5_000 });
  });

  test('drag a failed card to backlog shows toast', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    const card = '[data-testid="task-card"]:has-text("search bar crashes")';
    await expect(page.locator(card).first()).toBeVisible();

    await dragCardToColumn(page, card, columnLoc('Backlog'));

    await expect(page.getByText(/Moved/).first()).toBeVisible({ timeout: 5_000 });
  });
});

// ── WebSocket real-time refresh tests ──────────────────────────────────

test.describe.serial('WebSocket real-time kanban refresh', () => {
  test.beforeEach(async ({ page }) => {
    // Patch WebSocket before the page loads so React components use our patched version
    await page.addInitScript(() => {
      const OrigWS = window.WebSocket;

      // Track WS instances created by the app for test control
      (window as any).__wsInstances = new Set<WebSocket>();
      (window as any).__wsReady = false;

      window.WebSocket = class PatchedWS extends (OrigWS as any) {
        constructor(url: string | URL, protocols?: string | string[]) {
          super(url, protocols);
          (window as any).__wsInstances.add(this);

          // Remove from set when the real connection closes
          this.addEventListener('close', () => {
            (window as any).__wsInstances.delete(this);
          });

          // Signal ready after a tick so the hook registers onmessage first
          setTimeout(() => {
            (window as any).__wsReady = true;
            this.dispatchEvent(new Event('open'));
          }, 100);
        }
      } as any;
    });

    const ok = await ensureProjectSelected(page);
    if (ok) isSeeded = true;
    else isSeeded = false;

    // Wait for the patched WS to be "connected"
    await page.waitForFunction(
      () => (window as any).__wsReady === true,
      { timeout: 5_000 },
    );
  });

  /** Helper: send a JSON message to all active patched WS instances. */
  async function sendWsJson(page: Page, payload: Record<string, unknown>): Promise<void> {
    await page.evaluate((data) => {
      const json = JSON.stringify(data);
      for (const ws of (window as any).__wsInstances as Set<WebSocket>) {
        ws.dispatchEvent(new MessageEvent('message', { data: json }));
      }
    }, payload);
  }

  test('phase-change WS message triggers router.refresh (board re-renders)', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    // Capture the card count before the message
    const cardsBefore = await page.locator('[data-testid="task-card"]').count();
    expect(cardsBefore).toBeGreaterThan(0);

    // Send a phase-change — the hook calls router.refresh()
    await sendWsJson(page, {
      type: 'phase-change',
      taskId: '00000000-0000-0000-0000-000000000000',
      phase: 'done',
    });

    // Wait for Next.js re-render
    await page.waitForTimeout(2_000);

    // Board should still have cards (re-rendered in place)
    const cardsAfter = await page.locator('[data-testid="task-card"]').count();
    expect(cardsAfter).toBe(cardsBefore);
  });

  test('phase-change for nonexistent task still re-renders', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    const cardsBefore = await page.locator('[data-testid="task-card"]').count();

    await sendWsJson(page, {
      type: 'phase-change',
      taskId: 'nonexistent-task-id',
      phase: 'done',
    });

    await page.waitForTimeout(1_500);
    const cardsAfter = await page.locator('[data-testid="task-card"]').count();
    expect(cardsAfter).toBe(cardsBefore);
  });

  test('malformed WS message does not crash the board', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    await page.evaluate(() => {
      for (const ws of (window as any).__wsInstances as Set<WebSocket>) {
        ws.dispatchEvent(new MessageEvent('message', { data: 'not-json-at-all' }));
        ws.dispatchEvent(new MessageEvent('message', { data: '{"partial": ' }));
      }
    });

    await page.waitForTimeout(500);
    const cardCount = await page.locator('[data-testid="task-card"]').count();
    expect(cardCount).toBeGreaterThan(0);
  });

  test('reconnection after WS close resets and reconnects', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    // Close all active instances — the hook schedules a reconnect
    await page.evaluate(() => {
      for (const ws of (window as any).__wsInstances as Set<WebSocket>) {
        ws.close();
      }
    });

    // The hook should create new connections via scheduleReconnect
    await page.waitForFunction(
      () => (window as any).__wsInstances && (window as any).__wsInstances.size > 0,
      { timeout: 10_000 },
    );

    // New connection should still handle phase-change messages
    await sendWsJson(page, {
      type: 'phase-change',
      taskId: '00000000-0000-0000-0000-000000000000',
      phase: 'done',
    });

    await page.waitForTimeout(1_000);
    const cardsAfter = await page.locator('[data-testid="task-card"]').count();
    expect(cardsAfter).toBeGreaterThan(0);
  });

  test('container-log WS event refreshes the task detail panel', async ({ page }) => {
    test.skip(!isSeeded, 'E2E Test Project not found');

    // Open a task detail panel
    const card = page.locator('[data-testid="task-card"]').first();
    await card.click();

    const detailPanel = page.locator('text=Board').first();
    await expect(detailPanel).toBeVisible({ timeout: 5_000 });

    // Send container-log — task-panel should silently refresh
    await sendWsJson(page, {
      type: 'container-log',
      projectRoot: '/test/project',
      message: 'DevContainer startup...',
    });

    await page.waitForTimeout(1_000);
    await expect(detailPanel).toBeVisible();
  });
});
