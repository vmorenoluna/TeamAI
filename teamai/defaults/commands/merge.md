<!-- .claude/commands/merge.md -->
Read and adopt the role defined in .claude/roles/merger.md before proceeding.

You are merging a feature branch back to the target branch.

## Instructions
1. Run `git merge {branch} --no-commit` to attempt the merge.
2. If there are conflicts, resolve each one semantically:
   - Read both versions of the conflicted code.
   - Understand the intent of each change.
   - Produce a merged version that preserves both intents.
   - If intents are contradictory, prefer the feature branch.
   - Never leave conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in resolved code.
3. Run the project's test suite after resolving conflicts. Run the command ONCE
   and wait for it to complete — do NOT re-run it repeatedly.
   See `.claude/teamai-workflow.md` for full guidance on long-running scripts.
4. If tests pass, commit the merge with a message explaining how conflicts were resolved.
5. If tests fail, fix the issues and re-run.
6. Print a summary of conflicts resolved and test results.
```