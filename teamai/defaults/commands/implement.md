<!-- .claude/commands/implement.md -->
Read and adopt the role defined in .claude/roles/coder.md before proceeding.

You are implementing a single subtask from an implementation plan.

$ARGUMENTS

## QA Rework Mode

If the prompt includes "⚠️ QA FEEDBACK" at the top, you are in QA rework mode:

QA feedback represents the latest requirements. The plan may be stale — QA findings are
the ground truth. Where QA feedback and the plan conflict, follow the QA feedback and
note the deviation from the plan.

1. Read the QA feedback FIRST. It takes priority over everything else.
2. Address ONLY the QA issues listed. The acceptance criteria below are limited
   to items marked [QA CORRECTION] or [QA ISSUE] — fix those and nothing else.
3. Do NOT re-read the full spec or re-validate criteria that QA already passed.
   Those were verified by the QA agent and require no changes.
4. For each QA issue:
   - Address it even if the current code already satisfies the original plan.
   - If the issue requires a different approach than the plan, follow the QA feedback.
5. Do NOT skip an issue because the code "already matches the plan."
6. Do NOT mark the subtask as complete unless ALL QA issues are addressed.
   - Issues marked as **critical** or **error** severity are HARD BLOCKERS — they carry the same weight as FAIL criteria. You MUST fix them; they are not suggestions.
   - Only **suggestion** severity items are optional.
7. Focus on the specific issues listed — don't refactor unrelated code.
8. **Run the full test suite** after all fixes are committed to catch regressions
   on already-passed subtasks that shouldn't be affected by your changes. Run
   the command ONCE and wait — do not re-run it repeatedly. Capture only the
   pass/fail summary line — do not read the full test output into context unless a
   failure requires diagnosis.
   See `.claude/teamai-workflow.md` for full guidance on long-running scripts.
9. **CRITICAL: Do NOT change formulas, algorithms, or domain logic.** QA fixes
   are surgical corrections of implementation defects — they are NOT opportunities
   to redesign the solution. If an issue seems to require changing a formula or
   algorithm, STOP: this is a spec concern that must be escalated, not fixed in place.
   A fix that invents a new formula is not a fix — it's a design change that
   bypasses the spec.

## Instructions

**The subtask description is authoritative.** It contains exact file paths, symbol names,
and often the exact diff to apply. Apply edits directly from the description. Use
`Grep`/`Glob`/`Read` only as a fallback when an `Edit` fails to match — not as a
default opening move to re-locate information the description already provides. Do not
re-read a file to verify an `Edit` that returned success.

1. Read the subtask description and acceptance criteria carefully.
2. Read ALL files listed in the subtask before making any changes.
3. Implement the changes. Follow existing code patterns and conventions.
4. Run any existing tests related to the changed files. Run the command ONCE and wait —
   do NOT re-run it repeatedly in a loop. Capture only the pass/fail summary (e.g. pipe
   through a pattern that matches "X tests, Y failures" or equivalent) — do not read the
   full test output into context unless a failure requires diagnosis. See
   `.claude/teamai-workflow.md` for full guidance on long-running scripts.
5. If tests fail, fix the issues before proceeding.
6. Commit your changes with a descriptive message: `feat(scope): description`
7. Print a summary of what was changed and the test results.

## Rules
- Only modify files listed in the subtask unless absolutely necessary.
- If you must modify additional files, explain why.
- Do NOT modify files belonging to other subtasks.
- Match existing code style exactly (indentation, naming, patterns).
- Add or update tests for any new functionality.
- **CRITICAL: Do NOT delete, stage, or commit qa_report.json, qa_feedback.md, or human_feedback.md.** These are task-tracking files managed by the QA agent and human reviewers. Treat them as read-only.
- If the spec or plan documents rejected alternatives, failed approaches, or explains
  why a specific value or formula was chosen, treat that as authoritative. Do not
  re-derive, re-test, or re-explore alternatives the spec explicitly marks as rejected
  or superseded.

## Long-Running Verification Scripts

When a subtask requires running a verification script (sweep, benchmark, end-to-end
integration run) that takes more than ~30 seconds:

1. Start it using `run_in_background: true` on the Bash tool call.
2. Do any remaining non-blocking work (updating docs, minor edits) while it runs.
3. When the background completion notification arrives, read the output **once**.
4. **Never poll**: do not tail the output file, re-read partial output, or re-run
   the script to check progress. Polling wastes tokens and violates the "run once,
   don't poll" contract. One start + one await is the complete pattern.
5. Capture only the summary line from the output (pass/fail count, error list) —
   do not read the full output into context unless a failure requires diagnosis.
```