import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { ensureProjectSelected, getActiveSeedDir } from './helpers';

// ── Template verification (filesystem only — no page interaction) ──

test.describe('Spec Revision — Command Template Verification', () => {
  test('seed project has updated qa-review.md with spec-gap detection (Step 6)', () => {
    const seedDir = getActiveSeedDir();

    const qaReviewPath = join(seedDir, '.claude', 'commands', 'qa-review.md');
    expect(existsSync(qaReviewPath), 'qa-review.md should exist in seed project').toBe(true);

    const content = readFileSync(qaReviewPath, 'utf-8');
    expect(content, 'qa-review.md should contain Spec Gap Detection step').toContain('Spec Gap Detection');
    expect(content, 'qa-review.md should reference spec_concerns in output schema').toContain('spec_concerns');
    expect(content, 'qa-review.md should have Step 6 header').toContain('Step 6');
  });

  test('seed project has the spec-revise command with the revision workflow', () => {
    const seedDir = getActiveSeedDir();

    const revisePath = join(seedDir, '.claude', 'commands', 'spec-revise.md');
    expect(existsSync(revisePath), 'spec-revise.md should exist in seed project').toBe(true);

    const content = readFileSync(revisePath, 'utf-8');
    expect(content, 'spec-revise.md should contain the Revision Workflow').toContain('Revision Workflow');
    expect(content, 'spec-revise.md should reference spec_revision_feedback.md').toContain('spec_revision_feedback');

    // The fresh-spec command no longer carries the revision workflow.
    const spec = readFileSync(join(seedDir, '.claude', 'commands', 'spec.md'), 'utf-8');
    expect(spec, 'spec.md should not contain the Revision Workflow').not.toContain('Revision Workflow');
  });
});

// ── UI verification (no orchestrator invocation) ──

test.describe('Spec Revision — UI Elements', () => {
  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);
  });

  test('retry button is absent on non-failed tasks (backlog, done)', async ({ page }) => {

    await page.goto('/');

    // Backlog task should NOT have a retry button
    const backlogCards = page.locator('[data-component="task-card"]', { hasText: 'dark mode toggle' });
    if (await backlogCards.count() > 0) {
      const retryBtn = backlogCards.first().locator('[data-component="retry-button"]');
      await expect(retryBtn, 'backlog tasks should not have retry button').toHaveCount(0);
    }

    // Done task should NOT have a retry button
    const doneCards = page.locator('[data-component="task-card"]', { hasText: 'Extract shared types' });
    if (await doneCards.count() > 0) {
      const retryBtn = doneCards.first().locator('[data-component="retry-button"]');
      await expect(retryBtn, 'done tasks should not have retry button').toHaveCount(0);
    }
  });
});
