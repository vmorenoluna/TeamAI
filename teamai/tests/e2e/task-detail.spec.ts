import { test, expect } from '@playwright/test';

test.describe('Task Detail Panel (inline on kanban board)', () => {
  test('opens when clicking a task card and shows title, phase, and tabs', async ({ page }) => {
    await page.goto('/');

    // Wait for the page to fully load
    await expect(page.locator('body')).toBeVisible();

    // Check if we have an active project — if "Select or add a project" is visible, skip
    const noProject = page.locator('text=Select or add a project from the sidebar');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    // Check if there are task cards
    const taskCards = page.locator('[data-testid="task-card"]');
    const cardCount = await taskCards.count();

    if (cardCount === 0) {
      // Create a task first
      await page.locator('button:has-text("+ New Task")').click();
      await expect(page.locator('text=New Task')).toBeVisible();

      await page.locator('input[name="title"]').fill('E2E Test Task');
      await page.locator('textarea[name="description"]').fill('Created by Playwright E2E test');
      await page.locator('button:has-text("Create Task")').click();

      // Wait for the task to appear on the board
      await expect(page.locator('text=E2E Test Task').first()).toBeVisible({ timeout: 10_000 });
    }

    // Click the first task card
    const firstCard = page.locator('[data-testid="task-card"]').first();
    await firstCard.click();

    // Wait for the detail panel to appear
    const detailPanel = page.locator('text=← Board');
    await expect(detailPanel).toBeVisible({ timeout: 5_000 });

    // Title should be visible in the panel title bar
    const panelTitle = page.locator('text=Task Details');
    await expect(panelTitle.first()).toBeVisible({ timeout: 3_000 });

    // Phase badge should be visible
    const phaseBadge = page.locator('text=backlog').first();
    await expect(phaseBadge).toBeVisible({ timeout: 3_000 });
  });

  test('shows tabs: Overview, Terminal, Spec, Plan, QA', async ({ page }) => {
    await page.goto('/');

    // Check if we have an active project
    const noProject = page.locator('text=Select or add a project from the sidebar');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    // Check if there are task cards, skip if none
    const taskCards = page.locator('[data-testid="task-card"]');
    const cardCount = await taskCards.count();
    if (cardCount === 0) {
      test.skip(true, 'No tasks available to test detail panel');
      return;
    }

    // Click the first task card
    await taskCards.first().click();

    // Wait for the detail panel
    await expect(page.locator('text=← Board')).toBeVisible({ timeout: 5_000 });

    // All five tabs should be visible
    const expectedTabs = ['Overview', 'Terminal', 'Spec', 'Plan', 'QA'];
    for (const tab of expectedTabs) {
      const tabButton = page.locator(`button:has-text("${tab}")`).first();
      await expect(tabButton).toBeVisible({ timeout: 3_000 });
    }
  });

  test('can switch between tabs', async ({ page }) => {
    await page.goto('/');

    const noProject = page.locator('text=Select or add a project from the sidebar');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    const taskCards = page.locator('[data-testid="task-card"]');
    if ((await taskCards.count()) === 0) {
      test.skip(true, 'No tasks available to test tab switching');
      return;
    }

    await taskCards.first().click();
    await expect(page.locator('text=← Board')).toBeVisible({ timeout: 5_000 });

    // Click Spec tab
    await page.locator('button:has-text("Spec")').first().click();
    // Spec tab should show either spec content or "No spec generated yet"
    const specContent = page.locator('pre, p:has-text("No spec generated")').first();
    await expect(specContent).toBeVisible({ timeout: 3_000 });

    // Click Plan tab
    await page.locator('button:has-text("Plan")').first().click();
    // Should show either plan subtasks or "No plan generated yet"
    const planContent = page.locator('text=No plan generated yet').first();
    const planSubtasks = page.locator('[data-testid="plan-subtask"]').first();
    await expect(planContent.or(planSubtasks)).toBeVisible({ timeout: 3_000 });

    // Click QA tab
    await page.locator('button:has-text("QA")').first().click();
    const qaContent = page.locator('p:has-text("No QA report generated"), div:has-text("PASS"), div:has-text("FAIL")').first();
    await expect(qaContent).toBeVisible({ timeout: 3_000 });

    // Click back to Overview
    await page.locator('button:has-text("Overview")').first().click();
    // Overview should show dependency section
    await expect(page.locator('text=Depends on').first().or(page.locator('text=No dependencies set').first())).toBeVisible({ timeout: 3_000 });
  });

  test('shows breadcrumb link back to board', async ({ page }) => {
    await page.goto('/');

    const noProject = page.locator('text=Select or add a project from the sidebar');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    const taskCards = page.locator('[data-testid="task-card"]');
    if ((await taskCards.count()) === 0) {
      test.skip(true, 'No tasks available to test breadcrumb');
      return;
    }

    await taskCards.first().click();
    await expect(page.locator('text=← Board')).toBeVisible({ timeout: 5_000 });

    // The breadcrumb should be a link to "/"
    const breadcrumb = page.locator('a:has-text("← Board")');
    await expect(breadcrumb).toBeVisible();
    await expect(breadcrumb).toHaveAttribute('href', '/');
  });

  test('shows delete button in task detail panel', async ({ page }) => {
    await page.goto('/');

    const noProject = page.locator('text=Select or add a project from the sidebar');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    const taskCards = page.locator('[data-testid="task-card"]');
    if ((await taskCards.count()) === 0) {
      test.skip(true, 'No tasks available to test delete button');
      return;
    }

    await taskCards.first().click();
    await expect(page.locator('text=← Board')).toBeVisible({ timeout: 5_000 });

    // The delete button should be present (🗑 character or title="Delete task")
    const deleteButton = page.locator('button[title="Delete task"]');
    await expect(deleteButton).toBeVisible({ timeout: 3_000 });
  });

  test('close button (×) dismisses the panel', async ({ page }) => {
    await page.goto('/');

    const noProject = page.locator('text=Select or add a project from the sidebar');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    const taskCards = page.locator('[data-testid="task-card"]');
    if ((await taskCards.count()) === 0) {
      test.skip(true, 'No tasks available to test close button');
      return;
    }

    await taskCards.first().click();
    await expect(page.locator('text=← Board')).toBeVisible({ timeout: 5_000 });

    // Click the close (×) button
    const closeButton = page.locator('button[title="Close window"]');
    await closeButton.click();

    // Panel should be dismissed — the "← Board" breadcrumb should no longer be visible
    await expect(page.locator('text=← Board')).not.toBeVisible({ timeout: 3_000 });
  });
});

