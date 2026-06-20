<!-- .claude/commands/implement.md -->
Read and adopt the role defined in .claude/roles/coder.md before proceeding.

You are implementing a single subtask from an implementation plan.

$ARGUMENTS

## QA Rework Mode

If the prompt includes "⚠️ QA FEEDBACK" at the top, you are in QA rework mode:

QA feedback represents the latest requirements. The plan may be stale — QA findings are
the ground truth. Where QA feedback and the plan conflict, follow the QA feedback and
note the deviation from the plan.

**Before reading the full QA feedback**, check if `fail_type` in the QA report is `"cleanup"`.
If so, you are in **cleanup-only rework mode**:
- The QA issues require only mechanical operations with zero source code changes.
- Do NOT re-read the full spec. Do NOT run the test suite (no source code will change).
- Execute only the `fix_needed` operations from the failing criteria:
  - For git/file-system fixes: `git rm`, `git add`, `git mv`, committing missing files, etc.
  - For artifact fixes: run the specified script, verify the output meets the criterion's thresholds,
    `git add` the output, commit, and push.
- Commit and push.
- Print a summary of what was cleaned up or what artifact was produced.
- Cleanup rework is complete — do not mark additional subtasks as complete.

If `fail_type` is `"code"` or absent, proceed with the standard QA rework steps below.

1. Read the QA feedback FIRST. It takes priority over everything else.
2. Address ONLY the QA issues listed. The acceptance criteria below are limited
   to items marked [QA CORRECTION] or [QA ISSUE] — fix those and nothing else.
3. Do NOT re-read the full spec or re-validate criteria that QA already passed.
   Those were verified by the QA agent and require no changes.
4. For each QA issue:
   - Address it even if the current code already satisfies the original plan.
   - If the issue requires a different approach than the plan, follow the QA feedback.
5. Do NOT skip an issue because the code "already matches the plan."
   - If a FAIL criterion includes a `fix_needed` field, that field describes exactly
     what must be ADDED or CHANGED. A passing test suite does NOT mean the required
     code exists — it means existing code is not broken. QA FAIL means something is
     MISSING. Add it even if all current tests pass and all plan subtasks are marked
     `completed: true`.
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
7. Push the branch: `git push origin HEAD` (QA cannot verify unpushed commits).
8. Print a summary of what was changed and the test results.

## Rules
- Only modify files listed in the subtask unless absolutely necessary.
- If you must modify additional files, explain why.
- Do NOT modify files belonging to other subtasks.
- Match existing code style exactly (indentation, naming, patterns).
- Add or update tests for any new functionality.
- **CRITICAL: Do NOT delete, stage, or commit qa_report.json, qa_feedback.md, or human_feedback.md.** These are task-tracking files managed by the QA agent and human reviewers. Treat them as read-only.
- **CRITICAL: Do NOT create, modify, or delete any files under `.teamai/`.** If a subtask
  instructs you to create TeamAI tickets or write to `.teamai/`, skip that subtask entirely
  and include in your summary: `[SKIPPED] Ticket creation is the analyst's responsibility —
  not implemented by the coder role.` Ticket creation requires a more capable model with
  broader project context; the analyst will handle it after reviewing this work.
- If the spec or plan documents rejected alternatives, failed approaches, or explains
  why a specific value or formula was chosen, treat that as authoritative. Do not
  re-derive, re-test, or re-explore alternatives the spec explicitly marks as rejected
  or superseded.
- **No mathematical substitution:** If an acceptance criterion requires empirical evidence
  from a script run (benchmark, integration test, data pipeline, verification report),
  you MUST run the script and commit the output. Mathematical or theoretical justification
  does NOT satisfy an empirical criterion. A claim of "mathematically verified" for a
  criterion that says "post-fix script exits with < 20 failures" is a FAIL. Changing the
  wording of a claim from "verified" to "expected" or "mathematically estimated" is not
  a fix — it is an acknowledgement of failure. If the script takes too long for the
  session budget, stop and report the blocker explicitly rather than substituting a
  theoretical claim.

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

### When background output is unreadable

If a long-running background script does not deliver readable output after its
completion notification, re-run it synchronously (without `run_in_background`).
Do NOT substitute a partial or reduced run for the full required invocation, and
do NOT change acceptance-criterion wording to work around missing evidence.

### When the script produces incremental progress output

If a long-running background script produces incremental output while running
(a growing log file, a record counter, a progress line):

1. **Check once** shortly after starting to confirm it is running and producing output.
2. **Estimate remaining time** from the progress: how many records/steps have completed,
   how many remain, what the throughput rate is.
3. **Wait that estimated duration** before checking again — do NOT check on a fixed
   short interval. A script processing 100 records/min with 900 remaining has ~9 minutes
   left; checking every 30 seconds serves no purpose.
4. **Do not restart** a script that is visibly making progress at the expected rate.
   It is running correctly — restarting wastes time and risks corrupting partial output.
   Do not start a parallel run — one running instance is sufficient.
5. **Escalate only on clear failure signals:**
   - No new output has appeared for more than 10 minutes
   - The script has exited early (before completing the expected workload)
   - An error line appears in the output
   Do NOT restart or escalate because the script "feels slow" — use the math.

### When the sweep output is a committed artifact

If the subtask requires running a sweep that **produces files you will commit** (e.g.,
`summary.jsonl`, `aggregate.md`, log directories):

1. Run the sweep ONCE with `run_in_background: true`. The output files will be written to disk.
2. While it runs, complete any doc edits or other non-blocking subtask work.
3. Wait for the background completion notification — do NOT read the output file while it is
   running, do NOT re-run the sweep to "check progress", do NOT tail the log.
4. When the notification arrives, verify the output (record count, no truncated JSON lines,
   expected fields present) by reading only the first and last records.
5. Run the aggregator script (if one exists) against the completed output.
6. `git add` the sweep output directory + aggregated results. Commit.
7. **Never commit a partial sweep.** If the sweep was interrupted, delete the partial output
   and re-run from the beginning. A committed summary.jsonl with 1,431 of 3,000 expected
   records is harder to diagnose than no file at all.
```