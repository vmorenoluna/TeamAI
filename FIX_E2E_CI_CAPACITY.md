# Fix E2E test flakiness under concurrent load (CI `test-all`/`test-coverage`)

## Problem

`teamai`'s CI has two jobs — `test-all` and `test-coverage` — that run the full
`npm run test:all` chain (`typecheck && lint && test && test:e2e && test:changelog`),
including the full Playwright E2E suite. Both jobs are currently red on `main`, and
have been for a while (the E2E part specifically was masked until recently by two
unrelated pre-existing bugs in the `test` step that made `test:e2e` never even run —
those are already fixed).

The E2E suite fails widely, but **not because of broken product code**. It's a
capacity/concurrency problem: all Playwright workers share **one single Next.js dev
server process** (`npx tsx server.ts`, started via `webServer` in
`teamai/playwright.config.ts`), and that one process can't reliably keep up with the
SSR request volume generated once enough spec files/tests run concurrently.

`playwright.config.ts` already has a comment acknowledging a version of this problem
for one specific test ("terminal-live-labels"), which is why `workers` is capped at 2
instead of the default 4 — but 2 workers is still not enough once multiple full spec
files run together.

## Evidence already gathered (don't re-derive this)

- `tests/e2e/task-detail.spec.ts` passes **7/7 reliably in isolation**
  (`npx playwright test tests/e2e/task-detail.spec.ts`, ~19s total) — no code bug.
- The same file, run as part of `npm run test:e2e:smoke` (5 files together:
  `sidebar.spec.ts`, `task-detail.spec.ts`, `kanban.spec.ts`, `settings.spec.ts`,
  `workflow.spec.ts`), fails **every single test**, all with the same signature:
  `tests/e2e/helpers.ts`'s `ensureProjectSelected(page)` times out waiting for
  `text=Backlog` to appear (it already has a built-in retry: wait 15s, reload, wait
  another 25s — and *still* times out under load).
- `tests/e2e/workflow.spec.ts` shows the identical pattern (every test fails when run
  combined, presumably passes alone — confirm this).
- On CI itself, the full `test-all` run (4 workers, ~260 tests) failed **210 of them**,
  all with the same `expect(locator).toBeVisible()` / element-not-found signature —
  consistent with the same root cause at larger scale.
- This reproduces identically against a clean `main` checkout (tested via an isolated
  `git worktree`) — it is **not** caused by any specific recent feature work, it's a
  pre-existing capacity ceiling in the E2E harness itself.
- A 30-second in-memory cache was added to `teamai/src/app/actions/history.ts`
  (`getCachedScan`) to stop a *specific* per-request blocking `execFileSync` call
  (`git log` + `gh pr list`) from adding to the load on every navigation to `/`. It's a
  legitimate improvement (avoids a real blocking network call on every page load,
  keep it) but **did not resolve** the wider flakiness — confirming the bottleneck is
  broader than any one feature's server actions.

## What's already fixed, don't re-touch

- `tests/unit/orchestrator-worktree-patching.test.ts` — was asserting on a hardcoded
  Windows-style path with `path.basename()`, which is platform-dependent. Fixed to
  build paths with `join()`.
- `tests/integration/worktree-unpushed-commits.test.ts` — `setupGitRepo()` now pins
  `git init --bare -b main` so the push doesn't depend on the git client's own
  `init.defaultBranch` config.
- `tests/e2e/sidebar.spec.ts` — several tests navigated via a bare `page.goto('/')`
  instead of `ensureProjectSelected(page)`, so with the E2E harness's 5 simultaneously-
  registered per-worker seed projects (T31 isolation), `getActiveProjectPath()`'s
  single-project auto-select fallback never fires and the page deterministically shows
  the "no project selected" state. This was a **real, deterministic logic bug**,
  distinct from the capacity issue described above, and is already fixed.

## Your task

