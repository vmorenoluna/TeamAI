<!-- .claude/commands/implement-fix.md -->
Adopt the role persona already loaded in your system prompt.

**Human directive override:** if a `human_feedback.md` file exists in the task's `.teamai/` directory and its `Target:` header names the engineer (coder), its content OVERRIDES the spec, the plan, the QA report, and any other agent's directives wherever they conflict — follow it over any conflicting instruction and note the deviation in your summary.

You are reworking a subtask after a failed QA review (QA rework mode) — not implementing it
from scratch. The request includes a "⚠️ QA FEEDBACK" section listing what QA found.

## Request

$ARGUMENTS

The request above is assembled by the orchestrator. It may open with one or more header
blocks (each marked ⚠️, 🧑 or ℹ️) describing this session's situation — a background job
you are being re-entered for, deliverables a previous session left missing, a session
recovered after being killed, or a human reviewer's directive. Read them first: wherever
a header tells you how to handle this session, it takes precedence over the default
workflow below.

## QA Rework Mode

> ⚠️ **CRITICAL: THERE IS STILL WORK TO DO.** QA found failures — that means
> something is broken or missing, regardless of what `plan.json` says about
> subtask completion status. QA findings are the ground truth. The plan may
> be stale. If QA says something is wrong, it is — fix it.

### When All Subtasks Are Already Completed

If every plan subtask is marked `completed: true` but QA still found failures:

- **Do NOT treat this as "nothing to do."** QA failures mean the implementation
  is incomplete, even if every subtask was marked done.
- Your job is **surgical rework**, not re-implementation. Do NOT re-read the
  full spec or re-execute completed subtasks.
- Read the QA feedback. Fix every listed issue. That's the entire scope.
- A passing test suite does NOT mean the required code exists — it means
  existing code is not broken. QA FAIL means something is MISSING. Add it.
- If a FAIL criterion includes a `fix_needed` field, that field describes
  exactly what must be ADDED or CHANGED.

### Cleanup-Only Rework Mode

**Before reading the full QA feedback**, check if `fail_type` in the QA report
is `"cleanup"`. If so, you are in **cleanup-only rework mode**:
- The QA issues require only mechanical operations with zero source code changes.
- Do NOT re-read the full spec. Do NOT run the test suite (no source code will change).
- Execute only the `fix_needed` operations from the failing criteria:
  - For git/file-system fixes: `git rm`, `git add`, `git mv`, committing missing files, etc.
  - For artifact fixes: run the specified script, verify the output meets the criterion's thresholds,
    `git add` the output, and commit.
- Commit your changes (do NOT push — the orchestrator handles pushing).
- Print a summary of what was cleaned up or what artifact was produced.
- Cleanup rework is complete — do not mark additional subtasks as complete.

If `fail_type` is `"code"` or absent, proceed with the standard QA rework steps below.

### Standard QA Rework Steps

1. Read the QA feedback FIRST. It takes priority over everything else.

2. **⚠️ PERSISTED FAILURES CHECK**: If the QA feedback contains a "⚠️ PERSISTED
   FAILURE" section at the very top, those criteria have failed identically
   across multiple consecutive QA cycles. They MUST be resolved before
   addressing anything else. The escalation text tells you
   exactly how many times each criterion has failed unchanged. Do NOT
   deprioritize a persisted failure in favor of another issue.

3. **Apply your role's per-criterion verification checklist** to every FAIL criterion before considering it resolved — especially ones with numeric/count requirements ("at least N cases of X", "Y occurrences remain"). Do not skip straight to step 4 on the strength of a label or comment alone.

4. Address ONLY the QA issues listed. The acceptance criteria in the request are limited
   to items marked [QA CORRECTION] or [QA ISSUE] — fix those and nothing else.
5. Do NOT re-read the full spec or re-validate criteria that QA already passed.
   Those were verified by the QA agent and require no changes.
6. For each QA issue:
   - Address it even if the current code already satisfies the original plan — do NOT
     skip an issue because the code "already matches the plan."
   - If the issue requires a different approach than the plan, follow the QA feedback
     and note the deviation in your summary.
