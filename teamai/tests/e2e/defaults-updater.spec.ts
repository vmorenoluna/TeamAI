/**
 * E2E tests for the DefaultsUpdater component.
 *
 * Verifies the amber "Defaults update available" banner appears when a
 * registered project has outdated default files, and that the Sync button
 * updates uncustomized files and resolves the staleness.
 */
import { test, expect } from '@playwright/test';
import { ensureProjectSelected, SEED_DIR } from './helpers';
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { createHash } from 'crypto';

function computeChecksum(content: string): string {
  return 'sha256:' + createHash('sha256').update(content).digest('hex').slice(0, 16);
}

test.describe('DefaultsUpdater', () => {
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
      writeFileSync(defaultImplSrc, content, 'utf-8');
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

      // Click Sync — triggers syncProjectDefaults
      await page.waitForTimeout(1000);
      const syncButton = page.locator('button:has-text("Sync"):not(:has-text("All"))').first();
      await syncButton.click();

      const updatingLocator = page.locator('button:has-text("Updating…")').first();
      await expect(updatingLocator).toBeVisible({ timeout: 5_000 });
      await expect(updatingLocator).not.toBeVisible({ timeout: 15_000 });

      // ── Disk verification: sync successfully updated both the project
      //     file and the scaffold manifest ──────────────────────────────
      const implPath = join(SEED_DIR, '.claude', 'commands', 'implement.md');
      expect(readFileSync(implPath, 'utf-8')).toContain('E2E defaults-updater test marker');

      const manifestPath = join(SEED_DIR, '.claude', '.teamai-scaffold.json');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const currentDefaultsContent = readFileSync(defaultImplSrc, 'utf-8');
      expect(computeChecksum(currentDefaultsContent)).toBe(manifest.files['commands/implement.md']);

      // ── UI verification: "1 project synced" appears ─────────────────
      await expect(page.locator('text=1 project synced')).toBeVisible({ timeout: 10_000 });

      // ── UI verification: amber banner disappears after sync ─────────
      // The component removes synced projects from localStale immediately
      // in handleSync, and the useEffect merge strategy blocks re-entry
      // via syncedPaths gating. Path 2 (CompletedResults only, no banner)
      // renders once pendingStale drops to zero. Poll the DOM until the
      // warning banner text is gone.
      await page.waitForFunction(
        () => !document.body.innerText.includes('Defaults update available'),
        { timeout: 10_000 },
      );
    } finally {
      writeFileSync(defaultImplSrc, backup);
    }
  });
});
