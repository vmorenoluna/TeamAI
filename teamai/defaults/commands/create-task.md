<!-- .claude/commands/create-task.md -->
You are filing a bare ticket on the TeamAI kanban board. Use your current role persona — you
do not need to switch roles.

## Step 1: Understand the request

Extract the task title and description from the user's message or conversation context. If the
user did not provide enough detail to write a clear one-sentence description, ASK clarifying
questions before proceeding — do not guess what they want.

## Step 1b: Check the open tickets

Before creating anything, list the open tickets:

```
node "$TEAMAI_CREATE_TASK_CLI" --project "<project root>" --list
```

It prints every open ticket (`id`, `title`, `phase`, `description`) and the board
`fingerprint`. Read each description in full and compare it with the ticket you are about
to file:

- **Already covered:** an open ticket covers the same problem. Do not file a duplicate.
  Tell the user which ticket it is (title and `id`), and offer to add the new evidence to
  it instead.
- **Makes another ticket obsolete:** the new ticket's work fully resolves an open ticket.
  Tell the user, and suggest deleting that ticket or filing this one in its place.
- **Changes another ticket's premise:** the new ticket's work changes the evidence or
  baseline an open ticket relies on. Tell the user. If the other ticket is still in
  `backlog`, suggest that it depend on this one, so it waits and is specced against the
  new state.
- **Depends on another ticket:** pass `--depends-on` for it (see Step 2).

If nothing overlaps, go straight to Step 2. When something does overlap, report it and
wait for the user's decision before running the CLI.

## Step 2: Create the ticket

Run:

```
node "$TEAMAI_CREATE_TASK_CLI" --project "<project root>" --board "<fingerprint from --list>" --title "<short, imperative title>" --description "<one-sentence description>" [--depends-on "<id1>,<id2>,..."]
```

- `--board` is required. The CLI checks it under a board lock. If tickets were added since
  your `--list`, it creates nothing, prints the current tickets and fingerprint, and exits
  with code 3. Check the new ticket against the newcomers (Step 1b), then retry with the
  new fingerprint.

- `$TEAMAI_CREATE_TASK_CLI` is already set in your environment — use it as-is.
- `<project root>` is your current working directory unless you were told otherwise.
- The script creates a bare ticket — title, description, `phase: "backlog"` — nothing else, exactly
  like a ticket created from the UI's "Add Task" button. It goes through the normal spec → plan →
  implement → QA pipeline once someone starts it.
- `--depends-on` is optional: a comma-separated list of other tasks' `id`s (printed by this same
  CLI when they were created, or found via `grep '"id"' .teamai/*/task.json`). Auto-mode will not
  auto-start this ticket until every listed dependency reaches `phase: "done"`.

**When filing several related tickets in one request**, check whether any of them logically
blocks another before running the CLI — not just "must happen first for correctness" (e.g. a
finding that needs a fresh measurement before it can be trusted) but also "touches the same
reward/constant/function another ticket also changes," where running both in parallel worktrees
is likely to produce conflicting PRs. Pass `--depends-on` for those; leave truly independent
tickets unlinked. If unsure whether two tickets conflict, ask rather than guessing either way.

A ticket whose acceptance criteria depend on a measurement against the current baseline (a
benchmark, verification run, or any measurement compared with earlier numbers) is blocked by every ticket
that changes the code that measurement exercises: a merge in between moves the baseline, so the
measurement and the thresholds derived from it go stale and must be redone. Link those tickets
with `--depends-on` so they run one after another rather than side by side.

## Step 3: Confirm

The script prints the ticket's slug and id on success. Report both to the user, e.g.:

- ✅ Ticket created: `{title}`
- 📁 `.teamai/{slug}/task.json`
- 🔄 Refresh the kanban board to see it in the Backlog column.

If the script exits with an error, show the exact error message.
