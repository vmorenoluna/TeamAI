# Changelog

## [Unreleased]

- Fix PR creation failing on large specs ("Body is too long") by embedding a short spec summary in the PR body instead of the full spec.md, which is unbounded in size and could exceed GitHub's 65,536-character PR body limit
- Fix a wakeup-pending subtask (ADR 002 — e.g. a long verification sweep) being resumed immediately on server restart instead of waiting out its scheduled `wakeup_at`, which could burn through the deliverable-verification retry cap in minutes and fail the task despite a healthy background job
- Surface QA `spec_concerns` and `additional_issues` on the QA report tab, so a "PASS" report that still flags spec-level gaps or extra hard blockers is no longer visually misleading
- Fix a task getting stuck failing forever after a correct QA-fallback rework fix: the synthetic QA-rework subtask (id 9999) is no longer scope-rejected for fixing exactly what `qa_feedback.md` named, and completing it now reconciles the `completed` flag of any real subtask whose declared deliverables it happened to satisfy — unblocking that subtask's own dependents instead of leaving the implement-completeness gate checking a bookkeeping field nothing ever updates
- Fix the review panel being unable to distinguish a genuine QA pass from the spec phase auto-parking in `awaiting-review` (no-op revision, or a revision session that wrote `spec.md` but skipped `spec_summary.md`) — both land on the same phase with no visible reason, so an approver could wave a parked task straight into `create-pr`, which then fails trying to build the PR body. The `awaiting-review` event now carries an `awaitingReviewReason` (the same mechanism previously used only for failed-approval rollbacks, generalized and renamed from `approvalError`), surfaced as a "Needs attention" banner
- Fix `spec_summary.md` sometimes getting skipped by a revision-mode analyst session that stops right after verifying its own spec.md diff, without reaching the summary step after it: the spec/revision prompts now call out writing it as an explicit required step, and if it's still missing afterward the pipeline gives one focused follow-up session a chance to self-heal it (read the now-final spec.md, write just the summary) before parking for human review

## [0.1.0] — Initial Release

- Multi-agent Claude Code CLI orchestration with browser UI
- Kanban board for task management
- Automated pipeline: spec → plan → implement → QA → merge
- Auto mode for hands-free task processing
- Git worktree isolation for parallel agent sessions
- Rate-limit handling and crash recovery
- Project settings, provider configuration, and container support
- Electron desktop app with NSIS installer (Windows), DMG (macOS), AppImage/deb (Linux)
