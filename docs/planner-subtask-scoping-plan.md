# Planner Subtask Scoping — Plan

## 1. Context & motivation

When a task sits in `awaiting-review` (or `pr-open`) and the reviewer sends **Request Changes**, they can already scope feedback to *specific subtasks* for the **coder** target. The review panel shows a subtask checklist, the selection is persisted in `human_feedback.md` as a `Subtasks: 2,5` header, and the orchestrator uses it to re-run **only** those subtasks.

There is no equivalent for the **planner** target. "Request Changes → Planner" today always re-plans the *whole* plan in place (`REPLAN` mode). If the reviewer only wants to fix one or two subtasks — "rework subtask #3's file list" or "split subtask #2 into two" — the planner is free to regenerate everything, which can perturb subtasks the reviewer never mentioned.

This document specs how to add planner subtask scoping. It is a **different mechanism** from the coder's, not a copy of it.

## 2. The semantic distinction (the core of this feature)

| | Coder scoping (exists) | Planner scoping (this plan) |
|---|---|---|
| What the selection means | **Re-run filter** — which subtasks the implement phase re-executes | **Preserve-list** — which subtasks the planner is *allowed to modify* |
| What happens to the selection | `implement.ts` filters `subtasksToRun` to the ids and sets their `completed: false` | The planner revises those subtasks per the reviewer's directive + spec |
| What happens to the rest | Not run at all this round (already `completed`) | **Frozen byte-identical** — same `id`, `title`, `description`, `files`, `depends_on`, `acceptance_criteria`, `completed`, `qa_flagged` |
| Where it's enforced | Deterministically in code (`implement.ts`) | Instructed to the agent **and** enforced in code (see §4.4) |

The planner's job is to *re-derive the plan from the spec*, so "leave the rest untouched" is not its default instinct — an LLM re-planning will naturally rewrite descriptions it shouldn't. That is why the preserve-list must be **enforced in code**, not merely requested in the prompt.

## 3. Scope

**In scope**
- Selecting subtasks when the reviewer targets the **Planner** in Request Changes.
- Persisting that selection (reuse the existing `Subtasks:` header).
- Injecting a preserve-list directive into the planner's REPLAN prompt.
- Guaranteeing the unselected subtasks come back unchanged after re-plan (code-level guard).
- Command/role wording so the planner understands the preserve-list contract.

**Out of scope (for now)**
- Scoping for `analyst` (spec) or `qa-reviewer` targets.
- Re-planning a *subset* of the plan without touching `plan.json` wholesale (the planner still rewrites the file; only the unselected subtasks are restored).
- Per-subtask *partial* feedback (e.g. "change only the `files` array of #3") — the directive is free-text scoped to whole subtasks.

## 4. Design

### 4.1 Data model — extend `subtaskIds` to the planner

`src/lib/orchestrator/human-feedback.ts`:

- `HumanFeedback.subtaskIds` is currently documented "coder target only". Change the doc to "coder and planner targets".
- **No storage change needed.** `writeHumanFeedback(specPath, target, message, subtaskIds?)` already writes the `Subtasks: N,M` header for any target, and `readHumanFeedback` already parses it back. The `Subtasks:` line is target-agnostic today; only the *consumers* are coder-specific.

### 4.2 UI — show the checklist for the planner too

`src/components/review-panel.tsx`:

- Change the gate from `target === 'coder'` to `(target === 'coder' || target === 'planner')`.
- The `subtasks` prop is already passed in from `task-detail.tsx` (`plan?.subtasks?.map(s => ({ id, title, files }))`), so no prop plumbing is needed.
- The helper text under the checklist ("optional — scopes the rework") should be target-aware: for the planner it reads "scopes which subtasks may be re-planned; others are left unchanged".
- `handleReject` already forwards `selectedSubtasks` to `rejectTask(taskId, feedback, target, subtaskIds)`, which reaches `routeHumanFeedback` unchanged — no change there.

### 4.3 Directive — a planner-specific scope note

`src/lib/orchestrator/human-feedback.ts`:

- `humanDirectiveFor(specPath, phaseRole)` currently builds a scope note only for `fb.target === 'coder'` via `buildSubtaskScopeNote(readScopedSubtasks(...))`.
- Add a planner branch. The planner note must express **preserve-list** semantics, not rework semantics:

  > The human reviewer scoped this directive to the following subtasks — re-plan ONLY these, do not regenerate or alter any other subtask:
  >   - #2: …
  >   - #4: …
  > Every subtask NOT listed above must be preserved **byte-for-byte** (same id, title, description, files, depends_on, acceptance_criteria, completed, qa_flagged).

- `readScopedSubtasks` (already resolves ids → titles from `plan.json`) is reused as-is.

Generalize rather than duplicate: `buildSubtaskScopeNote(subtasks, mode: 'rework' | 'replan')` — the coder keeps "rework ONLY these, do not touch others", the planner gets the preserve-list wording above.

### 4.4 Enforce the preserve-list in code (the load-bearing guardrail)

