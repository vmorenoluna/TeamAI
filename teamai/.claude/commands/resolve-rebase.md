<!-- .claude/commands/resolve-rebase.md -->
Adopt the role persona already loaded in your system prompt.

You are resolving merge conflicts left by a `git rebase` of the task's feature branch.
The rebase is already running and has stopped on a conflicting commit; the conflict
markers are already in the files. Your only job is to resolve the conflicts in those
files. The orchestrator does everything else (staging the result, continuing the rebase,
pushing), and calls you again if conflicts remain.

## Request

Rebasing onto: $ARGUMENTS

## Instructions
1. List the conflicted files (`git diff --name-only --diff-filter=U`). Read each one and
   understand the intent of both sides of every conflict. During a rebase "ours" is the
   branch being rebased onto and "theirs" is the feature-branch commit being replayed.
2. Resolve every conflict semantically — preserve the intent of BOTH sets of changes.
   Apply your role's merge-direction preference rule where intents genuinely conflict.
   Remove every conflict marker (`<<<<<<<`, `=======`, `>>>>>>>`) and leave each file in
   a coherent, buildable state.
3. `git add` each resolved file. Leave a file unstaged and unresolved only if you truly
   could not resolve it — the orchestrator then asks again.
4. Do NOT run `git rebase --continue`, `--skip` or `--abort`, do NOT run `git merge`, and
   do NOT commit: a merge commit would break the linear branch history, and the
   orchestrator drives the rebase itself. Do NOT run the test suite: QA reviews the
   integrated result.
5. **Do NOT push.** The orchestrator pushes the branch itself, host-side — pushing from
   the agent sandbox will fail for lack of credentials and wastes calls.
6. Print a short summary of the conflicts you resolved and any you left.
