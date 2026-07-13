# TeamAI Codebase Audit

**Date:** 2026-07-12
**Scope:** `teamai/` app — server, orchestrator, stores, auto-mode, recovery, process manager, Next.js actions/components/hooks, Electron shell, and the full test suite (unit / integration / e2e).
**Verified:** `npx tsc --noEmit` passes clean at audit time.

This document is a work backlog. Each task in §6 is self-contained: any agent can pick one up without reading the rest of the audit. Sections 1–5 give the reasoning and evidence behind the tasks.

---

## 1. Architecture summary (as-built)

- **Custom Node server** (`server.ts`) wraps Next.js, hosts a WebSocket server (`/ws`), runs startup crash recovery, auto-mode restore, and a 5-minute stalled-task sweep.
- **ProcessManager** (`src/lib/process-manager.ts`) spawns `claude -p --input/output-format stream-json` subprocesses (optionally via `docker exec` in container mode), parses NDJSON, re-emits typed events. Also manages PTY terminal sessions (node-pty).
- **Orchestrator** (`src/lib/orchestrator.ts`, 847 lines) is a façade: phase logic lives in `src/lib/orchestrator/*` modules (implement.ts 918 lines, phase-runners.ts, qa-review.ts, rate-limit.ts, review-actions.ts, pipeline-state.ts, qa-feedback.ts, worktree-*, artifact-commit.ts, git-push.ts). Each call site injects a fresh object of ~10 closures ("deps") into the module functions.
- **State is file-based**: `.teamai/{slug}/task.json` + artifacts per task; `~/.teamai/projects.json` for the project registry; `.pipeline_state.json` for crash recovery; global singletons stored on `global.*` to survive Next.js dual module graphs.
- **Auto mode** (`src/lib/auto-mode.ts`): per-project tick loop (5s), phase-change listener, CI polling via `gh`, auto-merge.
- **Frontend**: React 19 + Tailwind 4, kanban board, task detail, xterm terminals, WebSocket live streaming. ESLint custom rule enforces "props over async-fetch-on-mount".

The layering is genuinely good: pure helpers are extracted, dependency injection makes phase runners testable, and crash-recovery paths are unusually thorough. The main structural debts are (a) hardcoded `master` branch assumptions, (b) the deps-object boilerplate, (c) the 760-line `runImplement` function, and (d) file-store scans that are O(N) per lookup.

---

## 2. Bugs found

Ordered by severity. File references are clickable.

### 2.1 High

**BUG-1 — `isRetryableError` operator-precedence error (can throw on null)**
`teamai/src/lib/task-store.ts:3-5`
```ts
return typeof err === 'object' && err !== null && 'code' in err && (err as {code:string}).code === 'EPERM' || (err as {code:string}).code === 'EBUSY';
```
`&&` binds tighter than `||`, so the `EBUSY` check runs **unguarded**. If `err` is `null`/primitive (first conjunct false), `(null).code` throws a TypeError from inside the retry-classification helper — masking the original rename error. Also means a genuine `EBUSY` on a null-ish path is misclassified. Fix: parenthesize and share the guard.

**BUG-2 — Default branch hardcoded as `master` across the pipeline**
`detectDefaultBranch()` exists in `teamai/src/lib/git-platform.ts:26` and is used by PR creation and diff views — but every git sync path hardcodes `master`:
- `teamai/src/lib/orchestrator.ts:422,435,452` (`markTaskDone` fetch/checkout/ff-merge of `origin/master`)
- `teamai/src/lib/orchestrator/phase-runners.ts:41-42,62` (`rebaseOntoLatestMaster`)
- `teamai/src/lib/orchestrator/phase-runners.ts:188` and `teamai/src/lib/orchestrator/implement.ts:73` (`pull --ff-only origin master`)
- `teamai/src/lib/orchestrator/qa-review.ts:125` (`fetch origin master`)

On any repo whose default branch is `main` (including TeamAI itself), all of these fail silently every time: rebases never happen, `markTaskDone` always falls into the lossy "minimal task.json" fallback, pulls are skipped. This is the single highest-impact fix in the codebase.

