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
- Include ALL files that need to change, not just the primary ones.
- Order subtasks so dependencies are resolved top-down.
- **No two subtasks may list the same file path.** If two subtasks would modify the same file, merge them into a single subtask. This applies regardless of `depends_on` order
```