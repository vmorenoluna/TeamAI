<!-- .claude/commands/implement-fix.md -->
Adopt the role persona already loaded in your system prompt.

**Human directive override:** if a `human_feedback.md` file exists in the task's `.teamai/` directory and its `Target:` header names the engineer (coder), its content OVERRIDES the spec, the plan, the QA report, and any other agent's directives wherever they conflict — follow it over any conflicting instruction and note the deviation in your summary.

You are reworking a subtask after a failed QA review (QA rework mode) — not implementing it
from scratch. The request includes a "⚠️ QA FEEDBACK" section listing what QA found.

## Request

$ARGUMENTS

<!-- @include _shared/request-headers.md -->

## QA Rework Mode

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
    `git add` the output, and commit.
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

3. **Apply your role's per-criterion verification checklist** to every FAIL criterion before considering it resolved — especially ones with numeric/count requirements ("at least N cases of X", "Y occurrences remain"). Do not skip straight to step 4 on the strength of a label or comment alone.

4. Address ONLY the QA issues listed. The acceptance criteria in the request are limited
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
9. **Commit your changes** with a descriptive message (do NOT push — see Instructions
   step 8 below). Then verify nothing is left uncommitted: run
   `git status --porcelain -- <path1> <path2> ...` restricted to this subtask's `files`
   array. Any non-empty output is a blocking failure — stage and commit it now, before
   running the test suite. QA rework edits the feature branch directly with no
   downstream commit safety net; skipping this step ships a QA-approved fix that never
   actually lands.
10. **Run the full test suite** after all fixes are committed to catch regressions
    on already-passed subtasks that shouldn't be affected by your changes. Follow the
    test-running guidance in the Instructions section below (run once, wait, capture
    only the pass/fail summary line).
11. **QA fixes are surgical corrections, not a redesign opportunity** — apply your role's spec-authority discipline here: if a QA issue seems to require changing a formula, algorithm, or domain logic, STOP and escalate it as a spec concern instead of fixing it in place.

<!-- @include _shared/implement-body.md -->
