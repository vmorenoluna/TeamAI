# ADR 010: Verified Backlog Check for Every Ticket-Filing Session

**Date:** 2026-10-09

**Status:** Accepted

## Context

Every pipeline agent files tickets for what it finds outside its own task: the analyst
for deferred defects, the coder for out-of-scope bugs, QA for issues beyond the criteria.
They reported these as `[BUG] Fix: …` lines that the orchestrator parsed out of the
session log, and the only safeguard was skipping an exact title match. Nothing made an
agent look at the board first, so three things went wrong:

- **Duplicates.** A finding already covered by an open ticket was filed again under a
  different title.
- **Obsolete tickets.** A task's work could fully resolve another ticket, and that ticket
  stayed on the board. In auto mode it could even start after the task that made it
  obsolete, and redo or fight that task's work.
- **Stale premises.** A task could change the code or baseline another ticket's evidence
  was measured on. Agents had no way to say so except filing yet another ticket.

A rule in the prompt ("check the board first") is not enough on its own. An agent that
skips the check looks the same as one that checked and found nothing. Parallel tasks can
also file the same finding at the same time, each against a board that doesn't yet show
the other's ticket.

Finally, agent-filed tickets come from a narrow view of the project, and nothing told the
analyst who later specs one to verify it. Even if it had, the pipeline had no way to stop:
a spec phase always led to planning and implementation.

## Decision

### Every ticket-filing session judges the whole board, verifiably

Before each session that can file tickets (spec, spec-revise, plan, plan-revise,
implement and implement-fix subtasks, QA), the orchestrator snapshots every open ticket
except the task's own into `open_tickets-<unit>.json`, together with a fingerprint of the
set of open ids. `<unit>` is `spec`, `plan`, `st<N>` or `qa`. A prompt header points the
agent at it.

The agent writes `backlog_check-<unit>.json`:

| Field | Content |
|---|---|
| `tickets` | exactly one `{id, verdict, reason}` per snapshot ticket |
| `new_tickets` | `{title, description}` for findings no open ticket covers |
| `self` | spec phase only: `proceed` or `reject` on the task's own ticket |

After the session the orchestrator verifies the file: every snapshot ticket judged
exactly once, no unknown ids, verdicts from the known set, and a reason for every verdict
other than `unrelated`. "Nothing found" is therefore an explicit `unrelated` for each
ticket, and a skipped check is detectable. A missing or invalid file gets a focused
follow-up session (same role, same working directory) naming the problems, at most three
times. After that the task fails with `backlog-check-incomplete`.

The check runs only when the unit actually completes. A session that paused for a
background job (ADR 002) is not checked until its re-entry finishes.

### Verdicts

| Verdict | Meaning | Effect |
|---|---|---|
| `unrelated` | the task doesn't touch the ticket | none |
| `overlaps` | same area, both stay valid | none (recorded in the spec's Backlog impact section for the planner) |
| `supersedes` | the task fully covers the ticket | `supersededBy` is set; auto mode never starts the ticket while the superseder is alive; it is deleted when the superseder reaches `done` |
| `invalidates` | still wanted, but its premise or baseline depends on what the task changes | the ticket depends on the task; if it already has a spec, a spec revision is prepared so its next start or retry re-specs |
| `update` | new evidence or a narrower scope | a dated note on the ticket |

A ticket that is already running (not `backlog` or `failed`) receives only the note.
Interrupting another task's live session stays a human decision.

### Compare-and-apply under a short board lock

The lock is never held across an agent session, because that would serialise every
parallel task for the length of a session. The snapshot gives each session a consistent
view. When applying, the orchestrator takes a cross-process board lock
(`src/lib/board-lock.ts`) and compares the live open-id set with the snapshot's
fingerprint:

- **Unchanged** (or tickets only removed): the verdicts and new tickets are applied, then
  the lock is released. This takes milliseconds.
- **Tickets added since the snapshot**: nothing is written. The snapshot is refreshed and
  the agent judges the newcomers in a follow-up session, which also drops any of its new
  tickets a newcomer already covers. Then the orchestrator retries.

The fingerprint covers only the set of open ids. A phase change or a note doesn't
invalidate a verdict, but a ticket the agent never saw does.

`TaskStore.create` and `delete` take the same lock (re-entrantly), so no writer can slip
between a comparison and its apply. The interactive `create-task-cli.mjs` (a separate
process) follows the same protocol: `--list` prints the open tickets and the fingerprint,
and creating a ticket requires `--board <fingerprint>`. The CLI exits with code 3 when the
board changed.

The lock is a file, `.teamai/.board.lock`, created with `O_EXCL` and holding
`{pid, host, acquiredAt}`. It never outlives its owner:

- it is released in `finally`;
- it is released by a process `exit` handler if the app closes while holding it;
- it is taken over when its pid is dead on this host (crash, kill) or when it is older
  than 30 s (owner on another host or in a container).

### Agent-filed tickets are claims; the analyst decides

Tickets created from `new_tickets` record `reportedBy` (the task) and `reportedByAgent`
(e.g. "the coder agent (Subtask 3)"). Their description opens with a note that the claim
is unverified. When such a ticket reaches its own spec phase, the prompt header names the
filing agent and says verifying the claim is the analyst's job. The analyst role states
the same discipline for every ticket: a ticket is a claim, not an order.

The spec phase's `self` verdict acts on that verification. On `reject` (already fixed,
not reproducible, stale evidence, misdiagnosed) the ticket and any worktree are deleted
and the reason is logged. Nothing is planned, and no human confirmation is required: the
analyst's verification is the decision.

