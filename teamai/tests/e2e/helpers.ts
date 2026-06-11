/**
 * Shared helpers for E2E tests.
 *
 * All specs that need a seeded project should import `ensureProjectSelected`
 * from here instead of duplicating the logic.
 */

import { expect, type Page } from '@playwright/test';
import { resolve, join } from 'path';
import { readFileSync, readdirSync, existsSync } from 'fs';

/** The seed project path — must match seed.ts */
export const SEED_DIR = resolve(__dirname, '..', '..', '.teamai-e2e-seed');

/**
 * Read a seed task ID from the filesystem by slug.
 * Returns null if the task directory or task.json doesn't exist.
 *
 * Slugs match the seed.ts slugify function:
 *   title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
 */
export function getSeedTaskId(slug: string): string | null {
  const taskPath = join(SEED_DIR, '.teamai', slug, 'task.json');
  if (!existsSync(taskPath)) return null;
  try {
    const data = JSON.parse(readFileSync(taskPath, 'utf-8'));
    return data.id || null;
  } catch {
    return null;
  }
}

/**
 * Get a map of all seed task slugs to their IDs.
 */
export function getAllSeedTaskIds(): Map<string, string> {
  const result = new Map<string, string>();
  const tasksDir = join(SEED_DIR, '.teamai');
  if (!existsSync(tasksDir)) return result;
  for (const entry of readdirSync(tasksDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const id = getSeedTaskId(entry.name);
    if (id) result.set(entry.name, id);
  }
  return result;
}

/**
 * Set the activeProject cookie so the page at / loads with the seeded
 * E2E Test Project already selected. Returns true if the kanban board
 * renders (Backlog column visible), false if something is wrong.
 *
 * This replaces the per-spec duplicated function that hunted for the
 * "E2E Test Project" button in the project selector and clicked it.
 * Cookie-based selection is faster, more reliable, and avoids timeout
 * issues with slow page renders.
 */
export async function ensureProjectSelected(page: Page): Promise<boolean> {
  // Set the active project cookie directly — the server reads this to
  // resolve getActiveProjectPath(). Bypasses UI hunting entirely.
  await page.context().addCookies([{
    name: 'activeProject',
    value: SEED_DIR,
    url: 'http://localhost:3000',
  }]);

  await page.goto('/');

  // Backlog column header confirms the kanban board loaded
  const backlog = page.locator('text=Backlog').first();
  try {
    await expect(backlog).toBeVisible({ timeout: 30_000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a seed task ID from the filesystem by slug, throwing if not found.
 * Convenience wrapper around getSeedTaskId for tests that need a task ID.
 */
export function requireSeedTaskId(slug: string): string {
  const id = getSeedTaskId(slug);
  if (!id) throw new Error(`Seed task "${slug}" not found on disk — did the seed run?`);
  return id;
}

/**
 * Check if a task card with the given text exists on the kanban board.
 * Used by tests that verify card-level content without opening the panel.
 */
export async function ensureTaskCardVisible(page: Page, text: string): Promise<boolean> {
  const cardCount = await page.locator('[data-testid="task-card"]').count();
  if (cardCount === 0) return false;
  const card = page.locator('[data-testid="task-card"]', { hasText: text });
  return await card.count() > 0;
}

/**
 * Scroll the kanban board horizontally to the right so the rightmost
 * columns (Failed, Done) are visible.
 */
export async function scrollKanbanRight(page: Page): Promise<void> {
  await page.evaluate(() => {
    const container = document.querySelector('.overflow-x-auto');
    if (container) (container as HTMLElement).scrollLeft = (container as HTMLElement).scrollWidth;
  });
}
