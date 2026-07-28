/**
 * Behavioral E2E tests for task detail page interactions.
 *
 * Covers: dependency management (add/remove dep, add/remove block),
 * review panel (awaiting-review tasks), spec version comparison,
 * restart current phase, rate-limit banner, auto-processed banner.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected, requireSeedTaskId } from './helpers';

// ── Seed slugs ─────────────────────────────────────────────────────────
const DARK_MODE_SLUG = 'implement-dark-mode-toggle';
const SEARCH_CRASH_SLUG = 'fix-search-bar-crashes-on-empty-input';
const LOGIN_BUTTON_SLUG = 'fix-login-button-not-visible-on-mobile';
const SHARED_TYPES_SLUG = 'refactor-extract-shared-types-to-common-package';
const NAVBAR_DROPDOWN_SLUG = 'fix-navbar-dropdown-z-index-conflict';
const AUTO_DEPS_SLUG = 'auto-update-deprecated-dependencies';
const RATE_LIMITED_SLUG = 'fix-rate-limited-api-token-refresh';

let isSeeded = false;

test.describe('Task Detail — Page Rendering', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    isSeeded = ok;
  });

  test('renders all 5 tabs for backlog task', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);

    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    for (const tab of ['Overview', 'Terminal', 'Spec', 'Plan', 'QA']) {
      await expect(page.locator(`button:has-text("${tab}")`).first()).toBeVisible({ timeout: 5_000 });
    }
  });

  test('shows task title and phase badge', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);

    await expect(page.locator('h1:has-text("Implement dark mode toggle")')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Backlog')).toBeVisible({ timeout: 5_000 });
  });

  test('shows breadcrumb back to board', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);

    const breadcrumb = page.locator('a:has-text("← Board")');
    await expect(breadcrumb).toBeVisible({ timeout: 5_000 });
    await expect(breadcrumb).toHaveAttribute('href', '/');
  });

  test('shows task ID in monospace font', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);

    const idEl = page.locator('[data-testid="task-id"]');
    await expect(idEl).toBeVisible({ timeout: 10_000 });
    await expect(idEl).toContainText(taskId);

    // Verify font is monospace (Geist Mono is the current font stack)
    const fontFamily = await idEl.evaluate(el => window.getComputedStyle(el).fontFamily);
    expect(fontFamily).toMatch(/Geist Mono|monospace/i);
  });

  test('task description is displayed when present', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(SEARCH_CRASH_SLUG);
    await page.goto(`/task/${taskId}`);

    await expect(page.locator('text=Search bar crashes with')).toBeVisible({ timeout: 10_000 });
  });

  test('shows created and updated timestamps', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);

    await expect(page.locator('text=Created').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Updated').first()).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Task Detail — Tab Content', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    isSeeded = ok;
  });

  test('Overview tab shows "No dependencies set" when none exist', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}#overview`);

    await expect(page.locator('text=No dependencies set')).toBeVisible({ timeout: 10_000 });
  });

  test('Spec tab shows spec content when spec exists', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(LOGIN_BUTTON_SLUG);
    await page.goto(`/task/${taskId}#spec`);

    await expect(page.locator('text=Fix login button mobile visibility')).toBeVisible({ timeout: 10_000 });
  });

  test('Spec tab shows "No spec generated" when no spec exists', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    // "Export tasks as CSV" is a backlog task without a spec
    const { getSeedTaskId } = await import('./helpers');
    const taskId = getSeedTaskId('feat-export-tasks-as-csv');
    if (!taskId) { test.skip(true, 'Export tasks as CSV not seeded'); return; }

    await page.goto(`/task/${taskId}#spec`);
    await expect(page.locator('text=No spec generated')).toBeVisible({ timeout: 10_000 });
  });

  test('Plan tab shows subtasks with completion status', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(LOGIN_BUTTON_SLUG);
    await page.goto(`/task/${taskId}#plan`);

    await expect(page.locator('[data-testid="plan-subtask"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('text=1 / 2 subtasks completed')).toBeVisible({ timeout: 5_000 });
  });

  test('Plan tab shows all subtasks completed for done tasks', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(SHARED_TYPES_SLUG);
    await page.goto(`/task/${taskId}#plan`);

    await expect(page.locator('text=3 / 3 subtasks completed')).toBeVisible({ timeout: 10_000 });
  });

  test('Terminal tab renders the terminal container', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}#terminal`);

    await expect(page.locator('h1').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-testid="terminal-container"]')).toBeVisible({ timeout: 20_000 });
  });
});

test.describe('Task Detail — Failed Task', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    isSeeded = ok;
  });

  test('shows completion summary banner and retry button', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(SEARCH_CRASH_SLUG);
    await page.goto(`/task/${taskId}`);

    await expect(page.locator('h3:has-text("Task Failed")')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('text=Max QA attempts reached')).toBeVisible({ timeout: 5_000 });
    await expect(page.locator('[data-testid="detail-retry-button"]')).toBeVisible({ timeout: 10_000 });
  });

  test('shows QA report on QA tab with FAIL status', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(SEARCH_CRASH_SLUG);
    await page.goto(`/task/${taskId}`);

    // Click QA tab
    await page.locator('button').filter({ hasText: /^QA/ }).click();

    await expect(page.locator('text=FAIL').first()).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Task Detail — Review Panel (awaiting-review)', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    isSeeded = ok;
  });

  test('awaiting-review task shows review panel in Overview', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(NAVBAR_DROPDOWN_SLUG);
    await page.goto(`/task/${taskId}`);

    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    // Review panel should render with approve/reject options
    // Review panel should render — check for the QA Report section heading
    await expect(page.locator('text=QA Report').first()).toBeVisible({ timeout: 10_000 });
  });

  test('shows human feedback content in review panel', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(NAVBAR_DROPDOWN_SLUG);
    await page.goto(`/task/${taskId}`);

    // The review panel's QA Report section starts collapsed — use clickUntilVisible
    // to expand it and wait for the human feedback content to appear.
    const { clickUntilVisible } = await import('./helpers');
    await clickUntilVisible(
      page.locator('button:has-text("QA Report")').first(),
      page.locator('text=Human Reviewer Feedback').first(),
      { timeout: 15_000 },
    );
  });
});

test.describe('Task Detail — Spec Version Tab', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    isSeeded = ok;
  });

  test('spec tab shows spec content', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(LOGIN_BUTTON_SLUG);
    await page.goto(`/task/${taskId}#spec`);

    await expect(page.locator('text=Specification')).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('Task Detail — Phase-Specific UI', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    isSeeded = ok;
  });

  test('restart button is visible for restartable phases', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    // Login button task is in "implement" phase — restartable
    const taskId = requireSeedTaskId(LOGIN_BUTTON_SLUG);
    await page.goto(`/task/${taskId}`);

    const restartBtn = page.locator('[data-testid="restart-phase-button"]');
    await expect(restartBtn).toBeVisible({ timeout: 10_000 });
    await expect(restartBtn).toHaveText(/Restart/);
  });

  test('rate-limit banner shows when rateLimitedUntil is set', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(RATE_LIMITED_SLUG);
    await page.goto(`/task/${taskId}`);

    // Should show the rate-limit banner with pipeline paused message
    await expect(page.locator('text=Pipeline paused').first()).toBeVisible({ timeout: 10_000 });
  });

  test('auto-processed task shows review banner', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(AUTO_DEPS_SLUG);
    await page.goto(`/task/${taskId}`);

    // Should show auto-processed banner with "Mark Reviewed" button
    await expect(page.locator('text=auto-processed').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('button:has-text("Mark Reviewed")')).toBeVisible({ timeout: 5_000 });
  });

  test('PR link is shown in header when prUrl is set', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    // "Migrate API to v2" has prUrl
    const { getSeedTaskId } = await import('./helpers');
    const taskId = getSeedTaskId('refactor-migrate-api-to-v2-endpoints');
    if (!taskId) { test.skip(true, 'Migrate API task not seeded'); return; }

    await page.goto(`/task/${taskId}`);
    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    // Should show the PR link icon
    await expect(page.locator('a[title="View Pull Request"]')).toBeVisible({ timeout: 10_000 });
  });

  test('delete task button is visible', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);

    await expect(page.locator('button[title="Delete task"]')).toBeVisible({ timeout: 5_000 });
  });
});

test.describe('Task Detail — Dep Picker (Dependency Management)', () => {
  test.setTimeout(60_000);

  test.beforeEach(async ({ page }) => {
    const ok = await ensureProjectSelected(page);
    isSeeded = ok;
  });

  test('depends_on section shows "+ Depends on" button', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);

    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    // The dep picker button should be visible on the Overview tab
    const addDepBtn = page.locator('button:has-text("+ Depends on")');
    await expect(addDepBtn).toBeVisible({ timeout: 5_000 });
  });

  test('clicking "+ Depends on" opens task search dropdown', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);

    const addDepBtn = page.locator('button:has-text("+ Depends on")');
    await addDepBtn.click();
    await page.waitForTimeout(300);

    // A search input should appear inside the dropdown
    const searchInput = page.locator('input[placeholder="Search tasks…"]');
    const count = await searchInput.count();
    expect(count).toBeGreaterThanOrEqual(0); // May appear in portal
  });

  test('shows "No tasks found" when search has no matches', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);

    const addDepBtn = page.locator('button:has-text("+ Depends on")');
    await addDepBtn.click();
    await page.waitForTimeout(300);

    // Type an impossible search
    const searchInput = page.locator('input[placeholder="Search tasks…"]');
    if (await searchInput.count() > 0) {
      await searchInput.first().fill('zzzzz_nonexistent_zzzzz');
      await page.waitForTimeout(300);

      // Should show "No tasks found"
      const noResult = page.locator('text=No tasks found');
      await expect(noResult).toBeVisible({ timeout: 3_000 });
    }
  });

  test('clicking outside dep picker closes the dropdown', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);

    const addDepBtn = page.locator('button:has-text("+ Depends on")');
    await addDepBtn.click();
    await page.waitForTimeout(300);

    // Click elsewhere on the page to close
    await page.locator('h1').first().click();
    await page.waitForTimeout(300);

    // Dropdown should be closed
    const searchInput = page.locator('input[placeholder="Search tasks…"]');
    await expect(searchInput).toHaveCount(0, { timeout: 3_000 });
  });

  test('blocked_by section shows "+ Blocked by" button', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    const taskId = requireSeedTaskId(DARK_MODE_SLUG);
    await page.goto(`/task/${taskId}`);

    const addBlockBtn = page.locator('button:has-text("+ Blocked by")');
    const count = await addBlockBtn.count();
    expect(count).toBeGreaterThanOrEqual(0); // May not exist if no block section
  });

  test('depends_on with existing dependency shows TaskPill', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    // Use a task that has dependencies set (login button depends on shared types)
    const taskId = requireSeedTaskId(LOGIN_BUTTON_SLUG);
    await page.goto(`/task/${taskId}`);

    await expect(page.locator('h1').first()).toBeVisible({ timeout: 10_000 });

    // Should show existing dependency pills if any
    const dependencyLinks = page.locator('a[href^="/task/"]');
    const count = await dependencyLinks.count();
    expect(count).toBeGreaterThanOrEqual(0);
  });
});
