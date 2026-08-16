<!-- .claude/commands/implement.md -->
Adopt the role persona already loaded in your system prompt.

**Human directive override:** if a `human_feedback.md` file exists in the task's `.teamai/` directory and its `Target:` header names the engineer (coder), its content OVERRIDES the spec, the plan, the QA report, and any other agent's directives wherever they conflict — follow it over any conflicting instruction and note the deviation in your summary.

You are implementing a single subtask from an implementation plan.

$ARGUMENTS

## QA Rework Mode

If the prompt includes "⚠️ QA FEEDBACK" at the top, you are in QA rework mode.

> ⚠️ **CRITICAL: THERE IS STILL WORK TO DO.** QA found failures — that means
> something is broken or missing, regardless of what `plan.json` says about
> subtask completion status. QA findings are the ground truth. The plan may
> be stale. If QA says something is wrong, it is — fix it.

### When All Subtasks Are Already Completed

If every plan subtask is marked `completed: true` but QA still found failures:

- **Do NOT treat this as "nothing to do."** QA failures mean the implementation
  is incomplete, even if every subtask was marked done.
- Your job is **surgical rework**, not re-implementation. Do NOT re-read the
  full spec or re-execute completed subtasks.
- Read the QA feedback. Fix every listed issue. That's the entire scope.
- A passing test suite does NOT mean the required code exists — it means
  existing code is not broken. QA FAIL means something is MISSING. Add it.
- If a FAIL criterion includes a `fix_needed` field, that field describes
  exactly what must be ADDED or CHANGED.

### Cleanup-Only Rework Mode

**Before reading the full QA feedback**, check if `fail_type` in the QA report
is `"cleanup"`. If so, you are in **cleanup-only rework mode**:
- The QA issues require only mechanical operations with zero source code changes.
- Do NOT re-read the full spec. Do NOT run the test suite (no source code will change).
- Execute only the `fix_needed` operations from the failing criteria:
  - For git/file-system fixes: `git rm`, `git add`, `git mv`, committing missing files, etc.
  - For artifact fixes: run the specified script, verify the output meets the criterion's thresholds,
    `git add` the output, commit, and push.
- Commit your changes (do NOT push — the orchestrator handles pushing).
- Print a summary of what was cleaned up or what artifact was produced.
- Cleanup rework is complete — do not mark additional subtasks as complete.

If `fail_type` is `"code"` or absent, proceed with the standard QA rework steps below.

### Standard QA Rework Steps

1. Read the QA feedback FIRST. It takes priority over everything else.

2. **⚠️ PERSISTED FAILURES CHECK**: If the QA feedback contains a "⚠️ PERSISTED
   FAILURE" section at the very top, those criteria have failed identically
   across multiple consecutive QA cycles. They MUST be resolved before
   addressing anything else. The escalation text tells you
   exactly how many times each criterion has failed unchanged. Do NOT
   deprioritize a persisted failure in favor of another issue.

3. **Per-criterion checklist — MANDATORY before considering a FAIL criterion resolved**:
   For EVERY FAIL criterion (especially those with numeric/count requirements
   like "must have at least N cases of X" or "Y occurrences remain"):

   a) **Enumerate**: List every existing case/candidate/occurrence explicitly.
   b) **Classify assertion direction**: For each case that involves a test
      assertion, read the actual assertion logic — NOT the comment, label, or
      variable name. A test case that is commented as "positive case 2" but
      asserts a zero/no-op result does NOT count as a positive case.
   c) **Confirm the count**: After classification, verify that the count of
      cases with the correct assertion direction matches the requirement.
   d) **Summary report**: Print a line-per-case breakdown before marking
      the criterion resolved.

   Never trust comments, labels, or variable names as proof of satisfaction.
   Comments lie; assertions don't.

4. Address ONLY the QA issues listed. The acceptance criteria below are limited
   to items marked [QA CORRECTION] or [QA ISSUE] — fix those and nothing else.
5. Do NOT re-read the full spec or re-validate criteria that QA already passed.
   Those were verified by the QA agent and require no changes.
6. For each QA issue:
   - Address it even if the current code already satisfies the original plan — do NOT
     skip an issue because the code "already matches the plan."
   - If the issue requires a different approach than the plan, follow the QA feedback
     and note the deviation in your summary.
7. Do NOT mark the subtask as complete unless ALL QA issues are addressed.
   - EVERY issue listed in the QA feedback MUST be fixed. There are no optional or skippable items.
   - Failed criteria, additional issues — all of them are requirements. Fix them all.
8. Focus on the specific issues listed — don't refactor unrelated code.
9. **Run the full test suite** after all fixes are committed to catch regressions
   on already-passed subtasks that shouldn't be affected by your changes. Follow the
   test-running guidance in the Instructions section below (run once, wait, capture
   only the pass/fail summary line).
10. **CRITICAL: Do NOT change formulas, algorithms, or domain logic.** QA fixes
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
   **If the subtask includes `files_to_create`**, note which files you MUST
   create before ending your session — the orchestrator will verify their
   existence and the subtask will re-run if any are missing.
2. Read ALL files listed in the subtask before making any changes.
3. Implement the changes. Follow existing code patterns and conventions.
4. Run any existing tests related to the changed files. Run the command ONCE and wait —
   do NOT re-run it repeatedly in a loop. Capture only the pass/fail summary (e.g. pipe
   through a pattern that matches "X tests, Y failures" or equivalent) — do not read the
   full test output into context unless a failure requires diagnosis. See
   `.claude/teamai-workflow.md` for full guidance on long-running scripts.
