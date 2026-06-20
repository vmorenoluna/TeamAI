<!-- .claude/commands/plan.md -->
Read and adopt the role defined in .claude/roles/planner.md before proceeding.

You are creating an implementation plan from a specification.

Read the spec at: $ARGUMENTS

## Output
Create `.teamai/{same-slug}/plan.json` with this exact structure:

```json
{
  "complexity": 1-5,
  "estimated_subtasks": N,
  "parallel_safe": true/false,
  "subtasks": [
    {
      "id": 1,
      "title": "Short description",
      "description": "Detailed implementation instructions",
      "files": ["src/path/to/file.ts"],
      "depends_on": [],
      "acceptance_criteria": ["criterion from spec"],
      "parallel_group": "A"
    }
  ]
}
```

Rules:
- Subtasks with the same `parallel_group` letter can run concurrently.
- Subtasks with `depends_on` entries must wait for those IDs to complete.
- Each subtask must be self-contained enough for an independent agent to implement.
- Subtasks must be small enough to complete in a single session — no multi-day epics.
- Include ALL files that need to change, not just the primary ones.
- Order subtasks so dependencies are resolved top-down.
- Flag risks explicitly in the subtask description — don't assume things will work out.
- **NEVER include subtasks that create, modify, or delete files under `.teamai/`.** Ticket
  creation is the analyst's responsibility (the analyst uses a more capable model with
  broader project context). If the spec says to file follow-up tickets for findings,
  document those findings in the final documentation subtask instead — the analyst will
  create the follow-up tickets after reviewing the completed work.
- **Verification scripts need dedicated subtasks:** When the spec includes an acceptance
  criterion that requires running a script to produce empirical evidence (e.g. a
  benchmark, integration run, or data pipeline), the plan MUST include a dedicated
  subtask for that script run. Never fold it into a documentation subtask. The subtask
  must specify: (a) the exact command to run, (b) what output artifact to commit, and
  (c) the specific check to apply to the output (e.g. "section X shows fewer than N
  failures"). This makes the criterion independently verifiable by QA without relying
  on the engineer's self-report.
```