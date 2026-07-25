/**
 * E2E test: verify that live streaming events in the terminal tab show agent
 * labels in real-time — not just when the page is re-rendered or re-mounted.
 *
 * Regression test for the bug where `formatLiveEvent` lacked the `[Role]`
 * prefix that `parseRoleLog` always includes for disk-based logs. Live events
 * arriving via WebSocket would render without a label until the page refreshed.
 */
import { test, expect } from '@playwright/test';
import { getTestServerUrl } from '../../scripts/servers';
import {
  ensureProjectSelected,
  requireSeedTaskId,
  writeTestSessionMap,
  writeTestLogFile,
  getXtermText,
} from './helpers';

const TASK_SLUG = 'test-terminal-live-event-labels';
const TEST_SESSION_ID = 'test-coder-session-42';

test.describe('Terminal Live Event Labels', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);

    // Write a session_map.json so the UnifiedTerminal's sessionRoleMap
    // is populated and live events will be routed to formatLiveEventWithLabel.
    writeTestSessionMap(TASK_SLUG, {
      '1': TEST_SESSION_ID, // subtask id → session id (maps to 'coder' role)
    });

    // Write sample log content so the terminal initialises with at least
    // one parsed line (in this case the orchestrator log, which always
    // gets an [Orchestrator] label via parseRoleLog).
    writeTestLogFile(TASK_SLUG, 'output.log',
      '[2026-07-25T10:00:01] ◆ Session started — claude-sonnet-4\n' +
      '[2026-07-25T10:00:05] Hello from the coder\n'
    );
  });

  test('parsed log content shows [Orchestrator] label on initial render', async ({ page }) => {
    const taskId = requireSeedTaskId(TASK_SLUG);

    // Open the terminal tab directly via URL hash.
    await page.goto(`/task/${taskId}#terminal`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="terminal-container"]')).toBeVisible({ timeout: 20_000 });

    // Wait for xterm to initialise and render parsed log content.
    // Use expect.poll rather than a fixed waitForTimeout so the test
    // naturally adapts to slow dynamic xterm imports under parallel load.
    await expect.poll(() => getXtermText(page), { timeout: 20_000 })
      .toContain('Session started');
    const initialText = await getXtermText(page);
    expect(initialText).toContain('[Orchestrator]');
  });

  test('live assistant event appears with [Coder] label in open terminal', async ({ page }) => {
    const taskId = requireSeedTaskId(TASK_SLUG);

    await page.goto(`/task/${taskId}#terminal`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="terminal-container"]')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => getXtermText(page), { timeout: 20_000 })
      .toContain('Session started');

    // Wait for the WebSocket to connect before injecting live events.
    // The reconnecting banner is visible when !connected && hasAnyLog;
    // it disappears once the WebSocket handshake completes.
    await expect(page.getByTestId('terminal-reconnecting-banner')).not.toBeVisible({ timeout: 15_000 });

    // Inject a live event via the test endpoint. The server broadcasts
    // directly to all WebSocket clients — bypassing the agentHandler's
    // session-lookup gate so tests don't need real process-manager sessions.
    const serverUrl = getTestServerUrl();
    const response = await fetch(`${serverUrl}/api/test/emit-agent-event`, {
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

    expect(response.ok).toBe(true);
    const injectBody = await response.json() as { clients: number };
    expect(injectBody.clients, 'No WebSocket clients connected — event was not broadcast').toBeGreaterThan(0);

    // Wait for the event to be broadcast via WebSocket, processed by
    // useAgentStream, rendered by formatLiveEventWithLabel, and written
    // into the xterm buffer.
    await expect.poll(() => getXtermText(page), { timeout: 15_000 })
      .toContain('E2E-LIVE-MARKER');
    const updatedText = await getXtermText(page);
    expect(updatedText).toContain('[Coder]');
  });

  test('live result event appears with [Coder] label and Done text', async ({ page }) => {
    const taskId = requireSeedTaskId(TASK_SLUG);

    await page.goto(`/task/${taskId}#terminal`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="terminal-container"]')).toBeVisible({ timeout: 20_000 });
    await expect.poll(() => getXtermText(page), { timeout: 20_000 })
      .toContain('Session started');

    // Wait for the WebSocket to connect before injecting live events.
    await expect(page.getByTestId('terminal-reconnecting-banner')).not.toBeVisible({ timeout: 15_000 });

    // Result events have leading \r\n in their body. formatLiveEventWithLabel
    // moves \r\n before the label prefix so the label stays on the same
    // visual line as the "Done" text.
    const serverUrl = getTestServerUrl();
    const response = await fetch(`${serverUrl}/api/test/emit-agent-event`, {
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

    expect(response.ok).toBe(true);
    const injectBody = await response.json() as { clients: number };
    expect(injectBody.clients, 'No WebSocket clients connected — event was not broadcast').toBeGreaterThan(0);
    await expect.poll(() => getXtermText(page), { timeout: 15_000 })
      .toContain('Done');
    const updatedText = await getXtermText(page);
    expect(updatedText).toContain('[Coder]');
  });
});
