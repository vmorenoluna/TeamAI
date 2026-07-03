# Spec: Verification Gate Failure Tracking

**Date:** 2026-07-03

**Status:** Draft

## Problem

The pipeline has two verification gates where failures are currently conflated with quality failures:

1. **Deliverable verification (`files_to_create`)**: After a subtask session ends, the orchestrator checks that expected deliverable files exist on disk. If they're missing, the subtask stays incomplete and re-runs next pass. But there's no cap on re-runs, no distinct re-entry prompt telling the engineer WHY the subtask is re-running, and no failure attribution — a subtask that loops 10 times on missing deliverables is indistinguishable from one that was simply never started.

2. **QA session timeout**: The QA reviewer has a 20-minute session budget. When it times out, the current code burns a `qaAttempt` and gates on `maxQaAttempts` — treating an infrastructure failure (agent got stuck) identically to a quality failure (code didn't pass review). A task that fails after 3 consecutive timeouts reports "max QA attempts reached" even though the code was never actually reviewed.

Both problems share the same root cause: **verification gate failures lack their own counters and circuit breakers, so they silently consume the quality failure budget (`qaAttempt`/`maxQaAttempts`).**

ADR 004 established the retry policy taxonomy: infrastructure failures (rate limits, timeouts) need separate counters from quality failures. This spec defines the concrete implementation for the two remaining infrastructure counters.

## Design

### Unified Philosophy

Both features follow the same circuit-breaker pattern established in ADR 002 (wakeup) and ADR 004 (retry policy):

| Aspect | Deliverable Verification | QA Timeout |
|--------|------------------------|-------------|
| **Failure type** | Infrastructure (internal) — engineer didn't produce expected files | Infrastructure (internal) — agent got stuck |
| **Counter** | `deliverableFailCounts: Record<number, number>` | `qaTimeoutCount: number` |
| **Cap** | 3 per subtask | 3 total |
| **Burns `qaAttempt`?** | No | No (decremented on catch) |
| **Re-entry prompt** | `⚠️ DELIVERABLE RE-VERIFICATION` header | `⚠️ QA TIMEOUT — RE-RUNNING` header (transparent to agent) |
| **Failure message** | "Subtask {id} failed deliverable verification 3 times" | "Task failed after 3 QA timeouts" |
| **Reset trigger** | Successful `files_to_create` pass | QA session completes (PASS or FAIL) without timing out |
| **Reset on spec revision?** | Yes | Yes |

### Feature 1: Deliverable Verification Circuit Breaker

#### Current behavior (baseline)

In `implement.ts`, after each subtask session ends:

```ts
if (subtask.files_to_create?.length) {
  for (const file of subtask.files_to_create) {
    if (!existsSync(path.join(cwd, file))) {
      skipCompletion = true;
      appendFileSync(logFile, `[VERIFY] Subtask ${subtask.id}: expected file/directory missing — ${file}\n`);
    }
  }
  if (skipCompletion) {
    appendFileSync(logFile, `[VERIFY] Subtask ${subtask.id} will remain incomplete — ...\n`);
  }
}
if (!skipCompletion) {
  completedIds.push(subtask.id);
}
```

When `skipCompletion` is true, the subtask stays incomplete. On the next implement pass, it re-runs with the standard subtask prompt — no indication that this is a re-verification, no cap on how many times it can re-run.

#### New pipeline state

`TaskPipeline` (and by extension `ImplementPipeline`) gets one new field:

```ts
interface TaskPipeline {
  // ...existing fields...
  /** Per-subtask counter of consecutive files_to_create failures.
   *  Key = subtask ID, value = consecutive failure count.
   *  Reset to 0 (entry deleted) when the subtask passes verification.
   *  Persisted to .pipeline_state.json for crash recovery. */
  deliverableFailCounts?: Record<number, number>;
}
```

#### Re-entry prompt injection

When a subtask with a non-zero `deliverableFailCounts` entry is about to run, the prompt builder injects a header before the normal subtask prompt:

```text
⚠️ DELIVERABLE RE-VERIFICATION (attempt {count}/3)

Your previous session for this subtask ended but the following required
deliverable files were NOT created:

  - path/to/missing-file.md
  - path/to/other-file.json

You MUST create these files before ending your session. If you cannot
create them (e.g., the task is impossible with the current spec), explain
why and the orchestrator will advance the task to failed.
```

The list of missing files is reconstructed from `subtask.files_to_create` — the same list that the planner populated and that the verification loop checked.

#### Verification logic changes

After the `existsSync` loop, if `skipCompletion` is true:

1. Increment `deliverableFailCounts[subtaskId]` (initialize to 1 if absent)
2. Log: `[VERIFY] Subtask {id} failed deliverable verification (attempt {count}/3) — missing: {files}`
3. If `deliverableFailCounts[subtaskId] >= 3`:
   - Write a `qa_report.json` with the failure (so completion summary can reference it):
     ```json
     {
       "overall": "FAIL",
       "criteria": [{
         "criterion": "Deliverable verification — missing files",
         "name": "Deliverable verification",
         "status": "FAIL",
         "notes": "Subtask {id} failed deliverable verification 3 times. Missing files: {list}"
       }]
     }
     ```
   - Advance to `failed`
   - **Do not** continue to the next subtask or group

When `skipCompletion` is false (all files found):
- Delete `deliverableFailCounts[subtaskId]` (reset counter)

#### Composition with wakeup

Per ADR 002 AC 10: if `subtask_wakeup.json` exists at session end, the orchestrator reads and deletes it immediately, then stores the wakeup data in pipeline state (`wakeupSubtaskId`, `wakeupUntil`, etc.). `files_to_create` verification is **skipped entirely** for that subtask — the wakeup path takes priority and the deliverable counter is not incremented. At implementation time, the skip is gated on `pipeline.wakeupSubtaskId != null` (not file existence, since the file was already deleted). The wakeup circuit breaker (`wakeupAttemptCount`, cap 3) handles the retry budget for wakeup scenarios. Once the wakeup completes and the artifact is committed, the normal `files_to_create` check runs — this is the first time `deliverableFailCounts` gets a meaningful check. If the file STILL doesn't exist after wakeup completion, the deliverable counter starts ticking.

#### Persistence

`deliverableFailCounts` is included in `.pipeline_state.json` (via `savePipelineState`) and restored on crash recovery (via `restorePipelineState`). The counter survives crashes: if the process dies after 2 deliverable failures, the next run picks up at attempt 3.

### Feature 2: QA Timeout Counter

Per ADR 004 Category 2, implemented here.

#### Current behavior (baseline)

In `qa-review.ts`, the catch block for timeouts:

```ts
} catch (err) {
  if (err instanceof RateLimitError) {
    pipeline.qaAttempt--;
    throw err;
  }
  processManager.killSession(sessionId);
  // ...write timeout report...
  if (pipeline.qaAttempt >= pipeline.maxQaAttempts) {
    deps.writeCompletionSummary(pipeline);
    deps.advancePhase(pipeline, 'failed');
  } else {
    deps.advancePhase(pipeline, 'qa-review');
    deps.savePipelineState(pipeline);
    await deps.executePhase(pipeline);
  }
  return;
}
```

The `pipeline.qaAttempt >= pipeline.maxQaAttempts` check burns quality budget on timeouts.

#### New pipeline state

`TaskPipeline` (and by extension `QaReviewPipeline`) gets one new field:

```ts
interface TaskPipeline {
  // ...existing fields...
  /** Consecutive QA session timeouts. Resets to 0 when a QA session
   *  completes (PASS or FAIL) without timing out. Separate from
   *  qaAttempt — timeouts are infrastructure failures, not quality failures. */
  qaTimeoutCount?: number;
}
```

#### Timeout handling changes

Replace the current `if (pipeline.qaAttempt >= pipeline.maxQaAttempts)` gate with:

```ts
// On timeout:
pipeline.qaTimeoutCount = (pipeline.qaTimeoutCount || 0) + 1;
pipeline.qaAttempt--;  // timeouts don't consume quality budget

if (pipeline.qaTimeoutCount >= 3) {
  // Write timeout-specific completion summary
  deps.writeCompletionSummary(pipeline);  // updated to include timeout context
  deps.advancePhase(pipeline, 'failed', {
    failReason: 'timeout',
    timeoutCount: pipeline.qaTimeoutCount,
  });
} else {
  deps.advancePhase(pipeline, 'qa-review');
  deps.savePipelineState(pipeline);
  await deps.executePhase(pipeline);
}
```

Note: `qaAttempt` is incremented at the top of `runQaReview` (line 90), then decremented here — net zero. Same pattern as the rate-limit decrement at line 196.

#### Evaluation order

The timeout cap check (`qaTimeoutCount >= 3`) is evaluated **before** the quality cap check. This means:

1. If `qaTimeoutCount` hits 3, the task fails with a timeout message — even if `qaAttempt < maxQaAttempts`
2. If the QA session completes (PASS or FAIL) but fails quality checks, `qaTimeoutCount` resets to 0 and the quality cap (`qaAttempt >= maxQaAttempts`) applies
3. The timeout cap is the first gate; the quality cap is the fallback

#### Completion summary

When the timeout cap is exceeded, `writeCompletionSummary` produces a timeout-specific message:

```
Task failed after 3 QA timeouts — agent was unable to complete review
within the session budget. Consider:
- Increasing the session budget (currently 20 minutes)
- Simplifying the spec so QA has less to review
- Running QA manually to identify what's taking too long
```

This is distinct from the quality-failure completion summary ("Task failed after {N} QA attempts with unresolved failures...") so users can immediately see whether the task failed due to infrastructure or code quality.

#### Counter reset

`qaTimeoutCount` resets to 0 when:
- A QA session completes (PASS or FAIL) **without timing out** — the counter only tracks consecutive timeouts
- The spec is revised (`reviseSpec` flow — same reset hook as `qaAttempt`)
- A human rejects the task (`rejectTask` flow — same reset hook)

#### Persistence

`qaTimeoutCount` is included in `.pipeline_state.json` and restored on crash recovery. Same pattern as `qaAttempt`.

### Counter Reset Hook (Unified)

Both counters share reset triggers. A single reset point ensures consistency:

| Trigger | `qaAttempt` | `qaTimeoutCount` | `deliverableFailCounts` | `wakeupAttemptCount` |
|---------|:-----------:|:----------------:|:-----------------------:|:--------------------:|
| Spec revision | Reset to 0 | Reset to 0 | Reset to `{}` | Reset to 0 |
| Human rejection | Reset to 0 | Reset to 0 | Reset to `{}` | Reset to 0 |
| Subtask passes `files_to_create` | — | — | Delete entry (pass) | — |
| QA completes (no timeout) | +1 or no change | Reset to 0 | — | — |

### Pipeline State Persistence

`.pipeline_state.json` gains two new optional fields:

```json
{
  "taskId": "...",
  "phase": "qa-review",
  "qaAttempt": 2,
  "qaTimeoutCount": 1,
  "deliverableFailCounts": { "3": 2 },
  "...existing fields..."
}
```

Both are restored in `restorePipelineState` and included in the `runTask` saved-state merge.

### Counter Manipulation Table (Complete)

Extending the ADR 004 table:

> **Note on `qaAttempt` values:** `qaAttempt` is always incremented at the top of `runQaReview` (line 90). "No change" means the error handler decrements it back — net effect is zero. "+1" means the increment is kept (not reverted). See ADR 004 for the full explanation of the three-tier retry taxonomy.

| Event | `qaAttempt` | `qaTimeoutCount` | `deliverableFailCounts` | `wakeupAttemptCount` |
|-------|:-----------:|:----------------:|:-----------------------:|:--------------------:|
| QA session completes (PASS) | (no change) | Reset to 0 | — | — |
| QA session completes (FAIL) | +1 | Reset to 0 | — | — |
| Rate limit hit | −1 (decremented) | (no change) | (no change) | (no change) |
| QA session timeout | (no change) | +1 | — | — |
| Subtask passes `files_to_create` | — | — | Delete entry (pass) | — |
| Subtask fails `files_to_create` (attempt < 3) | — | — | +1 for subtask ID | — |
| Subtask fails `files_to_create` (attempt ≥ 3) | — | — | — (task fails) | — |
| Wakeup re-entry, artifact still missing | — | — | — | +1 |
| Wakeup re-entry, artifact committed | — | — | — | Reset to 0 |
| Spec revision | Reset to 0 | Reset to 0 | Reset to `{}` | Reset to 0 |
| Human rejection | Reset to 0 | Reset to 0 | Reset to `{}` | Reset to 0 |

## Acceptance Criteria

### Deliverable Verification

1. **Counter tracks per-subtask** — `deliverableFailCounts` is a `Record<number, number>`. Each failed `files_to_create` check for subtask N increments `deliverableFailCounts[N]`. Different subtasks' counters are independent — subtask 3 failing doesn't affect subtask 5's counter.

2. **Re-entry prompt identifies missing files** — When a subtask re-runs and `deliverableFailCounts[subtaskId] > 0`, the prompt includes a `⚠️ DELIVERABLE RE-VERIFICATION` header listing which files were missing in the previous session. The list comes from `subtask.files_to_create` (same array the planner populated and the verification loop checked).

3. **Circuit breaker at 3** — After 3 consecutive `files_to_create` failures for the same subtask, the task advances to `failed` with a `qa_report.json` documenting which files were never created. The pipeline does NOT continue to the next subtask or group.

4. **Counter resets on pass** — When a subtask passes `files_to_create` verification (all files exist), `deliverableFailCounts[subtaskId]` is deleted. The counter only tracks **consecutive** failures.

5. **No counter interaction with wakeup** — If `subtask_wakeup.json` exists, `files_to_create` verification is skipped entirely (per ADR 002). `deliverableFailCounts` is not incremented during wakeup cycles. After wakeup resolution, normal `files_to_create` verification resumes.

6. **Deliverable verification operates identically during QA rework** — During QA rework (`hasQaFeedback` is true), the deliverable verification counter still tracks failures and `skipCompletion` still blocks `completedIds.push` — the counter operates exactly as it does in first-pass mode. The QA feedback provides additional context for the engineer but does not alter the verification logic. If `files_to_create` entries are missing during rework, the counter increments normally.

7. **Crash recovery preserves counters** — `deliverableFailCounts` is persisted to `.pipeline_state.json`. If the process crashes between subtask sessions, the counter survives and the next run continues from the correct attempt number.

8. **Counter resets on spec revision** — When the spec is revised (via `reviseSpec`), `deliverableFailCounts` resets to `{}` along with all other retry counters. A fresh spec gets a fresh deliverable budget.

### QA Timeout

9. **Separate counter from `qaAttempt`** — `qaTimeoutCount` is incremented on timeout, `qaAttempt` is decremented back to its pre-call value. A timeout does not consume the quality failure budget.

10. **Cap of 3 timeouts** — After 3 consecutive QA timeouts, the task advances to `failed` with a timeout-specific completion summary. The message clearly distinguishes timeout failure from quality failure.

11. **Evaluation order: timeout cap before quality cap** — If `qaTimeoutCount >= 3`, the task fails with a timeout message even if `qaAttempt < maxQaAttempts`. The timeout cap is checked first; the quality cap is the fallback.

12. **Counter resets on successful QA completion** — When a QA session completes (PASS or FAIL) without timing out, `qaTimeoutCount` resets to 0. The counter only tracks **consecutive** timeouts.

13. **Counter resets on spec revision or human rejection** — Same reset hook as `qaAttempt`. A new spec or manual rejection gives the pipeline a fresh timeout budget.

14. **Crash recovery preserves counter** — `qaTimeoutCount` is persisted to `.pipeline_state.json` and restored on crash recovery.

### Cross-cutting

15. **All counters reset together on human intervention** — Spec revision and human rejection reset `qaAttempt`, `qaTimeoutCount`, `deliverableFailCounts`, and `wakeupAttemptCount` in a single reset point (not scattered across multiple files).

16. **Pipeline state persistence includes all new fields** — `savePipelineState` writes `qaTimeoutCount`, `deliverableFailCounts` (and existing `wakeupAttemptCount` if present). `restorePipelineState` reads them back.

17. **TypeScript types updated** — `TaskPipeline`, `ImplementPipeline`, `QaReviewPipeline`, and `.pipeline_state.json` types all include the new optional fields.

## Edge Cases

### Deliverable file created but in wrong location

If the engineer creates the file but at a different path than `files_to_create` specifies, the `existsSync` check fails. The engineer sees the re-entry prompt listing the expected path and can fix the location. This is a normal deliverable verification failure — the counter increments.

### `files_to_create` paths are relative to worktree root

The current code uses `path.join(cwd, file)` where `cwd` is the worktree root (or per-subtask worktree). If the planner specifies absolute paths in `files_to_create`, the behavior is undefined. The plan.md command template should explicitly state that `files_to_create` paths are relative to the repository root.

### Subtask has `files_to_create` but engineer never starts the work

If the engineer session ends without starting (e.g., immediate rate limit), `files_to_create` verification still runs. The files won't exist, so `skipCompletion` is true and the counter increments. This is correct — the subtask ran and didn't produce deliverables.

However, if the session never started at all (session creation failed), `files_to_create` verification doesn't run (the code is inside the `try` block that also handles session creation). The subtask stays incomplete and re-runs without incrementing the counter. This is correct — no work was attempted.

### Concurrent timeout and deliverable failure

These can't happen concurrently — deliverable verification runs in the implement phase, timeout tracking runs in the QA review phase. They're sequential in the pipeline.

### Subtask re-runs for non-deliverable reasons

If a subtask re-runs because it was never completed (not because of `files_to_create` failure), `deliverableFailCounts` is not incremented. The counter only increments when `skipCompletion` is true AND `subtask.files_to_create` was non-empty and at least one file was missing.

### Engineer creates some files but not all

If `files_to_create` lists 3 files and the engineer creates 2 (1 still missing), `skipCompletion` is true (ANY missing file triggers it). The counter increments normally. The re-entry prompt lists ALL files from `files_to_create` — both created and missing — so the engineer can verify which one needs attention. The existing files are harmless (the `existsSync` check for the missing one still fails).

### `deliverableFailCounts` entry for a subtask that was later deleted from the plan

If the plan is regenerated and a subtask ID no longer exists, stale entries in `deliverableFailCounts` are harmless — the verification loop only checks entries for subtasks that exist in the current plan. No explicit cleanup needed.

### QA timeout during a session that was already rate-limited

If a QA session hits a rate limit, resumes, and then times out: the rate limit decremented `qaAttempt` (net zero), and the timeout increments `qaTimeoutCount`. These are independent. The counters don't interfere.

## Implementation Plan

### Phase 1: Pipeline state types + persistence

- Add `deliverableFailCounts?: Record<number, number>` and `qaTimeoutCount?: number` to `TaskPipeline` in `orchestrator.ts`
- Add both fields to `ImplementPipeline` in `implement.ts`
- Add `qaTimeoutCount` to `QaReviewPipeline` in `qa-review.ts`
- Update `savePipelineState` in `pipeline-state.ts` to include both new fields
- Update `restorePipelineState` in `pipeline-state.ts` to restore both new fields.
  **Implementation note:** `deliverableFailCounts` is a `Record<number, number>` in TypeScript. When serialized to JSON, numeric keys become strings (`"3"` not `3`). When restoring, cast `Object.keys()` results to `Number` before use. This is standard `JSON.parse` behavior but easy to miss.
- Update the `runTask` saved-state merge to include both new fields

### Phase 2: Deliverable verification circuit breaker (implement.ts)

- After `files_to_create` verification loop, when `skipCompletion` is true:
  - Initialize/increment `deliverableFailCounts[subtaskId]`
  - Log the attempt count and missing files
  - If counter ≥ 3: write failure `qa_report.json`, advance to `failed`, return
- When `skipCompletion` is false: delete `deliverableFailCounts[subtaskId]`
- Inject `⚠️ DELIVERABLE RE-VERIFICATION` header into subtask prompt when counter > 0
- Skip counter increment when `pipeline.wakeupSubtaskId != null` (the wakeup file was already deleted by the orchestrator when first processed — check the pipeline state field, not disk). Wakeup takes priority, per ADR 002.

### Phase 3: QA timeout counter (qa-review.ts)

- Increment `qaTimeoutCount` in the timeout catch block
- Decrement `qaAttempt` in the timeout catch block (same pattern as rate-limit decrement)
- Replace `qaAttempt >= maxQaAttempts` gate with `qaTimeoutCount >= 3` gate
- Write timeout-specific completion summary message
- Reset `qaTimeoutCount` to 0 when QA completes without timeout (at the end of `runQaReview`, before the quality-cap check)

### Phase 4: Unified counter reset hook

- In `review-actions.ts` (`autoReviseSpec`, `rejectTask`): reset `deliverableFailCounts` to `{}` and `qaTimeoutCount` to 0 alongside existing `qaAttempt = 0`
- Verify `wakeupAttemptCount` (from ADR 002) also resets at the same point

### Phase 5: Command template updates

- `plan.md` Rules section: add guidance that `files_to_create` paths must be relative to the repository root
- `implement.md`: add the `$TEAMAI_SPEC_DIR` variable to the subtask prompt so the engineer can reference files by their absolute path
- `implement.md`: mention `files_to_create` in the subtask prompt — the engineer should see which deliverable files are expected

### Phase 6: Tests

- Unit tests for `deliverableFailCounts` increment/decrement/reset logic
- Unit tests for `qaTimeoutCount` increment/decrement/reset logic
- Unit tests for re-entry prompt injection (header content, attempt count, missing file list)
- Integration test: subtask fails `files_to_create` 3 times → task fails with correct message
- Integration test: QA times out 3 times → task fails with timeout-specific message
- Integration test: QA times out once, then completes → counter resets to 0
- Integration test: deliverable fails twice, then passes → counter resets
- Integration test: spec revision resets all counters
- Integration test: crash recovery restores both counters

## References

- `src/lib/orchestrator/implement.ts` — `files_to_create` verification loop (lines 305-318), subtask prompt builder
- `src/lib/orchestrator/qa-review.ts` — timeout catch block (lines 193-218)
- `src/lib/orchestrator.ts` — `TaskPipeline` interface (line 58), `runTask` saved-state merge (line 213)
- `src/lib/orchestrator/pipeline-state.ts` — `savePipelineState`, `restorePipelineState`
- `src/lib/orchestrator/review-actions.ts` — `autoReviseSpec`, `rejectTask` (counter reset points)
- `adr/002-schedule-wakeup-subtask-state.md` — Wakeup composition with `files_to_create` (AC 10)
- `adr/004-failure-budgets-retry-policy.md` — Retry policy taxonomy, Category 2 timeout design
- `defaults/commands/plan.md` — Planner command template (`files_to_create` field)
- `defaults/commands/implement.md` — Implement command template (subtask prompt structure)