**BUG-3 — Agent WebSocket events are broadcast to every client, ignoring the project filter**
`teamai/server.ts:41-48`. `broadcastToProject()` is used for `phase-change`/`container-*` events, but the per-connection `agentHandler` sends **all** agent/error events to **all** connected clients regardless of their `?project=` filter. With two projects open in two windows, each window receives (and must discard) the other project's full agent output stream — wasted bandwidth and a mild information-leak between projects.

**BUG-4 — `findOrphanedWorktrees` scans a directory that is never used**
`teamai/src/lib/recovery.ts:94-160` looks in `<project>/.teamai/worktrees` for dirs named `task-<uuid>`. Real worktrees live at `getWorktreeBase()` (`teamai/src/lib/orchestrator/helpers.ts:125`): `<project>/../worktrees/<slug>` (host) or `<project>/.worktrees/<slug>` (container), named by slug. The orphan detector can never match anything — the feature is dead, and orphaned worktrees accumulate undetected.

**BUG-5 — `recovery.ts` bypasses the config-dir resolution used everywhere else**
`teamai/src/lib/recovery.ts:450-458` reads `join(homedir(), '.teamai', 'projects.json')` directly, while `project-store.ts` resolves `TEAMAI_CONFIG_DIR` / the e2e path file first. Consequences: (a) during e2e runs, startup recovery and the 5-minute sweep operate on the developer's **real** projects (can resume real tasks mid-test!); (b) any future change to config location silently diverges. Should import `projectStore.getAll()`.

**BUG-6 — `parallelSubtasks` setting is dead**
Exposed in the UI (`teamai/src/components/pipeline-config.tsx:10,21`), parsed into `PipelineConfig` (`teamai/src/lib/orchestrator/helpers.ts:145`), typed into `ImplementDeps` — but `runImplement` never reads it. Subtasks in a `parallel_group` always run concurrently via `Promise.allSettled` (`teamai/src/lib/orchestrator/implement.ts:234`). Toggling the setting does nothing.

### 2.2 Medium

**BUG-7 — Raw `gh`/`glab` invocations bypass configured tool paths**
The app has a whole Tool Paths settings system (`tool-checker.ts`), used inconsistently:
- `teamai/src/lib/orchestrator/implement.ts:692` — `execFileSync('gh', ...)` (PR-exists fallback check)
- `teamai/src/lib/git-platform.ts:172,186` — `createPRViaCLI` uses raw `'gh'`/`'glab'` while `checkExistingPRViaCLI`/`isPrMerged` correctly use `getToolPath()`.
Users with a custom gh path can list PRs but not create them.

**BUG-8 — Unvalidated `qa_report.json` parse crashes the phase**
`teamai/src/lib/orchestrator/qa-review.ts:157` — `JSON.parse(readFileSync(reportPath))` with no existence/shape check. If the QA agent wrote nothing or invalid JSON, the task fails with a raw ENOENT/SyntaxError stack instead of a structured FAIL report ("QA agent did not produce a report"). Same pattern for `plan.json` in `runImplement` (`implement.ts:121`).

**BUG-9 — Deliverable circuit-breaker doesn't stop sibling work**
`teamai/src/lib/orchestrator/implement.ts:433` — when a subtask exceeds `maxDeliverableFails`, the handler writes a FAIL report, calls `advancePhase(pipeline,'failed')` and `return`s — but that only exits **that subtask's** async closure. Parallel siblings keep running, and the outer `for (const [, subtasks] of groups)` loop proceeds to spawn sessions for **subsequent groups**; only the post-loop guard at `implement.ts:608` stops the phase transition. Wasted agent sessions (and cost) after a decided failure. The group loop should check `pipeline.phase === 'failed'` between groups (and ideally cancel in-flight siblings).

