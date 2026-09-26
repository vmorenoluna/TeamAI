# ADR 008: QA-Rework Cleanup Must Track Its Own Scope, Not the Whole Plan

**Date:** 2026-09-26

**Status:** Accepted

## Context

When QA fails a task, the implement phase re-enters in "QA bounce-back" mode: `selectSubtasks` reads `qa_feedback.md` and restricts dispatch to only the real subtasks QA's criteria matched against (`qa_flagged: true`). If criterion-matching can't target any real subtask, a synthetic subtask `9999` is synthesized from the raw feedback text instead (`qa_flagged: true` on the synthetic subtask too) — this is the only fallback that exists.

Once the implement phase's group loop finishes for the pass, a "structural completeness gate" decides whether to advance to QA or retry: it reads the full `plan.json`, and if ANY subtask (real or synthetic, targeted by this bounce or not) is `!completed`, it recurses back into `implement` instead of advancing — up to `maxImplementRetries` (default 3) attempts before failing the task outright. Only once the ENTIRE plan shows zero incomplete subtasks does the pipeline delete `qa_feedback.md` and clear every `qa_flagged` marker.

**The bug:** `selectSubtasks`'s dispatch filter, while `qa_feedback.md` exists, is `realSubtasks.filter(s => s.qa_flagged)` — it does not fall back to "run any remaining `!completed` subtask" the way a normal (non-bounce) pass does. So as long as `qa_feedback.md` exists, ANY real subtask that was never QA-flagged and isn't a dependent of anything the rework fixed (see `reconcileSubtaskCompletionFromDeliverables`'s narrower "flag the dependent" mechanism, which only fires for subtasks whose `depends_on` names a just-reconciled id) is invisible to dispatch, forever — no matter how many bounce passes run.

If the rework itself (the flagged real subtasks, or the synthetic `9999`) genuinely succeeds on pass 1, but some OTHER, unrelated subtask remains incomplete for its own separate reason (never dispatched yet, not itself flagged, not a dependent of the fix), the cleanup gate never fires: `qa_feedback.md` stays, every subsequent pass finds zero real `qa_flagged` subtasks (the fix already succeeded), and re-synthesizes a *fresh* `9999` from the *same stale* feedback text — which typically has nothing left to do, confirms so, and ends cleanly, satisfied. The unrelated subtask is never touched. After `maxImplementRetries` such passes, the task fails with "Implement completeness gate" — having burned its entire retry budget re-verifying a fix that succeeded on attempt 1, while never once attempting the subtask actually blocking progress.

**Found on task `add-per-constraint-soft-score-attributio`'s third retry.** `qa_feedback.md` (stale, from an earlier "wakeup attempt limit exceeded" failure naming subtask `9999`) persisted across a task-level retry (`failed` → `implement`). Three separate `9999` sessions each confirmed the named artifact was already committed and correct, found nothing left in their own scope, and ended cleanly — while subtask 15 (never named by QA, and not a dependent of anything `9999` touched) sat completely untouched for all three passes. The task failed via the implement completeness gate, 16 minutes after the retry started — nowhere near the ~2h a genuine attempt at subtask 15's real work would have taken.

## Decision

Track "is the QA-targeted rework done" as its own, narrower condition, separate from "is the whole plan done":

```ts
const qaTargetedIds = finalSubtasks.filter(s => s.qa_flagged).map(s => s.id);
const qaTargetedDone = qaTargetedIds.length > 0
  && qaTargetedIds.every(id => finalSubtasks.find(s => s.id === id)?.completed === true);
if (qaTargetedDone) {
  // delete qa_feedback.md, clear qa_flagged markers — NOW, independent of
  // whether other, unrelated subtasks in the plan remain incomplete.
}
```

This runs *before* the existing whole-plan completeness check, in the same Phase 4 block, using the plan already re-read fresh from disk (post-reconciliation). Both real qa_flagged subtasks and the synthetic `9999` are covered uniformly — both carry `qa_flagged: true` the same way.

Once `qa_feedback.md` is deleted, the *next* pass's `selectSubtasks` call reads that fresh (file gone) state directly from disk — no in-memory flag needs to be threaded through the current invocation's recursive `advancePhase('implement') → executePhase()` call, since that call re-enters `selectSubtasks` from scratch. The remaining incomplete subtask(s) then fall through to the normal `!completed` dispatch path, exactly as they would if there had never been a QA bounce-back — making real progress instead of re-synthesizing rework that already succeeded.

The existing whole-plan completeness check (further down, deciding retry vs. fail) is untouched — it still gates advancing to QA on every subtask being complete, and still fails the task after `maxImplementRetries` whole passes. The only change is that `qa_feedback.md` no longer outlives the rework it was created for.

## Consequences

### Positive
- A QA bounce-back that succeeds on its first pass no longer wastes the entire `maxImplementRetries` budget re-confirming a fix that already landed, while starving an unrelated subtask of any chance to run.
- `reconcileSubtaskCompletionFromDeliverables`'s existing "flag the dependent" mechanism is unaffected and still handles its own (narrower) case — a subtask that IS a dependent of something the rework fixed. This ADR's fix handles the complementary case: a subtask that is NOT a dependent of anything QA-relevant, and so was never going to get flagged by any existing mechanism.

### Negative / watch-outs
- `finalSubtasks`'s `completed` field can be stale for a subtask that was previously `completed: true`, got QA-flagged, and then FAILED its rework attempt this pass (`selectSubtasks` resets `completed` to `false` only in memory for `effectiveSubtasks`, and nothing persists that reset back to disk when the retry fails) — `persistCompletedSubtasks` only ever writes `true` for ids that succeeded, never `false` for ids that were reset-and-then-failed. This is a pre-existing property of the whole completeness-tracking mechanism (the existing whole-plan gate has the exact same blind spot), not something this fix introduces or resolves. It surfaced while testing this fix (a test's mock produced a spurious scope violation that the old code silently tolerated because nothing depended on per-subtask accuracy across groups) — worth a dedicated look separately.

## References
- `src/lib/orchestrator/implement.ts` — `selectSubtasks` (QA-fallback synthesis), Phase 4 of `runImplement` (the fix)
- `src/lib/orchestrator/implement.ts` — `reconcileSubtaskCompletionFromDeliverables` (the complementary, narrower mechanism)
- ADR 006 — the sibling cross-group completion barrier fix, found via the same incident
