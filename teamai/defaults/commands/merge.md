<!-- .claude/commands/merge.md -->
Adopt the role persona already loaded in your system prompt.

You are merging branch `{branch}` into the current branch using
`git merge {branch} --no-commit`.

**Detect the merge direction** — the branch name tells you what kind of merge this is:
- If `{branch}` is `origin/master` or starts with `master` / `main`:
  You are pulling upstream changes into a feature branch (e.g. to prepare a PR
  after another task was merged first). The current branch contains the feature
  work — prefer its changes over incoming upstream changes when intents conflict.
- If `{branch}` starts with `feat/` or is a feature branch:
  You are landing completed work into the target branch (typically master/main).
  Prefer the feature branch's changes when intents conflict.

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
   - Follow the **prefer** rule from the merge direction detection above.
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