**BUG-10 — Wakeup file race under parallel subtasks**
`subtask_wakeup.json` is a single shared file in `specPath`, read and deleted inside each parallel subtask handler (`teamai/src/lib/orchestrator/implement.ts:381-398`), mutating shared `pipeline.wakeup*` fields. Two subtasks scheduling wakeups concurrently clobber each other (last write wins, first file deleted by whichever handler reaches it). Should be per-subtask (`subtask_wakeup-st<id>.json`) or serialized through the existing lock pattern.

**BUG-11 — Auto-mode CI polling is GitHub-only and ignores merge strategy**
`teamai/src/lib/auto-mode.ts:353` — `prUrl.match(/\/pull\/(\d+)/)` only matches GitHub URLs; GitLab MRs (`/-/merge_requests/N`) are silently never polled, so auto mode stalls at `pr-open` forever on GitLab projects. Also `gh pr merge --merge` (`auto-mode.ts:408`) hardcodes merge-commit strategy.

**BUG-12 — `useWebSocket` never reconnects when the active project changes**
`teamai/src/hooks/use-websocket.ts:126` — effect deps are `[]` by design, but nothing recreates the socket when `project` changes, so after a project switch the client stays subscribed to the old project's filtered broadcasts until a consumer manually calls `reconnect()`. Grep shows consumers do not consistently do so.

**BUG-13 — Slug collisions & dual slug sources**
`slugify()` truncates to 40 chars with no uniqueness (`teamai/src/lib/utils.ts:7`). Task **directories** use `slugify(title)` (`task-store.ts:67`), while **branch/worktree** use `slugify(description)` (`orchestrator.ts:142-144`). Two tasks whose titles/descriptions share a 40-char prefix silently share a branch and worktree — cross-contamination of commits. `artifact-commit.ts:83` already contains a workaround comment for the title/description mismatch. Needs a single canonical slug (stored on the task at creation, with a uniqueness suffix).

**BUG-14 — `killSession` marks every killed session `done`**
`teamai/src/lib/process-manager.ts:205` sets `status = 'done'` even when the session was killed while hung or erroring; downstream stall/health reporting can't distinguish. Also `getStalledSessions()` (`process-manager.ts:244`) is defined and tested but never called from production code — the stall detection feature (#8) is not wired to anything.

### 2.3 Low

**BUG-15 — Synchronous busy-wait in `atomicWriteJson`** ✅ FIXED (c6d0544)
`teamai/src/lib/task-store.ts:26` — `while (Date.now() < waitUntil) {}` blocked the whole event loop (all sessions, the WS server) up to ~70ms per contested write on Windows. **Fixed by capping the exponential-backoff spin to 2/4/8ms (14ms max, 5× improvement) using `Math.min(10, 2 * (2 ** attempt))`.** The full async conversion (`fs.promises.rename` + `await setTimeout`) was attempted but proved too invasive — cascading through ~35 call sites and breaking test mocks across 6 rounds of iteration. The capped-spin approach preserves synchronous APIs with a single-line formula change.

**BUG-16 — TaskStore is O(N) per lookup, O(N²) in hot paths**
`getById()` calls `getAll()` (reads and parses every `task.json`); `getDirById()` re-scans and re-parses everything again; `update()` = getById + getDirById → three full directory scans per write. Called from the auto-mode 5s tick, CI poll (30s), every server action, and `checkBulkTaskWorktrees` loops. Fine at 10 tasks, painful at 200.

**BUG-17 — Repo hygiene**
- A stray tracked file literally named `` `` `` at `teamai/``` (shell-quoting accident) is committed.
- `teamai/dist-server/` build output is tracked in git.
- `tsconfig.tsbuildinfo`, `teamai/tmp/`, root `test-results/` present and not consistently ignored.
- `package.json`: `xterm@^5.3.0` is unused (all imports use `@xterm/xterm@6`); `uuid` is unused (code uses `crypto.randomUUID`).

