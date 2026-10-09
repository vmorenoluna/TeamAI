<!-- .claude/commands/spec-revise.md -->
Adopt the role persona already loaded in your system prompt.

**Human directive override:** if a `human_feedback.md` file exists in the task's `.teamai/` directory and its `Target:` header names the analyst, its content OVERRIDES the feature request, any existing spec, and any other agent's directives wherever they conflict — address it explicitly.

You are revising an existing spec, not writing one from scratch.

## Request

$ARGUMENTS

The request above is assembled by the orchestrator. It may open with one or more header
blocks (each marked ⚠️, 🧑 or ℹ️) describing this session's situation — a background job
you are being re-entered for, deliverables a previous session left missing, a session
recovered after being killed, or a human reviewer's directive. Read them first: wherever
a header tells you how to handle this session, it takes precedence over the default
workflow below.

## Revision Workflow
1. Read the existing spec at the path provided in the request.
2. Read the `spec_revision_feedback.md` file at the same path — this contains the concerns that triggered the revision (from the QA reviewer's findings or the human reviewer's directive).
3. Address EVERY concern listed in the feedback:
   - If the concern points to a wrong assumption, correct it in the spec
   - If the concern identifies missing requirements, add them
   - If the concern identifies contradictory criteria, resolve the contradiction
4. Preserve valid parts of the spec that the feedback doesn't challenge — only change what needs changing.
5. Validate the revised spec against the original feature description — does the revised spec still satisfy the feature request, corrected for the discovered issues?
6. Re-run codebase research (Glob/Grep for related code, adjacent tests, configuration, and
   relevant types) scoped to the feedback's scope. Research only the
   files, modules, and configuration the concerns actually name (plus their adjacent tests
   and immediate dependencies) to ensure the revised spec is grounded in current codebase
   reality. Do NOT re-run a full-codebase Glob/Grep scan — a revision triggered by a
   single concern does not need to re-map the whole repository.
7. **Resolve every conditional you introduce.** If your fix involves a fork ("if the measured effect still shows the problem, do Y instead"), do not write the fork into the spec — pick one branch now and write only that branch's acceptance criteria and formulas. A spec with an unresolved fallback clause will fail review again.
8. Write the revised spec to `spec.md` (the path given in the request) — the versioned baseline file you read in step 1 (e.g. `spec_v1.md`) is the archived previous version; do NOT write to it.
9. **Verify you actually changed something.** Diff what you just wrote against the spec content you read in step 1. For each concern in `spec_revision_feedback.md`, find the specific line(s) that changed to address it. If any concern has no corresponding change, you have not addressed it — go back and fix the spec before proceeding to output.
10. Update `spec_summary.md` (same directory) so it reflects the revised spec's current reasoning:

- **Roughly 3–8 lines of plain prose**, capturing the feature's intent and the key decisions made in this spec — the "why" behind non-obvious choices (the approach picked over alternatives, notable formulas/thresholds and why, how tricky edge cases are handled). Do not restate the requirements list or acceptance criteria verbatim; summarize the reasoning, not the checklist.
- Write it for another agent or a human reviewer to understand the spec's reasoning without reading the full document — `spec.md` itself is not committed to git and is deleted once the task completes, so this summary becomes the durable record of the spec, embedded in the pull request's description.

## Revision Output
After writing the revised spec, print:
- The path to the revised spec file
- For each concern in `spec_revision_feedback.md`: the specific before → after change that addresses it (quote the old and new text/value/formula, not just a paraphrase)
- Confirmation that all spec concerns from the feedback were addressed, each backed by the diff above

**Deferred defects.** Never drop a defect you scope out of this spec. File it under
`new_tickets` in the backlog check (below), or as an `update` to the open ticket that
already covers it, and also record it in the spec's risks section.

**Backlog impact.** The spec owns the overlap analysis for the change it specifies. Add a
**Backlog impact** section to `spec.md` that lists each open ticket you judged `overlaps`,
`supersedes` or `invalidates`, with its `id` and one line on why, or states "none". The
planner reads this section to sequence around overlapping work.

## Backlog check

Your work can affect other tickets on the board, not just the one in front of you. Every
session that can file tickets judges the whole open board, and the orchestrator verifies
that it did. Never edit, create or delete ticket files yourself.

