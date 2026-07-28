/**
 * Shared helpers for E2E tests.
 *
 * All specs that need a seeded project should import `ensureProjectSelected`
 * from here instead of duplicating the logic.
 */

import { expect, type Locator, type Page, test } from '@playwright/test';
import { resolve, join } from 'path';
import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from 'fs';
import { getTestServerUrl } from '../../scripts/servers';

/** Base seed project path — must match seed.ts */
const BASE_SEED_DIR = resolve(__dirname, '..', '..', '.teamai-e2e-seed');

/**
 * Per-worker seed directory for isolated parallel execution (T31).
 * Falls back to the base seed when worker index isn't available
 * (e.g., single-worker mode or manual test runs).
 */
export function getActiveSeedDir(): string {
  try {
    const wi = test.info().workerIndex;
    return resolve(__dirname, '..', '..', `.teamai-e2e-seed-w${wi}`);
  } catch {
    return BASE_SEED_DIR;
  }
}

/** @deprecated Use getActiveSeedDir() for per-worker isolation (T31). */
export const SEED_DIR = BASE_SEED_DIR;

/**
 * Read a seed task ID from the filesystem by slug.
 * Returns null if the task directory or task.json doesn't exist.
 *
 * Slugs match the seed.ts slugify function:
 *   title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80)
 */
export function getSeedTaskId(slug: string): string | null {
  const taskPath = join(getActiveSeedDir(), '.teamai', slug, 'task.json');
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
  const tasksDir = join(getActiveSeedDir(), '.teamai');
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
/**
 * Set the activeProject cookie and verify the kanban board renders.
 *
 * Throws if the seed data didn't load — there's no per-test skip fallback.
 * The playwright-setup.ts globalSetup already throws on seed failure, so
 * this is a redundant safety check that fails fast with a clear message.
 */
export async function ensureProjectSelected(page: Page): Promise<void> {
  const seedDir = getActiveSeedDir();
  // Set the active project cookie directly — the server reads this to
  // resolve getActiveProjectPath(). Bypasses UI hunting entirely.
  await page.context().addCookies([{
    name: 'activeProject',
    value: seedDir,
    url: getTestServerUrl(),
  }]);

  await page.goto('/');

  // Backlog column header confirms the kanban board loaded.
  // If this fails, seed data is missing — fail the entire test run.
  await expect(page.locator('text=Backlog').first()).toBeVisible({ timeout: 30_000 });
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

/**
 * Write a session_map.json to the given seed task's directory so the
 * UnifiedTerminal component's live-events pipeline is active.
 */
export function writeTestSessionMap(slug: string, map: Record<string, string>): void {
  const seedDir = getActiveSeedDir();
  const taskDir = join(seedDir, '.teamai', slug);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, 'session_map.json'), JSON.stringify(map, null, 2));
}

/**
 * Write a sample log file to a seed task so the terminal has content to render.
 */
export function writeTestLogFile(slug: string, filename: string, content: string): void {
  const seedDir = getActiveSeedDir();
  const taskDir = join(seedDir, '.teamai', slug);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, filename), content);
}

/**
 * Click a button repeatedly until a target element becomes visible.
 *
 * Handles React hydration races where the server-rendered button is in
 * the DOM immediately but the onClick handler is not attached until
 * React hydrates — a single click can fire into the void.
 *
 * @param button  Locator for the button to click.
 * @param target  Locator for the element that should appear after clicking.
 * @param options Optional overrides for the outer retry timeout (default
 *                15 s) and inner poll interval (default 500 ms).
 */
export async function clickUntilVisible(
  button: Locator,
  target: Locator,
  options?: { timeout?: number; pollInterval?: number },
): Promise<void> {
  await expect(async () => {
    await button.click();
    await expect(target).toBeVisible({ timeout: options?.pollInterval ?? 500 });
  }).toPass({ timeout: options?.timeout ?? 15_000 });
}
