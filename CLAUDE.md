@.claude/teamai-workflow.md
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TeamAI is an Electron desktop app that orchestrates multi-agent Claude Code CLI workflows. It replaces manual CLI usage with a native desktop UI that spawns and manages Claude CLI subprocesses, enabling parallel agent sessions (planner, coder, qa-reviewer, etc.) for automated software development pipelines.

All source code lives in the `teamai/` subdirectory. Run all commands from there.

## Commands

```bash
cd teamai
npm run dev                # Dev server (React HMR on :3002)
npm run build              # Production build (Next.js)
npm run build:server       # Bundle server.ts with esbuild
npm run build:electron     # Run both build + build:server
npm run start              # Start production server (:3000)
npm run electron:dev       # Launch Electron in dev mode (connects to :3002)
npm run electron:start     # Launch Electron in production (:3000, auto-builds first via prehook)
npm run lint               # ESLint check
```

Run the process manager test script:
```bash
cd teamai
npx tsx scripts/test-process-manager.ts
```

> **Talking to the test server from a script or test?** Don't hardcode `localhost:3001` — import `getTestServerUrl()` from `teamai/scripts/servers.ts` (which reads the `PORT` literal from `playwright.config.ts`).
>
> **Talking to the dev server (npm run dev or electron:dev) from a script or test?** Don't hardcode `localhost:3002` — import `getDevServerUrl()` from the same `teamai/scripts/servers.ts` (which reads the `PORT` literal from `package.json`'s `dev` script).

### Pre-Commit Testing

**Before every commit, run the full test suite:**

```bash
cd teamai && npm run precommit
```

This runs `test:all` which chains: **typecheck → lint → unit + integration tests → E2E tests → changelog test**. The pre-commit hook (`./.husky/pre-commit`) runs a fast subset automatically (typecheck + lint-staged + vitest), but does NOT run E2E or changelog tests — those must be run manually before pushing.

Individual test commands:

```bash
cd teamai
npm run typecheck        # tsc --noEmit
npm run lint             # eslint --max-warnings 0
npm run test:unit        # vitest run --exclude "tests/integration/**"
npm run test:integration # vitest run tests/integration
npm run test             # vitest run (unit + integration)
npm run test:e2e         # playwright test (full suite, ~30 min)
npm run test:e2e:smoke   # playwright test (5 critical specs, ~2 min)
npm run test:changelog   # bash tests/unit/changelog-parsing.test.sh
npm run test:all         # typecheck + lint + vitest + playwright + changelog
npm run test:coverage    # vitest --coverage + playwright E2E (combined report)
npm run precommit        # alias for test:all with a banner
```

> **Windows note:** npm scripts run under `cmd.exe` on Windows, which does not
> strip single quotes the way a POSIX shell does. Glob arguments passed to a
> script's CLI flags (e.g. `--exclude`) must use double quotes, not single
> quotes, or the quote characters end up as part of the literal glob and
> silently match nothing.

Vitest runs via `vitest.workspace.ts`, not a single `vitest.config.ts`: the integration tests that create real git worktrees (`worktree-commondir-patching`, `worktree-unpushed-commits`, `create-pr-conflict`, `crash-recovery`) run in their own single-worker `worktree-serial` project so no two of them ever call `git worktree add` concurrently with each other; everything else runs in the `default` project at normal parallelism.

