# Spec: ScheduleWakeup-Aware Subtask State

**Date:** 2026-07-03

**Status:** Draft

## Problem

When an engineer starts a long-running background process (sweep, benchmark, data pipeline) and the session budget ends before it completes, the orchestrator has no concept of "background work pending." It treats the session ending as subtask completion and advances to the next subtask — even though the deliverable file was never created.

**Exhibit (task 437920fa):** Subtask 3 required a 100-minute Python sweep producing `docs/melody-optimizer-analysis.md`. The sweep output was 0 bytes when the session started (Python only flushes its 8KB buffer when full or the process exits). The engineer correctly identified the issue, scheduled a `ScheduleWakeup` for 23:20, and ended the session. The orchestrator marked subtask 3 complete. Subtask 4 then added cross-references to a file that didn't exist.

## Design

### Signal mechanism: `subtask_wakeup.json`

When an engineer session needs to end before a background process completes, the engineer writes a `.teamai/{taskId}/subtask_wakeup.json` file before ending the session:

```json
{
  "subtask_id": 3,
  "wakeup_at": "2026-07-03T23:20:00Z",
  "background_command": "python sweep.py --output sweep-results/",
  "expected_artifact": "sweep-results/summary.jsonl"
}
```

The `implement.md` command template instructs the engineer to write this file when scheduling a wakeup:

> If a background script won't finish before your session budget ends, write a `subtask_wakeup.json` to `$TEAMAI_SPEC_DIR/subtask_wakeup.json` (the `.teamai/{taskId}/` directory — use the `$TEAMAI_SPEC_DIR` environment variable since your cwd is the worktree, not the project root) with `subtask_id`, `wakeup_at` (ISO 8601), `background_command`, and `expected_artifact`. Then end your session normally. The orchestrator will re-enter this subtask after the wakeup time.

`background_command` is purely informational — it helps the re-entered engineer understand what was running. The orchestrator only uses `subtask_id`, `wakeup_at`, and `expected_artifact`.

### Orchestrator detection

After `waitForCompletion` resolves and `killSession` is called, the orchestrator checks for `subtask_wakeup.json` in the spec directory:

```
{specPath}/subtask_wakeup.json  (i.e., .teamai/{taskId}/subtask_wakeup.json)
```

If the file exists:

1. Read and parse the wakeup data
2. Do NOT add this subtask to `completedIds`
3. Store all wakeup data in pipeline state: set `wakeupUntil`, `wakeupSubtaskId`, `wakeupCommand`, `wakeupArtifact`
4. Increment `pipeline.wakeupAttemptCount` (for the circuit breaker)
5. Log: `[WAKEUP] Subtask {id} wakeup scheduled for {wakeup_at} (attempt {wakeupAttemptCount}) — background process: {command}`
6. Broadcast a `phase-change` event so the UI shows the countdown
7. **Pause the ENTIRE implement phase** — do NOT advance to later subtasks or groups. Later subtasks often depend on this subtask's output (e.g., subtask 4 references a file created by subtask 3). Running them before the artifact exists would produce broken references.
8. Schedule a `setTimeout` for the wakeup time (reusing the `handleRateLimit` pattern — see below)

The wakeup file is deleted when the orchestrator processes it (to prevent stale re-entry).

> **2026-09-26 addition (bind-mount sync race):** in container mode, a coder
> session's writes only become visible on the host once the bind mount
> syncs — not instantaneous, particularly on Windows/Docker Desktop, worse
> under I/O contention. `killSession` only waits for the CLI process itself
> to exit, not for the mount to catch up, so a scan taken immediately after
> can race a wakeup file the coder definitely wrote: the scan finds nothing,
> the subtask is wrongly treated as having failed deliverable verification,
> and — since this can repeat across every re-entry — the task can fail
> outright well before the coder's own wakeup budget is exhausted. Found on
> task `add-per-constraint-soft-score-attributio`'s third failure: subtask
> 15 wrote `subtask_wakeup-st15.json` (confirmed via its own session log)
> and ended cleanly, but the scan run immediately after found nothing, twice.
> The scan now retries (up to 4 times, `wakeupScanRetryDelayMs` apart —
> default 2000ms in production, 0 under `vitest`) before concluding no
> wakeup was scheduled, but only when a miss would actually change the
> outcome: a re-entry session (already mid-wakeup-cycle) or a subtask with a
> `files_to_create` check about to run. A subtask with neither skips
> verification anyway, so a slow-to-sync (nonexistent) wakeup file costs it
> nothing. See `implement.ts`'s `scanWakeupFiles` retry loop.

