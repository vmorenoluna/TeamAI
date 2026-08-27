<!-- .claude/commands/qa-review.md -->
Adopt the role persona already loaded in your system prompt.

**Human directive override:** if a `human_feedback.md` file exists in the task's `.teamai/` directory, honor it by target: if its `Target:` header names the QA reviewer, its content OVERRIDES the spec and plan wherever they conflict — verify against it; if it names another agent, treat it as authoritative context — verify the change was made and do not flag it as a deviation.

You are a QA reviewer validating an implementation against its specification.

Read the spec at: $ARGUMENTS

## Step 0: Detect Rework Pass (run first, before anything else)

Check whether a previous `qa_report.json` already exists in `.teamai/{slug}/`.

> ⚠️ **REWORK PASS: DON'T SKIP VERIFICATION.** A previous QA report exists —
> that means the coder has made changes, and your job is to verify those changes
> haven't broken anything. Carry forward ONLY criteria whose files haven't changed.
> For everything else: re-verify from scratch. The coder was told to fix specific
> issues — they may have introduced regressions elsewhere.

### First QA Pass

**If it does NOT exist** (first QA pass) → proceed normally from Step 1.

### Rework Pass

**If it DOES exist** (this is a rework pass):
1. Read the previous `qa_report.json`. Note which criteria previously FAILed and which PASSed.
2. Read `head_at_review` from the previous report (the sha of the commit QA last reviewed).
3. Run: `git diff <head_at_review>...HEAD --name-only` to get the list of files changed since last review.
4. For each criterion that previously **PASSED**:
   - If NONE of the criterion's relevant files appear in the changed-files list → carry forward the PASS with the original evidence. Do NOT re-verify.
   - If any relevant file DID change → re-verify from scratch.
5. For each criterion that previously **FAILed** → always re-verify from scratch.
6. Skip Steps 1–4 of the Review Process for carry-forward criteria (they are already verified).

This means on a rework pass where only one criterion failed and its file was changed, QA only needs to re-verify that one criterion — not all of them.

## Review Process

### Step 1–4: Gather Evidence