### Implement subtasks check only when they have something to say

Spec and QA always run the full check, and together they bracket every change: the
planned change and the delivered change are each judged against the whole board. An
implement subtask's check file is optional. A missing file means "nothing to report".
The file becomes mandatory, and fully verified, when the subtask:

- files or reports anything, so duplicates stay impossible; or
- produced evidence files matching `backlogCheckEvidencePaths` in `pipeline.json`.

Evidence learned during implementation (logs, measurements, probe output) can bear on
other tickets without showing up in the diff QA reviews. Patterns match repo paths the
session changed, committed or not. A `$TEAMAI_SPEC_DIR/` prefix matches files written
under the task's own folder since the unit's first session, which covers background jobs
that ran between wakeup sessions.

### Configuration

| `pipeline.json` key | Default | Effect |
|---|---|---|
| `backlogCheck` | `true` | `false` turns the whole check off for the project |
| `backlogCheckEvidencePaths` | `[]` | globs whose matches make an implement subtask's check mandatory |

`backlogCheck` defaults off under Vitest only, following the same pattern as
`wakeupScanRetryDelayMs`. Tests that drive the real orchestrator simulate agents that
don't write verdict files, and the feature's own tests opt in explicitly.

## Consequences

- **Token cost.** Every checking session reads the whole snapshot and writes a verdict
  per ticket, so the cost scales with the number of sessions × board size, plus any
  follow-ups. Making subtask checks conditional removes most of it on large plans.
- **Wrong verdicts are still possible.** The orchestrator verifies coverage, not
  judgement. An agent can call a superseded ticket `unrelated`. The verdict file and its
  reasons make that reviewable.
- **Stricter failure.** A task whose agent never produces an acceptable check fails with
  `backlog-check-incomplete`, the same way a missing deliverable fails a subtask.
- **`[BUG]` lines are gone.** `out-of-scope-tickets.ts` is removed. All ticket creation by
  pipeline agents goes through the verified check.

## Tests

- `tests/unit/board-lock.test.ts`: acquire/release, re-entrancy, takeover of dead and aged
  locks.
- `tests/unit/backlog-check.test.ts`: snapshot and header, validation, compare-and-apply,
  stale-board refusal, follow-up sessions, superseded lifecycle, the evidence trigger and
  optional mode.
- `tests/unit/spec-phase-backlog-check.test.ts`: the spec phase advancing on a valid check,
  deleting its ticket on `reject`, and failing after the follow-ups.
- `tests/unit/create-task-cli-board.test.ts`: `--list`, the fingerprint gate, exit 3.
- `tests/unit/orchestrator.test.ts`: a pending spec revision wins the start phase.
- `tests/unit/command-contract-coverage.test.ts`: the backlog-check contract is present in
  every ticket-capable mode.

## References

- `src/lib/orchestrator/backlog-check.ts`: snapshot, validation, apply, session loop,
  superseded lifecycle, evidence trigger
- `src/lib/board-lock.ts`: the lock protocol (copied in `defaults/create-task-cli.mjs`)
- `src/lib/auto-mode.ts`: superseded tickets are skipped and swept
- `defaults/commands/_shared/backlog-effects.md`: the agent-facing contract
- ADR 002: wakeup files; ADR 009: per-mode commands