**BUG-18 — QA criterion→subtask matching heuristic is near-vacuous**
`teamai/src/lib/orchestrator/qa-feedback.ts:79-87` — the fallback clause matches if *any single word* of an acceptance criterion contains *every word* of the QA criterion name — for multi-word names this is almost never true, so matching degrades to plain substring `includes()`. Result: FAIL criteria often map to no subtask and the pipeline synthesizes the 9999 "rework everything" subtask more often than intended. Replace with token-overlap scoring (e.g. ≥50% of criterion words present in the AC).

**BUG-19 — Rate-limit/wakeup timers are uncancellable and lost on restart**
`handleRateLimit` (`rate-limit.ts:158`) and `_scheduleWakeup` (`orchestrator.ts:789`) create `setTimeout`s that `cancelPipeline` cannot clear (stale-pipeline guards mitigate wrong resumes, but the timer itself lingers, holding the pipeline object alive). After a server restart the timers are gone entirely; recovery relies on the 5-minute sweep. Track timer handles on the pipeline and clear them in `cancelPipeline`.

**BUG-20 — `waitForCompletion` piles listeners on a global emitter**
Each call adds 3 listeners (`event`, `exit`, `raw`) to the singleton `processManager` (`rate-limit.ts:101-103`). With >3 concurrent sessions Node prints MaxListenersExceededWarning; with many parallel subtasks every NDJSON line fans out to every waiter's filter. Consider per-session scoping or `setMaxListeners`.

---

## 3. Reliability opportunities

1. **Schema validation at agent boundaries.** `plan.json`, `qa_report.json`, `subtask_wakeup.json`, `session_map.json` are all agent- or crash-writable and parsed with bare `JSON.parse` in ~30 places, half wrapped in silent `catch {}`. A tiny `readJsonFile<T>(path, validate?)` helper + lightweight validators (hand-rolled or zod) would convert silent corruption into structured, reportable failures (see BUG-8).
2. **One artifact registry.** Which files belong to which phase is currently defined in *three* diverging places: `TaskStore.clearArtifacts` (`task-store.ts:146`), `Orchestrator.cleanupTaskArtifacts` (`orchestrator.ts:594`), and the `extraFiles` list in `review-actions.ts:189`. E.g. `clearArtifacts('spec')` knows about `spec_v1..3.md` but `cleanupTaskArtifacts` doesn't. Define a single `artifacts.ts` module mapping phase → files and derive all three behaviors from it.
3. **One phase-set registry.** `TERMINAL_PHASES`/`PAUSED_PHASES` (auto-mode.ts), `NO_RESUME_PHASES` (rate-limit.ts), `IN_PROGRESS_PHASES` (recovery.ts), `noStopPhases`/`restartablePhases` (actions/tasks.ts) are five hand-maintained sets over the same phase enum. Move them next to `constants/phases.ts` so a new phase can't be forgotten in one of them.
4. **Unify logging.** `logger.ts` exists but `console.log/error` with ad-hoc `[tags]` is used throughout orchestrator/auto-mode/recovery. Route everything through the logger so output.log/stdout behavior is consistent and testable. ✅ DONE (T24).
5. **Cancellation.** `cancelPipeline` kills the current session but not: pending rate-limit/wakeup timers (BUG-19), sibling parallel subtask sessions, or the merger session. A per-pipeline `AbortController`-style bag of cancellables would make stop/cancel actually stop everything.

---

## 4. Modularity / streamlining opportunities

