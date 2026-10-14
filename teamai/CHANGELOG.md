# Changelog

## [Unreleased]

## [0.2.1] — 2026-10-14

- **Subtask `files` no longer fail a ticket when a coder touches other files.** Previously a subtask that changed files outside its plan `files` was rejected. Now the subtask's commits are held on their own branch and the planner decides, once per implement pass, whether to approve or reject each extra file (optionally serializing the subtask against others). Approved work is integrated without a re-run; if files were rejected, the subtask re-runs once with the rejected paths shown to the coder. This is bounded by two new pipeline settings, `maxScopeStall` (default 2) and `maxScopeReplans` (default 6); exhausting either fails the task. A session that touched none of its assigned files is still rejected as a no-op
- **QA retries are now progress-aware.** The QA stall counter resets when a QA round fixes criteria or issues that failed in an earlier round, so a ticket that is converging is no longer failed by the attempt cap. A new `maxQaRounds` setting (Settings → Pipeline, default 3× `maxQaAttempts`) caps the total number of rounds. To make rounds comparable, spec, spec-revise and qa-review now require a stable ID on every acceptance criterion
- The orchestrator's safety-net commits (the COMMIT-GUARD WIP auto-commit and the others) now bypass the project's git hooks, so a pre-commit hook rejecting a deliberately partial state no longer makes real subtask work look like a no-op. The final squash commit still runs hooks
- A session running in a container can declare its wakeup `expected_artifact` as a container-absolute path, or a host-absolute one. Both are now mapped to a path under the checked directory. Previously the freshness check reported "artifact not updated" for a finished job on every re-entry until the attempt cap failed the subtask. An unmappable absolute path is ignored with a warning and the deliverables fallback applies
- Issue keys used to match QA `additional_issues` across rounds now collapse whitespace correctly. A bad regex made descriptions that differed only in spacing or newlines produce different keys. Issues in a task already in flight get a one-time key change
- `execGit` pipes git's stderr instead of inheriting it
- The coder instructions now describe the real commit guard (the orchestrator auto-commits after every coder session) and tell coders not to fight project hooks

## [0.2.0] — 2026-10-12

- **Upgrading with tickets in flight:** you can update from 0.1.x without finishing or restarting your tickets. Task state under `.teamai/` (spec, plan, QA report, events) is read as-is, no migration step is needed, and a stopped task resumes or retries from its last phase. What changes for them:
  - **Agent instructions switch immediately.** Every session started after the update, including a retry or resume of a ticket that began under 0.1.x, gets its instructions from this version's per-mode commands (`spec` / `spec-revise`, `plan` / `plan-revise`, `implement` / `implement-fix`, and so on).
  - **The backlog check starts at the next ticket-filing session.** An in-flight ticket is checked when its next spec, plan, QA or filing/evidence-producing implement session runs, against every other open ticket. A ticket that already has a spec is not re-specced, and one filed under 0.1.x is treated as an ordinary ticket, not an unverified agent claim. If another ticket's check marks it as superseded, auto mode will not start it; if it is invalidated, it re-specs on its next start or retry. A ticket already running is only given a note. To keep the old behaviour, set `"backlogCheck": false` in `.teamai/pipeline.json`.
  - **Container mode is validated once.** With container mode on, your existing devcontainer setup has no stored validation result, so it is validated before the next session runs. A passing result is reused until the devcontainer, lockfiles or validation commands change. If it fails, tickets still in the backlog stay there and auto mode pauses. A ticket already mid-pipeline fails with `CONTAINER_INVALID`; fix the container (Settings → Container → Re-validate), then press Retry and it resumes from its last phase.
  - **Roles are not rewritten.** Command files are synced into each project at startup (customised copies are overwritten), but `.claude/roles/*.md` are yours and are left alone. Customised roles keep the work-mode workflow text that 0.2.0 removed from the defaults. This is redundant but harmless, because the commands carry the authoritative rules. Remove those sections whenever convenient.
  - **Stall limits use your settings.** Sessions that previously would have been killed at 10 minutes now follow `idleStallMinutes` (default 15) and `toolStallMinutes` (default 30).
  - **Auto mode counts parked tasks as occupying a slot.** After updating, tasks sitting in `awaiting-review`, `create-pr` or `pr-open` hold their slot until they are done, so with `maxParallel` of 1 the next backlog ticket starts only once the previous one is merged.