**Input.** The `ℹ️ BACKLOG CHECK` header at the top of this request names a snapshot file,
`open_tickets-<unit>.json` in `$TEAMAI_SPEC_DIR`. It lists every open ticket except your
own, each with `id`, `title`, `phase` and `description`. Read the whole description of
each ticket. A title alone is not enough to judge it.

**Output.** Before ending the session, write the check file named in the header,
`backlog_check-<unit>.json`:

```json
{
  "tickets": [
    { "id": "<ticket id>", "verdict": "unrelated", "reason": "" },
    { "id": "<ticket id>", "verdict": "invalidates", "reason": "<what changed, with evidence>" }
  ],
  "new_tickets": [
    { "title": "Fix: <short imperative title>", "description": "<one paragraph with the evidence>" }
  ],
  "self": { "verdict": "proceed", "reason": "<why the premise holds>" }
}
```

- `tickets` has **exactly one entry per ticket in the snapshot**. The orchestrator rejects a
  file that misses a ticket, repeats one, names one that isn't in the snapshot, or omits
  a reason for any verdict other than `unrelated`.
- `new_tickets` lists defects, missing features and refactors you found outside your
  scope that no open ticket covers. Titles start with `Fix:`, `Feat:`, `Refactor:` or
  `Docs:`. Put the evidence (file, measurement, observed versus expected) in the
  description, because the next analyst will verify it before acting on it.
- `self` is required only when the header asks for it (the spec phase). See below.

**Verdicts.** Judge each ticket against what your task does and what it has found:

| Verdict | Meaning | Effect |
|---|---|---|
| `unrelated` | Your task doesn't touch this ticket's problem, code or evidence. | none |
| `overlaps` | Same code or area, but both stay valid and independent. | none; record it so the work can be sequenced |
| `supersedes` | Your task fully covers the ticket's scope, or removes the problem it describes. | auto mode stops starting it at once; it is deleted when your task is done |
| `invalidates` | Still wanted, but its premise, evidence, baseline or measurements depend on something your task changes. | it waits for your task, then is re-specced against the result |
| `update` | You have new evidence for it, or a narrower scope. | a dated note is added to it |

Use `supersedes` only for full coverage. If your task covers part of a ticket, use
`update` to say which part. If one of your findings is already covered by an open ticket,
`update` that ticket rather than adding it to `new_tickets`. A ticket whose phase is
neither `backlog` nor `failed` is already running. It receives only your reason, as a
note.

**Judge on evidence, not on wording.** Two tickets can share vocabulary and be unrelated,
or use different words for the same defect. Decide from what each ticket claims and from
what your task actually changes, which means checking the code or the measurement when
the description alone doesn't settle it. If you can't tell, say so in the reason. Never
default to `unrelated` to save time.

**Own-ticket verdict (`self`, spec phase).** A ticket's description is a claim, not an
instruction. Any pipeline agent can file tickets (a coder, planner, QA reviewer or another
analyst) for whatever it finds outside its own task. The header tells you when this ticket
was filed that way and by which agent. Such a claim comes from a narrow view of the
project, and nobody has verified it yet: verifying it is your job. Before speccing, verify
the premise: is the problem real, still present on the current code, and correctly
diagnosed? Is its evidence current? Then give:

- `proceed`, with a reason that says what you verified. Your spec then addresses the
  problem as it really is, which can be narrower than, or different from, the ticket's
  wording.
- `reject`, when the premise does not hold: already fixed, no longer reproducible,
  measured on code that has since changed, or a misdiagnosis. Put the evidence in the
  reason. The ticket is deleted and nothing is planned. The decision is yours to make, so
  don't reject for lack of effort: if the premise is partly right, `proceed` with the
  part that holds.

**Never write a backlog entry about your own task's internals** (its spec, plan,
subtasks, acceptance gates, baseline or expected values). Problems with your own task
belong in your normal output: the spec's risks, your summary, or the QA report.

---

## When a long-running job won't finish before your session budget

If your codebase research (or your own self-critique) leads you to kick off a long-running
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
Shell polling loops count as waiting inline too — `while …; do sleep …; done`, a
`for … sleep …` loop, or a series of long `sleep` calls, whether foreground or
backgrounded: they burn your session (or die with it) and never resume you. Once the
wakeup file is written, end the session.

Then end your session normally without writing `spec.md` — the orchestrator will NOT
treat this as a missing spec, it pauses instead. On re-entry (headed
`⚠️ WAKEUP RE-ENTRY`):
- Check if the artifact exists and is complete. If it is: use its results to finish the
  spec (the workflow above).
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
