<!-- .claude/commands/resolve-rebase.md -->
Adopt the role persona already loaded in your system prompt.

You are resolving the conflicts of a `git rebase` of the task's feature branch onto the
branch named in the request below. The rebase is already running and has stopped on a conflicting commit; the
conflict markers are already in the files. You resolve it **inside the rebase** — do NOT
run `git merge`, and do NOT abort and restart: the branch history must stay linear, and a
merge commit on it breaks how the orchestrator later lands subtask branches onto it.

## Request

Rebasing onto: $ARGUMENTS

## Instructions
1. List the conflicted files (`git diff --name-only --diff-filter=U`). Read each one and
   understand the intent of both sides of every conflict. During a rebase "ours" is the
   branch being rebased onto and "theirs" is the feature-branch commit being replayed.
2. Resolve all conflicts semantically — preserve the intent of BOTH sets of changes.
   Apply your role's merge-direction preference rule where intents genuinely conflict.
3. `git add` the resolved files. Do NOT run `git rebase --continue` yet.
4. Run the project's test suite ONCE and wait for it to complete — do NOT re-run it
   repeatedly. Capture only the pass/fail summary line — do not read the full test output
   into context unless a failure requires diagnosis. See `.claude/teamai-workflow.md` for
   full guidance on long-running scripts.
5. If tests fail:
   - A failure caused by your resolution → fix the resolution, `git add` it, and re-run
     the suite once.
   - A failure unrelated to the conflicted files (it also fails on the branch being rebased onto)
     → note it in your summary; it does not block you.
   - If failures your resolution caused remain after that, still continue the rebase
     (step 6), and state clearly in your summary which tests fail and why — QA reviews
     the result and routes the failure back for a fix. Never report the resolution as
     clean when tests fail.
6. Continue the rebase non-interactively, with project git hooks disabled:
   `GIT_EDITOR=true git -c core.hooksPath=/dev/null rebase --continue`. The branch can
   legitimately fail the pre-commit hook (typecheck/tests) at an intermediate commit, and
   QA is the quality gate for the final result. Do NOT leave the rebase unfinished
   because a hook would reject a commit. If the replayed commit becomes empty after your
   resolution, run `git rebase --skip` instead. If the rebase stops on another
   conflicting commit, repeat steps 1–6 for it, until `git status` no longer reports a
   rebase in progress. Leave the rebase unfinished only if you could not resolve the
   conflicts at all — the orchestrator then aborts it and leaves the branch untouched.
7. **Do NOT push.** The orchestrator pushes the branch itself, host-side — pushing from
   the agent sandbox will fail for lack of credentials and wastes calls.
8. Print a summary of the conflicts resolved and the test results.
