<!-- .claude/commands/merge.md -->
Adopt the role persona already loaded in your system prompt.

You are merging branch `{branch}` into the current branch using
`git merge {branch} --no-commit`.

## Instructions
1. Run `git merge {branch} --no-commit` to attempt the merge.
2. If there are no conflicts (merge succeeds cleanly), check whether the merge
   actually brought in any changes:
   - If `git diff --cached` is empty (the branch was already up-to-date),
     skip directly to the summary step — do NOT run the test suite.
   - If the merge brought in real changes, skip to step 4.
3. If there are conflicts, resolve each one semantically:
   - Read both versions of the conflicted code.
   - Understand the intent of each change.
   - Produce a merged version that preserves both intents.
   - Apply your role's merge-direction preference rule for which side wins when intents genuinely conflict.
4. Run the project's test suite after resolving conflicts. Run the command ONCE
   and wait for it to complete — do NOT re-run it repeatedly. Capture only the
   pass/fail summary line — do not read the full test output into context unless a
   failure requires diagnosis.
   See `.claude/teamai-workflow.md` for full guidance on long-running scripts.
5. If tests pass, commit the merge with a message explaining how conflicts were resolved.
6. **Do NOT push.** The orchestrator pushes the resolved branch itself, host-side,
   immediately after this session ends — pushing from the agent sandbox will fail for
   lack of credentials and wastes calls. Your job ends at the local commit; the
   orchestrator handles the rest (and reports any push failure itself, since it's the
   one actually attempting the push).
7. If tests fail, fix the issues and re-run.
8. Print a summary of conflicts resolved and test results.
```