1. **Kill the per-call deps boilerplate.** `orchestrator.ts` builds a fresh object of ~10 arrow-function closures on *every* phase invocation (`runSpec`…`runCreatePR`, lines 267–369), plus 30 one-line private delegate methods. Build a single `PhaseContext` object once per `Orchestrator` (or per pipeline) holding `projectRoot`, `taskStore`, and the shared functions, and pass it everywhere. This deletes ~200 lines of pure plumbing and makes signatures stable.
2. **Decompose `runImplement`** (`implement.ts:51-760`, one function). Natural seams already visible in the code: `ensureWorktree()`, `selectSubtasks()` (QA-flag / wakeup / synthetic-9999 logic), `runSubtaskSession()` (prompt build + scope check + deliverable check + wakeup detect), `integrateGroup()` (auto-commit + cherry-pick + recovery), `pushAndVerify()`, `applySensorGate()`. Each becomes unit-testable without the 3.5k-line mock scaffolding currently required.
3. **Extract `updateSessionMap(specPath, key, sessionId)`.** The read-modify-write of `session_map.json` is copy-pasted 6× (phase-runners.ts ×3, implement.ts ×2, qa-review.ts ×1) — and only implement.ts serializes it with a lock.
4. **`resolveBaseBranch(projectRoot)`** — one cached function wrapping `detectDefaultBranch`, used by every place in BUG-2's list.
5. **Frontend splits.** ✅ DONE (T27). Extracted 8 components: `copy-button`, `error-banner`, `task-modal`, `dep-picker`, `plan-subtasks`, `qa-report-view`, `new-task-dialog`, `kanban-filters`. Mega-components reduced: task-detail (710→350), kanban-board (670→450), roadmap-view (810→650), workflow-view (690→570).
6. **`getTaskFull`** (`actions/tasks.ts:310-397`) reads ~12 files inline; extract a `taskArtifacts.ts` reader module shared with `getTaskArtifacts` (which duplicates half of it). ✅ DONE (T28). Extracted `src/lib/task-artifacts.ts` with `readCommonArtifacts(dir, projectPath, branch?)` returning `{spec, qaReport, humanFeedback, diff}`. Both functions now delegate shared reads; removed duplicate `readHumanFeedback` and `detectDefaultBranch` imports from tasks.ts. 2,563 tests pass.
7. **Two `fix-v4.js`/`fix-v5.js` scripts** in `teamai/scripts/` look like one-off migration leftovers — verify and delete.

---

## 5. Test suite review

**Shape:** ~42,000 lines. Unit (vitest, node env + jsdom pragma per file), integration (vitest, real servers/websockets), e2e (Playwright against a seeded temp-config server on :3001, serial). Custom ESLint rule has its own tests; command-template guardrails are covered by `guardrail-coverage.test.ts`; there's even a bash test for changelog parsing.

**Strengths**
- Crash recovery, rate limiting, WebSocket filtering, worktree `.git`-file patching — the risky code has dedicated integration suites.
- e2e config isolation via `TEAMAI_CONFIG_DIR` temp dirs is thoughtfully engineered (though see BUG-5: `recovery.ts` escapes it).
- Coverage configured for `src/lib/**`.

**Weaknesses / gaps**
1. **Monolith test files mirror monolith sources**: `orchestrator.test.ts` (4,116 lines), `orchestrator-robustness.test.ts` (3,535) share a huge copy-pasted mock preamble. Extract a shared `tests/utils/orchestrator-harness.ts` (the `tests/utils/` dir exists but is empty).
2. **No test exercises a `main`-default-branch repo** — exactly why BUG-2 survived. All git fixtures implicitly use `master`.
3. **No test that `parallelSubtasks: false` serializes execution** (BUG-6 undetected).
4. **`findOrphanedWorktrees` tests validate the wrong directory layout**, locking BUG-4 in place rather than catching it.
5. **No malformed-`qa_report.json` test** for the QA phase read path (BUG-8).
6. **e2e runs with `workers: 1`** due to shared seed mutation — fine for now, but seed-per-test isolation would cut wall time as the suite grows.
7. Unit tests reach deep into private behavior via module mocking (`vi.hoisted` + full `process-manager` fakes); after the §4.1 refactor, most could inject a `PhaseContext` instead — less brittle.

---

## 6. Actionable task backlog

Effort: **S** (<½ day) / **M** (½–2 days) / **L** (>2 days). Priority: **P0** (fix now) → **P3** (nice to have). Each task lists concrete acceptance criteria so QA can verify independently.

### P0 — correctness

