# ADR 004: Orchestrator Failure Budgets & Retry Policy

**Date:** 2026-07-03

**Status:** Accepted

## Context

The TeamAI pipeline orchestrator encounters three distinct categories of failure during execution. The original implementation treated all failures identically — any error during a QA review burned a `qaAttempt` and counted toward the configured `maxQaAttempts` cap. This conflated fundamentally different failure modes:

- A **Claude API rate limit** is an external infrastructure blockage — the code may be correct, verification is just delayed.
- A **QA session timeout** is an internal infrastructure failure — the agent got stuck or the session budget was insufficient.
- A **QA FAIL report** is a quality failure — the code did not meet the acceptance criteria.

Under the original policy, a task could fail with "max QA attempts reached" after three consecutive timeouts, even though the code was never actually reviewed for quality. This wasted pipeline runs and obscured the true failure cause.

ADR 002 (ScheduleWakeup) introduced a circuit-breaker pattern for background-process wakeups (`wakeupAttemptCount`, cap of 3). This ADR generalizes that pattern into a cohesive retry policy for all failure modes.

## Decision

### Failure Taxonomy

Failures are classified into three categories, each with its own retry budget:

| Category | Cause | Retry Cap | Burns `qaAttempt`? | Counter |
|----------|-------|-----------|---------------------|---------|
| **Infrastructure — External** | Claude API rate / session limit | **Unlimited** | No¹ | None needed |
| **Infrastructure — Internal** | Agent session timeout, scheduler delay | **3** (hardcoded) | No¹ | `qaTimeoutCount` |
| **Quality** | Code fails acceptance criteria | **`maxQaAttempts`** (configurable, default 3) | Yes | `qaAttempt` |

> ¹ `qaAttempt` is always incremented at phase start (`runQaReview` line 90). "No" means the error handler decrements it back — the net effect on the counter is zero. "Yes" means the increment is kept.

### Category 1: Rate Limits (Unlimited Retries)

Rate limits are **free retries** — they cost no compute budget beyond the wait, and the underlying code may be correct. The policy:

- `RateLimitError` is thrown by `waitForCompletion()` when a `rate_limit_event` is detected.
- `handleRateLimit()` schedules a `setTimeout`-based retry after the limit window expires.
- In `runQaReview`, `pipeline.qaAttempt` is **decremented** on catch: `pipeline.qaAttempt--; // rate limits are free retries`.
- There is **no cap** — a task can hit rate limits indefinitely during its pipeline run.
- `rateLimitedUntil` is persisted to the task record for crash recovery. `autoResumeInterruptedTasks` re-schedules the timer on startup.
- Stale-pipeline guard: if the task was manually moved to a terminal phase (`backlog`, `failed`, `done`, `awaiting-review`, `pr-open`) during the wait, the retry is silently skipped.

**Design rationale:** Rate limits are time-bound external blocks, not code defects. Capping them would cause tasks to fail when a longer wait would have succeeded — a worse user experience than showing a countdown.

### Category 2: Timeouts (Cap of 3)

Agent session timeouts are infrastructure failures — the agent didn't finish within the session budget. Unlike rate limits, timeouts CAN indicate a real problem (e.g., the agent is stuck in a loop), so unlimited retries are inappropriate. But unlike quality failures, the code hasn't been evaluated yet, so timeouts should not consume the quality failure budget.

The policy (to be implemented — see Consequences):

- `runQaReview` has a 20-minute timeout (`QA_TIMEOUT_MS = 20 * 60 * 1000`).
- A new pipeline state field `qaTimeoutCount` tracks consecutive timeouts, separate from `qaAttempt`.
- When a timeout occurs:
  - `qaTimeoutCount` is incremented.
  - `qaAttempt` is decremented back to its pre-call value (timeouts are not quality failures).
  - A `qa_report.json` is written with `overall: "FAIL"` and a timeout-specific criterion.