- Every pipeline session now gets its instructions from a command of its own for its kind of work, rendered by the orchestrator from TeamAI's own defaults rather than invoked as a slash command. A fresh spec vs. a revision, a fresh plan vs. a re-plan, a subtask vs. QA rework, a spec-summary retry and a cherry-pick conflict each have their own command. Previously most implement sessions, and every revision and re-plan session, never received the command's instructions, including the wakeup procedure. Work-mode workflow has moved out of the default roles into these commands, so rewriting a role can no longer break the pipeline
- The wakeup-file location is now exported to agent sessions as `TEAMAI_SPEC_DIR`, so wakeup files written by a session reach the orchestrator
- Auto mode keeps a task in its slot while it is parked in `awaiting-review`, `create-pr` or `pr-open`, so the next ticket no longer starts against a codebase that does not yet contain the unmerged work
- The app version and git sha are shown in a badge at the bottom-left of the screen
- Rejecting a task in review returns as soon as the pipeline has advanced instead of waiting for the whole rework cycle, so the board updates without a hard refresh
- The failure overview lists each failed QA criterion once
- A failed pre-push squash commit now restores `HEAD` instead of leaving the branch half-squashed
- Finished agent sessions are pruned from the process manager when their process closes (30 s fallback after exit)
- Session stall detection now honours the per-project `idleStallMinutes` and `toolStallMinutes` thresholds. A second, hardcoded 10-minute sweep used to ignore them and kill every session at the 10-minute mark, including legitimate long-running tool calls. A session killed for stalling now gets a stall-recovery retry instead of failing the task outright
- Workspace trust is now recorded as the devcontainer's `remoteUser`, the user agent sessions run as. It was written as the container's default user (root), so sessions still reported "this workspace has not been trusted" and ignored `permissions.allow`.
- Container sessions no longer silently lose the project's `permissions.allow` entries. Claude Code ignores them in a workspace it has not been told to trust, and nobody can answer the trust dialog in an unattended session, so the container now records trust for its workspace folder in its own `~/.claude.json` (the host's configuration is untouched) as part of starting, and again when TeamAI picks up an already-running container (after a server restart, or after a start whose trust write failed). If that cannot be recorded, the container is not handed out and the error names the cause, instead of running agents without their allowlist
- Retrying a task that the orchestrator itself failed (incomplete-subtask cap, deliverable cap, push failure, wakeup cap) no longer turns that failure note into QA feedback. Previously the retry synthesized a rework subtask that re-checked the same artifacts instead of resuming the incomplete subtasks
- A subtask's deliverables now count as done when they are committed on the branch, whichever session committed them. Previously a subtask that spanned several sessions (a background job finished after a session limit, a retry) was failed as "stale" because the latest session had not touched the files, and the retry cap then failed the whole ticket. Only a QA or human rework dispatch still requires its deliverables to have been committed after the feedback was written. Uncommitted deliverables are reported as such
- Container validation now runs its steps as the devcontainer's `remoteUser` (as agent sessions do) instead of root, so a failed or re-run validation no longer leaves root-owned files in `node_modules` that break the next install. Node dev containers also install `python3-setuptools` so native optional dependencies such as `node-pty` compile on Python 3.12+, and this repo's container keeps its own Linux `.next` so a container build no longer overwrites the host's.
- A subtask worktree directory held open by a scanner or orphaned process no longer fails the ticket. The subtask takes the next free `-r<N>` path instead (the task's own worktree likewise, up to 100 slots), the choice is remembered across wakeup resumes, and abandoned directories are deleted when work finishes, at the start of the next run, and at server startup. Every deletion that fails is logged with its cause
- Generated Node dev containers now keep their own Linux `node_modules` in a named volume and install into it on create, so a `node_modules` installed on a Windows or macOS host is no longer shared into the container, where it crashed vitest and failed every commit
- An invalid container setup now always blocks agent work. A container must pass validation (agent tooling, native modules, install, build, tests) for its exact devcontainer definition, lockfiles and container before any session runs in it, whether or not you wrote the `devcontainer.json` yourself. A failure shows the failing step in Settings and pauses auto mode until you fix it and press Re-validate or edit the definition. Projects whose source lives in a subdirectory are now validated there instead of passing trivially, and a `node_modules` installed on the host and shared into the container is detected up front
- Every agent session that can file tickets now judges the whole open board, and the orchestrator verifies the check before the phase advances. Duplicates are no longer filed. Tickets a task makes obsolete are held back from auto mode and deleted when it completes. Tickets whose premise a task changes wait for it and are re-specced. Agent-filed tickets are verified by the analyst, which can reject them.
- Ticket writes are serialized by a crash-safe board lock. The `create-task` CLI requires the board fingerprint from `--list` and refuses if tickets were added since.
- New `pipeline.json` options: `backlogCheck` (default on) and `backlogCheckEvidencePaths`
- Generated dev containers now refresh the Claude Code CLI on every start (`postStartCommand`), so a long-lived container no longer fails on newer models with "Claude Code … does not support this model"

## [0.1.3] — 2026-10-08

- Resolve Next.js native-package symlinks whether their targets are absolute or relative, ensuring macOS and Linux release packages include the node-pty runtime shim

## [0.1.2] — 2026-10-08

- Allow packaged macOS and Linux builds without generated external shims to pass release validation; continue to reject any package that omits a shim its server bundle requires

## [0.1.1] — 2026-10-08

- Fix packaged Windows, macOS, and Linux apps returning HTTP 500 when Next.js could not resolve generated external-module shims; release builds now verify shims before uploading artifacts

## [0.1.0] — 2026-10-05

- Multi-agent Claude Code workflows with a Kanban board and automated spec-to-merge pipeline
- Auto mode, isolated worktrees, crash recovery, project/provider settings, and a Role Refinement Assistant
- Electron desktop app for Windows, macOS (Apple Silicon), and Linux; unsigned macOS builds require manual updates
