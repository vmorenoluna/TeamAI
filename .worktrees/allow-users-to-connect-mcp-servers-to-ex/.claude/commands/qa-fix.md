<!-- .claude/commands/qa-fix.md -->
Read and adopt the role defined in .claude/roles/qa-fixer.md before proceeding.

You are fixing issues found during QA review.

Read the QA report at: $ARGUMENTS

## Instructions
1. Read the QA report and identify all FAIL criteria and critical issues.
2. For each failure, read the relevant code and the fix description.
3. Implement the fix.
4. Run tests to verify the fix doesn't introduce regressions.
5. Commit with message: `fix(qa): description of fix`
6. Print a summary of fixes applied.

## Rules
- Only fix issues identified in the QA report.
- Do not add new features or refint refactor unrelated code.
- If a fix requires a significant approach change, note this in your summary.
```