7. Do NOT mark the subtask as complete unless ALL QA issues are addressed.
   - EVERY issue listed in the QA feedback MUST be fixed. There are no optional or skippable items.
   - Failed criteria, additional issues — all of them are requirements. Fix them all.
8. Focus on the specific issues listed — don't refactor unrelated code.
9. **Commit your changes** with a descriptive message (do NOT push — see Instructions
   step 8 below). Then verify nothing is left uncommitted: run
   `git status --porcelain -- <path1> <path2> ...` restricted to this subtask's `files`
   array. Any non-empty output is a blocking failure — stage and commit it now, before
   running the test suite. QA rework edits the feature branch directly with no
   downstream commit safety net; skipping this step ships a QA-approved fix that never
   actually lands.
10. **Run the full test suite** after all fixes are committed to catch regressions
    on already-passed subtasks that shouldn't be affected by your changes. Follow the
    test-running guidance in the Instructions section below (run once, wait, capture
    only the pass/fail summary line).
11. **QA fixes are surgical corrections, not a redesign opportunity** — apply your role's spec-authority discipline here: if a QA issue seems to require changing a formula, algorithm, or domain logic, STOP and escalate it as a spec concern instead of fixing it in place.

## Instructions

**The subtask description is authoritative.** It contains exact file paths, symbol names,
and often the exact diff to apply. Apply edits directly from the description. Use
`Grep`/`Glob`/`Read` only as a fallback when an `Edit` fails to match — not as a
default opening move to re-locate information the description already provides. Do not
re-read a file to verify an `Edit` that returned success.

1. Read the subtask description and acceptance criteria carefully.
   **If the subtask includes `files_to_create`**, note which files you MUST
   create before ending your session — the orchestrator will verify their
   existence and the subtask will re-run if any are missing.
2. Read ALL files listed in the subtask before making any changes.
3. Implement the changes. Follow existing code patterns and conventions.
4. Run any existing tests related to the changed files. Run the command ONCE and wait —
   do NOT re-run it repeatedly in a loop. Capture only the pass/fail summary (e.g. pipe
   through a pattern that matches "X tests, Y failures" or equivalent) — do not read the
   full test output into context unless a failure requires diagnosis. See
   `.claude/teamai-workflow.md` for full guidance on long-running scripts.
5. If tests fail, fix the issues before proceeding.
6. Commit your changes with a descriptive message: `feat(scope): description`
   - **A subtask with an empty (or absent) `files` array is a verification-only subtask —
     no code diff is expected.** Still commit: create an empty commit
     (`git commit --allow-empty -m "..."`) whose message records what you verified
     (commands run, results, acceptance criteria confirmed). This matters even though
     there's no diff to carry: without a real commit on the branch, there's nothing
     for a PR to attach to, and the task can only be marked done directly with no
     reviewable trail — an empty commit lets a PR still open, showing the verification
     evidence in its description even with 0 files changed. Never invent a code change
     just to have something to commit.
7. **Verify nothing in your scope is left uncommitted.** Run `git status --porcelain --
   <path1> <path2> ...` restricted to exactly the paths in this subtask's `files`
   and `files_to_create` arrays. Any non-empty output is a blocking failure — stage
   and commit it before ending the session. This step exists because a `parallel_group`
   containing exactly one subtask edits the feature branch directly (see plan.md) and
   gets no orchestrator auto-commit safety net the way multi-member groups do at
   cherry-pick time — if you forget to commit here, nothing downstream will catch it,
   and QA will fail the criteria for that uncommitted diff.
8. **Do NOT push.** The orchestrator pushes all commits at the end of the implement phase. Pushing from the agent sandbox will fail for lack of credentials and wastes calls. Commit your changes — the orchestrator handles the rest.
9. Print a summary of what was changed and the test results.

