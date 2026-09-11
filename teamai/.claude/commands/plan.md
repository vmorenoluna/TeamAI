<!-- .claude/commands/plan.md -->
Adopt the role persona already loaded in your system prompt.

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
- Include ALL files that need to change (INCLUDING associated test files). NEVER isolate test updates into a separate subtask from the implementation changes they verify. A feature and its tests must be in the same subtask — parallel test-only subtasks will cause cherry-pick conflicts when the implementation also touches those test files.
- Order subtasks so dependencies are resolved top-down.
- Flag risks explicitly in the subtask description — don't assume things will work out.
- **NEVER include subtasks that create, modify, or delete files under `.teamai/`.** Ticket
  creation is the analyst's responsibility (the analyst uses a more capable model with
  broader project context). If the spec says to file follow-up tickets for findings,
  document those findings in the final documentation subtask instead — the analyst will
  create the follow-up tickets after reviewing the completed work. **Wire the deferral to
  QA's auto-PASS marker**: whenever a subtask's description defers `.teamai/`-touching
  work this way, that subtask's description MUST explicitly instruct the coder to
  include the literal string `[SKIPPED] Ticket creation is the analyst's responsibility`
  in its summary — verbatim, matching qa-review.md's auto-PASS trigger for
  ticket-creation subtasks. A correctly-deferred subtask whose description omits this
  instruction is planned correctly but invisible to QA: QA has no way to distinguish it
  from a subtask that simply skipped required work, and will FAIL the criterion instead
  of auto-passing it.
- **Plan coverage**: Every spec acceptance criterion must map to at least one subtask —
  no orphaned criteria. After writing the plan, verify that each criterion from the
  spec appears in a subtask's `acceptance_criteria` array. If a criterion has no
  matching subtask, add one.
- **Shared files across `parallel_group`s.** Subtasks in the SAME `parallel_group` run
  concurrently — each in its own isolated worktree branched from the same base, then
  cherry-picked back as one batch — so two subtasks in the same group that touch the
  same file will conflict at cherry-pick. `depends_on` does NOT prevent this: it is
  documentation only, and nothing in the runtime orders execution on it — only
  `parallel_group` placement does. Subtasks in DIFFERENT `parallel_group`s run strictly
  sequentially, one full group's changes landing on the feature branch before the next
  group starts — so a later group's subtask safely builds on an earlier group's already-
  integrated changes to the same file. A `parallel_group` containing exactly one subtask
  does not use isolated-worktree cherry-picking at all; it edits the feature branch
  directly. So never put two subtasks that touch the same file in the same
  `parallel_group`: either merge them into one subtask, or split them across separate
  (sequential) `parallel_group`s. (The orchestrator auto-serializes same-group subtasks
  that still declare a shared file as a safety net — but place them deliberately, don't
  rely on that.)
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
- **`files_to_create` must be a fixed, static filename — never a date/timestamp
  placeholder the coder is expected to substitute.** Writing `evidence-YYYY-MM-DD.log`
  and telling the coder "use the actual run date" produces a file that will never
  match the literal placeholder — the deliverable check is an exact match against
  the real filesystem, not a pattern. Pick one concrete, static name and instruct
  the coder to use exactly that name (rename/copy the tool's output to it before
  committing if the tool's own output is timestamped).
- **Check whether the artifact's path could be gitignored** (log directories
  commonly are). If so, any "stage and commit" example in the subtask description
  must use `git add -f <path>`, not a plain `git add` — a plain `git add` on a
  gitignored path silently stages nothing, producing a commit that looks successful
  but omits the evidence QA needs.
- **If a later revision of this plan renames or replaces a previously-declared
  artifact**, the subtask instructions must tell the coder to `git rm -f` the old
  filename in the same commit that adds the new one — not just point `files_to_create`
  at the new name. Nothing else cleans up a superseded artifact; it silently ships
  in the final PR alongside its replacement.
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
- **Scoped re-plan (human preserve-list):** when the human directive scopes the
  replan to specific subtasks (a `Subtasks: N,M` line in `human_feedback.md`),
  re-plan ONLY those subtasks. Every subtask NOT listed must be preserved
  byte-for-byte — same `id`, `title`, `description`, `files`, `depends_on`,
  `acceptance_criteria`, `completed`, and `qa_flagged` — do not renumber their
  ids or rewrite their fields, even cosmetically. If fixing a dependency or file
  ownership issue would reach into a preserved subtask, resolve it WITHIN the
  selected set (e.g. adjust the selected subtask's `depends_on`), never by
  editing a preserved one. (The orchestrator deterministically restores any
  unlisted subtask that drifts — but a clean replan avoids the churn.)
```