1. Read the spec's acceptance criteria.
2. Read every file listed in the spec's "Files to Modify" section. Read the current file content — not just the diff.
3. Check the git diff to see what actually changed: `git diff origin/HEAD...HEAD`
4. **Ticket-creation subtasks**: If the coder's summary contains `[SKIPPED] Ticket creation is the analyst's responsibility`, treat all acceptance criteria for that subtask as **PASS**. Creating files under `.teamai/` is explicitly out of scope for the coder role — the analyst handles follow-up tickets. Do NOT mark these criteria as FAIL.

### Step 5: Evaluate Each Criterion

5. For each acceptance criterion, determine PASS or FAIL with evidence from the actual file content:
   - If a criterion says "no occurrences of X remain": grep the relevant files and paste the result.
   - If a criterion says "Y is used instead of Z": read the file and confirm.
   - If a criterion requires empirical evidence from a script run (benchmark, integration test, etc.): read the committed output and confirm the results meet the criterion's thresholds. A coder claim of "mathematically verified" or theoretical justification does NOT satisfy an empirical criterion — mark it FAIL.
   - **Unverifiable criterion detection**: If a criterion demands evidence that structurally cannot exist in any committed artifact (e.g., it asks for detail from an uncommitted log, a transient server response, or the coder's self-reported observation), do NOT mark it as a standard FAIL. Instead, add a `spec_concerns` entry: the spec/plan failed to provide a producing artifact for this criterion. The issue is that the criterion itself is unverifiable — the coder cannot fix this by changing code. Flagging it as a standard FAIL would guarantee a useless cleanup bounce.
   - Never infer a criterion is satisfied from the diff alone — verify against current code.
     - **After evaluating each criterion**: write the partial QA report to disk immediately
       (with `"overall": "IN_PROGRESS"` as a placeholder). This ensures that if the session
       is interrupted, partial results are preserved and the next pass can continue from
       where it left off rather than restarting entirely. Replace `"IN_PROGRESS"` with the
       final `"PASS"` or `"FAIL"` once all criteria are evaluated.

### Step 5a: Label/Assertion Mismatch Detection

**Active whenever a criterion involves a numeric/count requirement** (e.g.,
"at least 3 positive cases", "no occurrences of X remain", "Y occurrences exist").

For count-based criteria, do NOT trust comments, labels, or variable names as
proof that a specific case counts toward the requirement. Comments lie;
assertions don't.

1. For each candidate item that could satisfy the count requirement:
   - Read the item's actual assertion logic, not its comment or label.
   - Classify what the assertion actually proves (positive, negative, zero, no-op).
2. If any candidate has a label/comment that says one thing but an assertion
   that proves something different (e.g., a test case commented as "// Positive
   case 2" but asserting `result shouldBe 0`), flag it as an
   `additional_issues` entry:
   - **description**: "Test case at [file:line] is labeled as '[label]' but asserts [what it actually asserts] — this inflates the count for criterion '[criterion text]'"
   - **file**: exact file path and line number
   - **fix_needed**: "Fix the assertion to match the label, or relabel/remove the case"
3. The FAIL criterion itself should remain FAIL until the actual count of
   correctly-asserted cases meets the requirement. The label/assertion mismatch
   is a separate issue that the coder must also fix.
4. Apply the same rigor to negative counts ("no occurrences of X") — grep
   results alone are not sufficient; verify that each occurrence actually
   does what the grep keyword suggests.

## Running Verification Scripts & Servers

When verification requires running a script, server, or service (including the test
suite in Step 6):

- **Run from the worktree.** Start everything from the current working directory (the task's git worktree), NOT the base project root. The worktree contains the branch's code — running from the project root would exercise the wrong revision.
- **Use dynamic ports.** When starting a local server, bind to port 0 (OS-assigned free port). Never hardcode a fixed shared port — another concurrent task may collide.
- **Never kill what you didn't start.** Do NOT use `kill`, `fuser -k`, `taskkill`, or equivalent against any port or process. Another task's agent may be using it.
- **Stop your own instances.** When verification is complete, explicitly tear down any server or service you started.

## Step 6: Run Test Suite

> ⚠️ **ON REWORK PASSES: Run the FULL suite.** The coder was told to run tests,
> but they may have introduced regressions in areas QA previously passed.
> Independent verification is mandatory.

**Run the project's test suite to verify the implementation end-to-end.**

1. Find the test command from the project's build config, Makefile, or package.json.
2. Run it ONCE and wait for completion — do NOT re-run repeatedly. Capture only the
   pass/fail summary line — do not read the full test output into context unless a
   failure requires diagnosis.
   See `.claude/teamai-workflow.md` for full guidance on long-running scripts.
3. **On rework passes** (a previous `qa_report.json` exists in `.teamai/{slug}/`):
   - Run the FULL suite, not just tests targeting changed files.
   - The coder was told to run tests, but they may have introduced regressions
     in areas QA previously passed. Independent verification is mandatory.
   - **Exception — skip the test suite entirely** if `git diff <head_at_review>...HEAD --name-only`
     shows zero changes under the project's source or test directories. Identify those
     directories from the project's own layout (e.g. `src/`, `lib/`, `test/`, `tests/`,
     `src/main/<lang>/`, `src/test/<lang>/`) via its build config, `package.json`, Makefile,
     or directory structure. In that case, carry forward the previous test evidence
     ("Tests: succeeded N, failed 0") as PASS. Only changes outside the source and test
     trees (scripts/, docs/, `.teamai/`, config files) cannot cause test regressions.
     Do NOT skip tests if any source or test file changed.
4. If tests fail:
   - Failures in code the coder was assigned to change → standard FAIL on
     the relevant acceptance criteria.
   - Failures in code the coder was NOT supposed to touch → add an
     `additional_issues` entry (regression / unintended side effect).
5. Record the test command used and the result (pass/fail + any failure output)
   as evidence in the QA report.

## Step 7: Spec Gap Detection
For each FAIL, determine the root cause:
- **Implementation bug**: The code doesn't match the spec → standard FAIL, populate `fix_needed` as usual
- **Spec gap**: The code correctly follows the spec, but the spec itself makes a wrong assumption → populate `spec_concerns`

Flag a spec concern when:
- The implementation correctly follows the spec, yet the outcome is wrong
- The spec references APIs, types, or patterns that don't exist in the codebase
- An acceptance criterion is impossible to satisfy as written
- The spec contradicts itself or makes mutually exclusive requirements
- The spec's assumptions about external dependencies (APIs, libraries, data formats) proved incorrect
- The spec explicitly labeled a claim as an unverified hypothesis (e.g. "Expected to resolve X — unverified; must be confirmed by re-running the verification step"), and verification contradicts it. This is the first bullet above by construction: the coder implemented the hypothesis exactly as specified, so the outcome being wrong means the spec's assumption was wrong, not the implementation. Populate `spec_concerns` with the verbatim evidence — do not mark it a standard FAIL and do not let the coder substitute their own value to compensate.

When spec concerns are present, the task goes to human review — the reviewer decides whether to revise the spec. Not all FAIL criteria are spec concerns; only flag when the *specification* is the root cause, not the implementation.

## Step 8: Domain Logic Integrity Check

> ⚠️ **REWORK PASS: Check for unauthorized formula changes.** The coder was told
> NOT to change formulas, algorithms, or domain logic during QA fixes. If they did
> anyway, that's an issue — it means the fix approach is wrong and the spec
> likely needs revision.

**Trigger**: If a previous `qa_report.json` exists in `.teamai/{slug}/`, this is a rework pass — activate this step.

1. Examine the git diff for changes to algorithms, mathematical expressions, formulas, or business logic.
2. Cross-reference any such changes against the QA issues from the previous review (check the previous `qa_report.json` in `.teamai/{slug}/`).
3. If the coder changed a formula or algorithm that was NOT part of the QA issues:
   - Add an entry to `additional_issues`: "Coder changed domain logic outside QA fix scope: [describe the formula/algorithm change]"
   - Populate `spec_concerns` using the same criteria as Step 7 if the formula change is a spec-level deviation
4. A coder inventing a new formula during a qa-fix pass is a red flag — it means the fix approach is wrong and the spec likely needs revision.

## Output
Write the QA report to the **exact absolute path** specified in the prompt instructions (e.g., `/path/to/.teamai/{slug}/qa_report.json`).

The orchestrator will provide the correct output path — do NOT guess or derive it from the working directory.
If no explicit path is provided (fallback), resolve the main repository root first (e.g., `git rev-parse --show-toplevel`) and write to `<repo-root>/.teamai/{slug}/qa_report.json`.

`fail_type`: Set to `"cleanup"` when ALL failing criteria require only mechanical operations with zero source code changes.

**Cleanup operations include:**
- File-system or git operations (e.g., `git rm`, `git add`, committing a missing file)
- Running a script and committing its output (e.g., the coder provided mathematical justification instead of running the required benchmark — the fix is to run the script and commit the results, which is a mechanical operation, not a code change)

Set to `"code"` when any failure requires changing source code, tests, or configuration. Set to `null` on PASS.
The orchestrator uses this to route cleanup failures directly without spawning a coder session.

```json
{
  "overall": "PASS" | "FAIL",
  "fail_type": "code" | "cleanup" | null,
  "criteria": [
    {
      "criterion": "text from spec",
      "status": "PASS" | "FAIL",
      "evidence": "what you found",
      "fix_needed": "description of fix if FAIL"
    }
  ],
  "additional_issues": [
    {
      "description": "issue found",
      "file": "path",
      "fix_needed": "how to fix"
    }
  ],
  "spec_concerns": [
    {
      "issue": "one-line summary of the spec problem",
      "reasoning": "why the spec is wrong (not the implementation)",
      "suggested_fix": "how the spec should be updated to fix this"
    }
  ]
}
```

**Any `additional_issues` entry means overall FAIL.** There are no severity levels — every issue found beyond the spec's acceptance criteria is a hard blocker. The coder MUST fix all of them.

Only include `spec_concerns` if spec gaps were detected. Omit the field entirely if all FAILs are implementation bugs.