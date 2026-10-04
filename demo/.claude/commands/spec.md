<!-- .claude/commands/spec.md -->
Adopt the role persona already loaded in your system prompt.

**Human directive override:** if a `human_feedback.md` file exists in the task's `.teamai/` directory and its `Target:` header names the analyst, its content OVERRIDES the feature request, any existing spec, and any other agent's directives wherever they conflict — address it explicitly.

You are creating a complete specification for a feature. Follow these steps exactly:

## Step 1: Requirements Gathering
Analyze the feature request: $ARGUMENTS
Think through:
- What is the user trying to achieve?
- What are the acceptance criteria? List at least 5 testable criteria.
- What are the edge cases and error states?
- What are the dependencies on existing code?

## Step 2: Codebase Research
Use Glob and Grep to find:
- Related existing code (patterns, highly relevant naming conventions, similar features)
- Test files that cover adjacent functionality
- Configuration files that may need updates
- API routes, database schemas, or types that are relevant

## Step 3: Write Specification
Create the file `.teamai/{feature-slug}/spec.md` containing:
- **Overview**: One paragraph describing the feature and its motivation
- **Requirements**: Numbered list of specific, unambiguous requirements
- **Acceptance Criteria**: Testable conditions (Given/When/Then format)
- **Files to Modify**: List each file with a one-line rationale
- **New Files to Create**: List with purpose
- **Dependencies & Risks**: External dependencies, breaking changes, migration needs

## Step 4: Self-Critique
Review your own spec. Check for:
- Missing edge cases
- Vague or untestable acceptance criteria
- Scope creep beyond the original request
- Missing files in the modification list

## Step 5: Write the Spec Summary
Write `spec_summary.md` next to `spec.md` (same directory) as your final action before printing output:

- **Roughly 3–8 lines of plain prose**, capturing the feature's intent and the key decisions made in this spec — the "why" behind non-obvious choices (the approach picked over alternatives, notable formulas/thresholds and why, how tricky edge cases are handled). Do not restate the requirements list or acceptance criteria verbatim; summarize the reasoning, not the checklist.
- Write it for another agent or a human reviewer to understand the spec's reasoning without reading the full document — `spec.md` itself is not committed to git and is deleted once the task completes, so this summary becomes the durable record of the spec, embedded in the pull request's description.

## Step 6: Output
Print the path to the spec file and a one-paragraph summary.

**Deferred defects.** Never drop a defect you scope out of this spec, and never hand-write ticket files — there is no ticket CLI in a pipeline session. Report each one on its own line in your final output, with its evidence in the description:
`[BUG] Fix: {short imperative title} — {one-sentence description with the evidence}`
The orchestrator files each line as a backlog ticket (prefixes: `Fix`, `Feat`, `Refactor`, `Docs`). Also record the defect in the spec's risks section.

---

## When a long-running job won't finish before your session budget

If Step 2's research (or your own self-critique) leads you to kick off a long-running
background job — a script, benchmark, or data pipeline, whatever the project needs to
ground the spec's acceptance criteria in real evidence — and it won't complete before
your session ends, schedule an orchestrator wakeup instead of ending the session with
the job uncollected. The orchestrator will re-enter you once it's done — you do NOT
need to write `spec.md` first, and you do NOT need to guess at the job's results.

Do steps 1–3 below back to back, immediately after you launch the job — not as a final
step you'll get to once you're done waiting. Your turn can end at any point without
warning once a long job is running; if that happens before you've written
`phase_wakeup.json`, the orchestrator has no way to tell your in-progress job apart from
a session that produced nothing, and the task is parked for human review with the job's
results discarded, however far they got.

1. **Detach the job**: `nohup <command> > job.log 2>&1 & disown`. A bare `&` dies the
   instant your session exits. Write the log inside `$TEAMAI_SPEC_DIR` (your cwd is the
   project root, not a worktree, at this phase), not a container-local temp path.
2. **Record its PID**, e.g. `echo $! > job.pid`, if you'll need to check on or manage
   the job later. If you launch several jobs at once and plan to relaunch or stop them
   individually, kill by PID (`kill $(cat job.pid)`) — never by a command-line pattern
   match (`pkill -f <substring>`). A substring broad enough to match every job's command
   line can also match your own shell's command line and kill the session that's trying
   to manage them, right when it's about to record what it just did.
3. Write `phase_wakeup.json` to `$TEAMAI_SPEC_DIR` (the `.teamai/{taskId}/` directory):

