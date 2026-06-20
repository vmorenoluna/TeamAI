@.claude/teamai-workflow.md
# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

TeamAI is a Next.js web app that orchestrates multi-agent Claude Code CLI workflows. It replaces an Electron-based approach with a browser UI that spawns and manages Claude CLI subprocesses, enabling parallel agent sessions (planner, coder, qa-reviewer, etc.) for automated software development pipelines.

All source code lives in the `teamai/` subdirectory. Run all commands from there.

## Commands

```bash
cd teamai
npm run dev      # Development server (tsx server.ts + Next.js hot reload)
npm run build    # Production build
npm run start    # Production server
npm run lint     # ESLint check
```

Run the process manager test script:
```bash
cd teamai
npx tsx scripts/test-process-manager.ts
```

## Architecture

### Custom Server (`server.ts`)
Wraps Next.js with a raw HTTP+WebSocket server (`ws` package). The browser connects via WebSocket for real-time agent event streaming; REST API routes handle task CRUD and pipeline orchestration.

### ProcessManager (`src/lib/process-manager.ts`)
Core engine. Extends `EventEmitter` and manages a `Map<string, AgentSession>`. Each session spawns a `claude -p --input-format stream-json --output-format stream-json` subprocess with piped stdio. Output is buffered and parsed line-by-line as NDJSON, then re-emitted as typed events (`event`, `error`, `exit`).

Key methods: `createSession(taskId, role, cwd)`, `writeToSession(id, data)`, `terminateSession(id)` (SIGTERM).

### Multi-Agent Pipeline
Defined in `defaults/roles/` (analyst, planner, coder, qa-reviewer, qa-fixer, merger) and `defaults/commands/` (spec, plan, implement, qa-review, qa-fix, merge, roadmap, ideation, changelog).

Each command template injects the role at runtime: the Claude subprocess is told to adopt a role persona from `.claude/roles/{role}.md`. Per-project customization lives in the target project's `.claude/` directory.

### Frontend
Next.js App Router (`src/app/`). shadcn/ui components go in `src/components/ui/`. Path alias `@/*` maps to `src/*`. Tailwind CSS 4. Terminal output will render via xterm.js (dependency already installed, not yet wired up).

## Key Design Decisions

- **NDJSON streaming**: Claude CLI outputs newline-delimited JSON; the buffer parser in ProcessManager handles chunks that split across multiple `data` events.
- **Git worktree isolation**: Each pipeline task will run in its own git worktree so parallel agents don't conflict (planned, not yet implemented).
- **node-pty** is installed for PTY support but not yet used — future terminal emulation feature.- **Multi-project**: The app manages multiple target codebases. Each has its own `.teamai/` state directory and `.claude/` config.

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

2. **Pipeline bifurcates**: When `spec_concerns` exist in the QA report, `runQaReview` in `src/lib/orchestrator.ts` advances the task to `awaiting-review` instead of bouncing back to `implement`. A human must decide.

3. **Human clicks "Revise Spec"**: The review panel (`src/components/review-panel.tsx`) shows a purple banner listing each spec concern (issue, reasoning, suggested fix). Clicking **Revise Spec** calls `reviseSpec()`:
   - Writes `spec_revision_feedback.md` with the QA's spec concerns
   - Snapshots `spec.md` → `spec_v1.md` (preserves original)
   - Clears downstream artifacts: `plan.json`, `qa_report.json`, `qa_feedback.md`, `completion_summary.md`, `human_feedback.md`
   - Resets `qaAttempt` to 0
   - Advances to `spec` phase → runs spec → plan → implement → QA from scratch

4. **Revision-mode spec**: `runSpec` detects `spec_revision_feedback.md` and sends a `REVISION:` prompt instead of `/spec`. The spec command template (`spec.md` Revision Mode) instructs the analyst to read the existing spec + revision feedback, address all concerns, preserve valid parts, and re-validate.

5. **After revision**: The revised spec flows through plan → implement → QA normally. If QA now passes, the task goes to `awaiting-review` for final approval.

**How retry integrates**: Ensure the project's `.claude/commands/` has the updated templates (synced from `defaults/commands/`) — then clicking **Retry** on any previously-failed task works seamlessly. It resumes from the last real phase using the updated command templates (with spec-gap detection) on the next run. No manual migration needed.

### QA Report Severity Levels

QA reports (`qa_report.json`) contain two kinds of issues:
- **`criteria`** — formal pass/fail per spec acceptance criterion. FAIL criteria are always hard blockers.
- **`additional_issues`** — issues found beyond the spec criteria, each tagged with a severity level.

**Severity levels** (defined in `defaults/commands/qa-review.md`):

| Severity | Meaning | Blocking? | Engineer must fix? |
|----------|---------|-----------|-------------------|
| `critical` | Hard blocker — cannot pass QA until fixed | Yes | Yes |
| `error` | Same as `critical` — interchangeable | Yes | Yes |
| `warning` | Should be fixed but doesn't block QA pass alone | No | If time permits |
| `suggestion` | Nice-to-have improvement | No | Optional |

**How severity flows through the pipeline:**

1. **QA agent** produces `qa_report.json` with `additional_issues` containing `severity`, `description`, `file`, and optional `fix_needed`.

2. **`_writeQaFeedback`** (orchestrator.ts) writes `qa_feedback.md` and patches `plan.json`:
   - FAIL criteria → `[QA CORRECTION: fix_needed]` appended to matching subtask acceptance criteria
   - `additional_issues` → `[QA ISSUE (severity): description → Fix: fix_needed]` appended to subtasks matching by file
   - Both set `qa_flagged: true` so only affected subtasks re-run