`src/lib/orchestrator/phase-runners.ts` → `runPlanPhase`:

Instructing the LLM is not sufficient. Enforce it deterministically:

1. **Before** starting the planner session, if the pending human feedback targets `planner` and carries `subtaskIds`, read `plan.json` and snapshot the subtasks **not** in the selection (keyed by `id`).
2. Run the planner (REPLAN prompt + directive) as today.
3. **After** the session completes, re-read `plan.json` and **restore the unselected subtasks from the snapshot** — overwrite whatever the planner wrote for those ids with the original objects. This makes the preserve-list unconditional.
4. If the planner *added* new subtask ids, keep them (they are outside the preserve-list). If the planner changed an unselected subtask's `id`, restore by the snapshot's original ids and drop/relocate any orphan — flag this in the plan-output log.

Rationale: this mirrors the coder path, where the selection's effect (`subtasksToRun` filtering) is applied in code rather than trusted to the agent. The prompt instruction (§4.5) reduces the work the guardrail has to undo, but the guardrail is the guarantee.

Persistence edge case: the snapshot must live across the planner session. The planner runs synchronously in `runPlanPhase` (no wakeup/restart mid-phase today), so an in-memory snapshot is sufficient; but if the replan spans a crash, re-deriving the snapshot from `human_feedback_before_bounce.md` (which `routeHumanFeedback` already snapshots) is the recovery path — note this as a follow-up if replan ever becomes resumable.

### 4.5 Command/role wording — teach REPLAN the preserve-list

`defaults/commands/plan.md` (and the mirrored `.claude/commands/plan.md`), plus the matching "Re-planning an Existing Plan" paragraph in `defaults/roles/planner.md` (and `.claude/roles/planner.md`):

- Extend the existing REPLAN bullets with: when the human directive lists a scoped set of subtasks, re-plan **only** those; leave every unlisted subtask byte-for-byte unchanged (including its `completed` / `qa_flagged` flags) and do not renumber ids or rewrite their fields.
- This belongs in the **command** (orchestration contract), not just the role — same principle as the existing worktree/ports/push rules. The role may keep a one-line pointer, but the binding rule lives in `plan.md`.

### 4.6 Routing

No change to `routeHumanFeedback` (`src/lib/orchestrator/review-actions.ts`): the planner target already routes to `plan`, `trimArtifactsForTarget('planner')` already clears QA artifacts, and `subtaskIds` already flows through `writeHumanFeedback`.

## 5. Edge cases

- **Empty selection** → no `Subtasks:` header → whole-plan re-plan (current behavior), as if scoping were never used.
- **Invalid/stale ids** (subtask deleted since the plan was shown) → `readScopedSubtasks` silently drops missing ids; the preserve-list simply has fewer entries. The guardrail should warn rather than fail.
- **Dependencies** — if a selected subtask's change alters files another (unselected) subtask also lists, the unselected one is preserved verbatim and the conflict surfaces at implement time exactly as it would today; the directive should tell the planner to fix `depends_on`/file ownership *within* the selected set rather than reach into preserved subtasks.
- **Interaction with spec revision** — a spec revision (analyst target) resets the plan downstream; scoped planner feedback is independent and only applies to a plan that still exists.
- **`completed` flags** — the preserved subtasks keep their existing flags, so already-completed work is not re-implemented; this composes with the existing "keep completed subtasks" REPLAN rule.

## 6. Testing

Unit:

- `human-feedback.test.ts` — `readHumanFeedback` parses `Subtasks:` for a `planner` target; `humanDirectiveFor` emits the planner preserve-list note (and the coder note is unchanged).
- `review-panel.test.tsx` — the checklist renders for the `planner` target (and pre-fill for `analyst` is untouched); selection flows into `rejectTask`.
- `phase-runners`/orchestrator test — after a scoped planner re-plan, the unselected subtasks in `plan.json` are byte-identical to the pre-session snapshot, and a planner that tried to rewrite them is corrected.

Integration/guardrail:

- A mock planner session that rewrites an unselected subtask is reverted by the guardrail (§4.4).
- Scoped re-plan preserves `completed: true` on unselected subtasks so they are not re-implemented.

## 7. Open questions

1. **Restore vs. verify-only** — §4.4 proposes *restoring* unselected subtasks unconditionally. The lighter alternative is *verify-only* (fail the replan if they changed). Restore is recommended: it is resilient to an LLM that "helpfully" reformats. Confirm this is acceptable (it means the planner's renumbering/merging of preserved subtasks is always undone).
2. **Mid-replan resumability** — the snapshot is in-memory because replan is synchronous today. If replan ever gains wakeup/restart, the snapshot needs a persisted home (reuse the `human_feedback_before_bounce.md` path). Defer unless the resumability work lands.
3. **Planner target at `pr-open`** — scoping is available wherever Request Changes → Planner is available; confirm no additional PR-phase concerns (the code path is the same `routeHumanFeedback`).
