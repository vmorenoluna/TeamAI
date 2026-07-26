/**
 * E2E test: verify that live streaming events in the terminal tab show agent
 * labels in real-time — not just when the page is re-rendered or re-mounted.
 *
 * Regression test for the bug where `formatLiveEvent` lacked the `[Role]`
 * prefix that `parseRoleLog` always includes for disk-based logs. Live events
 * arriving via WebSocket would render without a label until the page refreshed.
 *
 * All content verification reads from a hidden `data-testid="terminal-raw-output"`
 * div that contains the full parsed log + accumulated live events as plain text.
 * This bypasses xterm.js's viewport-dependent DOM rendering, which under
 * parallel load may show 0–1 empty rows.
 */
import { test, expect } from '@playwright/test';
import { getTestServerUrl } from '../../scripts/servers';
import {
  getActiveSeedDir,
  requireSeedTaskId,
  writeTestSessionMap,
  writeTestLogFile,
} from './helpers';

const TASK_SLUG = 'test-terminal-live-event-labels';
const TEST_SESSION_ID = 'test-coder-session-42';

test.setTimeout(90_000);

test('terminal renders SSR log labels, then live assistant labels, then live result labels', async ({ page }) => {
  // Write files then set the active-project cookie directly.
  writeTestSessionMap(TASK_SLUG, { '1': TEST_SESSION_ID });
  writeTestLogFile(TASK_SLUG, 'output.log',
    '[2026-07-25T10:00:01] ◆ Session started — claude-sonnet-4\n' +
    '[2026-07-25T10:00:05] Hello from the coder\n'
  );

  const seedDir = getActiveSeedDir();
  await page.context().addCookies([{
    name: 'activeProject',
    value: seedDir,
    url: getTestServerUrl(),
  }]);

  const taskId = requireSeedTaskId(TASK_SLUG);

  // ── Navigate and wait for the terminal to initialise ──────────────
  await page.goto(`/task/${taskId}#terminal`);
  await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('[data-testid="terminal-container"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('terminal-empty-state')).not.toBeVisible({ timeout: 10_000 });
  // Wait for the raw-output div to be populated (SSR + React hydration).
  // The div is hidden, so use state: 'attached' instead of the default
  // 'visible'.  Under parallel load hydration may lag behind the initial
  // page render.
  await page.locator('[data-testid="terminal-raw-output"]').waitFor({ state: 'attached', timeout: 20_000 });

  // ── Phase 1: verify SSR-rendered log content ─────────────────────
  // Read from the hidden raw-output div instead of xterm DOM rows,
  // which are unreliable under parallel load (xterm renders only rows
  // that fit its viewport).
  await expect(page.getByTestId('terminal-raw-output'))
    .toContainText('Session started', { timeout: 30_000 });
  const raw1 = await page.getByTestId('terminal-raw-output').textContent();
  // rawOutput is derived from interleavedOutput (ANSI-stripped), which uses
  // display labels from the terminal (capitalized: [Orchestrator], [Coder]).
  expect(raw1).toContain('[Orchestrator]');

  // ── Phase 2: inject a live assistant event via WebSocket ──────────
  await expect(page.getByTestId('terminal-reconnecting-banner')).not.toBeVisible({ timeout: 15_000 });

  const serverUrl = getTestServerUrl();
  const assistantResp = await fetch(`${serverUrl}/api/test/emit-agent-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: TEST_SESSION_ID,
      taskId,
      event: {
        type: 'assistant',
        message: {
          content: [{ type: 'text', text: 'E2E-LIVE-MARKER: Labeled live assistant event' }],
        },
      } as Record<string, unknown>,
    }),
  });

  expect(assistantResp.ok).toBe(true);
  const assistantBody = await assistantResp.json() as { clients: number };
  expect(assistantBody.clients, 'No WebSocket clients connected').toBeGreaterThan(0);

  // Live events are appended to the raw-output div as they arrive.
  await expect(page.getByTestId('terminal-raw-output'))
    .toContainText('E2E-LIVE-MARKER', { timeout: 20_000 });
  const raw2 = await page.getByTestId('terminal-raw-output').textContent();
  expect(raw2).toContain('[Coder]');

  // ── Phase 3: inject a live result event via WebSocket ─────────────
  const resultResp = await fetch(`${serverUrl}/api/test/emit-agent-event`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: TEST_SESSION_ID,
      taskId,
      event: {
        type: 'result',
        subtype: 'success',
        duration_ms: 500,
        total_cost_usd: 0.0042,
      } as Record<string, unknown>,
    }),
  });

  expect(resultResp.ok).toBe(true);
  const resultBody = await resultResp.json() as { clients: number };
  expect(resultBody.clients, 'No WebSocket clients connected').toBeGreaterThan(0);

  await expect(page.getByTestId('terminal-raw-output'))
    .toContainText('Done', { timeout: 20_000 });
  const raw3 = await page.getByTestId('terminal-raw-output').textContent();
  expect(raw3).toContain('[Coder]');
});
