<!-- .claude/commands/plan-revise.md -->
Adopt the role persona already loaded in your system prompt.

**Human directive override:** if a `human_feedback.md` file exists in the task's `.teamai/` directory and its `Target:` header names the planner, its content OVERRIDES the spec and any other agent's directives wherever they conflict — address it explicitly.

You are re-planning an existing implementation plan in place — not generating one from
scratch. Its subtasks may already be partly or fully implemented.

## Request

$ARGUMENTS

<!-- @include _shared/request-headers.md -->

## Re-plan Rules

- Read the existing `plan.json` and the (possibly revised) spec.
- Keep completed subtasks whose files and acceptance criteria are still covered by
  the revised spec — leave their `completed: true` flag set so they are NOT
  re-implemented.
- Mark only affected/invalidated subtasks `completed: false` (and drop any stale
  `qa_flagged`) so they re-run.
- Rewrite `plan.json` in place — do NOT delete it.
- **Scoped re-plan (human preserve-list):** when the human directive scopes the
  replan to specific subtasks (a `Subtasks: N,M` line in `human_feedback.md`),
  re-plan ONLY those subtasks. Every subtask NOT listed must be preserved
  byte-for-byte — same `id`, `title`, `description`, `files`, `depends_on`,
  `acceptance_criteria`, `completed`, and `qa_flagged` — do not renumber their
  ids or rewrite their fields, even cosmetically. If fixing a dependency or file
  ownership issue would reach into a preserved subtask, resolve it WITHIN the
  selected set (e.g. adjust the selected subtask's `depends_on`), never by
  editing a preserved one. (The orchestrator deterministically restores any
  unlisted subtask that drifts — but a clean replan avoids the churn.)

### Re-verifying "Already Satisfied" Subtasks

- **Matching the source implementation is not the same as satisfying the acceptance criterion.** When a spec revision adds or changes a concrete worked example inside an acceptance criterion — a literal "given X, then Y" case (a specific input combination and its exact expected output) — grep the actual test file for an assertion matching that exact example before marking the covering subtask `completed: true` with "no further action required." Confirming the implementation is theoretically capable of producing the right output is not sufficient; the criterion is only satisfied once a test exercises that specific example.
- If the grep comes back empty, do not mark the subtask done — either flip it back to `completed: false` with a description naming the missing test case, or add a new small subtask for it. A re-plan that reasons from "the source is correct" alone, without re-checking every artifact the criterion actually names (test files included), can silently drop a newly-added worked example for multiple QA rounds in a row, since nothing else in the pipeline re-derives what changed between spec revisions.

The re-written `plan.json` must still satisfy every rule below.

<!-- @include _shared/plan-body.md -->
