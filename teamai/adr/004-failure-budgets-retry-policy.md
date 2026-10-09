# ADR 004: Orchestrator Failure Budgets & Retry Policy

**Date:** 2026-07-03

**Status:** Accepted (revised 2026-07-04 — timeout counters removed)

> **2026-07-04 revision:** Category 2 (timeout counters) and the `qaTimeoutCount` field were removed. Timeouts are no longer tracked as a distinct failure category — all agent sessions rely on Claude's native session budget rather than a software-enforced deadline. QA sessions that exceed their budget exit naturally via Claude's own termination, which propagates through `waitForCompletion` as a normal session exit (not a timeout). This simplifies the failure taxonomy to two categories: infrastructure (rate limits) and quality (code failures).

## Context

The TeamAI pipeline orchestrator encounters two distinct categories of failure during execution. The original implementation treated all failures identically — any error during a QA review burned a `qaAttempt` and counted toward the configured `maxQaAttempts` cap. This conflated fundamentally different failure modes:

- A **Claude API rate limit** is an external infrastructure blockage — the code may be correct, verification is just delayed.
- A **QA FAIL report** is a quality failure — the code did not meet the acceptance criteria.

Under the original policy, a task could fail with "max QA attempts reached" after three infrastructure events, even though the code was never actually reviewed for quality. This wasted pipeline runs and obscured the true failure cause.

ADR 002 (ScheduleWakeup) introduced a circuit-breaker pattern for background-process wakeups (`wakeupAttemptCount`, cap of 3). This ADR generalizes that pattern into a cohesive retry policy for all failure modes.

## Decision

### Failure Taxonomy

Failures are classified into two categories, each with its own retry budget:

| Category | Cause | Retry Cap | Burns `qaAttempt`? | Counter |
|----------|-------|-----------|---------------------|---------|
| **Infrastructure — External** | Claude API rate / session limit | **Unlimited** | No¹ | None needed |
| **Quality** | Code fails acceptance criteria | **`maxQaAttempts`** (configurable, default 3) | Yes | `qaAttempt` |

> ¹ `qaAttempt` is always incremented at phase start. "No" means the error handler decrements it back — the net effect on the counter is zero. "Yes" means the increment is kept.

### Category 1: Rate Limits (Unlimited Retries)

Rate limits are **free retries** — they cost no compute budget beyond the wait, and the underlying code may be correct. The policy:

- `RateLimitError` is thrown by `waitForCompletion()` when a `rate_limit_event` is detected.
- `handleRateLimit()` schedules a `setTimeout`-based retry after the limit window expires.
- `pipeline.qaAttempt` is **decremented** on catch — rate limits don't consume the quality budget.
- There is **no cap** — a task can hit rate limits indefinitely during its pipeline run.
- `rateLimitedUntil` is persisted to the task record for crash recovery. `autoResumeInterruptedTasks` re-schedules the timer on startup.
- Stale-pipeline guard: if the task was manually moved to a terminal phase (`backlog`, `failed`, `done`, `awaiting-review`, `pr-open`) during the wait, the retry is silently skipped.

**Design rationale:** Rate limits are time-bound external blocks, not code defects. Capping them would cause tasks to fail when a longer wait would have succeeded — a worse user experience than showing a countdown.

### Category 2: Quality Failures (`maxQaAttempts`)

Quality failures are the core retry loop: the QA reviewer produced a FAIL report with specific issues, and the engineer must fix them. The policy:

- `pipeline.qaAttempt` is incremented at the top of `runQaReview`.
- Two checkpoints evaluate `pipeline.qaAttempt >= pipeline.maxQaAttempts`:
  1. **Unpushed commits detected** — worktree is out of sync with remote.
  2. **QA report is non-PASS** — actual quality failure, the main case.
- When the cap is exceeded, the task advances to `failed` with a `completion_summary.md` documenting the attempt count and last-known QA findings.
- `maxQaAttempts` is configurable via `pipeline.json` (default 3). Users with complex projects that need more QA cycles can increase it.
- `qaAttempt` resets to 0 on spec revision or human rejection, giving the fresh spec a clean budget.

### Counter Manipulation Table

| Event | `qaAttempt` | `wakeupAttemptCount` |
|-------|------------|----------------------|
| QA session completes (PASS) | (no change) | N/A |
| QA session completes (FAIL) | +1 | N/A |
| Rate limit hit | **−1** (decremented) | (no change) |
| Wakeup re-entry, artifact still missing, same `background_command` | N/A | +1 |
| Wakeup re-entry, artifact still missing, **different** `background_command` | N/A | **Reset to 1** |
| Wakeup re-entry, artifact committed | N/A | Reset to 0 |
| Spec revision | Reset to 0 | Reset to 0 |