- **Evaluation order:** The timeout cap check (`qaTimeoutCount >= 3`) is evaluated **before** the quality cap check (`qaAttempt >= maxQaAttempts`). A task that exhausts its timeout budget fails with a timeout message even if the quality budget still has room. The timeout cap is the first gate; the quality cap is the fallback.
- If `qaTimeoutCount >= 3` → task advances to `failed` with a timeout-specific completion summary: "Task failed after 3 QA timeouts — agent was unable to complete review within the session budget."
- If `qaTimeoutCount < 3` → task bounces back to `qa-review` phase for another attempt.
- `qaTimeoutCount` resets to 0 when a QA session completes (PASS or FAIL) without timing out — the cap only triggers on *consecutive* timeouts.
- `qaTimeoutCount` also resets to 0 on spec revision or human rejection (same reset hook as `qaAttempt`).

**Design rationale:** A hardcoded cap of 3 prevents infinite timeout loops (unlike rate limits) while being generous enough to handle transient issues (busy scheduler, slow API). Not configurable initially — three attempts is a clear signal the agent is stuck, and making it configurable adds complexity without clear user benefit.

### Category 3: Quality Failures (`maxQaAttempts`)

Quality failures are the core retry loop: the QA reviewer produced a FAIL report with specific issues, and the engineer must fix them. The policy:

- `pipeline.qaAttempt` is incremented at the top of `runQaReview`.
- Three checkpoints evaluate `pipeline.qaAttempt >= pipeline.maxQaAttempts`:
  1. **Unpushed commits detected** — worktree is out of sync with remote.
  2. **Session timeout** — agent didn't finish (this checkpoint will be replaced by the timeout cap).
  3. **QA report is non-PASS** — actual quality failure, the main case.
- When the cap is exceeded, the task advances to `failed` with a `completion_summary.md` documenting the attempt count and last-known QA findings.
- `maxQaAttempts` is configurable via `pipeline.json` (default 3). Users with complex projects that need more QA cycles can increase it.
- `qaAttempt` resets to 0 on spec revision or human rejection, giving the fresh spec a clean budget.

### Counter Manipulation Table

> **Note:** This table covers the three failure categories defined in this ADR. ADR 005 extends it with `deliverableFailCounts` — a per-subtask circuit breaker for `files_to_create` verification failures.

| Event | `qaAttempt` | `qaTimeoutCount` | `wakeupAttemptCount` |
|-------|------------|------------------|----------------------|
| QA session completes (PASS) | (no change) | Reset to 0 | N/A |
| QA session completes (FAIL) | +1 | Reset to 0 | N/A |
| Rate limit hit | **−1** (decremented) | (no change) | (no change) |
| QA session timeout | (no change) | +1 | N/A |
| Wakeup re-entry, artifact still missing | N/A | N/A | +1 |
| Wakeup re-entry, artifact committed | N/A | N/A | Reset to 0 |
| Spec revision | Reset to 0 | Reset to 0 | Reset to 0 |
| Human rejection | Reset to 0 | Reset to 0 | Reset to 0 |

### Composition: A Task With Multiple Failure Types

A task can encounter all three failure types in a single pipeline run. For example:

1. QA attempt 1: rate-limited 3 times → resumes each time, finally completes → FAIL (quality). `qaAttempt` = 1.
2. QA attempt 2: rate-limited → resumes → times out. `qaAttempt` = 1, `qaTimeoutCount` = 1.
3. QA attempt 2 (retry): completes → FAIL (quality). `qaAttempt` = 2, `qaTimeoutCount` = 0.
4. QA attempt 3: times out. `qaAttempt` = 2, `qaTimeoutCount` = 1.
5. QA attempt 3 (retry): times out again. `qaAttempt` = 2, `qaTimeoutCount` = 2.
6. QA attempt 3 (retry): times out yet again. `qaAttempt` = 2, `qaTimeoutCount` = 3 → task fails with timeout message, NOT quality message.

The quality budget (`maxQaAttempts` = 3) was never exhausted, but the timeout budget (3) was. The completion summary correctly attributes the failure to timeouts, not code quality.

## Status

**Accepted** (partial implementation). Category 1 (rate limit = unlimited) and Category 3 (quality = `maxQaAttempts`) are live in production. Category 2 (timeout cap of 3, separate from `qaAttempt`) is specified here but not yet implemented — the current code uses `maxQaAttempts` for timeout gating. See ADR 005 for the full implementation spec, and Consequences → Negative for the implementation gap.

