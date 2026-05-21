<!-- .claude/commands/implement.md -->
Read and adopt the role defined in .claude/roles/coder.md before proceeding.

You are implementing a single subtask from an implementation plan.

$ARGUMENTS

## QA Rework Mode

If the prompt includes "⚠️ QA FEEDBACK" at the top, you are in QA rework mode:

1. Read the QA feedback FIRST. It takes priority over the acceptance criteria below.
2. For each issue in the QA feedback:
   - Address it even if the current code already satisfies the plan's acceptance criteria.
   - If the issue requires a different approach than the plan, follow the QA feedback.
   - The plan may be outdated — trust the QA report over the plan.
3. Do NOT skip an issue because the code "already matches the plan."
4. Do NOT mark the subtask as complete unless ALL QA issues are addressed.
5. Focus on the specific issues listed — don't refactor unrelated code.

## Instructions
1. Read the subtask description and acceptance criteria carefully.
2. Read ALL files listed in the subtask before making any changes.
3. Implement the changes. Follow existing code patterns and conventions.
4. Run any existing tests related to the changed files (`npm test`, `pytest`, etc.).
5. If tests fail, fix the issues before proceeding.
6. Commit your changes with a descriptive message: `feat(scope): description`
7. Print a summary of what was changed and the test results.

## Rules
- Only modify files listed in the subtask unless absolutely necessary.
- If you must modify additional files, explain why.
- Do NOT modify files belonging to other subtasks.
- Match existing code style exactly (indentation, naming, patterns).
- Add or update tests for any new functionality.
```