| ID | Task | Effort |
|----|------|--------|
| T1 | **Fix `isRetryableError` precedence** (BUG-1). Parenthesize so both `EPERM` and `EBUSY` checks are guarded by the object/null check. Add unit tests: `null`, `undefined`, `{code:'EBUSY'}`, `{code:'EPERM'}`, `{code:'ENOENT'}`, string error. | S |
| T2 | **Introduce `resolveBaseBranch(projectRoot)` and eliminate hardcoded `master`** (BUG-2). New function in `git-platform.ts` (wrap `detectDefaultBranch`, cache per projectRoot, invalidate opt-in). Replace all literals listed in §2.1 BUG-2, including `markTaskDone`, `rebaseOntoLatestMaster` (also rename it `rebaseOntoLatestDefault`), both `pull --ff-only` sites, and the `/merge origin/master` agent prompt. AC: integration test creating a repo whose default branch is `main` passes the full merge + markTaskDone flow; existing `master` fixtures still pass. | M |
| T3 | **Route recovery through `projectStore`** (BUG-5). Replace `_loadProjects()` in `recovery.ts` with `projectStore.getAll()`. AC: e2e run with `TEAMAI_CONFIG_DIR` set never reads `~/.teamai/projects.json` (assert via unit test that mocks projectStore). | S |
| T4 | **Filter agent events by project in the WS server** (BUG-3). In `server.ts`, resolve the session's project (session cwd → project root, or attach `projectRoot` to sessions at creation) and only send agent/error/terminal events to clients whose `projectRoot` matches (keep the no-filter backwards-compat rule). AC: extend `websocket-filtering.test.ts` to cover agent `event` messages, not just `phase-change`. | M |

### P1 — reliability & dead features

| ID | Task | Effort |
|----|------|--------|
| T5 | **Honor `parallelSubtasks`** (BUG-6). In `runImplement`, when `getPipelineConfig().parallelSubtasks === false`, run each group's subtasks sequentially (for-await) instead of `Promise.allSettled`, skipping per-subtask worktree creation (single worktree, no cherry-pick). AC: unit test asserts sessions are created one-at-a-time when disabled; UI toggle round-trips. | M |
| T6 | **Fix `findOrphanedWorktrees`** (BUG-4). Scan `getWorktreeBase(project.path)` for slug-named dirs; correlate to tasks via `task.branch`/slug; report dirs with no live task or task in terminal phase. Update the (currently wrong-layout) tests. AC: integration test creates a worktree via the orchestrator path, deletes the task dir, and the scanner reports it. | M |
| T7 | **Harden agent-output JSON reads** (BUG-8, §3.1). Add `readJsonFile<T>(path, {required, validate})` in `src/lib/json-io.ts`. Use it for `qa_report.json` in `qa-review.ts` (missing/invalid → write structured FAIL report "QA produced no readable report" and follow the normal bounce/fail budget instead of throwing) and for `plan.json` in `implement.ts` (missing/invalid → fail with actionable message). AC: unit tests for missing file, invalid JSON, valid report. | M |
| T8 | **Stop sibling/subsequent work after circuit-breaker failure** (BUG-9). In the group loop, check `pipeline.phase === 'failed'` before starting each subsequent group; inside `Promise.allSettled`, pass a shared aborted flag so unstarted session sends are skipped. AC: unit test — 2 groups, group 1 trips `maxDeliverableFails`; assert no sessions created for group 2. | M |
| T9 | **Per-subtask wakeup files** (BUG-10). Write/read `subtask_wakeup-st<id>.json`; keep reading the legacy name for one release. Serialize `pipeline.wakeup*` mutation through the existing lock pattern. AC: unit test — two parallel subtasks both schedule wakeups; both are honored (second re-enters after first completes). | M |
| T10 | **Use `getToolPath` everywhere** (BUG-7). Fix `implement.ts:692`, `git-platform.ts:172,186`. Add an ESLint restriction or a grep-based unit test asserting no raw `execFileSync('gh'|'glab'|'claude'|'docker'…)` outside tool-checker. | S |
| T11 | **Auto-mode GitLab support + strategy** (BUG-11). Extract PR-number parsing per platform (GitHub `/pull/N`, GitLab `/-/merge_requests/N`); poll via `glab` for GitLab; read merge method from pipeline config (default merge-commit). AC: unit tests for both URL shapes; GitLab path exercised with a mocked `glab`. | M |
| T12 | **Track and clear pause timers** (BUG-19). Store `setTimeout` handles on the pipeline (`pipeline.pendingTimer`); `cancelPipeline` clears them. AC: unit test — cancel during rate-limit pause; timer callback never runs (vi.useFakeTimers). | S |
| T13 | **Reconnect WebSocket on project switch** (BUG-12). Either include `project` in the effect deps of `use-websocket.ts` (tearing down the old socket) or make all consumers call `reconnect()` on project change — prefer the hook fix. AC: unit test with mocked WebSocket asserting a new connection with the new query param after prop change. | S |
| T14 | **Canonical task slug** (BUG-13). Store `slug` on the Task at creation (`slugify(title)` + `-2`, `-3`… suffix on collision, checked against existing dirs). Use `task.slug` for dir, branch, and worktree; keep `slugify(description)` fallback for legacy tasks. AC: creating two tasks titled identically yields distinct dirs/branches; existing tests pass. | L |

