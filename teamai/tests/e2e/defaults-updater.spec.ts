/**
 * E2E tests for the DefaultsUpdater component.
 *
 * Verifies the amber "Defaults update available" banner appears when a
 * registered project has outdated default files, and that the Sync button
 * updates uncustomized files and resolves the staleness.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected, getActiveSeedDir } from './helpers';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

function computeChecksum(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex').slice(0, 16);
}

/** Retry write on Windows where the dev server may hold a file lock. */
function writeFileWithRetry(path: string, content: string): void {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      writeFileSync(path, content, 'utf-8');
      return;
    } catch (e) {
      if (attempt === 4) throw e;
      const start = Date.now();
      while (Date.now() - start < 200) { /* busy-wait */ }
    }
  }
}

// Serial mode: this test mutates shared defaults/ files, which are not
// per-worker isolated (T31 seed isolation only covers .teamai-e2e-seed-w*).
test.describe.serial('DefaultsUpdater', () => {
  const defaultImplSrc = join(process.cwd(), 'defaults', 'commands', 'implement.md');
  const MARKER = '\n\n<!-- E2E defaults-updater test marker -->\n';

  test.beforeEach(async ({ page }) => {
    await ensureProjectSelected(page);
  });

  test.afterEach(() => {
    if (!existsSync(defaultImplSrc)) return;
    let content = readFileSync(defaultImplSrc, 'utf-8');
    if (content.includes('E2E defaults-updater test marker')) {
      content = content.replace(/\r\n/g, '\n');
      content = content.replace(MARKER, '');
      writeFileWithRetry(defaultImplSrc, content);
    }
  });

  test('no banner when defaults are up to date', async ({ page }) => {
    const banner = page.locator('text=Defaults update available');
    await expect(banner).not.toBeVisible({ timeout: 5_000 });
  });

  test('stale defaults are detected and sync resolves them', async ({ page }) => {
    const backup = readFileSync(defaultImplSrc, 'utf-8');
    writeFileSync(defaultImplSrc, backup + MARKER);

    try {
      // Reload: SSR picks up the modified defaults — banner appears
      await page.reload();
      const bannerSection = page.locator('text=Defaults update available');
      await expect(bannerSection).toBeVisible({ timeout: 10_000 });

      // Sync all stale projects — the marker makes every registered
      // project stale, and in the full suite other tests may have added
      // extra projects beyond the E2E seed project.
      // Use a while loop (not for-with-nth) to handle DOM re-renders
      // as synced projects are removed from the stale list mid-loop.
      await page.waitForTimeout(1000);
      const syncButtons = page.locator('button:has-text("Sync"):not(:has-text("Sync All"))');
      while (await syncButtons.count() > 0) {
        await syncButtons.first().click();
        await expect(page.locator('button:has-text("Updating…")').first()).toBeVisible({ timeout: 5_000 });
        await expect(page.locator('button:has-text("Updating…")').first()).not.toBeVisible({ timeout: 20_000 });
      }

      // ── Disk verification: sync successfully updated the E2E seed
      //     project file and its scaffold manifest ────────────────────
      const implPath = join(getActiveSeedDir(), '.claude', 'commands', 'implement.md');
      expect(readFileSync(implPath, 'utf-8')).toContain('E2E defaults-updater test marker');

      const manifestPath = join(getActiveSeedDir(), '.claude', '.teamai-scaffold.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const currentDefaultsContent = readFileSync(defaultImplSrc, 'utf-8');
      expect(computeChecksum(currentDefaultsContent)).toBe(manifest.files['commands/implement.md']);

      // ── UI verification: amber banner disappears after sync ─────────
      await page.waitForTimeout(500);
      await expect(page.locator('text=Defaults update available')).not.toBeVisible({ timeout: 20_000 });
    } finally {
      writeFileWithRetry(defaultImplSrc, backup);
    }
  });
});