> **Git-hook env leak, not a filesystem race:** running `git worktree add` inside these tests could fail with `'.../index.lock': No such file or directory` — this looked like a Windows filesystem race (and the retry-with-cleanup mitigation in `tests/utils/git-worktree.ts` helps with genuine transient races), but the real cause was that `git commit`'s pre-commit hook sets `GIT_INDEX_FILE` (and friends) pointing at the *outer* repo's `.git`, and every child process the hook's `npx vitest run` spawns inherits it — including `git init`/`git worktree add` in the completely unrelated temp repos these tests create, which then resolve the wrong repository. `tests/global-setup.ts` and `tests/vitest-setup.ts` strip `GIT_INDEX_FILE`/`GIT_DIR`/`GIT_WORK_TREE`/etc. from `process.env` at test-run startup so this can't reproduce there. Only ever reproduced when triggered via a real `git commit` (the env vars aren't set otherwise), which is why isolated manual `vitest run` attempts wouldn't show it.

> **Always use `npm run test:e2e` (or `test:e2e:smoke`), never `npx playwright test` directly.**
> The `pretest:e2e` and `pretest:e2e:smoke` hooks run port 3001 cleanup which
> prevents orphaned server processes from blocking subsequent test runs.
> The smoke suite covers the 5 most critical areas (sidebar, task detail,
> kanban, settings, workflow) and completes in ~2 minutes — ideal for
> pre-commit verification.

### Build & Start Pre-Hooks

Several npm scripts use `pre<name>` hooks to auto-run prerequisite steps:

| Command | Pre-hook (`pre<name>`) |
|---|---|
| `npm run electron:start` | `preelectron:start` → `npm run build:electron` (builds Next.js + server first) |
| `npm run test:e2e` | `pretest:e2e` → `node scripts/clear-port-3001.mjs` |
| `npm run test:e2e:smoke` | `pretest:e2e:smoke` → `node scripts/clear-port-3001.mjs` |

Shared build step (`build:electron`):
```bash
npm run build:electron     # equivalent to: npm run build && npm run build:server
```

This script is reused by `preelectron:start`, `electron:build`, `electron:build:mac`,
`electron:build:linux`, and `electron:build:all` — keeping the build pipeline
definition in one place.

## Architecture

### Main Process

The Electron main process manages Claude CLI subprocesses via the ProcessManager and communicates with the renderer through IPC for real-time agent event streaming and pipeline orchestration.

### ProcessManager (`src/lib/process-manager.ts`)
Core engine. Extends `EventEmitter` and manages a `Map<string, AgentSession>`. Each session spawns a `claude -p --input-format stream-json --output-format stream-json` subprocess with piped stdio. Output is buffered and parsed line-by-line as NDJSON, then re-emitted as typed events (`event`, `error`, `exit`).

Key methods: `createSession(taskId, role, cwd)`, `writeToSession(id, data)`, `terminateSession(id)` (SIGTERM).

### Multi-Agent Pipeline
Defined in `defaults/roles/` (analyst, planner, coder, qa-reviewer, merger) and `defaults/commands/` (spec, plan, implement, qa-review, merge, roadmap, ideation, changelog, create-task, role-refinement-analysis). Each session gets its role persona injected as a system prompt (`--append-system-prompt` in `process-manager.ts`) before the first turn; the slash-command template (e.g. `/implement`) supplies the task instructions.

#### Commands vs. roles — responsibilities

The two file sets are deliberately asymmetric:

- **Commands** (`defaults/commands/`) are TeamAI's **orchestration contract**. They own everything the pipeline depends on to work mechanically: artifact paths and schemas (`spec.md`, `plan.json`, `qa_report.json`, `files_to_create`, the `subtask_wakeup-*.json` schema including `progress_log_path`), the output formats the orchestrator parses (`qa_report.json`'s `fail_type` / `criteria` / `additional_issues` / `spec_concerns`, the `[BUG] Fix: …` summary lines), execution-environment rules (run from the worktree, dynamic ports, never kill another agent's processes, don't push — the orchestrator does), and the cross-phase guardrails. They are force-synced from `defaults/` into each project at startup (customized copies are overwritten), and the result is surfaced as an informational banner rather than a click-to-sync prompt. `role-refinement-analysis` is also a force-synced command, but it is TeamAI-internal tooling (the Role Refinement Assistant's failure post-mortem) rather than a pipeline phase — like the other commands, users cannot customize it.
- **Roles** (`defaults/roles/`) are **persona + project conventions** — who the agent is and the project's own style. They are scaffolded once and then never auto-synced, because they are the part users customize (persona / tone / domain knowledge) to fit their project.

**Invariant: rewriting a role — even radically — must never break TeamAI.** Anything the orchestrator or another phase relies on belongs in a command, never a role. `tests/unit/guardrail-coverage.test.ts` enforces this boundary (the verification-environment rules are pinned to the commands and asserted absent from every role).

### Renderer
React application in `src/app/`. shadcn/ui components go in `src/components/ui/`. Path alias `@/*` maps to `src/*`. Tailwind CSS 4. Terminal output renders via xterm.js (dependency already installed).

The `UnifiedTerminal` component (`src/components/unified-terminal.tsx`) uses **deferred initialisation**: it waits for the container to reach a usable height (≥20px) via `ResizeObserver` + `requestAnimationFrame` + `setTimeout` retry before fitting the terminal and marking it ready (`termReady`). A single React effect (deps: `[interleavedOutput, termReady, selectedSessionIds]`) handles ALL terminal writes — the initial content is written after `termReady` becomes true, guaranteeing the parsed log output is available from React's render cycle. This avoids timing races between the async xterm init callbacks and React's hydration/lifecycle.

### Data-Flow Pattern: Props Over Async Fetch

**Components must never `useEffect` + async-fetch their own state on mount.** An ESLint rule (`local/no-async-fetch-on-mount`) enforces this.

Antipattern (state resets on refresh):
```tsx
const [enabled, setEnabled] = useState(false);
useEffect(() => { fetchState().then(s => setEnabled(s.enabled)); }, []);
```

Correct pattern — pass initial state as a prop:
```tsx
// Parent component
const state = getSomeState();
return <Button initialEnabled={state.enabled} />;

// Child component
function Button({ initialEnabled }: { initialEnabled: boolean }) {
  const [enabled, setEnabled] = useState(initialEnabled); // survives refresh
}
```

Why: phase-change events trigger UI re-renders that re-mount components. Any component using `useState(literal)` + async-fetch-on-mount will briefly show the wrong default on every refresh.

## Key Design Decisions

- **NDJSON streaming**: Claude CLI outputs newline-delimited JSON; the buffer parser in ProcessManager handles chunks that split across multiple `data` events.
- **Git worktree isolation**: Each pipeline task will run in its own git worktree so parallel agents don't conflict (planned, not yet implemented).
- **node-pty** is installed for PTY support but not yet used — future terminal emulation feature.- **Multi-project**: The app manages multiple target codebases. Each has its own `.teamai/` state directory and `.claude/` config.

### Auto Mode

Auto mode (`src/lib/auto-mode.ts`) automatically advances tasks through the pipeline without manual intervention: picks backlog tasks, auto-approves at `awaiting-review`, creates PRs, polls CI, and auto-merges. Enabled per-project via the UI toggle (`AutoModeButton`).

**State persistence:** Auto-mode state (`enabled`, `maxParallel`) is persisted to `.teamai/auto-mode.json` on every `setAutoModeState()` call. On server startup, `restoreAutoModeStates()` scans all registered projects via `projectStore.getAll()` and re-enables auto mode from disk for any project that had it on. This ensures auto mode survives server restarts — critical because rate-limit pauses can span a dev hot reload, crash, or manual restart. Without persistence, the user would have to manually re-enable auto mode in the UI after every restart.

**Stalled task adoption:** When auto mode is re-enabled, `_adoptStalledTasks()` scans the task store for tasks already in paused phases (`awaiting-review` or `pr-open`) and re-adopts them:
- **`awaiting-review`**: adds to `autoApprovedIds` and immediately calls `approveTask(taskId, 'pull-request')` — the phase-change listener won't fire because the phase isn't changing.
- **`pr-open`**: adds to `autoTrackedIds` and immediately starts CI polling via `_startCIPolling()`.

Without this, re-enabling auto mode only picks up *future* phase-change events — tasks that stalled while auto was off are orphaned because the `onPhaseChange` listener only auto-approves tasks in `autoTrackedIds`/`autoApprovedIds`, and the tick loop only picks `backlog` tasks.

**Tracking sets:**
- `autoTrackedIds` — tasks started by auto mode (for CI polling and done/failed cleanup)
- `autoApprovedIds` — tasks that auto mode has called `approveTask` for but `pr-open` hasn't fired yet (bridges the timing gap)
- `startingIds` — tasks between `resumeTask` call and phase change (prevents duplicate picks during tick loop)

**Tick loop:** Runs every 5 seconds via `setInterval`. Picks oldest backlog tasks (FIFO by `createdAt`) whose dependencies are all `done`, up to `maxParallel` minus active task count. Paused-phase tasks (`awaiting-review`, `pr-open`) count as active slots.

**CI polling:** After a PR is created (`pr-open` phase), auto mode polls `gh pr view` every 30 seconds. When all status checks pass, it auto-merges via `gh pr merge --merge`, calls `markTaskDone`, and sets `autoProcessed: true` on the task. The UI shows a "Mark Reviewed" button for auto-processed tasks so the user can acknowledge they reviewed the auto-merged PR.

### Role Refinement Assistant

The Role Refinement Assistant (`src/lib/role-refinement.ts`) investigates *failed* tasks and decides whether a project's **role prompts** (`.claude/roles/*.md`) are the root cause. When a task fails, a headless analysis agent reads the failure artifacts (QA report, plan, event history) plus the five role files and classifies the cause:

- **Role-prompt gap** — a project convention is missing/misworded in a role file. Produces diffable `edits[]` the user reviews and approves.
- **Contract gap** — the problem is actually in TeamAI's *commands* (`defaults/commands/`), which are force-synced and can't be fixed per-project. Returns a copyable `diagnosis` to bring back to the TeamAI repo — never a role edit.
- **Not a prompt problem** — genuine task difficulty / spec / code issue. Nothing to apply.

**The analysis agent is deliberately NOT a pipeline role.** The session spawns as `role: 'general'` (`process-manager.ts` injects no role persona for `general` — the pipeline roles describe how to develop the project, which is irrelevant to analyzing a failure). Its instructions come from an **internal command**, `defaults/commands/role-refinement-analysis.md` (the classification logic + JSON output contract), force-synced into each project's `.claude/commands/` at startup like the other commands — so users cannot customize it. The model it uses is user-selectable (Settings → Role Refinements → **Analysis model**, default `claude-sonnet-4-6`).

**Config & state:** `.teamai/role-refinement.json` holds the feature config (`mode: off|manual|auto`, `model`, `autoApply`, `maxAutoAnalysesPerDay`, `recurrenceThreshold`) — persisted like auto-mode. Suggestion records live in `.teamai/role-refinements/<id>.json` (status `analyzing` → `suggested`/`no-gap` → `applied`/`dismissed`/`superseded`), each stamped with the producing `model` and a `signature` dedupe key (sha256 of the sorted FAIL-criterion names + role set).

**Modes:**
- **Off** — feature hidden.
- **Manual** (default) — button only: the failed-task card's **Analyze failure** runs the analysis; every edit requires human approval (editable before/after diff, backup, one-click revert).
- **Auto** — `startRoleRefinementWatcher()` (`src/lib/role-refinement-watcher.ts`, boot-time, independent of auto-mode) turns `failed` phase-changes into auto-triggered analyses when **all** gates pass: mode `auto`, `detectRecurrence()` hits, the `maxAutoAnalysesPerDay` spend cap isn't exhausted, the failure `signature` isn't already covered, and the retry-loop guard is clear. Recurrence fires on any of three signals: persisted criterion (same FAIL-criterion name across QA cycles), repeated task failure (≥ `recurrenceThreshold` `failed` events), or a cross-task cluster (≥2 tasks failed with overlapping FAIL criteria within 7 days). Analyses still land as *suggestions* — no edits are automatic. The Settings nav item shows a pending-count badge.

**Phase 3 — auto-apply + auto-retry (compounded opt-ins):** when an auto analysis resolves to a `suggested` record, `maybeAutoApplyAndRetry()` applies + retries only when **all** of these hold: mode `auto` AND the `autoApply` checkbox AND the pipeline auto-runner (Auto Mode) enabled. The record must also pass `isAutoApplyEligible()`: role-prompt gap, `high` confidence, every edit `append`/`additive` and ≤ `MAX_AUTO_APPEND_CHARS` (1.5 KB). The apply is backed up + revertable like a manual one (`appliedBy: 'auto'`), `refinementRetryCount` is bumped, and the task retries through the shared `task-retry.ts` path. **Retry-loop guard:** a task that fails again with the same signature as an *applied* refinement — or reaches `REFINEMENT_RETRY_LOOP_CAP` (2) retries — is never auto-analyzed/auto-applied again; the watcher escalates instead, stamping `refinementEscalated` on the task and showing an amber "A role refinement was applied but the task failed the same way — human review needed" banner on the failed-task card.

**Key files:** `src/lib/role-refinement.ts` (config, store, signature, recurrence detection, analyzer, apply/dismiss/revert, eligibility), `src/lib/role-refinement-watcher.ts` (boot-time listener, auto gates, auto-apply), `src/lib/task-retry.ts` (shared retry path), `src/components/role-refinement-card.tsx` (inline card + escalation banner), `src/components/role-refinement-settings.tsx` (mode, analysis model, autoApply, spend cap, history), `defaults/commands/role-refinement-analysis.md` (internal analysis command).
### Retry Flow (`retryTask`)

When a task fails (phase = `failed`), the user clicks **Retry** to restart the pipeline from where it left off. The retry logic lives in `src/app/actions/tasks.ts` → `retryTask()`.

**Resume phase determination:** `retryTask` reads the task's `events.jsonl` (phase-change history) and calls `getResumePhaseForFailedTask()` in `src/lib/task-utils.ts`. This function:
1. Filters out `backlog`, `failed`, and `done` phases from the event chain
2. Returns the **last real phase** before failure (e.g., `qa-review`, `implement`, `plan`, `spec`)
3. Defaults to `qa-review` if no real phase is found

**Example event chain** → resume phase:
- `backlog → spec → plan → implement → qa-review → failed` → resumes at **`qa-review`**
- `backlog → spec → plan → implement → failed` → resumes at **`implement`**
- `backlog → spec → plan → failed` → resumes at **`plan`**

**Before resuming**, `retryTask` preserves context:
- Snapshots `qa_report.json` → `qa_report_before_failed.json` (so context is preserved if retry fails again)
- Restores `qa_report.json` from snapshot if it was deleted between failure and retry
- Restores `human_feedback.md` from `human_feedback_before_bounce.md` if deleted
- Clears `completionSummary` so the failure indicator disappears from the UI

**After** these steps, `retryTask` calls `orchestrator.moveTaskToPhase(taskId, resumePhase)`, which starts the pipeline from the determined phase. For `qa-review`, `moveTaskToPhase` sets `startPhase = 'implement'` (if plan.json exists), so the pipeline re-runs implement → QA.

### Spec Revision Workflow (Human-Gated)

The spec revision workflow allows a human reviewer to fix the spec itself (rather than the code) when QA detects that the **specification** is the root cause of failures, not the implementation.

**How it works:**

1. **QA detects spec gaps** (Step 6 in `defaults/commands/qa-review.md`): The QA agent distinguishes between implementation bugs (code doesn't match spec) and spec gaps (spec itself is wrong). Spec gaps are reported in `spec_concerns` in `qa_report.json`.

2. **Pipeline bifurcates**: When `spec_concerns` exist in the QA report, `runQaReview` in `src/lib/orchestrator/qa-review.ts` calls `autoReviseSpec` — which auto-revises the spec up to 3 times, then parks the task in `awaiting-review` for a human to decide.

3. **Human sends a change request to the Analyst**: The review panel (`src/components/review-panel.tsx`) shows a purple banner listing each spec concern (issue, reasoning, suggested fix). In **Request Changes**, selecting the **Analyst** target pre-fills the textarea with those concerns; sending it routes through `routeHumanFeedback` (analyst target) → `beginSpecRevision()`:
   - Writes `spec_revision_feedback.md` with the reviewer's directive (or the QA's spec concerns)
   - Snapshots `spec.md` → `spec_revision_before.md` (the pre-revision baseline used by the no-op guard; `spec_v{N}.md` is only written once the revision actually completes)
   - Clears downstream QA artifacts (preserves `plan.json` — the planner re-plans in place)
   - Resets retry counters
   - Advances to `spec` phase → runs spec → plan → implement → QA

4. **Revision-mode spec**: `runSpec` detects `spec_revision_feedback.md` and sends a `REVISION:` prompt instead of `/spec`. The spec command template (`spec.md` Revision Mode) instructs the analyst to read the existing spec + revision feedback, address all concerns, preserve valid parts, and re-validate.

5. **After revision**: The revised spec flows through plan → implement → QA normally. If QA now passes, the task goes to `awaiting-review` for final approval.

**How retry integrates**: Ensure the project's `.claude/commands/` has the updated templates (synced from `defaults/commands/`) — then clicking **Retry** on any previously-failed task works seamlessly. It resumes from the last real phase using the updated command templates (with spec-gap detection) on the next run. No manual migration needed.

**Revision counter persistence**: The `specRevision` counter tracks how many times the spec has been revised for a given task (max 3 before falling back to human review). Without persistence, server restarts or pipeline recreation would reset it to 0, causing the next revision to overwrite `spec_v1.md` instead of creating `spec_v{N+1}.md`.

- **Increment**: `autoReviseSpec()` (QA auto-revision) and `routeHumanFeedback()`'s analyst target (human "Request Changes → Analyst") both increment `pipeline.specRevision` in `src/lib/orchestrator/review-actions.ts` before snapshotting.
- **Save**: `savePipelineState()` in `src/lib/orchestrator/pipeline-state.ts` writes `specRevision` to `.pipeline_state.json` alongside other crash-recovery state.
- **Restore**: `_restoreSpecRevision()` in `src/lib/orchestrator.ts` recovers the counter from `.pipeline_state.json` (primary) or by counting existing `spec_v{N}.md` files on disk (fallback). Called from both `restorePipeline()` and `runTask()`'s crash-recovery path (`restorePipelineState`).
- **Guard**: At `specRevision > 3`, `autoReviseSpec` stops revising and advances to `awaiting-review` for human intervention.

### QA Report Issues

QA reports (`qa_report.json`) contain two kinds of issues:
- **`criteria`** — formal pass/fail per spec acceptance criterion. FAIL criteria are always hard blockers.
- **`additional_issues`** — issues found beyond the spec criteria. **Every `additional_issues` entry is a hard blocker.** Any `additional_issues` entry means overall FAIL. There are no severity levels.

**How issues flow through the pipeline:**

1. **QA agent** produces `qa_report.json` with `additional_issues` containing `description`, `file`, and optional `fix_needed`.

2. **`_writeQaFeedback`** (orchestrator.ts) writes `qa_feedback.md` and patches `plan.json`:
   - FAIL criteria → `[QA CORRECTION: fix_needed]` appended to matching subtask acceptance criteria
   - `additional_issues` → `[QA ISSUE: description → Fix: fix_needed]` appended to subtasks matching by file
   - Both set `qa_flagged: true` so only affected subtasks re-run

3. **`runImplement` QA rework mode** sends the engineer a prompt where:
   - `[QA CORRECTION: Fix X]` → `[BLOCKER] Fix X`
   - `[QA ISSUE: desc → Fix: x]` → `desc → Fix: x` (no severity prefix)
   - Non-QA acceptance criteria pass through unchanged

4. **`implement.md`** QA Rework Mode instructs the engineer:
   - ALL issues listed in the QA feedback MUST be fixed. There are no optional or skippable items.
   - Every QA issue is a requirement.

This design ensures the engineer treats every QA finding as mandatory, preventing infinite qa-fix loops where the engineer ignores issues because no severity label told them to.

### Pipeline Workflow Rules

The command templates in `defaults/commands/` enforce cross-cutting guardrails to prevent common anti-patterns. These rules span multiple pipeline phases and are designed to work together.

#### Spec Phase (analyst)

1. **No Delegated Analysis** (`spec.md` Step 1): Investigation and root-cause analysis are pre-spec activities. If the feature request asks the analyst to "investigate", "analyse", or "determine the correct value for" something, the analyst must complete that investigation NOW — read logs, derive formulas, determine thresholds — and embed findings directly into the spec. NEVER delegate analysis to the implement phase via requirements like "determine the correct value" or "analyse why X fails". By the time the spec reaches the engineer, every concrete value, formula, and threshold must already be decided and justified.

2. **Self-Critique Check** (`spec.md` Step 4): The analyst must check for delegated-analysis anti-patterns — are any requirements worded as research tasks ("analyse", "investigate", "determine") instead of concrete, computed specifications?

12. **Spec Executability** (`spec.md` Step 4): The spec must be self-contained and executable without the analyst's tribal knowledge. No unquantified requirements ("fast enough", "sufficient", "reasonable"), no reference implementations ("do it like module X"), no vague justifications ("obviously", "clearly"). Every requirement must be independently testable by QA without needing the analyst's context.

#### Plan Phase (planner)

3. **Verification Script Subtask Rule** (`plan.md` Rules): When the spec includes an acceptance criterion that requires running a script to produce empirical evidence (benchmark, integration run, data pipeline), the plan MUST include a dedicated subtask for that script run. Never fold it into a documentation subtask. The subtask must specify: (a) the exact command to run, (b) what output artifact to commit, and (c) the specific check to apply to the output (e.g. "section X shows fewer than N failures"). This makes the criterion independently verifiable by QA without relying on the engineer's self-report.

13. **Plan Coverage** (`plan.md` Rules): Every spec acceptance criterion must map to at least one subtask — no orphaned criteria. If two parallel subtasks modify the same file without coordination, add an explicit `depends_on` between them or merge them. Parallel writes to the same file cause merge conflicts that waste engineer sessions.

#### Implement Phase (coder)

4. **No Mathematical Substitution** (`implement.md` Rules): If an acceptance criterion requires empirical evidence from a script run (benchmark, integration test, data pipeline, verification report), the coder MUST run the script and commit the output. Mathematical or theoretical justification does NOT satisfy an empirical criterion. A claim of "mathematically verified" for a criterion that says "post-fix script exits with < 20 failures" is a FAIL.

5. **Word-Gaming Prevention** (`implement.md` Rules): Changing the wording of a claim from "verified" to "expected" or "mathematically estimated" is not a fix — it is an acknowledgement of failure.

6. **Session Budget Awareness** (`implement.md` Rules): If a required script takes too long for the session budget, stop and report the blocker explicitly rather than substituting a theoretical claim.

7. **Cleanup-Only Rework Mode** (`implement.md` QA Rework): When `fail_type` is `"cleanup"`, the coder enters cleanup-only mode: no spec re-read, no test suite, execute only mechanical `fix_needed` operations. This covers both git/file-system fixes (git rm, git add) and artifact fixes (run a script, verify output, git add, commit, push).

8. **Incremental Progress Estimation** (`implement.md` Long-Running Scripts): For scripts that produce incremental progress output (growing log, record counter, progress lines), check once to confirm it's running, estimate remaining time from throughput rate, wait that duration before checking again. Do NOT check on a fixed short interval. Do NOT restart a script making expected progress. Do NOT start parallel runs. Only escalate if: no output for 10+ minutes, script exited early, or an error line appears.

9. **Background Output Unreadable** (`implement.md` Long-Running Scripts): If a long-running background script does not deliver readable output after its completion notification, re-run it synchronously (without `run_in_background`). Do NOT substitute a partial or reduced run for the full required invocation, and do NOT change acceptance-criterion wording to work around missing evidence.

14. **Spec Authority** (`implement.md` Rules): If the coder believes a formula, algorithm, threshold, or design decision in the spec is wrong, they must flag it in their summary — NOT silently change it. The spec is the contract between analyst and engineer; changing it without revision is a spec bypass. This applies to normal implement mode, not just QA rework. Implement what the spec says, then escalate concerns through the proper pipeline.

#### QA Review Phase (qa-reviewer)

10. **Empirical Evidence Enforcement** (`qa-review.md` Step 5): For acceptance criteria requiring empirical evidence from a script run, the QA agent must read the committed output and confirm the results meet the criterion's thresholds. A coder claim of "mathematically verified" or theoretical justification does NOT satisfy an empirical criterion — mark it FAIL.

11. **Extended Cleanup fail_type** (`qa-review.md` Output, `orchestrator.ts`): `fail_type: "cleanup"` covers ALL mechanical fixes with zero source code changes — both git/file-system operations AND script-run-and-commit operations (e.g., the coder substituted math for benchmark output; the fix is to run the script and commit results). The orchestrator routes cleanup failures to implement with cleanup-only rework mode, and writes `fail_type` into `qa_feedback.md` so the coder detects cleanup mode without needing to locate `qa_report.json`.
