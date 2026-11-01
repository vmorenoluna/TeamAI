<!-- .claude/commands/resolve-rebase.md -->
Adopt the role persona already loaded in your system prompt.

You are resolving merge conflicts left by a `git rebase` of the task's feature branch.
The rebase is already running and has stopped on a conflicting commit; the conflict
markers are already in the files. Your job is to resolve the conflicts in those files
and leave them correct. The orchestrator does everything else — it stages your result,
runs the project's verification, continues the rebase and pushes — and calls you again
if conflicts remain or its verification fails.

## Request

$ARGUMENTS

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
4. If the request above reports a verification failure, it is the output of the project's
   checks run on your previous resolution. Fix what your resolution broke. If the failure
   is unrelated to the files you resolved (it also fails on the branch being rebased
   onto), do not touch unrelated code: write a short explanation to
   `$TEAMAI_SPEC_DIR/integration_checks_waiver.md` and the orchestrator will proceed.
   If the request says no verification command is configured, run the project's test
   suite ONCE yourself as described there. See `.claude/teamai-workflow.md` for guidance
   on long-running scripts.
5. Do NOT run `git rebase --continue`, `--skip` or `--abort`, do NOT run `git merge`, and
   do NOT commit: a merge commit would break the linear branch history, and the
   orchestrator drives the rebase itself.
6. **Do NOT push.** The orchestrator pushes the branch itself, host-side — pushing from
   the agent sandbox will fail for lack of credentials and wastes calls.
7. Print a short summary of the conflicts you resolved and any you left.