5. If tests fail, fix the issues before proceeding.
6. Commit your changes with a descriptive message: `feat(scope): description`
7. **Do NOT push.** Commit your changes — the orchestrator handles pushing (see your role guardrails).
8. Print a summary of what was changed and the test results.

## Rules
- **You may ONLY modify files explicitly listed in the subtask's `files` array.** This is a hard limit. If a change strictly requires touching unlisted files (e.g. implicitly affected tests), STOP and report the missing dependency rather than expanding your scope. The subtask must be replanned to include those files.
- Do NOT modify files belonging to other subtasks.
- Match existing code style exactly (indentation, naming, patterns).
- Add or update tests for any new functionality.
- **CRITICAL: Do NOT create, modify, delete, stage, or commit pipeline artifacts** (spec.md, plan.json, qa_report.json, qa_feedback.md, human_feedback.md, completion_summary.md) — they are managed by the pipeline orchestrator and QA agent; treat them as read-only. If a subtask instructs you to write to these files, skip that instruction entirely and include in your summary: `[SKIPPED] Pipeline artifact management is the orchestrator's responsibility.`
- **Out-of-scope bugs: report, don't fix inline.** If you discover a bug, missing feature,
  or refactor opportunity that is outside your assigned subtask scope, do NOT fix it and
  do NOT write any ticket files — the orchestrator creates the kanban ticket from your
  summary. Report each finding on its own line using the `Fix:` prefix:
  Summary format: `[BUG] Fix: {description} — {reason it's out-of-scope}`
  The orchestrator parses these lines and files the ticket in the project's `.teamai/`
  directory. This lets the team triage the bug properly rather than silently shipping an
  unplanned change.
- If the spec or plan documents rejected alternatives, failed approaches, or explains
  why a specific value or formula was chosen, treat that as authoritative. Do not
  re-derive, re-test, or re-explore alternatives the spec explicitly marks as rejected
  or superseded.
- **Spec authority**: If you believe a formula, algorithm, threshold, or design
  decision in the spec is wrong, flag it in your summary — do NOT silently change it.
  The spec is the contract between the analyst and the engineer; changing it without
  revision is a spec bypass. Implement what the spec says, then escalate concerns so
  the spec can be revised through the proper pipeline (spec → plan → implement),
  not patched ad-hoc during implementation. This applies to NORMAL implement mode,
  not just QA rework.
- **A labeled hypothesis that verification disproves is the same case, not a different one.** If a spec criterion is explicitly marked as an unverified hypothesis (e.g. "Expected to resolve X — unverified; must be confirmed by re-running the verification step"), implement it exactly as specified and run the required verification. If the result contradicts the hypothesis, that is a spec-authority issue per the rule above — do NOT invent, adjust, or retune a value to compensate, even if you're confident your replacement is correct. State in your summary that this is a spec-level gap with the verbatim verification evidence, so it routes to spec revision instead of looping you on a fix that was never yours to make.
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

When a subtask requires running a verification script (benchmark, end-to-end
integration run, data pipeline) that takes more than ~30 seconds:

**NEVER foreground a known-long job.** If the subtask description, spec, or your
own estimate says a verification step will run longer than a few minutes, detach it
from the very first attempt. Foregrounding it under the session timeout wastes a
full session — it gets killed mid-run, the output is lost, and you have to re-launch
it detached anyway. Detach from the start.

1. Start it using `run_in_background: true` on the Bash tool call.
2. Do any remaining non-blocking work (updating docs, minor edits) while it runs.
3. When the background completion notification arrives, read the output **once**.
4. **Never poll on a fixed interval**: do not tail the output file on a short loop.
   One start + one wait is the complete pattern. See below for progress-based waiting.
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

### When the run's output is a committed artifact

> **Note:** The `$TEAMAI_SPEC_DIR` environment variable is available to locate the
> `.teamai/{taskId}/` directory from within the worktree. Use it when you need to
> reference the spec directory (your cwd is the worktree, not the project root).

If the subtask requires running a script that **produces files you will commit** (e.g.,
`summary.jsonl`, `aggregate.md`, log directories):

1. Run it ONCE with `run_in_background: true`. The output files will be written to disk.
2. While it runs, complete any doc edits or other non-blocking subtask work.
3. Wait for the background completion notification — do NOT read the output file while it is
   running, do NOT re-run the script to "check progress", do NOT tail the log.
4. When the notification arrives, verify the output (record count, no truncated JSON lines,
   expected fields present) by reading only the first and last records.
5. Run the aggregator script (if one exists) against the completed output.
6. `git add` the output directory + aggregated results. Commit.
7. **Never commit a partial run.** If it was interrupted, delete the partial output
   and re-run from the beginning. A committed summary.jsonl with 1,431 of 3,000 expected
   records is harder to diagnose than no file at all.

### When a background script won't finish before your session budget

If a background script is still running and won't complete before your session
ends, write a `subtask_wakeup-st<ID>.json` file to the spec directory and end
normally. The file's exact shape, how to size `wakeup_at`, and the re-entry
contract are in your role's "Running Verification Scripts & Servers" section.