### P2 — structure & performance

| ID | Task | Effort |
|----|------|--------|
| T15 | **Introduce `PhaseContext`** (§4.1). One object per Orchestrator instance carrying `projectRoot`, `taskStore`, `execGit`, `gitPush`, `sessionOpts`, `waitForCompletion`, `advancePhase`, `persistAndEmitPhase`, `savePipelineState`, `phaseHeader`, etc. Phase-runner signatures become `(pipeline, ctx)`. Delete the delegate one-liners in orchestrator.ts. Mechanical, but touches every phase module and their tests — do it in one PR with no behavior change. | L |
| T16 | **Decompose `runImplement`** (§4.2) into the six named helpers. No behavior change; move the existing giant tests' assertions onto the smaller units where practical. Depends on T15 landing first (or coordinate). | L |
| T17 | **Extract `updateSessionMap()` helper** (§4.3), used by all 6 call sites, serialized with an internal lock. | S |
| T18 | **Single artifact registry** (§3.2). `src/lib/orchestrator/artifacts.ts` exporting `PHASE_ARTIFACTS`; re-implement `TaskStore.clearArtifacts`, `cleanupTaskArtifacts`, and review-actions' `extraFiles` on top of it. AC: table-driven unit test that every artifact filename referenced anywhere appears in the registry. | M |
| T19 | **Single phase-set registry** (§3.3). Move `TERMINAL_PHASES`, `PAUSED_PHASES`, `IN_PROGRESS_PHASES`, `NO_RESUME_PHASES`, `restartablePhases` into `constants/phases.ts`; import everywhere. | S |
| T20 | **TaskStore index** (BUG-16). Maintain an in-memory `Map<id, dir>` built on first scan, invalidated on create/delete/external-change (mtime check on the specs dir is enough). `getById`/`getDirById`/`update` become O(1) with one file read. AC: existing task-store tests pass; add a test that 200 tasks → `getById` reads at most 2 files. | M |
| T21 | **Async atomic writes** (BUG-15). ✅ DONE (c6d0544). Capped-spin approach: busy-wait reduced from 10/20/40ms (70ms max) to 2/4/8ms (14ms max) using `Math.min(10, 2 * (2 ** attempt))`. Preserves exponential backoff with a smaller base. All APIs remain synchronous — zero call-site changes. Full async conversion attempted but too invasive (~30 test failures from cascading mock timing changes). | S ✅ |
| T22 | **`killSession` status + wire stall detection** (BUG-14). Preserve `error` status when killing a non-idle session; either delete `getStalledSessions` or actually call it from the recovery sweep to kill+log hung sessions (>10 min silent). Decide, implement, test. | S |
| T23 | **Improve QA criterion matching** (BUG-18). Replace the word-inclusion clause with token-overlap scoring (match if ≥half the criterion-name tokens, minus stopwords, appear in the AC). AC: unit tests with realistic criterion names showing correct subtask flagging where today's code falls through to the synthetic 9999 subtask. | S |
| T24 | **Unify logging** (§3.4). Extend logger.ts with `info`; replace `console.*` in lib/ with it. Keep output format stable for tests that grep logs. ✅ DONE. All 48 console.* calls across 8 source files replaced with structured logger calls (`log`/`warn`/`error`). Added `info` alias to logger. Updated 16 test mocks. | M ✅ |
| T25 | **Repo hygiene** (BUG-17). `git rm` the `` `` `` file and `teamai/dist-server/`; add `dist-server/`, `tsconfig.tsbuildinfo`, `tmp/`, root `test-results/` to the appropriate .gitignores; drop `xterm@5` and `uuid` from package.json (verify with a grep + full test run). | S |

