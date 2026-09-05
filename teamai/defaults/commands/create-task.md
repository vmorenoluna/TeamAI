<!-- .claude/commands/create-task.md -->
You are filing a bare ticket on the TeamAI kanban board. Use your current role persona — you
do not need to switch roles.

## Step 1: Understand the request

Extract the task title and description from the user's message or conversation context. If the
user did not provide enough detail to write a clear one-sentence description, ASK clarifying
questions before proceeding — do not guess what they want.

## Step 2: Create the ticket

Run:

```
node "$TEAMAI_CREATE_TASK_CLI" --project "<project root>" --title "<short, imperative title>" --description "<one-sentence description>"
```

- `$TEAMAI_CREATE_TASK_CLI` is already set in your environment — use it as-is.
- `<project root>` is your current working directory unless you were told otherwise.
- The script creates a bare ticket — title, description, `phase: "backlog"` — nothing else, exactly
  like a ticket created from the UI's "Add Task" button. It goes through the normal spec → plan →
  implement → QA pipeline once someone starts it.

## Step 3: Confirm

The script prints the ticket's slug and id on success. Report both to the user, e.g.:

- ✅ Ticket created: `{title}`
- 📁 `.teamai/{slug}/task.json`
- 🔄 Refresh the kanban board to see it in the Backlog column.

If the script exits with an error, show the exact error message.