## Consequences

### Positive

- **Clearer failure attribution.** Users see whether a task failed because of code quality (exhausted `maxQaAttempts`) or infrastructure (exhausted timeout retries). This reduces confusion when a task fails after "3 attempts" that were all timeouts.
- **No wasted quality budget.** Rate limits and timeouts don't consume `qaAttempt` slots, so the full `maxQaAttempts` budget is available for actual code review cycles.
- **Predictable behavior.** Each failure mode has a well-defined cap and retry strategy. No unbounded loops except rate limits (which are externally time-bounded).
- **Composes with wakeups.** The `wakeupAttemptCount` circuit breaker (ADR 002) follows the same philosophy as the timeout cap — hardcoded 3, independent counter, resets on success.

### Negative

- **Increased state complexity.** Each counter field must be persisted, restored on crash, and reset at the right lifecycle points. The counter manipulation table above documents the expected behavior.
- **`qaTimeoutCount` not yet implemented.** The current code uses `maxQaAttempts` for timeout gating, which wastes quality budget on infrastructure failures. The timeout counter must be added to `QaReviewPipeline`, `runQaReview`, and `pipeline-state.ts`.
- **Hardcoded caps.** The timeout cap (3) and wakeup cap (3) are hardcoded, unlike `maxQaAttempts` which is configurable. Users who need more timeout attempts must wait for a configurable policy (see Future Work).

## Alternatives Considered

### Single counter for all failures (original approach)
Rejected because it conflates infrastructure and quality failures. A task that fails after 3 timeouts with no code review is indistinguishable from one that failed after 3 QA cycles — confusing for users and wasteful for the pipeline.

### Fully configurable caps for all three categories
Rejected for initial implementation. Adding `maxTimeouts` and `maxWakeups` to `pipeline.json` is low-priority relative to getting the timeout counter separated from `qaAttempt`. Most users won't need to tune timeout caps — 3 is a reasonable default.

### No timeout cap (treat timeouts like rate limits)
Rejected because timeouts can indicate a stuck agent, and unbounded retries would waste compute on a task that will never complete. Rate limits are externally time-bounded; timeouts are not.

## Future Work

1. **Implement `qaTimeoutCount`** — Add the counter to pipeline state, separate the timeout checkpoint from `qaAttempt` in `runQaReview`, and write timeout-specific completion summaries. The full implementation spec lives in `adr/005-verification-gate-failure-tracking.md`.

2. **Configurable timeout/wakeup caps** — Move the hardcoded caps (3) into `pipeline.json` alongside `maxQaAttempts`. Users with long-running QA sessions (e.g., large codebases) may need more timeout attempts.

3. **Implement-phase timeout caps** — The `implement` phase relies on Claude's session budget rather than an explicit software timeout. A timeout cap for the implement phase (similar to the QA timeout cap) would catch engineers stuck in infinite loops.

4. **Unified counter reset hook** — A centralized function that resets all retry counters (`qaAttempt`, `qaTimeoutCount`, `wakeupAttemptCount`, `deliverableFailCounts`) when human intervention occurs (spec revision, task rejection). This prevents scattered reset logic across the orchestrator. Specified in ADR 005 Phase 4 (`review-actions.ts`).

5. **Implement-phase timer extension** — Allow engineers to request additional session time for long-running subtasks (e.g., benchmarks), gated by a per-task budget rather than a per-phase timeout.

## References

- `src/lib/orchestrator/qa-review.ts` — `runQaReview` (QA attempt lifecycle, timeout, rate-limit handling)
- `src/lib/orchestrator/rate-limit.ts` — `RateLimitError`, `handleRateLimit`, `NO_RESUME_PHASES`
- `src/lib/orchestrator.ts` — `TaskPipeline` interface, `handleRateLimit` delegate
- `adr/002-schedule-wakeup-subtask-state.md` — Wakeup circuit breaker pattern (same philosophy)
- `defaults/commands/qa-review.md` — QA reviewer command template (structural improvements for rework detection)
