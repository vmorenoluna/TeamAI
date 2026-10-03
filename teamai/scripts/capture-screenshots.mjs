/**
 * Capture the three optional landing-page screenshots into docs/images/:
 *
 *   terminals.jpg   — Terminals page with a live interactive session open
 *   diagnostics.jpg — A failed task's overview (failed criteria + QA recommendations)
 *   delivered.jpg   — The kanban board scrolled to the Delivered (Done) column
 *
 * Requires the dev server already running with the demo project available:
 *
 *   cd teamai && npm run dev        # or electron:dev (app serves on :3000)
 *   npx tsx seed-demo.ts --yes      # from the repo root, once
 *
 * The script selects the demo project via the same `activeProject` cookie the
 * E2E helpers use (tests/e2e/helpers.ts), so no UI clicking is needed.
 *
 * Usage:  node scripts/capture-screenshots.mjs [--url http://localhost:3000]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { fileURLToPath } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const teamaiRoot = resolve(here, '..');
const repoRoot = resolve(teamaiRoot, '..');
const OUT_DIR = join(repoRoot, 'docs', 'images');
const DEMO_DIR = join(repoRoot, 'demo');

const BASE_URL = process.argv.includes('--url')
  ? process.argv[process.argv.indexOf('--url') + 1]
  : 'http://localhost:3000';

// The landing page reserves layout space from each <img width/height>; the
// existing screenshots are ~1600×1000-1850×1050 CSS pixels at 1.75 device
// scale, so match that ratio for visual consistency.
const VIEWPORT = { width: 1680, height: 1050 };
const SCALE = 1.75;
const JPEG_QUALITY = 88;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Retry an async action until it stops throwing, up to timeoutMs. */
async function retryUntil(action, timeoutMs = 20_000, stepMs = 500) {
  const start = Date.now();
  for (;;) {
    try {
      await action();
      return;
    } catch (err) {
      if (Date.now() - start > timeoutMs) throw err;
      await sleep(stepMs);
    }
  }
}

async function selectDemoProject(context) {
  await context.addCookies([{
    name: 'activeProject',
    value: DEMO_DIR,
    url: BASE_URL,
  }]);
}

/** Wait for an element containing `text` to be visible, with a hard timeout. */
async function waitForText(page, text, timeoutMs = 20_000) {
  await page.locator(`text=${text}`).first().waitFor({ state: 'visible', timeout: timeoutMs });
}

// ── 1. Terminals page with a live session ────────────────────────────────

async function captureTerminals(page) {
  await page.goto(`${BASE_URL}/terminals`, { waitUntil: 'domcontentloaded' });
  // The interactive panel (terminal-panel.tsx) renders a bare xterm — its
  // container carries no data marker, so key off the xterm DOM itself.
  const xtermRoot = page.locator('.xterm').first();
  const hasLiveSession = await xtermRoot.waitFor({ state: 'visible', timeout: 8_000 })
    .then(() => true)
    .catch(() => false);

  if (!hasLiveSession) {
    // The app marks components with data-component (the E2E suite remaps
    // getByTestId to it; standalone scripts must use CSS locators instead).
    const newTerminalBtn = page.locator('[data-component="new-terminal-btn"]');
    await newTerminalBtn.waitFor({ state: 'visible', timeout: 30_000 });

    // Open the New Terminal dialog (retry — the button is SSR'd but hydration
    // may not have attached onClick yet).
    const dialogBackdrop = page.locator('[data-component="dialog-backdrop"]');
    await retryUntil(async () => {
      await newTerminalBtn.click();
      await dialogBackdrop.waitFor({ state: 'visible', timeout: 500 });
    });

    // Pick the Coder role for the most interesting CLI UI (falls back to the
    // first available role when the label isn't present).
    const select = page.locator('select').first();
    const options = await select.locator('option').allTextContents();
    const preferred = options.findIndex((label) => /coder/i.test(label));
    await select.selectOption({ index: preferred >= 0 ? preferred : 0 });

    await page.getByRole('button', { name: 'Open', exact: true }).click();
  }

  // Wait for the deferred xterm init, then give the PTY time to render the
  // interactive CLI banner/prompt before capturing.
  await page.locator('.xterm-rows').first().waitFor({ state: 'visible', timeout: 30_000 });
  await sleep(6_000);

  await page.screenshot({
    path: join(OUT_DIR, 'terminals.jpg'),
    type: 'jpeg',
    quality: JPEG_QUALITY,
  });
  console.log('✓ terminals.jpg');
}

// ── 2. Failed task overview (diagnostics) ────────────────────────────────

async function captureDiagnostics(page) {
  // The failed criteria + QA evidence live on the QA tab (the Overview tab
  // only shows dependencies).
  await page.goto(`${BASE_URL}/task/FAIL-001#qa`, { waitUntil: 'domcontentloaded' });

  // Failed title + criteria table render server-side from task.json.
  await waitForText(page, 'Fix Checkout Timeout Under High Load', 30_000);
  await waitForText(page, 'P95 under 2s at 500 users', 30_000);
  await waitForText(page, 'Additional Issues', 20_000);
  await sleep(1_500);

  await page.screenshot({
    path: join(OUT_DIR, 'diagnostics.jpg'),
    type: 'jpeg',
    quality: JPEG_QUALITY,
  });
  console.log('✓ diagnostics.jpg');
}

// ── 3. Kanban board scrolled to Delivered ────────────────────────────────

async function captureDelivered(page) {
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  await waitForText(page, 'Backlog', 30_000);
  await waitForText(page, 'Order Tracking Dashboard', 20_000); // a DONE card
  await sleep(1_000);

  // Scroll the board fully right so the Done column is in view.
  await page.evaluate(() => {
    const container = document.querySelector('.overflow-x-auto');
    if (container) (container).scrollLeft = (container).scrollWidth;
  });
  await sleep(1_000);

  await page.screenshot({
    path: join(OUT_DIR, 'delivered.jpg'),
    type: 'jpeg',
    quality: JPEG_QUALITY,
  });
  console.log('✓ delivered.jpg');
}

// ── Main ──────────────────────────────────────────────────────────────────

mkdirSync(OUT_DIR, { recursive: true });

const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
  });
  await selectDemoProject(context);

  const page = await context.newPage();
  page.setDefaultTimeout(30_000);

  await captureTerminals(page);
  await captureDiagnostics(page);
  await captureDelivered(page);
} finally {
  await browser.close();
}