## Rules
- **You may ONLY modify files explicitly listed in the subtask's `files` array.** This is a hard limit. If a change strictly requires touching unlisted files (e.g. implicitly affected tests), STOP and report the missing dependency rather than expanding your scope. The subtask must be replanned to include those files.
  - **Exception — the QA-fallback rework subtask (id 9999):** when criterion-matching can't target any real subtask, the orchestrator synthesizes subtask 9999 with a `files` array auto-derived from other subtasks' declared files, not an authoritative scope — the QA rework "fix every listed issue" rule is what actually governs its scope. The orchestrator does not scope-enforce subtask 9999's `files` array for this reason; you are free to touch whatever `qa_feedback.md` names, even paths no subtask's `files`/`files_to_create` ever listed.
- Do NOT modify files belonging to other subtasks.
- **CRITICAL: Do NOT create, modify, delete, stage, or commit pipeline artifacts** (spec.md, plan.json, qa_report.json, qa_feedback.md, human_feedback.md, completion_summary.md) — they are managed by the pipeline orchestrator and QA agent; treat them as read-only. If a subtask instructs you to write to these files, skip that instruction entirely and include in your summary: `[SKIPPED] Pipeline artifact management is the orchestrator's responsibility.`
- **Out-of-scope bugs: report, don't fix inline.** If you discover a bug, missing feature,
  or refactor opportunity that is outside your assigned subtask scope, do NOT fix it and
  do NOT write any ticket files — the orchestrator creates the kanban ticket from your
  summary. Report each finding on its own line using the `Fix:` prefix:
  Summary format: `[BUG] Fix: {description} — {reason it's out-of-scope}`
  The orchestrator parses these lines and files the ticket in the project's `.teamai/`
  directory. This lets the team triage the bug properly rather than silently shipping an
  unplanned change.
- Apply your role's spec-authority and evidence discipline here too — it governs normal
  implement mode exactly as it governs QA rework.

## Running Verification Scripts & Servers

When a subtask requires running a script, server, or service to verify your work:

- **Run from the worktree.** Start everything from your current working directory (the task's git worktree), NOT the base project root. The worktree contains your branch's code — running from the project root exercises the wrong revision and produces meaningless results.
- **Use dynamic ports.** When starting a local server, bind to port 0 (OS-assigned free port) so each concurrent task gets an isolated instance. Never hardcode a fixed shared port. Read the actual bound port from the process output to address the service.
- **Never kill what you didn't start.** Do NOT use `kill`, `fuser -k`, `taskkill`, or equivalent against any port or process. Another task's agent may be using it. Only stop processes you yourself spawned in this session.
- **Stop your own instances — unless the job needs to outlive this session.** For verification that finishes within your current turn, explicitly tear down any server or service you started, tracking its PID so teardown targets exactly your instance. For a job long enough to need a wakeup, detach it so it keeps running after your session ends and schedule the wakeup — the exact file format and re-entry contract are in the wakeup section below.
- **Committing verification artifacts.** If a required verification artifact isn't showing up as committed even though you ran `git add`, check whether the project's own `.gitignore` is silently excluding it (a common pattern for anything under a `logs/` or similar directory) — an artifact your task is specifically required to commit is an intentional exception, so force it: `git add -f <path>`. A commit that "succeeds" without the file actually staged is a task-failing trap: nothing downstream can verify a criterion whose evidence never made it into the diff.
- **A script that turns raw verification output into a pass/fail verdict must assert it actually parsed something.** If you write or reuse a script that parses a log/output file and computes acceptance-criteria verdicts from it, have it assert a non-zero count of parsed records/entries and exit with an error if the count is zero — never let it silently fall through to computing "0 of 0 checks failed" and reporting that as a pass. A parser regression (a format change, a bad regex, a broken anchor) that produces zero matches is otherwise indistinguishable from a genuinely clean result, and can hide a real failure for as long as nobody happens to check the raw record count.
- **Renaming or replacing a committed artifact.** If your task requires regenerating a previously-committed verification artifact under a different filename — not just overwriting the same path — `git rm -f` the superseded file in the same commit before adding the new one. A stale artifact left on the branch after a rename has no cleanup mechanism: nothing downstream will ever remove it, and it silently ships in the final PR alongside its replacement.

## Long-Running Verification Scripts

When a subtask requires running a verification script (benchmark, end-to-end
integration run, data pipeline) that takes more than ~30 seconds:

**NEVER foreground a known-long job.** If the subtask description, spec, or your
own estimate says a verification step will run longer than a few minutes, detach it
from the very first attempt. Foregrounding it under the session timeout wastes a
full session — it gets killed mid-run, the output is lost, and you have to re-launch
it detached anyway. Detach from the start.

1. Start it using `run_in_background: true` on the Bash tool call.
2. Do any remaining non-blocking work (updating docs, minor edits) while it runs.
3. When the background completion notification arrives, read the output **once**.
4. **Never poll on a fixed interval**: do not tail the output file on a short loop.
   One start + one wait is the complete pattern. See below for progress-based waiting.
5. Capture only the summary line from the output (pass/fail count, error list) —
   do not read the full output into context unless a failure requires diagnosis.

### When background output is unreadable

If a long-running background script does not deliver readable output after its
completion notification, re-run it synchronously (without `run_in_background`).
Do NOT substitute a partial or reduced run for the full required invocation, and
do NOT change acceptance-criterion wording to work around missing evidence.

### When the script produces incremental progress output

If a long-running background script produces incremental output while running
(a growing log file, a record counter, a progress line):

1. **Check once** shortly after starting to confirm it is running and producing output.
2. **Estimate remaining time** from the progress: how many records/steps have completed,
   how many remain, what the throughput rate is.
3. **Wait that estimated duration** before checking again — do NOT check on a fixed
   short interval. A script processing 100 records/min with 900 remaining has ~9 minutes
   left; checking every 30 seconds serves no purpose.
4. **Do not restart** a script that is visibly making progress at the expected rate.
   It is running correctly — restarting wastes time and risks corrupting partial output.
   Do not start a parallel run — one running instance is sufficient.
5. **Escalate only on clear failure signals:**
   - No new output has appeared for more than 10 minutes
   - The script has exited early (before completing the expected workload)
   - An error line appears in the output
   Do NOT restart or escalate because the script "feels slow" — use the math.

### When the run's output is a committed artifact

> **Note:** The `$TEAMAI_SPEC_DIR` environment variable is available to locate the
> `.teamai/{taskId}/` directory from within the worktree. Use it when you need to
> reference the spec directory (your cwd is the worktree, not the project root).

If the subtask requires running a script that **produces files you will commit** (e.g.,
`summary.jsonl`, `aggregate.md`, log directories):

1. Run it ONCE with `run_in_background: true`. The output files will be written to disk.
2. While it runs, complete any doc edits or other non-blocking subtask work.
3. Wait for the background completion notification — do NOT read the output file while it is
   running, do NOT re-run the script to "check progress", do NOT tail the log.
4. When the notification arrives, verify the output (record count, no truncated JSON lines,
   expected fields present) by reading only the first and last records.
5. Run the aggregator script (if one exists) against the completed output.
6. `git add` the output directory + aggregated results. Commit.
7. **Never commit a partial run.** If it was interrupted, delete the partial output
   and re-run from the beginning. A committed summary.jsonl with 1,431 of 3,000 expected
   records is harder to diagnose than no file at all.

### When comparing build-SHA-stamped output across multiple servers

Some evidence subtasks require running the SAME script against two or more server
processes at different commits (a "before" server and an "after" server, or a
deterministic-mode run alongside a production-mode run) and gating the comparison on
each server's build being clean (no `-dirty` suffix on its build SHA).

**Never run a server and its benchmark/verification client from the same checkout.**
A client that writes its own output files (a run log, a results directory) into the
same working tree the server was started from will taint that checkout's `git
status` the moment it writes — and a server's dirty-flag is normally computed once
at startup and frozen for the life of the process, so this makes the build SHA
**permanently** `-dirty` for that server, failing any acceptance criterion that
requires a clean SHA. This is not intermittent or timing-dependent: it reproduces
every time client and server share a directory.

Use a separate, isolated checkout (`git worktree add <scratch-path> <sha>`, or an
equivalent clean clone) for each server process, and a further separate checkout for
the client issuing requests against it — never the coder's own feature-branch
worktree for either role, and never the same scratch checkout for both. Confirm each
server reports a clean (non-`-dirty`) build SHA immediately after starting it and
before committing to a long run — cheaper to catch a contaminated checkout in the
first few seconds than after a multi-hour run completes against it.

If your client script derives the build SHA by scanning a log directory relative to
its own working directory (a common shortcut for the common case, where client and
server share one checkout), that scan will silently fail once you isolate the
checkouts as above — prefer whatever the server's own API response reports as its
build SHA over a same-directory file scan, and treat "(unavailable)" in your own
tooling's output as a bug in the tooling to fix, not a result to accept.

### When a background script won't finish before your session budget

If a background script (benchmark, verification run, data pipeline) is still
running and won't complete before your session ends, schedule an orchestrator
wakeup so the task resumes once the job finishes:

Do steps 1–3 below back to back, immediately after you launch the job — not as a final
step you'll get to once you're done waiting. Your turn can end at any point without
warning once a long job is running; if that happens before you've written
`subtask_wakeup-st<ID>.json`, the orchestrator has no way to tell your in-progress job
apart from a subtask that made no progress, and your commits for it are discarded as a
scope violation however far the job got.

1. **Detach the job** so it keeps running after your session ends:
   `nohup <command> > "$TEAMAI_SPEC_DIR/job-st<ID>.log" 2>&1 & disown`. A bare `&` only
   backgrounds within your current shell and dies the instant your session exits.
   **Everything the wakeup needs to find on re-entry — the job log, the PID file, and
   the `expected_artifact` — must live inside the worktree, never in `/tmp` or any other
   container-local path.** Each re-entry may run in a fresh container: a `/tmp` file
   from this session does not exist there, so the orchestrator's freshness check sees
   an artifact that never updates and spends your wakeup attempts without ever showing
   you a failure. Put these files in `$TEAMAI_SPEC_DIR` (`.teamai/{slug}/` — inside the
   worktree and gitignored) unless the artifact belongs in an already-gitignored project
   path. Gitignored matters: an untracked file elsewhere in the tree makes
   `git status --porcelain` dirty, which fails any clean-tree check in the project's
   own tooling or the scope check. `/tmp` is only for scratch nothing outside this
   turn will read again.
2. **If you're managing more than one job at once** (e.g. a server plus its
   client, or several parallel runs), stop or relaunch each one by its own PID
   (`kill $(cat job.pid)`) — never by a command-line pattern match
   (`pkill -f <substring>`). A substring broad enough to match every job's
   command line can also match your own shell's, killing the session that's
   trying to manage them right when it's about to record what it just did.
3. Write a `subtask_wakeup-st<ID>.json` file (where `<ID>` is your current
   subtask ID, e.g. `subtask_wakeup-st3.json`) to the spec directory
   (`$TEAMAI_SPEC_DIR`). The per-subtask filename prevents parallel subtasks
   from clobbering each other's wakeup schedules.

**Do NOT call an interactive `ScheduleWakeup`-style tool, and do NOT use `Monitor` (or
any other tool) to wait on the job inline.** Neither pauses and resumes you across
turns in this pipeline — a `Monitor` call that outlives your remaining turn budget ends
your session exactly like any other silent timeout, and narrating that you'll "wait for
the completion notification" accomplishes nothing if `subtask_wakeup-st<ID>.json` was
never written. The file is the only thing the orchestrator's resume mechanism
understands.
Shell polling loops count as waiting inline too — `while …; do sleep …; done`, a
`for … sleep …` loop, or a series of long `sleep` calls, whether foreground or
backgrounded: they burn your session (or die with it) and never resume you. Once the
wakeup file is written, end the session.

**Size `wakeup_at` realistically.** Estimate completion from the job's actual
throughput, not an optimistic guess, and add a 20% safety margin. An undersized
wakeup fires before the job finishes, wasting a session on a re-entry that can
do nothing but write another wakeup file.

```json
{
  "subtask_id": 3,
  "wakeup_at": "2026-07-03T23:20:00Z",
  "background_command": "python scripts/run_verification.py --output results/",
  "expected_artifact": "results/summary.jsonl",
  "progress_log_path": "results/job.log"
}
```

- `subtask_id`: your current subtask ID
- `wakeup_at`: ISO 8601 timestamp when the process should be done
- `background_command`: the command you ran (informational)
- `expected_artifact`: the file you expect the process to produce (inside the worktree)
- `progress_log_path`: the job's own log file, relative to the worktree root.
  Include it whenever the job writes one — the orchestrator periodically
  checks this file's freshness while you're asleep and re-enters you early if
  it goes stale, instead of always waiting out the full `wakeup_at` window.

Then end your session normally. The orchestrator re-enters you at `wakeup_at`
with a `⚠️ WAKEUP RE-ENTRY` header. On re-entry:
- Check if the artifact exists and is complete. If it is: verify it, git add,
  commit, and mark the subtask done.
- If the artifact is missing or incomplete, check whether the detached process
  (via its PID file) is still alive:
  - **Still running**: read its latest reported progress, write an updated
    `subtask_wakeup-st<ID>.json` with a new `wakeup_at`, and end again.
  - **Crashed or exited with error**: do NOT write another wakeup file.
    Write a `subtask_blocked-st<ID>.json` (see "When you've root-caused a
    defect and retrying won't help" below) instead of just narrating the
    failure — that's what actually fails the task immediately, rather than
    waiting out the remaining wakeup-attempt budget.

**If you diagnose and fix a real blocker before relaunching** (a compile error, a
contaminated checkout, a bug in your own tooling), state the new `background_command`
in your fresh `subtask_wakeup-st<ID>.json` rather than reusing the old one verbatim —
the orchestrator treats a materially different command on re-entry as evidence of
genuine progress and resets the wakeup attempt budget instead of charging the fix
against the same 3-attempt cap as a job that simply needed more time. Reusing the
exact same command when nothing actually changed still counts as a normal attempt.

Use `$TEAMAI_SPEC_DIR` to resolve the path — your cwd is the worktree, not
the project root.

### When you've root-caused a defect and retrying won't help

If your investigation concludes that this subtask cannot succeed as planned —
an earlier subtask's change was never actually made despite being marked
`completed: true`, a precondition the spec assumed doesn't hold, or any other
defect that a code fix (possibly in a *different* subtask) must resolve
before this one can — do NOT just explain that in your summary and end the
session. A summary is prose; nothing reads it before the orchestrator decides
what happens next. Write `subtask_blocked-st<ID>.json` (`<ID>` = your current
subtask ID) to `$TEAMAI_SPEC_DIR` instead:

```json
{
  "reason": "Subtask #1 (CS-1) was never actually implemented despite plan.json marking it completed — Chord.containsPitch is byte-identical to the pre-task baseline. This subtask's own acceptance gate (AC-S3) can't pass until that fix lands.",
  "blocking_subtask_id": 1
}
```

- `reason`: a specific, evidence-backed explanation — what you checked and
  what you found, not a guess. This becomes the QA report's failure note.
- `blocking_subtask_id`: optional — the id of the subtask whose defect
  actually needs fixing, if you traced the root cause to one.

This immediately fails the task (skipping any further retries of this
subtask) instead of leaving the orchestrator to eventually reach the same
conclusion on its own via an unrelated cap — burning a session that will only
re-verify what you already verified. Only use this when you've done the
investigation and are confident retrying is pointless; if there's a real
chance a fresh session (or waiting on a background job) could still resolve
this, use the wakeup mechanism above or just end normally instead.