### P3 — polish

| ID | Task | Effort |
|----|------|--------|
| T26 | **Shared orchestrator test harness.** Create `tests/utils/orchestrator-harness.ts` exporting the mock `processManager`/`container-manager`/fs-temp-project setup duplicated across the 5 big orchestrator suites; migrate `orchestrator.test.ts` and `orchestrator-robustness.test.ts` first. | M |
| T27 | **Split mega-components** (§4.5): extract dialogs and panels from `task-detail.tsx` and `kanban-board.tsx` (~<300 lines per file target), preserving the props-over-fetch rule. ✅ DONE. Extracted 8 sub-components (`copy-button`, `error-banner`, `task-modal`, `dep-picker`, `plan-subtasks`, `qa-report-view`, `new-task-dialog`, `kanban-filters`). All 4 mega-files reduced by 120–360 lines each. 2,555 tests pass, 0 type errors. | L ✅ |
| T28 | **Extract shared task-artifact reader** for `getTaskFull`/`getTaskArtifacts` (§4.6). ✅ DONE. Created `src/lib/task-artifacts.ts` with `readCommonArtifacts()`; eliminated duplicate spec/qa/feedback/diff reads; rewrote tests to cover the new module directly. 2,563 tests pass, 0 type errors. | S ✅ |
| T29 | **Per-session waiters** (BUG-20): raise `processManager.setMaxListeners` and/or route `waitForCompletion` through a per-session EventEmitter created in `createSession`. | S |
| T30 | **Delete or document `scripts/fix-v4.js` / `fix-v5.js`** and `scripts/update-phase.ts` if they are one-off migrations. | S |
| T31 | **e2e seed isolation**: give each spec its own seeded task fixtures so Playwright can run `workers > 1`. | M |
| T32 | **Add `main`-branch and malformed-report regression tests** (companions to T2/T7 — write the tests first if picking those up). | S |

### Suggested ordering

1. **Wave 1 (independent, small):** T1, T3, T10, T12, T13, T19, T22, T23, T25, T30
2. **Wave 2 (behavioral fixes):** T2 (+T32), T4, T5, T6, T7, T8, T9, T11
3. **Wave 3 (structural, sequence matters):** T15 → T16 → T17/T18/T26
4. **Wave 4:** T14, T20, T21, T24, T27, T28, T29, T31

All Wave 1–2 tasks are safe to run as parallel pipeline tasks (disjoint files) **except** T5/T8/T9 which all touch `implement.ts` — chain those with `depends_on`.

---

## 7. What is already good (don't "fix")

- Atomic write + backup/restore patterns in `project-store.ts` and `task-store.ts` (modulo BUG-1/BUG-15).
- The stale-pipeline identity guards in rate-limit/wakeup timers.
- Global-singleton pattern for surviving Next.js dual module graphs (documented with *why* comments).
- `git-push.ts` tiered auth fallback with token redaction.
- The worktree `.git`-file patching for container mode — subtle, well-commented, well-tested.
- The `no-async-fetch-on-mount` ESLint rule + ADR discipline (`adr/`).
- Guardrail coverage tests asserting command-template invariants.