### Wakeup timer

The wakeup timer follows the same pattern as `handleRateLimit` in `rate-limit.ts`:

1. Calculate waitMs from `wakeup_at` - `Date.now()`, capped at `MAX_DELAY_MS`
2. Store `wakeupUntil` on the task record so the UI shows the countdown
3. After the timeout fires:
   a. Check the task hasn't been moved to a terminal phase (same `NO_RESUME_PHASES` guard)
   b. Re-enter `executePhase` at `implement`
   c. The implement phase detects `pipeline.wakeupSubtaskId` and filters `effectiveSubtasks` to ONLY that subtask:
      ```ts
      let effectiveSubtasks = plan.subtasks.filter(s => !s.completed);
      if (pipeline.wakeupSubtaskId != null) {
        effectiveSubtasks = effectiveSubtasks.filter(s => s.id === pipeline.wakeupSubtaskId);
      }
      ```
      This ensures subtasks 4+ (never started, also `!completed`) are NOT re-run — they're intentionally deferred until the wakeup subtask's artifact is committed.
   d. After the wakeup subtask completes and is marked done, the orchestrator clears the wakeup state fields from the pipeline and bounces back into the implement phase:
      ```ts
      pipeline.wakeupSubtaskId = undefined;
      pipeline.wakeupUntil = undefined;
      pipeline.wakeupCommand = undefined;
      pipeline.wakeupArtifact = undefined;
      // NOTE: wakeupAttemptCount is NOT cleared here — it resets to 0 only when
      // the artifact is successfully committed (handled in AC 8 / the
      // nested-wakeup edge case).
      deps.advancePhase(pipeline, 'implement');
      await deps.executePhase(pipeline);
      return;
      ```
      The next pass finds no `wakeupSubtaskId`, so `effectiveSubtasks` reverts to all `!completed` subtasks — subtasks 4+ are processed naturally.
4. On re-entry, the engineer session gets a wakeup-specific prompt injected before the normal subtask prompt:
   ```text
   ⚠️ WAKEUP RE-ENTRY
   Your previous session was paused to wait for a background process.
   Background command: {pipeline.wakeupCommand}
   Expected artifact to verify: {pipeline.wakeupArtifact}

   Check if the artifact exists and is complete. If it is: verify it, git add, commit,
   and mark the subtask done. If it's missing or incomplete, first check whether the
   background process is still running:
   - If the process is still running → estimate remaining time, write an updated
     subtask_wakeup.json with a new wakeup_at, and end.
   - If the process has crashed or exited with an error → do NOT write another wakeup
     file. Report the failure immediately so the task can advance to failed without
     wasting the remaining wakeup attempts.
   ```
   This prompt context is built from `pipeline.wakeupCommand` and `pipeline.wakeupArtifact` (not from the file, which was already deleted).
   a. The engineer checks if the artifact exists and is complete
   b. If the artifact is complete: verifies it, commits it, marks subtask done
   c. If the artifact is still missing/incomplete: writes an updated `subtask_wakeup.json` with a new `wakeup_at` and ends

### Integration with `files_to_create`

The `files_to_create` verification already handles the case where deliverable files are missing — it skips `completedIds.push` and leaves the subtask incomplete. With wakeup support, there are now TWO reasons a subtask might stay incomplete:

| Reason | Detection | Resolution |
|--------|-----------|------------|
| Missing deliverable | `files_to_create` + `existsSync` at session end | Subtask stays incomplete, re-runs on next implement |
| Background work pending | `subtask_wakeup.json` exists at session end | Orchestrator schedules wakeup, re-enters subtask |

They compose cleanly: if `subtask_wakeup.json` exists, the wakeup path takes priority — `files_to_create` verification is SKIPPED entirely for that subtask (the re-entered engineer handles verification). If `subtask_wakeup.json` does NOT exist but `files_to_create` entries are missing, the normal verification path logs `[VERIFY]` warnings and keeps the subtask incomplete.

### Pipeline state additions

`ImplementPipeline` gets five new optional fields. `wakeupCommand` and `wakeupArtifact` are needed because the orchestrator deletes `subtask_wakeup.json` immediately after reading it — the context must be preserved in-memory for prompt injection on re-entry. `wakeupAttemptCount` tracks nested wakeup attempts for the circuit breaker:

```ts
interface ImplementPipeline {
  // ...existing fields...
  /** ISO timestamp — wakeup scheduled until this time */
  wakeupUntil?: string;
  /** Subtask ID that triggered the wakeup */
  wakeupSubtaskId?: number;
  /** Background command the engineer was running (informational, injected into re-entry prompt) */
  wakeupCommand?: string;
  /** Artifact the engineer should verify on re-entry (injected into re-entry prompt) */
  wakeupArtifact?: string;
  /** Consecutive wakeup attempts for the current subtask (resets on successful artifact commit) */
  wakeupAttemptCount?: number;
}
```

The `task.json` task record also gets `wakeupUntil?: string` and `wakeupSubtaskId?: number` (same pattern as `rateLimitedUntil` — these fields enable crash recovery to restore both the timer and the subtask isolation filter). `wakeupAttemptCount` is NOT persisted to the task record (it resets on crash, which is acceptable: a crash is not a wakeup failure).

## Acceptance Criteria

1. **Engineer writes wakeup file before session end** — When a background process won't finish before the session budget, the engineer writes `subtask_wakeup.json` to `.teamai/{taskId}/` with `subtask_id`, `wakeup_at`, `background_command`, and `expected_artifact`. The session ends normally. The file is NOT committed to git (it lives in `.teamai/`).

2. **Orchestrator detects wakeup file after session** — After `killSession`, the orchestrator checks for `subtask_wakeup.json`. If present, it reads the wakeup data and does NOT add the subtask to `completedIds`.

3. **Subtask stays incomplete** — The subtask's `completed` field remains `false` in `plan.json`. The implement phase does NOT advance to the next subtask or phase; it pauses.

4. **Wakeup timer fires at scheduled time** — The orchestrator schedules a `setTimeout` for `wakeup_at`. The UI shows a countdown via `wakeupUntil` on the task record.

5. **Wakeup re-enters implement phase with isolation** — When the timer fires (and the task hasn't been moved to a terminal phase), the orchestrator calls `executePhase` at `implement`. The implement phase detects `pipeline.wakeupSubtaskId` and filters `effectiveSubtasks` to ONLY that subtask. Other `!completed` subtasks (never started, deferred) are excluded. After the wakeup subtask completes, the orchestrator clears the `wakeup*` pipeline fields and bounces back into the implement phase — the next pass processes the remaining deferred subtasks naturally.

6. **Engineer receives wakeup context in prompt** — The re-entered session receives a `⚠️ WAKEUP RE-ENTRY` header injected before the normal subtask prompt. This header includes the background command and expected artifact (read from `pipeline.wakeupCommand` and `pipeline.wakeupArtifact` — the `subtask_wakeup.json` file was already deleted). The engineer checks if the artifact exists and is complete.

7. **Artifact exists and is complete** — If the artifact file exists and passes verification (non-zero size, valid format, expected record count), the engineer commits it and marks the subtask as done. The pipeline advances normally.

8. **Artifact is still missing or incomplete** — If the sweep hasn't finished, the output is truncated, or the file doesn't exist, the engineer first checks whether the background process is still running. If it's still running: the engineer estimates remaining time, writes an updated `subtask_wakeup.json` with a new `wakeup_at`, and ends. If the process crashed or exited with an error: the engineer does NOT write a new wakeup file — the task fails immediately (no point waiting for an artifact that will never appear). The orchestrator increments `pipeline.wakeupAttemptCount` each time it detects a new `subtask_wakeup.json` for the same subtask. After 3 consecutive wakeup attempts with no artifact, the subtask is marked as blocked and the task advances to `failed` with a clear message. `wakeupAttemptCount` resets to 0 when the artifact is successfully committed.

9. **Wakeup composes with rate limits** — If the re-entered session hits a rate limit during the artifact verification, `handleRateLimit` pauses and resumes normally. The `wakeup*` pipeline state fields are NOT cleared until the wakeup subtask completes successfully — this way, rate-limit retries don't lose the isolation filter or re-entry prompt context. The `wakeupUntil` timestamp is ignored once the timer fires (it's only used to schedule the initial `setTimeout`).

10. **Wakeup composes with `files_to_create`** — If `subtask_wakeup.json` exists, `files_to_create` verification is SKIPPED entirely for that subtask (the re-entered engineer handles artifact verification via the wakeup prompt). If `subtask_wakeup.json` does NOT exist, `files_to_create` verification works as before.

11. **implement.md template updated** — The `Long-Running Verification Scripts > When the sweep output is a committed artifact` section includes instructions for writing `subtask_wakeup.json` when the session budget won't cover the sweep duration.

