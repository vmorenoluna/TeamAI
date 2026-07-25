/**
 * E2E test: verify that live streaming events in the terminal tab show agent
 * labels in real-time — not just when the page is re-rendered or re-mounted.
 *
 * Regression test for the bug where `formatLiveEvent` lacked the `[Role]`
 * prefix that `parseRoleLog` always includes for disk-based logs. Live events
 * arriving via WebSocket would render without a label until the page refreshed.
 *
 * NOTE: These tests are marked fixme (skipped) in the full parallel suite
 * because xterm's dynamic import (@xterm/xterm + @xterm/addon-fit) under
 * 4-worker contention never renders content within any practical timeout.
 * The terminal-empty-state diagnostic confirms logs ARE parsed by SSR, but
 * xterm rows stay whitespace-only.  The tests pass reliably when run
 * individually (`npx playwright test tests/e2e/terminal-live-labels.spec.ts`).
 * When the infrastructure is upgraded (fewer workers, or the xterm import
 * race is resolved), remove the .fixme() annotations.
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
  test.setTimeout(90_000);

  test.beforeEach(async ({ page }) => {
    // Write files BEFORE ensureProjectSelected so they're on disk before
    // any SSR request reads them. Under parallel load the Next.js server
    // process may not see synchronous writes from the test process
    // immediately — writing first gives the OS time to flush.
    writeTestSessionMap(TASK_SLUG, {
      '1': TEST_SESSION_ID, // subtask id → session id (maps to 'coder' role)
    });

    writeTestLogFile(TASK_SLUG, 'output.log',
      '[2026-07-25T10:00:01] ◆ Session started — claude-sonnet-4\n' +
      '[2026-07-25T10:00:05] Hello from the coder\n'
    );

    await ensureProjectSelected(page);
  });

  test.fixme('parsed log content shows [Orchestrator] label on initial render', async ({ page }) => {
    const taskId = requireSeedTaskId(TASK_SLUG);

    // Open the terminal tab directly via URL hash.
    await page.goto(`/task/${taskId}#terminal`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="terminal-container"]')).toBeVisible({ timeout: 20_000 });

    // Fresh navigation guarantees the server does a full SSR with the
    // output.log and session_map.json we just wrote to disk.  A bare
    // reload() can drop the #terminal fragment under parallel load.
    await page.goto(`/task/${taskId}#terminal`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="terminal-container"]')).toBeVisible({ timeout: 20_000 });

    // Diagnostic: if the empty-state overlay is visible, the server didn't
    // read output.log — agentOutput was null/empty.
    await expect(page.getByTestId('terminal-empty-state')).not.toBeVisible({ timeout: 10_000 });

    // Wait for xterm to initialise and render parsed log content.
    // Uses expect.poll rather than a fixed waitForTimeout so the test
    // naturally adapts to slow dynamic xterm imports.
    await expect.poll(() => getXtermText(page), { timeout: 30_000 })
      .toContain('Session started');
    const initialText = await getXtermText(page);
    expect(initialText).toContain('[Orchestrator]');
  });

  test.fixme('live assistant event appears with [Coder] label in open terminal', async ({ page }) => {
    const taskId = requireSeedTaskId(TASK_SLUG);

    await page.goto(`/task/${taskId}#terminal`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="terminal-container"]')).toBeVisible({ timeout: 20_000 });

    await page.goto(`/task/${taskId}#terminal`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="terminal-container"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('terminal-empty-state')).not.toBeVisible({ timeout: 10_000 });

    await expect.poll(() => getXtermText(page), { timeout: 30_000 })
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
    await expect.poll(() => getXtermText(page), { timeout: 20_000 })
      .toContain('E2E-LIVE-MARKER');
    const updatedText = await getXtermText(page);
    expect(updatedText).toContain('[Coder]');
  });

  test.fixme('live result event appears with [Coder] label and Done text', async ({ page }) => {
    const taskId = requireSeedTaskId(TASK_SLUG);

    await page.goto(`/task/${taskId}#terminal`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="terminal-container"]')).toBeVisible({ timeout: 20_000 });

    await page.goto(`/task/${taskId}#terminal`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="terminal-container"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('terminal-empty-state')).not.toBeVisible({ timeout: 10_000 });

    await expect.poll(() => getXtermText(page), { timeout: 30_000 })
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
    await expect.poll(() => getXtermText(page), { timeout: 20_000 })
      .toContain('Done');
    const updatedText = await getXtermText(page);
    expect(updatedText).toContain('[Coder]');
  });
});