> **2026-09-26 addition (progress-aware wakeup reset):** A wakeup re-entry that
> relaunches its background job under a command string different from the one
> stored from its previous wakeup is treated as evidence the engineer diagnosed
> and fixed a real blocker before restarting — not as "no progress, waiting
> again." Charging that against the same 3-attempt cap as an unchanged retry
> means a subtask that correctly fixes a bug on wakeups 1 and 2 and relaunches
> a multi-hour job on wakeup 3 can fail seconds after that final, now-correct
> relaunch — the fix is indistinguishable from a stalled retry to a bare
> counter. Found on task `add-per-constraint-soft-score-attributio`: three
> wakeups each diagnosed and fixed a distinct real bug (a compile-visibility
> error, a git-dirty checkout-sharing contamination, a build-SHA-scanning
> script bug) and relaunched the ~2h evidence job each time; the counter
> incremented on every relaunch regardless, and the task failed 2 minutes into
> the third (correct) relaunch. See `src/lib/orchestrator/implement.ts`'s
> wakeup-file-detection block (search `isGenuineRelaunch`).
| Human rejection | Reset to 0 | Reset to 0 |

### Composition: A Task With Multiple Failure Types

A task in a rate-limited environment:

1. QA attempt 1: rate-limited 3 times → resumes each time, finally completes → FAIL (quality). `qaAttempt` = 1.
2. QA attempt 2: rate-limited → resumes → completes → FAIL (quality). `qaAttempt` = 2.
3. QA attempt 3: rate-limited → resumes → completes → FAIL (quality). `qaAttempt` = 3 → task fails with quality message.

## Status

**Accepted.** Category 1 (rate limit = unlimited) and Category 2 (quality = `maxQaAttempts`) are live in production.

## Consequences

### Positive

- **Clearer failure attribution.** Users see whether a task failed because of code quality (exhausted `maxQaAttempts`) or is still waiting on rate limits. The countdown timer on rate-limited tasks provides transparency.
- **No wasted quality budget.** Rate limits don't consume `qaAttempt` slots, so the full `maxQaAttempts` budget is available for actual code review cycles.
- **Predictable behavior.** Each failure mode has a well-defined cap and retry strategy. No unbounded loops except rate limits (which are externally time-bounded).
- **Composes with wakeups.** The `wakeupAttemptCount` circuit breaker (ADR 002) follows the same philosophy — hardcoded 3, independent counter, resets on success.

### Negative

- **Increased state complexity.** Each counter field must be persisted, restored on crash, and reset at the right lifecycle points. The counter manipulation table above documents the expected behavior.

## Alternatives Considered

### Single counter for all failures (original approach)
Rejected because it conflates infrastructure and quality failures. A task that fails after 3 rate-limit-induced failures with no code review is indistinguishable from one that failed after 3 QA cycles — confusing for users and wasteful for the pipeline.

### Software timeouts on agent sessions
Rejected. Agent sessions rely on Claude's native session budget rather than a software-enforced deadline. Adding a software timeout would kill sessions that are legitimately doing work (e.g., reading a large codebase for QA review, running a long benchmark during implement). The session budget is sufficient to catch truly stuck agents, and the rate-limit handling catches infrastructure blocks.

### Fully configurable caps for all categories
Rejected for initial implementation. Most users won't need to tune caps — 3 is a reasonable default for quality retries and wakeup attempts. Configuration can be added later if demand warrants it.

## Future Work

1. **Configurable caps** — Move hardcoded caps (wakeup: 3) into `pipeline.json` alongside `maxQaAttempts`. Users with complex projects may need more wakeup attempts.

2. **Unified counter reset hook** — A centralized function that resets all retry counters (`qaAttempt`, `wakeupAttemptCount`, `deliverableFailCounts`) when human intervention occurs (spec revision, task rejection). This prevents scattered reset logic across the orchestrator. Specified in ADR 005 Phase 4 (`review-actions.ts`).

3. **Implement-phase timer extension** — Allow engineers to request additional session time for long-running subtasks (e.g., benchmarks), gated by the wakeup lifecycle (ADR 002) rather than a per-phase timeout.

## References

- `src/lib/orchestrator/qa-review.ts` — `runQaReview` (QA attempt lifecycle, rate-limit handling)
- `src/lib/orchestrator/rate-limit.ts` — `RateLimitError`, `handleRateLimit`, `NO_RESUME_PHASES`
- `src/lib/orchestrator.ts` — `TaskPipeline` interface, `handleRateLimit` delegate
- `adr/002-schedule-wakeup-subtask-state.md` — Wakeup circuit breaker pattern (same philosophy)
- `defaults/commands/qa-review.md` — QA reviewer command template
