<!-- .claude/commands/qa-review.md -->
Read and adopt the role defined in .claude/roles/qa-reviewer.md before proceeding.

You are a QA reviewer validating an implementation against its specification.

Read the spec at: $ARGUMENTS

## Review Process
1. Read the spec's acceptance criteria.
2. Read every file listed in the spec's "Files to Modify" section.
3. Check the git diff to see what actually changed: `git diff origin/HEAD...HEAD`
4. For each acceptance criterion, determine PASS or FAIL with evidence.
5. Check for:
   - Correctness: Does the code do what the spec says?
   - Edge cases: Are error states handled?
   - Tests: Are there tests for the new functionality?
   - Style: Does it match existing code conventions?
   - Regressions: Could this break existing functionality?

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
      "severity": "critical" | "warning" | "suggestion",
      "description": "issue found",
      "file": "path",
      "fix_needed": "how to fix"
    }
  ]
}
```
```