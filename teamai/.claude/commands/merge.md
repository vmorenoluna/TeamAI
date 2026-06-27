<!-- .claude/commands/merge.md -->
Read and adopt the role defined in .claude/roles/merger.md before proceeding.

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
2. If there are no conflicts (merge succeeds cleanly), skip to step 4.
3. If there are conflicts, resolve each one semantically:
   - Read both versions of the conflicted code.
   - Understand the intent of each change.
   - Produce a merged version that preserves both intents.
   - Follow the **prefer** rule from the merge direction detection above.
   - Never leave conflict markers (`<<<<<<<`, `=======`, `>>>>>>>`) in resolved code.
4. Run the project's test suite after resolving conflicts. Run the command ONCE
   and wait for it to complete — do NOT re-run it repeatedly. Capture only the
   pass/fail summary line — do not read the full test output into context unless a
   failure requires diagnosis.
   See `.claude/teamai-workflow.md` for full guidance on long-running scripts.
5. If tests pass, commit the merge with a message explaining how conflicts were resolved.
6. If tests fail, fix the issues and re-run.
7. Print a summary of conflicts resolved and test results.
```