3. **`runImplement` QA rework mode** sends the engineer a prompt with per-subtask feedback:
   - The cleaning regex transforms tags into human-readable severity indicators:
     - `[QA CORRECTION: Fix X]` → `[BLOCKER] Fix X`
     - `[QA ISSUE (critical): desc → Fix: x]` → `[critical] desc → Fix: x`
     - `[QA ISSUE (warning): desc]` → `[warning] desc`
     - `[QA ISSUE (suggestion): desc]` → `[suggestion] desc`
   - Non-QA acceptance criteria pass through unchanged

4. **`implement.md`** QA Rework Mode instructs the engineer:
   - Issues marked `critical` or `error` are HARD BLOCKERS — must fix, not suggestions
   - Only `suggestion` severity items are optional
   - The engineer must address ALL QA issues before marking the subtask complete

This design ensures the engineer can distinguish between a hard blocker ("this must be fixed or QA will fail again") and an optional suggestion ("nice to have but won't block the merge"), preventing infinite qa-fix loops where the engineer ignores critical issues they thought were optional.

### Pipeline Workflow Rules

The command templates in `defaults/commands/` enforce cross-cutting guardrails to prevent common anti-patterns. These rules span multiple pipeline phases and are designed to work together.

#### Spec Phase (analyst)

1. **No Delegated Analysis** (`spec.md` Step 1): Investigation and root-cause analysis are pre-spec activities. If the feature request asks the analyst to "investigate", "analyse", or "determine the correct value for" something, the analyst must complete that investigation NOW — read logs, derive formulas, determine thresholds — and embed findings directly into the spec. NEVER delegate analysis to the implement phase via requirements like "determine the correct value" or "analyse why X fails". By the time the spec reaches the engineer, every concrete value, formula, and threshold must already be decided and justified.

2. **Self-Critique Check** (`spec.md` Step 4): The analyst must check for delegated-analysis anti-patterns — are any requirements worded as research tasks ("analyse", "investigate", "determine") instead of concrete, computed specifications?

#### Plan Phase (planner)

3. **Verification Script Subtask Rule** (`plan.md` Rules): When the spec includes an acceptance criterion that requires running a script to produce empirical evidence (benchmark, integration run, data pipeline), the plan MUST include a dedicated subtask for that script run. Never fold it into a documentation subtask. The subtask must specify: (a) the exact command to run, (b) what output artifact to commit, and (c) the specific check to apply to the output (e.g. "section X shows fewer than N failures"). This makes the criterion independently verifiable by QA without relying on the engineer's self-report.

#### Implement Phase (coder)

4. **No Mathematical Substitution** (`implement.md` Rules): If an acceptance criterion requires empirical evidence from a script run (benchmark, integration test, data pipeline, verification report), the coder MUST run the script and commit the output. Mathematical or theoretical justification does NOT satisfy an empirical criterion. A claim of "mathematically verified" for a criterion that says "post-fix script exits with < 20 failures" is a FAIL.

5. **Word-Gaming Prevention** (`implement.md` Rules): Changing the wording of a claim from "verified" to "expected" or "mathematically estimated" is not a fix — it is an acknowledgement of failure.

6. **Session Budget Awareness** (`implement.md` Rules): If a required script takes too long for the session budget, stop and report the blocker explicitly rather than substituting a theoretical claim.

7. **Cleanup-Only Rework Mode** (`implement.md` QA Rework): When `fail_type` is `"cleanup"`, the coder enters cleanup-only mode: no spec re-read, no test suite, execute only mechanical `fix_needed` operations. This covers both git/file-system fixes (git rm, git add) and artifact fixes (run a script, verify output, git add, commit, push).

8. **Incremental Progress Estimation** (`implement.md` Long-Running Scripts): For scripts that produce incremental progress output (growing log, record counter, progress lines), check once to confirm it's running, estimate remaining time from throughput rate, wait that duration before checking again. Do NOT check on a fixed short interval. Do NOT restart a script making expected progress. Do NOT start parallel runs. Only escalate if: no output for 10+ minutes, script exited early, or an error line appears.

9. **Background Output Unreadable** (`implement.md` Long-Running Scripts): If a long-running background script does not deliver readable output after its completion notification, re-run it synchronously (without `run_in_background`). Do NOT substitute a partial or reduced run for the full required invocation, and do NOT change acceptance-criterion wording to work around missing evidence.

#### QA Review Phase (qa-reviewer)

10. **Empirical Evidence Enforcement** (`qa-review.md` Step 5): For acceptance criteria requiring empirical evidence from a script run, the QA agent must read the committed output and confirm the results meet the criterion's thresholds. A coder claim of "mathematically verified" or theoretical justification does NOT satisfy an empirical criterion — mark it FAIL.

11. **Extended Cleanup fail_type** (`qa-review.md` Output, `orchestrator.ts`): `fail_type: "cleanup"` covers ALL mechanical fixes with zero source code changes — both git/file-system operations AND script-run-and-commit operations (e.g., the coder substituted math for benchmark output; the fix is to run the script and commit results). The orchestrator routes cleanup failures to implement with cleanup-only rework mode, and writes `fail_type` into `qa_feedback.md` so the coder detects cleanup mode without needing to locate `qa_report.json`.
