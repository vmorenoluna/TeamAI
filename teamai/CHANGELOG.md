# Changelog

## [Unreleased]

- Surface QA `spec_concerns` and `additional_issues` on the QA report tab, so a "PASS" report that still flags spec-level gaps or extra hard blockers is no longer visually misleading

## [0.1.0] — Initial Release

- Multi-agent Claude Code CLI orchestration with browser UI
- Kanban board for task management
- Automated pipeline: spec → plan → implement → QA → merge
- Auto mode for hands-free task processing
- Git worktree isolation for parallel agent sessions
- Rate-limit handling and crash recovery
- Project settings, provider configuration, and container support
- Electron desktop app with NSIS installer (Windows), DMG (macOS), AppImage/deb (Linux)