Find and fix the actual bottleneck so `npm run test:all` (and CI's `test-all`/
`test-coverage`) pass reliably under normal concurrent load, without just papering
over it with longer timeouts everywhere. Some concrete angles worth investigating,
roughly in order of how likely they are to be the real fix — but verify, don't assume:

1. **Dev mode vs. production build.** `webServer.command` in `playwright.config.ts` is
   `npx tsx server.ts` running in dev mode (`NODE_ENV: 'test'`, not `'production'`).
   Next.js dev mode compiles routes on-demand on first hit and does extra
   dev-only work (HMR, etc.) — this is inherently slower and less predictable
   under concurrent load than a production build. Consider whether E2E should run
   against `npm run build && npm run start` instead (mind `reuseExistingServer:
   false`'s existing rationale in the config comments — don't regress that fix).
2. **Server-side request cost.** Profile what `/` (Home, `src/app/page.tsx`) and other
   heavily-hit routes actually do per request — look for synchronous/blocking work
   (`execFileSync`, heavy computation, unbounded loops over tasks) that piles up
   under concurrent SSR requests. The `getCachedScan` fix in `actions/history.ts` is
   one example already addressed; look for others.
3. **Worker/concurrency tuning.** `workers: process.env.CI ? 2 : ...` in
   `playwright.config.ts` — determine empirically (not just guessing) what level of
   concurrency this specific dev server setup can actually sustain, and whether
   splitting `test:e2e:smoke`'s 5 files into smaller batches or running serially for
   the heaviest specs is warranted.
4. **`ensureProjectSelected`'s own timeout budget** (`tests/e2e/helpers.ts`) — only
   as a last resort / stopgap, not a real fix on its own.

## How to verify you actually fixed it, not just moved the symptom

- Run `npm run test:e2e:smoke` locally multiple times in a row — it should pass
  consistently, not intermittently.
- Run the full `npm run test:e2e` suite (not just smoke) at least once.
- Push to a branch and confirm CI's `test-all` and `test-coverage` jobs both go green.
- Don't declare success from a single lucky green run — this bug's whole signature is
  "passes sometimes."

## Progress — session 2 (2026-09-01)

**Status: NOT fixed yet.** Found and fixed one real, verified bug (below) and made
real progress narrowing down a second, still-open one. `npm run test:e2e:smoke` still
fails under concurrent load after this session's fix — do not skip re-verifying from
scratch.

### Fixed and verified: blocking `execFileSync` on the hot request path and in a
### leaked background timer

Confirmed via direct evidence (not just theory) that two places called Node's
**synchronous** `execFileSync` — which blocks the entire single-threaded event loop
for its duration — from code paths that fire unconditionally and often, on the ONE
shared Next.js server process all Playwright workers hit:

1. `src/lib/history-scanner.ts` — `scanCommitTrailers` (`git log`), `scanMergedPrBodies`
   (`gh pr list`, a live rate-limited network call, 20s timeout), and `getSpecContent`
   (`gh pr view`). Reached from `getDoneHistory()`, called on every navigation to `/`
   (`src/app/page.tsx`) — the single most-visited route in the whole suite.