12. **Wakeup file cleanup** — The orchestrator deletes `subtask_wakeup.json` immediately after reading it (at session end, when the wakeup timer is scheduled). The pipeline state (`wakeupUntil`, `wakeupSubtaskId`, `wakeupCommand`, `wakeupArtifact`) is stored in memory and persisted to the task record, so the timer fires independently of the file. A stale wakeup file from a previous run is harmless — it's read, processed, and deleted.

13. **Crash recovery restores wakeup timer** — If the TeamAI process crashes while a wakeup is scheduled, `autoResumeInterruptedTasks` reads `wakeupUntil` from the task record and re-schedules the wakeup on startup. Same pattern as `rateLimitedUntil`. The `wakeupSubtaskId` is persisted in the task record alongside `wakeupUntil` so the implement phase can re-apply the isolation filter on re-entry.

## Edge Cases

### Nested wakeups (artifact still not ready)

If the wakeup fires and the sweep still hasn't finished, the engineer checks whether the background process is still running. If it's still running: the engineer writes an updated `subtask_wakeup.json` with a new `wakeup_at`. If the process crashed: the engineer does NOT write a new wakeup file — the task fails immediately. The orchestrator increments `pipeline.wakeupAttemptCount` each time it detects a new wakeup file for the same subtask — UNLESS the new file's `background_command` differs from the one recorded on the previous wakeup, in which case the counter resets to 1 instead (see ADR 004's 2026-09-26 addition): a materially different command means the engineer fixed a real blocker before relaunching, which is forward progress rather than a stalled retry, and earns a fresh attempt budget. The counter resets to 0 when the artifact is successfully committed. After 3 consecutive wakeup attempts with no artifact completion and no command change, the task fails.

### Wakeup during QA rework

> **Superseded by the 2026-09-27 addition below** — a QA-rework (cleanup) coder session
> can legitimately need to start a long verification job just like a first-pass session,
> and the wakeup-file check is NOT gated on `hasQaFeedback`. The original claim here
> (wakeup only relevant for first-pass implement) predates that fix and was wrong even
> before wakeup was generalized beyond implement.

### Wakeup in parallel subtask groups

If subtasks run in parallel groups (`parallel_group` in `plan.json`) and a subtask in group N hits a wakeup, the entire implement phase pauses — including sibling subtasks in the same group. When the wakeup fires and the implement phase re-enters, only the wakeup-pending subtask is re-run. Sibling subtasks in the same group that were already completed stay completed. Subtasks in later groups (N+1, N+2) are deferred until the wakeup subtask's artifact is committed.

If multiple subtasks in the SAME group each write `subtask_wakeup.json`, the orchestrator uses the earliest `wakeup_at` as the timer target. When that timer fires and the first wakeup subtask completes, the orchestrator re-checks for any remaining wakeup files from sibling subtasks and schedules the next wakeup if needed.

### Planner role populates `files_to_create`

The planner should populate `files_to_create` for any subtask whose acceptance criteria require a committed file artifact (benchmark output, sweep results, data pipeline output, generated documentation). This feeds naturally into the wakeup flow: the `expected_artifact` in `subtask_wakeup.json` should match one of the entries in the plan's `files_to_create`. The `plan.md` command template should include this guidance in its Rules section.

### Wakeup file format errors

If `subtask_wakeup.json` exists but can't be parsed, the orchestrator logs `[WAKEUP] Malformed subtask_wakeup.json — treating as missing` and falls through to `files_to_create` verification.

### Wakeup time in the past

If `wakeup_at` is already in the past when the orchestrator reads it, the wakeup fires immediately (0ms delay). This handles the case where the session ended just before the wakeup time.

To prevent tight loops (e.g., engineer keeps writing past timestamps), a minimum 5-minute delay is enforced: if `wakeup_at` is more than 5 minutes in the past, `waitMs` is set to 5 minutes rather than 0. Additionally, each immediate-fire wakeup (where `wakeup_at` was in the past) counts toward the `wakeupAttemptCount` circuit breaker — after 3 immediate-fire wakeups with no artifact, the task fails. This prevents infinite retry loops when the engineer misestimates.

### Process crash during wakeup wait

If the TeamAI process crashes while a wakeup is scheduled, the `autoResumeInterruptedTasks` recovery hook reads `wakeupUntil` from the task record and re-schedules the wakeup on startup. Same pattern as `rateLimitedUntil`.

## Implementation Plan

