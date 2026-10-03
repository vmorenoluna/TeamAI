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
  same file will conflict at cherry-pick. A `depends_on` edge between two subtasks in
  THE SAME group does NOT prevent this: within a group, only `parallel_group` placement
  controls the concurrent dispatch set, so same-group siblings run together regardless
  of any `depends_on` between them. Subtasks in DIFFERENT `parallel_group`s run strictly
  sequentially, one full group's changes landing on the feature branch before the next
  group starts — so a later group's subtask safely builds on an earlier group's already-
  integrated changes to the same file. A `parallel_group` containing exactly one subtask
  does not use isolated-worktree cherry-picking at all; it edits the feature branch
  directly. So never put two subtasks that touch the same file in the same
  `parallel_group`: either merge them into one subtask, or split them across separate
  (sequential) `parallel_group`s. (The orchestrator auto-serializes same-group subtasks
  that still declare a shared file as a safety net — but place them deliberately, don't
  rely on that.)
- **`depends_on` IS enforced across groups — always declare real ordering
  requirements there, never through `parallel_group` placement alone.** Sequential
  `parallel_group` letters (A before B before C...) are the normal way later work
  builds on earlier work, but group order alone is not a durable ordering guarantee:
  a long-running subtask that pauses via a wakeup file (a background script,
  benchmark, or server process — see the coder's implement.md) re-enters through an
  ISOLATION path that dispatches ONLY that one subtask by id, and that path verifies
  readiness by checking `depends_on` directly — it does not re-check whether an
  earlier group actually finished. A subtask whose description says "confirm subtask
  N has finished" or "must run after subtask N" or "no other subtask running
  concurrently" but omits N from its own `depends_on` array has a requirement that
  exists only in prose: the orchestrator has no structural reason to hold it back,
  and a wakeup re-entry will not verify N's completion at all. **Any subtask
  description that references another subtask's completion, output, or exclusivity
  MUST add that subtask's id to `depends_on`, even when `parallel_group` ordering
  already implies it.** This is especially easy to miss for evidence-gathering
  subtasks that run one or more long-lived server/client processes and must be
  strictly ordered against sibling evidence subtasks (e.g. "run the production
  benchmark only once the baseline and comparison runs are both done and their
  servers are shut down") — declare that ordering in `depends_on`, not only in the
  description.
- **A subtask description never refers to a later subtask.** Each subtask must be
  self-contained: state only its own scope and constraints, never "this must land
  before the sweep (subtask 5)" or "subtask 9 adds the entry". A reference to an
  EARLIER subtask is allowed only with that id in `depends_on`. If a later subtask
  must run after this one, put the ordering in the LATER subtask's `depends_on`;
  never add a forward id to an earlier subtask's `depends_on` (it can never be
  satisfied). The orchestrator logs a `[PLAN-LINT]` warning for both cases.
- **Verification scripts need dedicated subtasks:** When the spec includes an acceptance
  criterion that requires running a script to produce empirical evidence (e.g. a
  benchmark, integration run, or data pipeline), the plan MUST include a dedicated
  subtask for that script run. Never fold it into a documentation subtask. The subtask
  must specify: (a) the exact command to run, (b) what output artifact to commit, and
  (c) the specific check to apply to the output (e.g. "section X shows fewer than N
  failures"). This makes the criterion independently verifiable by QA without relying
  on the engineer's self-report.
- **Run-only gate subtasks set `"verify_only": true`.** A subtask whose job is to
  run something and report (the full test suite, a build, a sweep) and which edits
  nothing when everything passes MUST carry `"verify_only": true`. List in `files`
  only the files it may need to fix if the run fails (or leave `files: []` if it
  must not edit anything). Without the flag, the orchestrator rejects a session
  that made no edit as a no-op, re-runs it, and fails the task after 3 passes —
  even though the run itself succeeded. Do NOT set it on subtasks expected to
  change files.
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

## When a feasibility check won't finish before your session budget

If sizing a subtask's verification requirements leads you to dry-run a script or
benchmark against the codebase — checking how long a full run actually takes, or
whether an approach the spec assumes is even viable — and it won't complete before
your session ends, schedule an orchestrator wakeup instead of guessing at the plan
based on an incomplete check.

Do steps 1–3 below back to back, immediately after you launch the job — not as a final
step you'll get to once you're done waiting. Your turn can end at any point without
warning once a long job is running; if that happens before you've written
`phase_wakeup.json`, the orchestrator has no way to tell your in-progress job apart from
a session that produced nothing, and the task is parked for human review with the job's
results discarded, however far they got.

1. **Detach the job**: `nohup <command> > job.log 2>&1 & disown`. Write the log inside
   `$TEAMAI_SPEC_DIR` (your cwd is the project root at this phase, not a worktree).
2. **Record its PID** (`echo $! > job.pid`) if you launch more than one job at once —
   kill by PID (`kill $(cat job.pid)`) when you need to stop or relaunch one, never by a
   command-line pattern match (`pkill -f <substring>`). A substring broad enough to
   match every job's command line can also match your own shell's, killing the session
   that's trying to manage them.
3. Write `phase_wakeup.json` to `$TEAMAI_SPEC_DIR`:

```json
{
  "wakeup_at": "2026-07-03T23:20:00Z",
  "background_command": "python scripts/dry_run_check.py --output results/",
  "expected_artifact": "results/summary.jsonl",
  "progress_log_path": "results/job.log"
}
```

- `wakeup_at`: ISO 8601 timestamp when the process should be done — estimate from the
  job's actual throughput plus a 20% safety margin.
- `background_command`: the command you ran (informational).
- `expected_artifact`: the file you expect the process to produce.
- `progress_log_path`: the job's own log file, relative to the project root — include it
  whenever the job writes one.

**Do NOT call an interactive `ScheduleWakeup`-style tool, and do NOT use `Monitor` (or
any other tool) to wait on the job inline.** Neither pauses and resumes you across
turns in this pipeline — a `Monitor` call that outlives your remaining turn budget ends
your session exactly like any other silent timeout, and narrating that you'll "wait for
the completion notification" accomplishes nothing if `phase_wakeup.json` was never
written. The file is the only thing the orchestrator's resume mechanism understands.

Then end your session normally without writing `plan.json` — the orchestrator pauses
instead of treating this as a failed plan. On re-entry (headed
`⚠️ WAKEUP RE-ENTRY`): check if the artifact exists and is complete. If it is, use its
results to finish the plan. If it's missing or incomplete, check whether the process is
still running — write an updated `phase_wakeup.json` with a new `wakeup_at` if so; if it
crashed, do NOT write another wakeup file and report the failure immediately (the
orchestrator fails the task after 3 consecutive wakeup attempts without progress). A
materially different `background_command` on relaunch (you fixed a real blocker) resets
that 3-attempt budget instead of consuming it.

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