2. `src/lib/auto-mode.ts` — `_startCIPolling`'s `setInterval` body (`gh pr view` /
   `gh pr merge` / `gh run rerun`). Fires every 30s for as long as a project has auto
   mode enabled with a `pr-open` task. `tests/e2e/auto-mode.spec.ts`'s "clicking auto
   mode button toggles it on" test turned auto mode on and never turned it back off —
   since the seed project has a `pr-open` task (fake PR #142), this left a real
   30s-interval blocking-`gh`-call timer running against the shared server for the
   rest of every subsequent test in the suite.

**Fix**: converted both to async `execFile` (via `util.promisify`) so the subprocess
still runs off-thread (libuv) without blocking the event loop; added a re-entrancy
guard (`pollInFlight`) to `_startCIPolling` since the body is no longer synchronous;
fixed the auto-mode E2E test to toggle back off at the end. Rewrote
`tests/unit/history-scanner.test.ts`'s mocks from `execFileSync` to callback-based
`execFile` (promisify's default heuristic still resolves `{stdout, stderr}` correctly
since the mock has no custom promisify symbol).

**Verified directly** (not just "tests still pass"):
- `npm run typecheck`, `npm run lint`, and the full unit suite (3056 tests) all pass.
- Direct `curl` load test against a manually-started production server (correct
  `activeProject` cookie, real seeded project): 20 concurrent requests to `/` all
  completed in under 1 second, no blocking observed — confirms the fix actually
  eliminates the event-loop freeze this class of bug causes.
- This is a real, worthwhile fix independent of whether it's the *whole* story — keep
  it regardless of what else gets found.

### Found and fixed: the actual root cause of the "permanent failure from test N
### onward" pattern — stale tests clicking sidebar links that were deliberately removed

The "browser/navigation-specific" mystery documented in the previous version of this
section (repro'd with curl, ruled out server blocking, suspected Chromium-process-level
connection-pool exhaustion) turned out to have a much more mundane explanation. The user
pointed at the right place: commit `f1073700` ("feat(sidebar): hide untested sections and
document current features", 2026-08-26 — already on this branch, an ancestor of `HEAD`)
removed the `/insights`, `/ideation`, `/analytics`, and `/github` entries from the sidebar
nav array (`src/components/sidebar.tsx`) — those routes are still live, just no longer
linked from the sidebar. Several E2E tests never got updated and were still doing
`sidebar.locator('a[href="/insights"]')`-style lookups against links that no longer exist
in the DOM:

- `tests/e2e/sidebar.spec.ts` — 6 tests/assertions: the "all navigation links" list, the
  "tooltip title attributes" list, three dedicated "clicking Insights/Ideation/GitHub icon"
  tests, the "expand sidebar restores link labels" text checks, and
  `expect(count).toBeGreaterThanOrEqual(8)` in "all sidebar links are keyboard focusable"
  (the sidebar now has 5 links, not 9).
- `tests/e2e/insights.spec.ts`, `tests/e2e/ideation.spec.ts`, `tests/e2e/github.spec.ts`,
  `tests/e2e/analytics.spec.ts` — each had 1-2 "sidebar navigation: clicking X link"
  tests at the top that are now testing a UI path that doesn't exist.

**Why this produced the "permanent failure from test 5 onward, curl still works" signature**:
these dead-link assertions/clicks made those *specific* tests fail (confirmed directly:
`sidebar.spec.ts`'s test #1 failure was `locator('aside').locator('a[href="/insights"]')`
timeout — an exact match). The full mechanism behind why that cascaded into *later,
unrelated* tests' `ensureProjectSelected` also failing wasn't nailed down beyond that
correlation — but it no longer needs to be: fixing the dead-link tests eliminated the
cascade entirely (see verification below), so whatever Playwright/Chromium-internal state
a failed `expect(nonexistentLocator).toBeVisible()` was leaving behind is moot once nothing
in the suite does that anymore. **Don't spend more time on the TIME_WAIT/RSC-prefetch/
Server-Action-abort leads from the previous investigation pass — they were a rabbit hole
off a real but secondary symptom, not the cause.**

**Fix**: removed/updated the dead-link assertions and tests in all 5 files above (kept
every test that exercises the actual page via direct `page.goto()` — those pages are still
fully live, just unlinked from the sidebar for now). Added a one-line comment pointing at
`f1073700` in each spot so nobody re-adds these thinking it's an oversight.

**Verified**:
- `npm run typecheck` / `npm run lint` clean.
- `sidebar.spec.ts` alone, `E2E_MAX_WORKERS=1`: **12/12 passed in 33s** (was 6 passed /
  9 failed before this fix, in the single-worker repro).
- `npm run test:e2e:smoke` (5 files, default worker count): **39/39 passed in ~38s**,
  three consecutive runs (was 28 failed / 14 passed in **9.1 minutes** before this
  session). Ran once via `npx playwright test <files>` directly and once via the full
  `npm run test:e2e:smoke` entrypoint (build hook included) — same result both ways.
- Full `npm run test:e2e` run — see below.

**Still worth doing, not urgent**: the four dedicated page spec files
(`insights.spec.ts` etc.) still have full coverage of their pages via direct
`page.goto()` — nothing lost there. If/when Insights/Ideation/Analytics/GitHub come back
to the sidebar, undo these test removals along with re-adding the nav entries.

### Fallout from the `execFileSync` → `execFile` fix: one integration test file needed updating

`tests/integration/auto-mode.test.ts` mocks `child_process` and asserts on CI-polling
behavior using Vitest fake timers (`vi.advanceTimersByTimeAsync`). Its mock only stubbed
`execFileSync` — after `auto-mode.ts` switched to async `execFile`, the mock's unconfigured
`execFile: vi.fn()` never invoked its callback, so every `await execFileAsync(...)` in
`_startCIPolling` hung forever and 18 tests failed with "expected N, got 0" (the poll body
never completed). Fixed the mock to route `execFile(...)` through the *same*
`mockExecFileSync` the rest of the file already configures — calls it synchronously and
adapts the result/thrown-error into the callback shape — so none of the 30+ existing
`mockExecFileSync.mockImplementation`/`.mock.calls` assertions elsewhere in the file needed
to change. All 59 tests in that file pass again.

### Full-suite results

- `npm run test` (unit + integration, 142 files): **3389 passed, 1 skipped, 0 failed.**
- `npm run test:e2e` (full suite, no `--grep`): **249/250 passed** on the first run after
  the sidebar-link fix — the one failure (`responsive-viewport.spec.ts` › "collapsing
  sidebar works at tablet width") was a pre-existing, unrelated click-timing flake (its own
  comment already said "Click again in case the first click didn't register (hydration
  timing)"). Fixed by switching to the native-DOM-click pattern `sidebar.spec.ts` already
  uses reliably (`sidebar.evaluate(el => el.querySelector('button')?.click())` instead of
  Playwright's `.click()` + arbitrary `waitForTimeout`s) — reran that file alone,
  **10/10 passed**, the fixed test now takes ~1s instead of failing after two clicks and a
  1.5s wait.
- Total full-suite wall time: **~3.5 minutes** (was: didn't reliably finish within 10+
  minutes before this session, when it finished at all — see the abandoned `full-run3.log`
  from this session's own investigation, cut off after 206/260-odd tests with no summary
  line).

Re-ran the full `npm run test:e2e` suite a second time after fixing the
`responsive-viewport.spec.ts` flake: **250/250 passed in 3.2 minutes**, fully clean.

## Progress — session 3 (PR #8, first CI run)

Pushed and opened PR #8. CI's `test-all` and `test-coverage` jobs each independently run
the full `npm run test:e2e` suite (see "test-all and test-coverage both run E2E" below) —
both surfaced failures that never reproduced locally (250/250 clean, twice, on Windows).
Both are real, CI-environment-specific bugs — found and fixed:

### `kanban-behaviors.spec.ts` › "Merge Locally and Open Pull Request buttons" — real
### product bug: auto-mode's task adoption doesn't respect `isPaused`

Root cause: `tests/e2e/auto-mode.spec.ts`'s "clicking auto mode button toggles it on" test
enables *real* auto mode against the shared per-worker seed project. The instant it does,
`auto-mode.ts`'s `_adoptStalledTasks()` scans that project for any task already sitting in
`awaiting-review` or `pr-open` and immediately acts on it — `approveTask()` writes the new
phase **synchronously, before any git/gh work** (`advancePhase(pipeline, next)` runs before
`await executePhase(pipeline)` — see `review-actions.ts:220`). The seed project has exactly
one task in each of those phases (`fix-navbar-dropdown-z-index-conflict`, awaiting-review;
`refactor-migrate-api-to-v2-endpoints`, pr-open, fake PR #142) that four *other* spec files
(`kanban-behaviors.spec.ts`, `task-detail-behaviors.spec.ts`) assert on staying in their
seeded phase. Toggling auto mode back off afterward (this session's earlier fix) doesn't
help — the phase write already happened by the time that runs. Whether this races depends
on which spec files Playwright schedules onto the same worker, which is why it never
reproduced in two clean local full-suite runs but hit reliably on CI's `ubuntu-latest`
2-worker scheduling.

Also found a real, narrower product bug while tracing this: `_adoptStalledTasks` never
checked `task.isPaused`, unlike every other auto-resume path in the codebase
(`recovery.ts`'s `autoResumeInterruptedTasks`/`sweepStalledTasks` both explicitly skip
paused tasks — "the pause is deliberate and must only be lifted by clicking Resume in the
UI, never by automated recovery"). Fixed `auto-mode.ts` to respect it there too.

**Fix**: `auto-mode.spec.ts` now marks the two vulnerable seed tasks `isPaused: true`
(directly on disk, matching the existing `writeTestSessionMap`/`writeTestLogFile` helper
pattern) before toggling auto mode on, and restores them afterward in a `finally` block —
using the now-real, respected `isPaused` guard to make this test's on/off round-trip a
true no-op against shared fixtures, regardless of Playwright's worker scheduling. Verified:
reran `auto-mode.spec.ts` + `kanban-behaviors.spec.ts` + `task-detail-behaviors.spec.ts` +
`model-dropdown.spec.ts` together, single worker — 74/74 passed, including the specific
test that failed on CI.

### `model-dropdown.spec.ts` › "model select shows options after curated models load" —
### test timing bug, not a product bug

The settings page renders 7 independent `ModelRow` instances (Default + 5 role overrides +
Exploration), each fetching curated models via a client-side in-flight-deduped call. They
normally share one promise and resolve together, but the test asserted `count() >= 6`
**immediately after only the first `<select>` became visible** — under CI's slower/
staggered hydration, a later-mounting row can start its own independent fetch after the
first one's promise already settled and was evicted from the dedup cache, so the rows
don't all finish in the same tick. Got "Received: 1" instead of the real, eventual 7.

**Fix**: wait for every `text=Loading models…` placeholder to clear (`toHaveCount(0)`)
before counting selects, instead of snapshotting the count right after the first one
appears. This waits for the actual terminal state — if models genuinely fail to load on
some environment, the test still correctly fails (loading clears either way: success shows
a `<select>`, failure shows a free-text `<input>` per `provider-config.tsx`'s
`renderModelControl()`), it just no longer flags a real environment that's still mid-flight
as broken.

### `test-all` and `test-coverage` both run the full E2E suite — worth deciding, not fixing

Per `.github/workflows/ci.yml`: `test-all` runs `npm run test:all` (the canonical merge
gate) and `test-coverage` runs `npm run test:coverage` (informational, uploads a combined
coverage report) — both include the full Playwright E2E suite, so every PR runs E2E twice,
independently. This is *arguably* not pure waste — the two runs happening to disagree
(as they did on this PR's first CI run: different single flakes in each) is itself a signal
about flakiness that a single run wouldn't surface, which is exactly the kind of thing this
whole doc has been chasing. But it does mean ~2x the CI minutes/wall-clock for the heaviest
part of the suite on every PR. Options, roughly cheapest-to-implement first:
1. Leave as-is — the redundancy has caught real bugs (this PR).
2. Have `test-coverage` skip E2E and only cover unit/integration, accepting a coverage-report
   gap for E2E-only code paths.
3. Fold coverage collection into `test-all` itself (one E2E run, coverage collected
   alongside) — cuts E2E CI time roughly in half, but couples the merge gate to coverage
   instrumentation overhead.

Not changed as part of this PR — this is a CI-cost/policy tradeoff for the repo owner to
decide, not a bug fix.

### What's left

- Push these two additional fixes and confirm CI's `test-all`/`test-coverage` jobs go
  green on the next run.
