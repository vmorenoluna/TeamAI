# Spec: Verification Gate Failure Tracking

**Date:** 2026-07-03

**Status:** Accepted (revised 2026-07-04 — QA timeout counter feature removed)

> **2026-07-04 revision:** Feature 2 (QA Timeout Counter) and the `qaTimeoutCount` field were removed. Agent sessions rely on Claude's native session budget rather than a software-enforced deadline. QA sessions that exceed their budget exit naturally via Claude's own termination, which propagates through `waitForCompletion` as a normal session exit. This simplifies the verification gate system to a single feature: deliverable verification with per-subtask circuit breakers.

## Problem

The pipeline has a verification gate where failure is currently conflated with quality failure:

**Deliverable verification (`files_to_create`)**: After a subtask session ends, the orchestrator checks that expected deliverable files exist on disk. If they're missing, the subtask stays incomplete and re-runs next pass. But there's no cap on re-runs, no distinct re-entry prompt telling the engineer WHY the subtask is re-running, and no failure attribution — a subtask that loops 10 times on missing deliverables is indistinguishable from one that was simply never started.

The root cause: **verification gate failures lack their own counter and circuit breaker, so they silently consume the quality failure budget (`qaAttempt`/`maxQaAttempts`).**

ADR 004 established the retry policy taxonomy: infrastructure failures need separate counters from quality failures. This spec defines the concrete implementation for the deliverable verification counter.

## Design

### Philosophy

The deliverable verification circuit breaker follows the same pattern established in ADR 002 (wakeup) and ADR 004 (retry policy):

| Aspect | Deliverable Verification |
|--------|------------------------|
| **Failure type** | Infrastructure (internal) — engineer didn't produce expected files |
| **Counter** | `deliverableFailCounts: Record<number, number>` |
| **Cap** | 3 per subtask |
| **Burns `qaAttempt`?** | No |
| **Re-entry prompt** | `⚠️ DELIVERABLE RE-VERIFICATION` header |
| **Failure message** | "Subtask {id} failed deliverable verification 3 times" |
| **Reset trigger** | Successful `files_to_create` pass |
| **Reset on spec revision?** | Yes |

### Feature: Deliverable Verification Circuit Breaker

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

### Counter Reset Hook (Unified)

A single reset point ensures consistency:

| Trigger | `qaAttempt` | `deliverableFailCounts` | `wakeupAttemptCount` |
|---------|:-----------:|:-----------------------:|:--------------------:|
| Spec revision | Reset to 0 | Reset to `{}` | Reset to 0 |
| Human rejection | Reset to 0 | Reset to `{}` | Reset to 0 |
| Subtask passes `files_to_create` | — | Delete entry (pass) | — |

### Pipeline State Persistence

`.pipeline_state.json` gains one new optional field:

```json
{
  "taskId": "...",
  "phase": "qa-review",
  "qaAttempt": 2,
  "deliverableFailCounts": { "3": 2 },
  "...existing fields..."
}
```

Restored in `restorePipelineState` and included in the `runTask` saved-state merge.

### Counter Manipulation Table

> **Note on `qaAttempt` values:** `qaAttempt` is always incremented at the top of `runQaReview`. "No change" means the error handler decrements it back — net effect is zero. "+1" means the increment is kept (not reverted). See ADR 004 for the full explanation of the retry taxonomy.

| Event | `qaAttempt` | `deliverableFailCounts` | `wakeupAttemptCount` |
|-------|:-----------:|:-----------------------:|:--------------------:|
| QA session completes (PASS) | (no change) | — | — |
| QA session completes (FAIL) | +1 | — | — |
| Rate limit hit | −1 (decremented) | (no change) | (no change) |
| Subtask passes `files_to_create` | — | Delete entry (pass) | — |
| Subtask fails `files_to_create` (attempt < 3) | — | +1 for subtask ID | — |
| Subtask fails `files_to_create` (attempt ≥ 3) | — | — (task fails) | — |
| Wakeup re-entry, artifact still missing | — | — | +1 |
| Wakeup re-entry, artifact committed | — | — | Reset to 0 |
| Spec revision | Reset to 0 | Reset to `{}` | Reset to 0 |
| Human rejection | Reset to 0 | Reset to `{}` | Reset to 0 |

