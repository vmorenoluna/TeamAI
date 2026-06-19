# TeamAI Workflow

This project uses an automated pipeline managed by an external orchestrator.
When you receive slash commands (/spec, /plan, /implement, /qa-review, /qa-fix, /merge),
follow their instructions precisely and output structured files as specified.

## Key Conventions
- Specs live in `.teamai/{slug}/`
- Each spec directory contains: spec.md, plan.json, qa_report.json
- Implementation happens in git worktrees (you're already in one)
- Commit messages follow Conventional Commits: feat(), fix(), chore()
- Run tests after every change before committing
- Match existing code style exactly

## Artifact Commits

When the pipeline reaches the merge or PR-creation phase, the orchestrator commits the
task's pipeline artifacts into the worktree so the PR or merge includes the full
implementation story alongside the code changes.

### What gets committed

Files from `.teamai/{task-slug}/` are copied into the worktree at `.teamai/{slug}/`.
Everything is included **except** these two files:

| Excluded file | Reason |
|---------------|--------|
| `output.log` | Raw terminal output — may contain sensitive data (API keys, errors, code snippets) |
| `.pipeline_state.json` | Transient crash-recovery checkpoint — session IDs and runtime paths, meaningless after commit |

Everything else that tells the story of the implementation is included:

- **`task.json`** — task metadata and current phase
- **`spec.md`** — feature specification (including `spec_v1.md`, `spec_v2.md`, ... revision snapshots)
- **`plan.json`** — implementation plan with subtask breakdown and completion status
- **`qa_report.json`** — QA review results (PASS/FAIL criteria, additional issues, severity levels)
- **`qa_report_before_*.json`** — snapshots from QA bounce-back cycles (shows what went wrong on each attempt)
- **`completion_summary.md`** — failure summary with subtask status and last QA report (if the task failed)
- **`events.jsonl`** — phase transition timeline (spec → plan → implement → QA → merge)
- **`qa_feedback.md`** — QA feedback sent to the engineer for fixes (if present at commit time)
- **`human_feedback.md`** — human reviewer feedback from `rejectTask` (if present at commit time)
- **`human_feedback_before_bounce.md`** — feedback snapshot preserved across bounce cycles
- **`spec_revision_feedback.md`** — QA spec concerns used to auto-revise the spec

### Commit behavior

1. Artifacts are committed to the feature branch in the worktree with a message like
   `Add TeamAI pipeline artifacts for "<description>"`.
2. The commit happens just before the push (in `runCreatePR`) or before the merge agent
   runs (in `runMerge`).
3. **Already committed**: If artifacts are already on the branch (e.g., re-running PR
   creation after a reject-bounce cycle), the commit is a no-op — no duplicate commit is made.
4. **Gitignored**: If `.teamai/` is listed in the project's `.gitignore`, the commit is
   silently skipped. The user's choice to not track artifacts is respected.

### Why this matters

When a reviewer looks at a PR, they can see the full story alongside the code:

- **What was asked for** — the spec (`spec.md`)
- **How it was planned** — the implementation plan (`plan.json`)
- **What QA found** — the review results (`qa_report.json`)
- **How it evolved** — spec revisions and QA bounce-back snapshots

This gives reviewers context for *why* the code looks the way it does, without needing
access to the TeamAI server. The artifacts are versioned alongside the code and persist
in the repository history.

### Two directory trees

The artifact commit copies files into `.teamai/{slug}/` inside the worktree. This is
distinct from the pipeline workspace at `.teamai/{task-slug}/` in the main project root:

- **Pipeline workspace** (`.teamai/{task-slug}/`) — live runtime state, rewritten on every
  phase transition, never tracked in git
- **Committed artifacts** (`.teamai/{slug}/` in the worktree) — frozen snapshot at PR/merge
  time, pushed to the remote, pulled into main after merge

These two directories coexist without conflict — they're the same top-level `.teamai/`
directory but with different subdirectories (`task-slug` vs `slug`). The live workspace
persists through the entire task lifecycle and is never deleted on merge.

## Memory
Claude Code's Auto Memory is enabled for this project. Claude will automatically:
- Save useful patterns, decisions, and lessons learned as it works.
- Load relevant memories at the start of each session.
- Consolidate and prune stale memories via Auto Dream.
You can inspect memories at ~/.claude/projects/<project>/memory/ or run /memory in a session.

## Running Long-Running Scripts

When running test suites, builds, linters, or other project scripts that take
more than a few seconds:

1. **Estimate before running**: Check the project's scripts, Makefile, or
   historical output for clues about expected duration. If the script/test suite/...
   historically takes ~90s, plan for that — don't assume 5 seconds.

2. **Read progress output**: Most test runners and build tools emit progress as
   they run (test counts, compilation percentages, file counters). Use this to
   gauge how far along the command is and whether it's still making progress
   vs. hung.

3. **Run once, don't poll**: Do NOT run the same command repeatedly in a loop
   to check if it's "done yet." Run it ONCE with an appropriate timeout. If
   the command is still producing meaningful output, it hasn't finished — wait
   for it. Re-running a long command wastes resources and can cause file-lock
   conflicts (especially on Windows).

4. **Run independent checks in parallel**: `typecheck`, `lint`, and `test`
   often have no dependencies on each other. Start them together in parallel
   rather than running sequentially — this is faster and avoids repeated
   context-switching by the agent.

5. **Use focused runs in iteration, full suite at the end**: During iterative
   fixes, run only the tests relevant to changed files (e.g., running just
   the test file for the changed module, not the entire suite). Run the full
   suite once as the final validation step before committing.

6. **Don't interpret "slow" as "broken"**: A test suite taking 2 minutes is
   not a failure — it's a large project. Wait for the result. Only treat
   timeouts or hanging output (no new output for 60+ seconds) as a problem.
