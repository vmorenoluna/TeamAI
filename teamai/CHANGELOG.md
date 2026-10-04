# Changelog

## [Unreleased]

## [0.1.0] — <date>

- Multi-agent Claude Code CLI orchestration with a browser UI — analyst, planner, coder, QA reviewer, and merger run as separate agents through a Next.js + Electron app
- Kanban board covering every phase, with drag-and-drop, task detail, review, and retry
- Automated pipeline: spec → plan → implement → QA review → merge, driven by slash-command templates and role personas synced from `defaults/` into each project's `.claude/`
- Auto mode for hands-free processing: picks backlog tasks, approves reviews, opens PRs, watches CI, and merges
- Git worktree isolation so parallel agents never conflict; per-project `.teamai/` state and `.claude/` config
- Rate-limit handling (retry with resume) and crash recovery (re-run interrupted tasks on startup)
- Project settings, provider configuration (Anthropic and others), and optional Docker sandboxing
- Role Refinement Assistant: inspects failed tasks and suggests fixes to the agents' instructions, with editable before/after diffs and one-click revert
- Electron desktop app with NSIS installer (Windows), DMG (macOS), and AppImage/deb (Linux); packaged builds check for updates automatically
