# CLAUDE.md

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