test.describe('Task Detail Full Page (/task/:id)', () => {
  test('full page renders task title, phase badge, and tabs', async ({ page }) => {
    await page.goto('/');

    const noProject = page.locator('text=Select or add a project from the sidebar');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    // Find the first task card
    const taskCards = page.locator('[data-testid="task-card"]');
    if ((await taskCards.count()) === 0) {
      test.skip(true, 'No tasks available to test full page');
      return;
    }

    // Click the first task card to open the panel
    await taskCards.first().click();
    await expect(page.locator('text=← Board')).toBeVisible({ timeout: 5_000 });

    // Extract the task ID from the displayed task ID text
    const taskIdText = page.locator('[data-testid="task-id"]');
    // Wait for the task data to load
    await expect(taskIdText).toBeVisible({ timeout: 5_000 });
    const taskId = await taskIdText.innerText();

    // Close the panel
    await page.locator('button[title="Close window"]').click();
    await expect(page.locator('text=← Board')).not.toBeVisible({ timeout: 3_000 });

    // Navigate to the full task detail page
    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    // The page should show the task title
    await expect(page.locator('h1')).toBeVisible({ timeout: 5_000 });

    // Phase badge should be visible
    const phaseBadge = page.locator('text=backlog').first();
    await expect(phaseBadge).toBeVisible({ timeout: 3_000 });

    // Tabs should be visible
    const expectedTabs = ['Overview', 'Terminal', 'Spec', 'Plan', 'QA'];
    for (const tab of expectedTabs) {
      const tabButton = page.locator(`button:has-text("${tab}")`).first();
      await expect(tabButton).toBeVisible({ timeout: 3_000 });
    }
  });

  test('full page shows task ID in monospace', async ({ page }) => {
    await page.goto('/');

    const noProject = page.locator('text=Select or add a project from the sidebar');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    const taskCards = page.locator('[data-testid="task-card"]');
    if ((await taskCards.count()) === 0) {
      test.skip(true, 'No tasks available to test full page');
      return;
    }

    await taskCards.first().click();
    await expect(page.locator('text=← Board')).toBeVisible({ timeout: 5_000 });

    const taskIdText = page.locator('[data-testid="task-id"]');
    await expect(taskIdText).toBeVisible({ timeout: 5_000 });
    const taskId = await taskIdText.innerText();

    await page.locator('button[title="Close window"]').click();

    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    // The task ID should still be displayed on the full page
    const fullPageTaskId = page.locator('[data-testid="task-id"]');
    await expect(fullPageTaskId).toBeVisible({ timeout: 5_000 });
    await expect(fullPageTaskId).toContainText(taskId);
  });

  test('full page has breadcrumb back to board', async ({ page }) => {
    await page.goto('/');

    const noProject = page.locator('text=Select or add a project from the sidebar');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    const taskCards = page.locator('[data-testid="task-card"]');
    if ((await taskCards.count()) === 0) {
      test.skip(true, 'No tasks available');
      return;
    }

    await taskCards.first().click();
    await expect(page.locator('text=← Board')).toBeVisible({ timeout: 5_000 });

    const taskIdText = page.locator('[data-testid="task-id"]');
    await expect(taskIdText).toBeVisible({ timeout: 5_000 });
    const taskId = await taskIdText.innerText();

    await page.locator('button[title="Close window"]').click();

    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    // Breadcrumb should lead back to "/"
    const breadcrumb = page.locator('a:has-text("← Board")');
    await expect(breadcrumb).toBeVisible({ timeout: 5_000 });
    await expect(breadcrumb).toHaveAttribute('href', '/');
  });

  test('terminal tab renders agent panel', async ({ page }) => {
    await page.goto('/');

    const noProject = page.locator('text=Select or add a project from the sidebar');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    const taskCards = page.locator('[data-testid="task-card"]');
    if ((await taskCards.count()) === 0) {
      test.skip(true, 'No tasks available to test terminal tab');
      return;
    }

    await taskCards.first().click();
    await expect(page.locator('text=← Board')).toBeVisible({ timeout: 5_000 });

    // Get the task ID first
    const taskIdText = page.locator('[data-testid="task-id"]');
    await expect(taskIdText).toBeVisible({ timeout: 5_000 });
    const taskId = await taskIdText.innerText();

    await page.locator('button[title="Close window"]').click();
    await page.goto(`/task/${taskId}`);

    // Click the Terminal tab
    await page.locator('button:has-text("Terminal")').first().click();

    // Agent panel header should render
    await expect(page.locator('text=Agent Output').first()).toBeVisible({ timeout: 5_000 });

    // No floating scroll buttons should exist — native scrollbar is used instead
    await expect(page.locator('[data-testid="scroll-to-bottom"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="scroll-to-top"]')).toHaveCount(0);
  });

  test('full page shows delete button', async ({ page }) => {
    await page.goto('/');

    const noProject = page.locator('text=Select or add a project from the sidebar');
    if (await noProject.isVisible({ timeout: 3_000 }).catch(() => false)) {
      test.skip(true, 'No active project selected');
      return;
    }

    const taskCards = page.locator('[data-testid="task-card"]');
    if ((await taskCards.count()) === 0) {
      test.skip(true, 'No tasks available');
      return;
    }

    await taskCards.first().click();
    await expect(page.locator('text=← Board')).toBeVisible({ timeout: 5_000 });

    const taskIdText = page.locator('[data-testid="task-id"]');
    await expect(taskIdText).toBeVisible({ timeout: 5_000 });
    const taskId = await taskIdText.innerText();

    await page.locator('button[title="Close window"]').click();

    await page.goto(`/task/${taskId}`);
    await expect(page.locator('body')).toBeVisible();

    // Delete button should be visible on the full page too
    const deleteButton = page.locator('button[title="Delete task"]');
    await expect(deleteButton).toBeVisible({ timeout: 3_000 });
  });
});
