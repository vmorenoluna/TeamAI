<!-- .claude/commands/implement.md -->
Read and adopt the role defined in .claude/roles/coder.md before proceeding.

You are implementing a single subtask from an implementation plan.

$ARGUMENTS

## QA Rework Mode

If the prompt includes "⚠️ QA FEEDBACK" at the top, you are in QA rework mode:

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
   the command ONCE and wait — do not re-run it repeatedly.
   See `.claude/teamai-workflow.md` for full guidance on long-running scripts.
9. **CRITICAL: Do NOT change formulas, algorithms, or domain logic.** QA fixes
   are surgical corrections of implementation defects — they are NOT opportunities
   to redesign the solution. If an issue seems to require changing a formula or
   algorithm, STOP: this is a spec concern that must be escalated, not fixed in place.
   A fix that invents a new formula is not a fix — it's a design change that
   bypasses the spec.

## Instructions
1. Read the subtask description and acceptance criteria carefully.
2. Read ALL files listed in the subtask before making any changes.
3. Implement the changes. Follow existing code patterns and conventions.
4. Run any existing tests related to the changed files (check the project's
   build config or Makefile for the test command). Run the command ONCE
   and wait — do NOT re-run it repeatedly in a loop.
   See `.claude/teamai-workflow.md` for full guidance on long-running scripts.
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
```