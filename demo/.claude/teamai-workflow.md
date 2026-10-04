# TeamAI Workflow

This project uses an automated pipeline managed by an external orchestrator.
When you receive slash commands (/spec, /plan, /implement, /qa-review, /merge),
follow their instructions precisely and output structured files as specified.

## Key Conventions
- Specs live in `.teamai/{slug}/`
- Each spec directory contains: spec.md, plan.json, qa_report.json
- Implementation happens in git worktrees (you're already in one)
- Commit messages follow Conventional Commits: feat(), fix(), chore()
- Run tests after every change before committing
- Match existing code style exactly

## Artifact Commits

`.teamai/{slug}/` — the task's spec, plan, QA report, events, and every other
pipeline artifact — is **never committed to the branch**. `.teamai/*` is gitignored
(added to the project's `.gitignore` on import), and nothing force-adds past that: the
folder stays purely local pipeline state, and is deleted once the task reaches `done`
(its worktree removed). It is never pulled into the base branch and never shows up in
`git log`.

Instead, the pipeline's story reaches git two ways, both assembled fresh from those
local files at merge/PR time — never as committed copies of the files themselves:

### Commit-message trailers

Just before pushing (in `runCreatePR`) or before the merge attempt (in `runMerge`), the
orchestrator collapses the feature branch to a single commit
(`git reset --soft <merge-base>` + `git commit`, so any messy per-subtask history is
gone) whose message carries a trailer block:

```
Task: <slug>
Task-ID: <uuid>
QA: PASS (6/6 criteria, retried 1 times)
Phases: spec>plan>implement>qa-review(x2)>create-pr
Reviewed-by: TeamAI QA agent
```

- **`QA:`** comes straight from `qa_report.json`'s top-level `overall`, with a
  pass/fail criteria count and a retry count derived from how many times `qa-review`
  appears in `events.jsonl`.
- **`Phases:`** is the actual path taken through the pipeline, including loops
  (`qa-review(x2)` means QA bounced back once before passing).
- The commit body is `implementation_summary.md` (written by QA on a PASS verdict),
  falling back to the task description if that's missing.
- This whole trailer block is only added when `recordHistoryInGit` is on (default) —
  turning it off skips the squash/message entirely and merges/pushes the branch as-is.

### PR body (pull-request strategy only)

When opening a PR, `spec_summary.md` and `implementation_summary.md` are read and
assembled into the PR body alongside the description and the same trailer lines — this
is the only place a reviewer sees the fuller story, and it's built at PR-creation time,
not committed as separate files.

### Nothing to merge

A task can legitimately reach this phase with **no commits beyond the base branch** —
most commonly a pure verification ticket whose own acceptance criteria mandate an empty
`src/` diff (the code was already correct; the job was only to confirm it), combined
with the artifact folder never being committed either. Both `runMerge` and `runCreatePR`
check for this before squashing/pushing: if there's nothing beyond the base, the task is
marked `done` directly with a clear log line, instead of attempting a merge/PR that has
nothing to act on (GitHub's `createPullRequest` correctly, but confusingly, rejects an
empty PR with "No commits between `<base>` and `<branch>`").

## Memory
Claude Code's Auto Memory is enabled for this project. Claude will automatically:
- Save useful patterns, decisions, and lessons learned as it works.
- Load relevant memories at the start of each session.
- Consolidate and prune stale memories via Auto Dream.
You can inspect memories at ~/.claude/projects/<project>/memory/ or run /memory in a session.

## Running Long-Running Scripts

When running test suites, builds, linters, or other project scripts that take
more than a few seconds:

1. **Estimate before running**: Check the project's scripts, Makefile, or
   historical output for clues about expected duration. If the script/test suite/...
   historically takes ~90s, plan for that — don't assume 5 seconds.

2. **Read progress output**: Most test runners and build tools emit progress as
   they run (test counts, compilation percentages, file counters). Use this to
   gauge how far along the command is and whether it's still making progress
   vs. hung.

3. **Run once, don't poll**: Do NOT run the same command repeatedly in a loop
   to check if it's "done yet." Run it ONCE with an appropriate timeout. If
   the command is still producing meaningful output, it hasn't finished — wait
   for it. Re-running a long command wastes resources and can cause file-lock
   conflicts (especially on Windows).

4. **Run independent checks in parallel**: `typecheck`, `lint`, and `test`
   often have no dependencies on each other. Start them together in parallel
   rather than running sequentially — this is faster and avoids repeated
   context-switching by the agent.

5. **Use focused runs in iteration, full suite at the end**: During iterative
   fixes, run only the tests relevant to changed files (e.g., running just
   the test file for the changed module, not the entire suite). Run the full
   suite once as the final validation step before committing.

6. **Don't interpret "slow" as "broken"**: A test suite taking 2 minutes is
   not a failure — it's a large project. Wait for the result. Only treat
   timeouts or hanging output (no new output for 60+ seconds) as a problem.
