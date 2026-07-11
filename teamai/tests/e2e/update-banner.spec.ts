import { test, expect, type Page } from '@playwright/test';
import { ensureProjectSelected } from './helpers';

let isSeeded = false;

// ── Mock electronAPI injection ──────────────────────────────────────────────

/**
 * Injects window.electronAPI mock via addInitScript so the UpdateBanner
 * component can receive simulated update events in a regular browser.
 *
 * Playwright compiles .ts test files, so TypeScript type annotations in
 * the callback are stripped before the code gets stringified and sent to
 * the browser.
 */
async function injectMockElectronAPI(page: Page) {
  await page.addInitScript(() => {
    type ReadyCb = () => void;
    type ProgressCb = (pct: number) => void;

    const readyListeners: ReadyCb[] = [];
    const progressListeners: ProgressCb[] = [];
    let installCalled = false;

     
    (window as any).electronAPI = {
      getUpdateStatus: () => Promise.resolve({ updateDownloaded: false }),
      onUpdateReady: (cb: ReadyCb) => { readyListeners.push(cb); },
      removeUpdateReadyListener: () => { readyListeners.length = 0; },
      onDownloadProgress: (cb: ProgressCb) => { progressListeners.push(cb); },
      removeDownloadProgressListener: () => { progressListeners.length = 0; },
      installUpdate: () => { installCalled = true; },

      // Helpers exposed for the test to trigger events from the page
      _fireDownloadProgress: (pct: number) => progressListeners.forEach((cb) => cb(pct)),
      _fireUpdateReady: () => readyListeners.forEach((cb) => cb()),
      _wasInstallCalled: () => installCalled,
    };
  });
}

/** Fire a download-progress event from the browser context. */
async function fireProgress(page: Page, pct: number) {
  await page.evaluate((p) => {
     
    (window as any).electronAPI?._fireDownloadProgress?.(p);
  }, pct);
}

/** Fire an update-ready event from the browser context. */
async function fireReady(page: Page) {
  await page.evaluate(() => {
     
    (window as any).electronAPI?._fireUpdateReady?.();
  });
}

/** Check if installUpdate was called. */
async function wasInstallCalled(page: Page): Promise<boolean> {
  return page.evaluate(() =>
     
    (window as any).electronAPI?._wasInstallCalled?.()
  );
}

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe.serial('Update Banner', () => {
  test.beforeEach(async ({ page }) => {
    await injectMockElectronAPI(page);
    const ok = await ensureProjectSelected(page);
    if (ok) isSeeded = true;
    else isSeeded = false;
  });

  test('banner is hidden when no update activity', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    // Wait for React to hydrate after SSR
    await page.waitForTimeout(1500);

    // Verify mock is in place
    const hasMock = await page.evaluate(() => !!window.electronAPI);
    expect(hasMock).toBe(true);

    const banner = page.locator('text=Downloading update');
    await expect(banner).toHaveCount(0, { timeout: 5_000 });

    const readyText = page.locator('text=Update ready');
    await expect(readyText).toHaveCount(0, { timeout: 5_000 });
  });

  test('shows download progress when download-progress fires', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await page.waitForTimeout(1500);

    await fireProgress(page, 42);

    const downloading = page.locator('text=Downloading update');
    await expect(downloading).toBeVisible({ timeout: 5_000 });
  });

  test('does not show install button while downloading', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await page.waitForTimeout(1500);

    await fireProgress(page, 10);

    const downloadText = page.locator('text=Downloading update');
    await expect(downloadText).toBeVisible({ timeout: 5_000 });

    const installBtn = page.locator('button', { hasText: 'Install & Restart' });
    await expect(installBtn).toHaveCount(0, { timeout: 5_000 });
  });

  test('shows ready state when update-ready fires', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await page.waitForTimeout(1500);

    await fireReady(page);

    const readyText = page.locator('text=Update ready');
    await expect(readyText).toBeVisible({ timeout: 5_000 });

    const installBtn = page.locator('button', { hasText: 'Install & Restart' });
    await expect(installBtn).toBeVisible({ timeout: 5_000 });
  });

  test('clicking install button calls installUpdate', async ({ page }) => {
    if (!isSeeded) { test.skip(true, 'E2E Test Project not found'); return; }

    await page.goto('/');
    await page.waitForTimeout(1500);

    await fireReady(page);

    const installBtn = page.locator('button', { hasText: 'Install & Restart' });
    await expect(installBtn).toBeVisible({ timeout: 5_000 });

    await installBtn.click();

    const called = await wasInstallCalled(page);
    expect(called).toBe(true);
  });
});