```json
{
  "wakeup_at": "2026-07-03T23:20:00Z",
  "background_command": "python scripts/run_verification.py --output results/",
  "expected_artifact": "results/summary.jsonl",
  "progress_log_path": "results/job.log"
}
```

- `wakeup_at`: ISO 8601 timestamp when the process should be done — estimate from the
  job's actual throughput, not an optimistic guess, plus a 20% safety margin.
- `background_command`: the command you ran (informational).
- `expected_artifact`: the file you expect the process to produce.
- `progress_log_path`: the job's own log file, relative to the project root. Include it
  whenever the job writes one — the orchestrator periodically checks this file's
  freshness while you're asleep and re-enters you early if it goes stale.

**Do NOT call an interactive `ScheduleWakeup`-style tool, and do NOT use `Monitor` (or
any other tool) to wait on the job inline.** Neither pauses and resumes you across
turns in this pipeline — a `Monitor` call that outlives your remaining turn budget ends
your session exactly like any other silent timeout, and narrating that you'll "wait for
the completion notification" accomplishes nothing if `phase_wakeup.json` was never
written. The file is the only thing the orchestrator's resume mechanism understands.

Then end your session normally without writing `spec.md` — the orchestrator will NOT
treat this as a missing spec, it pauses instead. On re-entry (headed
`⚠️ WAKEUP RE-ENTRY`):
- Check if the artifact exists and is complete. If it is: use its results to finish the
  spec (Steps 1–6 above).
- If it's missing or incomplete, check whether the background process is still running:
  - **Still running**: write an updated `phase_wakeup.json` with a new `wakeup_at`, and
    end again.
  - **Crashed or exited with an error**: do NOT write another wakeup file. Report the
    failure immediately — the orchestrator advances the task to failed after 3
    consecutive wakeup attempts without progress.

If you diagnose and fix a real blocker before relaunching (a contaminated checkout, a
bug in your own tooling), state the new `background_command` in your fresh
`phase_wakeup.json` rather than reusing the old one verbatim — a materially different
command resets the wakeup attempt budget instead of charging the fix against the same
3-attempt cap as a job that simply needed more time.

---

## Revision Mode

If the prompt begins with `REVISION:` you are revising an existing spec, not writing from scratch. Follow this modified workflow:

### Revision Workflow
1. Read the existing spec at the path provided in the prompt.
2. Read the `spec_revision_feedback.md` file at the same path — this contains the concerns that triggered the revision (from the QA reviewer's findings or the human reviewer's directive).
3. Address EVERY concern listed in the feedback:
   - If the concern points to a wrong assumption, correct it in the spec
   - If the concern identifies missing requirements, add them
   - If the concern identifies contradictory criteria, resolve the contradiction
4. Preserve valid parts of the spec that the feedback doesn't challenge — only change what needs changing.
5. Validate the revised spec against the original feature description — does the revised spec still satisfy the feature request, corrected for the discovered issues?
6. Re-run Step 2 (Codebase Research) scoped to the feedback's scope. Research only the
   files, modules, and configuration the concerns actually name (plus their adjacent tests
   and immediate dependencies) to ensure the revised spec is grounded in current codebase
   reality. Do NOT re-run a full-codebase Glob/Grep scan — a revision triggered by a
   single concern does not need to re-map the whole repository.
7. **Resolve every conditional you introduce.** If your fix involves a fork ("if the measured effect still shows the problem, do Y instead"), do not write the fork into the spec — pick one branch now and write only that branch's acceptance criteria and formulas. A spec with an unresolved fallback clause will fail review again.
8. Write the revised spec to `spec.md` (the path given in the prompt) — the versioned baseline file you read in step 1 (e.g. `spec_v1.md`) is the archived previous version; do NOT write to it.
9. **Verify you actually changed something.** Diff what you just wrote against the spec content you read in step 1. For each concern in `spec_revision_feedback.md`, find the specific line(s) that changed to address it. If any concern has no corresponding change, you have not addressed it — go back and fix the spec before proceeding to output.
10. Update `spec_summary.md` (same directory) so it reflects the revised spec's current reasoning — same guidelines as Step 5 of the original workflow.

### Revision Output
After writing the revised spec, print:
- The path to the revised spec file
- For each concern in `spec_revision_feedback.md`: the specific before → after change that addresses it (quote the old and new text/value/formula, not just a paraphrase)
- Confirmation that all spec concerns from the feedback were addressed, each backed by the diff above