### Phase 1: Core (implement.ts + orchestrator.ts)
- Add `wakeupUntil`, `wakeupSubtaskId`, `wakeupCommand`, `wakeupArtifact`, `wakeupAttemptCount` to pipeline state
- Add `subtask_wakeup.json` detection after `killSession` (read, store fields, delete file, increment `wakeupAttemptCount`)
- Add wakeup timer (setTimeout-based, same pattern as `handleRateLimit`; minimum 5-minute delay for past timestamps)
- Add `effectiveSubtasks` isolation filter when `wakeupSubtaskId` is set
- Add `⚠️ WAKEUP RE-ENTRY` prompt injection in the subtask prompt builder (with "check if process is still running" guidance)
- After wakeup subtask completes: clear `wakeup*` fields, bounce back to implement
- Skip `files_to_create` verification when wakeup file exists

### Phase 2: Command template (implement.md)
- Add `subtask_wakeup.json` writing instructions to `Long-Running Verification Scripts` section

### Phase 3: Recovery (recovery.ts)
- Add `wakeupUntil` to crash recovery (`autoResumeInterruptedTasks`)

### Phase 4: UI (kanban-board.tsx, task-detail.tsx)
- Show wakeup countdown in the task card (same pattern as rate-limit countdown)

## 2026-09-27 addition: generalized to spec, plan, and qa-review

**Exhibit:** task `fix-off-by-one-in-melodycontext-accented`. An analyst session (spec
phase) launched a multi-hour deterministic verification run, correctly said it would
wait for it to finish, and then its turn simply ended — headless pipeline sessions have
no interactive `ScheduleWakeup`-style capability to actually wait across turns.
`runSpecPhase` had no wakeup detection at all (this ADR's Phase 1 only touched
`implement.ts` and `orchestrator.ts`'s scheduling/timer half, which was already
phase-agnostic — see below), so the missing `spec.md` was treated as a hard failure and
the task was parked for human review, discarding a legitimate job that was still
running.

**What was already generic:** `_scheduleWakeup`/`_fireWakeup` (orchestrator.ts) and the
`wakeup*` fields on `TaskPipeline` (types.ts) never depended on the phase being
`implement` — they operate on the generic pipeline and just re-invoke `executePhase`,
whatever phase that currently is. Same for crash recovery (`autoResumeInterruptedTasks`)
and the stale-progress-log early-wake sweep in `recovery.ts`. Only the DETECTION half —
scanning for the file, parsing it, tracking attempt counts, building the re-entry
prompt — lived exclusively inside `implement.ts`'s per-subtask loop.

**What changed:** the detection primitives were extracted into
`src/lib/orchestrator/wakeup.ts` (parse/scan/attempt-count/staleness/prompt-building,
plus a `resolvePhaseWakeup` orchestration function for the single-session phases) and
wired into `runSpecPhase`, `runPlanPhase`, and `runQaReview` alongside `implement.ts`
(refactored to call the same primitives instead of its own inline copies — behavior
unchanged, verified against the full existing wakeup test suite). Single-session phases
use one fixed filename, `phase_wakeup.json` — no subtask multiplicity to disambiguate,
so implement's per-subtask `subtask_wakeup-st<ID>.json` convention and "earliest wakeup
wins across parallel subtasks" logic don't apply. A new `FailureReason` value,
`wakeup-exhausted`, covers the circuit-breaker failure path for these phases (kept
distinct from `implement-failure`, which stays implement-specific and unchanged).

**qa-review-specific fix alongside the generalization:** `runQaReview` incremented
`pipeline.qaAttempt`/`qaRoundCount` unconditionally at the top of every invocation. Left
unguarded, a wakeup re-entry — which re-invokes `runQaReview` from the top to continue
the SAME attempt's background check — would burn a QA-attempt-budget increment purely
on wakeup cycles, before the reviewer ever reached a fresh verdict. The increment is now
skipped when `wakeupCommand` is already set at entry (i.e., this invocation is a
re-entry, not a fresh attempt).

**Terminology note:** earlier drafts of this generalization used "sweep" throughout
(Sample-project's term for a parameter sweep) — genericized to "script"/"job"/"background
process" in code comments and command templates, since TeamAI itself is
project-agnostic. `expected_artifact`/`background_command`/`progress_log_path` always
described an arbitrary command; only the prose calling it a "sweep" was
Sample-project-specific.

**Also added while touching this area:** the command templates' "detach the job"
instructions now warn against relaunching or stopping multiple background jobs via a
command-line pattern match (`pkill -f <substring>`) instead of by recorded PID — a
substring broad enough to match every job's command line can also match the managing
session's own shell, killing the session that was trying to record what it just did.
Observed twice in the same live session (task `give-minor-mode-melodies-a-real-leading-`)
while this generalization was being scoped.
