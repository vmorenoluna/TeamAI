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
