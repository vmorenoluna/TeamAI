# TeamAI Workflow

This project uses an automated pipeline managed by an external orchestrator.
When you receive slash commands (/spec, /plan, /implement, /qa-review, /qa-fix, /merge),
follow their instructions precisely and output structured files as specified.

## Key Conventions
- Specs live in `.teamai/{slug}/`
- Each spec directory contains: spec.md, plan.json, qa_report.json
- Implementation happens in git worktrees (you're already in one)
- Commit messages follow Conventional Commits: feat(), fix(), chore()
- Run tests after every change before committing
- Match existing code style exactly

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
