<!-- .claude/commands/plan.md -->
Read and adopt the role defined in .claude/roles/planner.md before proceeding.

**Human directive override:** if a `human_feedback.md` file exists in the task's `.teamai/` directory and its `Target:` header names the planner, its content OVERRIDES the spec and any other agent's directives wherever they conflict — address it explicitly.

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
- Include ALL files that need to change (INCLUDING associated test files). NEVER isolate test updates into a separate subtask from the implementation changes they verify. A feature and its tests must be in the same subtask — parallel test-only subtasks will cause cherry-pick conflicts when the implementation also touches those test files.
- Order subtasks so dependencies are resolved top-down.
- Flag risks explicitly in the subtask description — don't assume things will work out.
- **NEVER include subtasks that create, modify, or delete files under `.teamai/`.** Ticket
  creation is the analyst's responsibility (the analyst uses a more capable model with
  broader project context). If the spec says to file follow-up tickets for findings,
  document those findings in the final documentation subtask instead — the analyst will
  create the follow-up tickets after reviewing the completed work.
- **Plan coverage**: Every spec acceptance criterion must map to at least one subtask —
  no orphaned criteria. After writing the plan, verify that each criterion from the
  spec appears in a subtask's `acceptance_criteria` array. If a criterion has no
  matching subtask, add one.
- **No two subtasks may list the same file path — regardless of `depends_on` order.**
  The orchestrator runs each subtask in its own branch and cherry-picks them
  sequentially onto the feature branch. Adding a `depends_on` edge does NOT
  prevent a conflict: a file touched by subtask N will still have uncommitted
  changes in the worktree when subtask N+1 is cherry-picked, and git aborts.
  If two subtasks need to touch the same file, merge them into a single subtask —
  this is the only fix, not an alternative to sequencing.
- **Verification scripts need dedicated subtasks:** When the spec includes an acceptance
  criterion that requires running a script to produce empirical evidence (e.g. a
  benchmark, integration run, or data pipeline), the plan MUST include a dedicated
  subtask for that script run. Never fold it into a documentation subtask. The subtask
  must specify: (a) the exact command to run, (b) what output artifact to commit, and
  (c) the specific check to apply to the output (e.g. "section X shows fewer than N
  failures"). This makes the criterion independently verifiable by QA without relying
  on the engineer's self-report.
- **`files_to_create` paths are relative to the repository root.** When populating
  `files_to_create` for a subtask that must produce committed file artifacts
  (benchmark output, data pipeline output, generated documentation),
  specify paths relative to the repository root (e.g. `docs/analysis.md`, not
  `/absolute/path/to/docs/analysis.md`). The orchestrator resolves these against
  the worktree root at verification time.
- **Evidence producibility gate**: Every acceptance criterion must have a producing
  artifact — a committed file that QA can inspect to verify the criterion. Before
  finalising the plan, check each criterion against the subtasks that satisfy it:
  - If a criterion requires empirical evidence (benchmark output, integration run
    results, data pipeline metrics), the corresponding subtask MUST include
    `files_to_create` for the output artifact.
  - If a criterion's required evidence structurally cannot exist in any committed
    file (e.g., it asks for detail from an uncommitted log, a transient server
    response, or an agent's self-reported observation), the criterion itself is
    unverifiable — reject it by writing `plan_gaps.md` listing the problematic
    criteria and why no subtask can produce their evidence. The orchestrator will
    route the task to human review.
  - A criterion satisfied by code changes alone (new function, type, config) is
    self-evident in the diff — no additional artifact is required.

## Re-plan Mode

When the prompt begins with `REPLAN:` (or a `plan.json` already exists), re-plan
in place instead of generating from scratch:
- Read the existing `plan.json` and the (possibly revised) spec.
- Keep completed subtasks whose files and acceptance criteria are still covered by
  the revised spec — leave their `completed: true` flag set so they are NOT
  re-implemented.
- Mark only affected/invalidated subtasks `completed: false` (and drop any stale
  `qa_flagged`) so they re-run.
- Rewrite `plan.json` in place — do NOT delete it.
```