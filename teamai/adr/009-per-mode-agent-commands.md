# ADR 009: Agent Commands — One Command per Work Mode, Rendered by the Orchestrator

**Date:** 2026-10-09

**Status:** Accepted

## Context

Every pipeline agent session receives its instructions from a command template in
`defaults/commands/`. Two properties of Claude Code shape how those templates can be
delivered:

- **A slash command is expanded only when the message starts with it.** The orchestrator
  opens most messages with header blocks (wakeup re-entry, human directive, deliverable
  re-verification, stall recovery, session context), so a `/command` placed after them
  reaches the agent as plain text and its template is never loaded.
- **A session only sees the `.claude/commands/` of its own working directory.** Implement,
  QA and merge sessions run in the task worktree, whose `.claude/` is the branch's
  committed copy. That copy can be older than the TeamAI version running the task, or lack
  a command entirely when the task was already in flight at upgrade time.

A session can also be in one of several work modes inside the same phase (a fresh spec or
a revision, a first plan or a re-plan, a subtask or its QA rework). Each mode has its own
workflow, and the orchestrator always knows which mode it is starting.

## Decision

### One command per work mode

The orchestrator picks the command from on-disk task state. The agent never has to work
out its mode from a marker in the message.

| Phase | Command | Used when |
|---|---|---|
| spec | `spec` | `spec_revision_feedback.md` is absent |
| spec | `spec-revise` | `spec_revision_feedback.md` is present |
| plan | `plan` | `plan.json` is absent |
| plan | `plan-revise` | `plan.json` is present (full or scoped re-plan) |
| implement | `implement` | the subtask has no QA feedback |
| implement | `implement-fix` | the subtask has QA feedback (including synthetic subtask 9999) |
| qa-review | `qa-review` | always |
| merge | `merge` | rebase merger, QA-precheck reconcile, final merge |

Each command holds only its own mode's workflow. `qa-review` stays a single command: its
rework pass is detected from the previous `qa_report.json`, which is the same signal the
orchestrator would use to choose.

### Shared sections live once

Sections that several commands need verbatim live under `defaults/commands/_shared/` and
are pulled in by a whole line of the form:

```markdown
<!-- @include _shared/<name>.md -->
```

| Fragment | Used by |
|---|---|
| `request-headers.md` | every pipeline command except `merge`: how to read the orchestrator's header blocks |
| `spec-summary-guidelines.md` | `spec`, `spec-revise` |
| `deferred-defects.md` | `spec`, `spec-revise` |
| `spec-phase-wakeup.md` | `spec`, `spec-revise` |
| `plan-body.md` | `plan`, `plan-revise`: the `plan.json` schema, plan rules and the plan-phase wakeup |
| `implement-body.md` | `implement`, `implement-fix`: coder rules, the subtask wakeup contract, commit rules |

A fragment may include another fragment, up to five levels deep. A missing fragment, a
path that leaves `defaults/commands/`, or deeper nesting is an error, never a silently
dropped section.

### The orchestrator renders commands

`src/lib/command-templates.ts` does the expansion Claude Code would do:

1. `readCommandTemplate(name)` reads `defaults/commands/<name>.md` and expands includes.
2. `renderCommand(name, request)` replaces every `$ARGUMENTS` with the request. A template
   without the placeholder gets `ARGUMENTS: <request>` appended.
3. The rendered text is sent as the session's message.

Every session therefore gets the instructions shipped with the running TeamAI version,
wherever it runs, and whatever `.claude/commands/` its working directory holds.

The request is the text the orchestrator assembles for the session: header blocks first,
then the task-specific lines (description, file paths, subtask title and criteria, QA
feedback). Each command places it under a `## Request` heading, followed by the
`request-headers.md` guidance: wherever a header says how to handle the session, it takes
precedence over the command's default workflow. `merge` is the exception: its argument is
only the branch to merge.

The message is rendered **before** `createSession`. A broken template fails the phase
without leaving a spawned session waiting for a message.

### Project copies

At startup `project-store.ts` force-syncs every top-level command into the project's
`.claude/commands/`, with includes already expanded so each copy is self-contained.
`_shared/` is never copied. These copies serve people who run a command by hand; pipeline
sessions do not read them.

### Writing a command

- Start the template with `Adopt the role persona already loaded in your system prompt.`
  The role file arrives through `--append-system-prompt`.
- Put `$ARGUMENTS` under a `## Request` heading, followed by
  `<!-- @include _shared/request-headers.md -->`.
- State the mode in the opening paragraph ("You are re-planning an existing
  implementation plan in place"). Do not add in-template mode detection for a mode the
  orchestrator already chooses.
- Put a section that another command also needs into `_shared/` and include it. Never copy
  it.
- Add a mode by adding a command and selecting it at the call site from on-disk state that
  survives a restart.
- Structure within a command follows ADR 003.

## Consequences

### Positive

- **Every session gets its contract.** The wakeup procedure, worktree and port rules, the
  no-push rule and the mode workflow reach every session, including wakeup re-entries,
  deliverable re-verifications, stall recoveries and sessions led by a human directive.
- **Upgrades reach in-flight tasks.** A task started under an older TeamAI version gets the
  new instructions on its next session, because worktree copies are never read.
- **Less room for interpretation.** An agent in rework mode never reads the fresh-subtask
  workflow, and the other way round.
- **One source per rule.** A shared rule is edited in one fragment and reaches every
  command that includes it.

### Negative

- **Messages are longer.** The full template travels with every session's first message.
- **Project copies can drift from what agents receive.** A hand edit to a project's
  `.claude/commands/` has no effect on pipeline sessions, and the next sync overwrites it.
  Project-specific guidance belongs in the project's role files.

## Tests

- `tests/unit/agent-prompt-routing.test.ts`: the command, role, working directory, headers
  and paths for every pipeline state that starts a session.
- `tests/unit/command-contract-coverage.test.ts`: every rule the orchestrator relies on
  mechanically is present in each mode that needs it.
- `tests/unit/command-templates.test.ts`: include expansion, its guards, `$`-safe
  substitution, and invariants for every shipped command.
- `tests/unit/agent-command-delivery.test.ts`: stale project and worktree copies are
  ignored, and each mode carries only its own workflow.
- `tests/unit/agent-command-render-failure.test.ts`: no session is spawned when rendering
  fails.

`tests/utils/agent-prompts.ts` is the only place in the tests that knows how a mode is
encoded in the message.

## References

- `src/lib/command-templates.ts`: include expansion and rendering
- `src/lib/orchestrator/phase-runners.ts`: spec, plan and merge call sites
- `src/lib/orchestrator/implement.ts`: subtask call site
- `src/lib/orchestrator/qa-review.ts`: QA and QA-precheck merge call sites
- `src/lib/project-store.ts`: project copy sync
- ADR 002: wakeup files; ADR 003: structure within a command
