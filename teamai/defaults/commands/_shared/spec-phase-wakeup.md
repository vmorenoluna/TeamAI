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