## Acceptance Criteria

### Deliverable Verification

1. **Counter tracks per-subtask** — `deliverableFailCounts` is a `Record<number, number>`. Each failed `files_to_create` check for subtask N increments `deliverableFailCounts[N]`. Different subtasks' counters are independent — subtask 3 failing doesn't affect subtask 5's counter.

2. **Re-entry prompt identifies missing files** — When a subtask re-runs and `deliverableFailCounts[subtaskId] > 0`, the prompt includes a `⚠️ DELIVERABLE RE-VERIFICATION` header listing which files were missing in the previous session. The list comes from `subtask.files_to_create` (same array the planner populated and the verification loop checked).

3. **Circuit breaker at 3** — After 3 consecutive `files_to_create` failures for the same subtask, the task advances to `failed` with a `qa_report.json` documenting which files were never created. The pipeline does NOT continue to the next subtask or group.

4. **Counter resets on pass** — When a subtask passes `files_to_create` verification (all files exist), `deliverableFailCounts[subtaskId]` is deleted. The counter only tracks **consecutive** failures.

5. **No counter interaction with wakeup** — If `subtask_wakeup.json` exists, `files_to_create` verification is skipped entirely (per ADR 002). `deliverableFailCounts` is not incremented during wakeup cycles. After wakeup resolution, normal `files_to_create` verification resumes.

6. **Deliverable verification operates identically during QA rework** — During QA rework (`hasQaFeedback` is true), the deliverable verification counter still tracks failures and `skipCompletion` still blocks `completedIds.push` — the counter operates exactly as it does in first-pass mode. The QA feedback provides additional context for the engineer but does not alter the verification logic. If `files_to_create` entries are missing during rework, the counter increments normally.

7. **Crash recovery preserves counter** — `deliverableFailCounts` is persisted to `.pipeline_state.json`. If the process crashes between subtask sessions, the counter survives and the next run continues from the correct attempt number.

8. **Counter resets on spec revision** — When the spec is revised (via `reviseSpec`), `deliverableFailCounts` resets to `{}` along with all other retry counters. A fresh spec gets a fresh deliverable budget.

### Cross-cutting

9. **All counters reset together on human intervention** — Spec revision and human rejection reset `qaAttempt`, `deliverableFailCounts`, and `wakeupAttemptCount` in a single reset point (not scattered across multiple files).

10. **Pipeline state persistence includes all new fields** — `savePipelineState` writes `deliverableFailCounts` (and existing `wakeupAttemptCount` if present). `restorePipelineState` reads them back.

11. **TypeScript types updated** — `TaskPipeline`, `ImplementPipeline`, and `.pipeline_state.json` types all include the new optional `deliverableFailCounts` field.

## Edge Cases

### Deliverable file created but in wrong location

If the engineer creates the file but at a different path than `files_to_create` specifies, the `existsSync` check fails. The engineer sees the re-entry prompt listing the expected path and can fix the location. This is a normal deliverable verification failure — the counter increments.

### `files_to_create` paths are relative to worktree root

The current code uses `path.join(cwd, file)` where `cwd` is the worktree root (or per-subtask worktree). If the planner specifies absolute paths in `files_to_create`, the behavior is undefined. The plan.md command template should explicitly state that `files_to_create` paths are relative to the repository root.

### Subtask has `files_to_create` but engineer never starts the work

If the engineer session ends without starting (e.g., immediate rate limit), `files_to_create` verification still runs. The files won't exist, so `skipCompletion` is true and the counter increments. This is correct — the subtask ran and didn't produce deliverables.

However, if the session never started at all (session creation failed), `files_to_create` verification doesn't run (the code is inside the `try` block that also handles session creation). The subtask stays incomplete and re-runs without incrementing the counter. This is correct — no work was attempted.

### Subtask re-runs for non-deliverable reasons

