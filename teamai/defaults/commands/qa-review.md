<!-- .claude/commands/qa-review.md -->
Read and adopt the role defined in .claude/roles/qa-reviewer.md before proceeding.

You are a QA reviewer validating an implementation against its specification.

Read the spec at: $ARGUMENTS

## Review Process
1. Read the spec's acceptance criteria.
2. Read every file listed in the spec's "Files to Modify" section. Read the current file content — not just the diff.
3. Check the git diff to see what actually changed: `git diff origin/HEAD...HEAD`
4. For each acceptance criterion, determine PASS or FAIL with evidence from the actual file content:
   - If a criterion says "no occurrences of X remain": grep the relevant files and paste the result.
   - If a criterion says "Y is used instead of Z": read the file and confirm.
   - Never infer a criterion is satisfied from the diff alone — verify against current code.
5. Check for:
   - Correctness: Does the code do what the spec says?
   - Edge cases: Are error states handled?
   - Tests: Are there tests for the new functionality?
   - Style: Does it match existing code conventions?
   - Regressions: Could this break existing functionality?

## Step 6: Spec Gap Detection
For each FAIL, determine the root cause:
- **Implementation bug**: The code doesn't match the spec → standard FAIL, populate `fix_needed` as usual
- **Spec gap**: The code correctly follows the spec, but the spec itself makes a wrong assumption → populate `spec_concerns`

Flag a spec concern when:
- The implementation correctly follows the spec, yet the outcome is wrong
- The spec references APIs, types, or patterns that don't exist in the codebase
- An acceptance criterion is impossible to satisfy as written
- The spec contradicts itself or makes mutually exclusive requirements
- The spec's assumptions about external dependencies (APIs, libraries, data formats) proved incorrect

When spec concerns are present, the task goes to human review — the reviewer decides whether to revise the spec. Not all FAIL criteria are spec concerns; only flag when the *specification* is the root cause, not the implementation.

## Output
Create `.teamai/{slug}/qa_report.json`:

```json
{
  "overall": "PASS" | "FAIL",
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
      "severity": "critical" | "error" | "warning" | "suggestion",
      "description": "issue found",
      "file": "path",
      "fix_needed": "how to fix"
    }
  ],

Severity semantics for additional_issues:
- **critical**: Hard blocker — the task cannot pass QA until this is fixed. Treated as equivalent to a FAIL criterion. The fixer MUST address this.
- **error**: Same as critical — hard blocker. Used interchangeably with critical for issues that prevent QA pass.
- **warning**: Should be addressed but does not block QA pass on its own. If time permits, fix it.
- **suggestion**: Nice-to-have improvement. Optional — the fixer may skip this without penalty.
  "spec_concerns": [
    {
      "issue": "one-line summary of the spec problem",
      "reasoning": "why the spec is wrong (not the implementation)",
      "suggested_fix": "how the spec should be updated to fix this"
    }
  ]
}
```

Only include `spec_concerns` if spec gaps were detected. Omit the field entirely if all FAILs are implementation bugs.
```