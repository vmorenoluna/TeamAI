<!-- .claude/commands/resolve-cherry-pick.md -->
Adopt the role persona already loaded in your system prompt.

You are resolving the conflicts left by a `git cherry-pick` of a parallel subtask's
commits onto the task's feature branch. The conflict markers are already in the files.

## Request

$ARGUMENTS

## Instructions
1. List the conflicted files (`git diff --name-only --diff-filter=U`). Read each one and
   understand the intent of both sides of every conflict.
2. Resolve all conflicts semantically — preserve the intent of BOTH sets of changes.
   Apply your role's merge-direction preference rule where intents genuinely conflict.
3. `git add` the resolved files. Do NOT run `git cherry-pick --continue` yet.
4. Run the project's test suite ONCE and wait for it to complete — do NOT re-run it
   repeatedly. Capture only the pass/fail summary line — do not read the full test output
   into context unless a failure requires diagnosis. See `.claude/teamai-workflow.md` for
   full guidance on long-running scripts.
5. If tests fail:
   - A failure caused by your resolution → fix the resolution, `git add` it, and re-run
     the suite once.
   - A failure unrelated to the conflicted files (it also fails on the feature branch as
     it stood before this cherry-pick) → note it in your summary; it does not block you.
   - If failures your resolution caused remain after that, still complete the
     cherry-pick (step 6), and state clearly in your summary which tests fail and why —
     QA reviews the integrated branch and routes the failure back for a fix. Never
     report the resolution as clean when tests fail.
6. Complete the cherry-pick non-interactively: `GIT_EDITOR=true git cherry-pick --continue`.
   If it stops on another conflicting commit from the same range, repeat steps 1–6 for
   that commit. Leave the cherry-pick unfinished only if you could not resolve the
   conflicts at all — the orchestrator then aborts it and preserves both branches for
   manual recovery.
7. **Do NOT push.** The orchestrator pushes the feature branch itself, host-side —
   pushing from the agent sandbox will fail for lack of credentials and wastes calls.
8. Print a summary of the conflicts resolved and the test results.