If a subtask re-runs because it was never completed (not because of `files_to_create` failure), `deliverableFailCounts` is not incremented. The counter only increments when `skipCompletion` is true AND `subtask.files_to_create` was non-empty and at least one file was missing.

### Engineer creates some files but not all

If `files_to_create` lists 3 files and the engineer creates 2 (1 still missing), `skipCompletion` is true (ANY missing file triggers it). The counter increments normally. The re-entry prompt lists ALL files from `files_to_create` — both created and missing — so the engineer can verify which one needs attention. The existing files are harmless (the `existsSync` check for the missing one still fails).

### `deliverableFailCounts` entry for a subtask that was later deleted from the plan

If the plan is regenerated and a subtask ID no longer exists, stale entries in `deliverableFailCounts` are harmless — the verification loop only checks entries for subtasks that exist in the current plan. No explicit cleanup needed.

## Implementation Plan

### Phase 1: Pipeline state types + persistence

- Add `deliverableFailCounts?: Record<number, number>` to `TaskPipeline` in `orchestrator.ts`
- Add the field to `ImplementPipeline` in `implement.ts`
- Update `savePipelineState` in `pipeline-state.ts` to include the new field
- Update `restorePipelineState` in `pipeline-state.ts` to restore it.
  **Implementation note:** `deliverableFailCounts` is a `Record<number, number>` in TypeScript. When serialized to JSON, numeric keys become strings (`"3"` not `3`). When restoring, cast `Object.keys()` results to `Number` before use. This is standard `JSON.parse` behavior but easy to miss.
- Update the `runTask` saved-state merge to include the new field

### Phase 2: Deliverable verification circuit breaker (implement.ts)

- After `files_to_create` verification loop, when `skipCompletion` is true:
  - Initialize/increment `deliverableFailCounts[subtaskId]`
  - Log the attempt count and missing files
  - If counter ≥ 3: write failure `qa_report.json`, advance to `failed`, return
- When `skipCompletion` is false: delete `deliverableFailCounts[subtaskId]`
- Inject `⚠️ DELIVERABLE RE-VERIFICATION` header into subtask prompt when counter > 0
- Skip counter increment when `pipeline.wakeupSubtaskId != null` (the wakeup file was already deleted by the orchestrator when first processed — check the pipeline state field, not disk). Wakeup takes priority, per ADR 002.

### Phase 3: Unified counter reset hook

- In `review-actions.ts` (`autoReviseSpec`, `rejectTask`): reset `deliverableFailCounts` to `{}` alongside existing `qaAttempt = 0`
- Verify `wakeupAttemptCount` (from ADR 002) also resets at the same point

### Phase 4: Command template updates

- `plan.md` Rules section: add guidance that `files_to_create` paths must be relative to the repository root
- `implement.md`: add the `$TEAMAI_SPEC_DIR` variable to the subtask prompt so the engineer can reference files by their absolute path
- `implement.md`: mention `files_to_create` in the subtask prompt — the engineer should see which deliverable files are expected

### Phase 5: Tests

- Unit tests for `deliverableFailCounts` increment/decrement/reset logic
- Unit tests for re-entry prompt injection (header content, attempt count, missing file list)
- Integration test: subtask fails `files_to_create` 3 times → task fails with correct message
- Integration test: deliverable fails twice, then passes → counter resets
- Integration test: spec revision resets all counters
- Integration test: crash recovery restores the counter

## References

- `src/lib/orchestrator/implement.ts` — `files_to_create` verification loop, subtask prompt builder
- `src/lib/orchestrator.ts` — `TaskPipeline` interface, `runTask` saved-state merge
- `src/lib/orchestrator/pipeline-state.ts` — `savePipelineState`, `restorePipelineState`
- `src/lib/orchestrator/review-actions.ts` — `autoReviseSpec`, `rejectTask` (counter reset points)
- `adr/002-schedule-wakeup-subtask-state.md` — Wakeup composition with `files_to_create` (AC 10)
- `adr/004-failure-budgets-retry-policy.md` — Retry policy taxonomy
- `defaults/commands/plan.md` — Planner command template (`files_to_create` field)
- `defaults/commands/implement.md` — Implement command template (subtask prompt structure)
