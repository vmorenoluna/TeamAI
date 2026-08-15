# Targeted Human Feedback — Implementation Plan

**Status:** Draft (to be reviewed before implementation)
**Date:** 2026-08-15
**Scope:** Let the human reviewer explicitly choose which agent (analyst, planner,
coder, or QA reviewer) receives their comment, instead of always bouncing to the
coder. Preserve prior work (plan + code) instead of throwing it away.

---

## 1. Goal

Today a human "Request Changes" comment is always routed to the **coder** via the
`implement` phase, with no way to address the analyst, planner, or QA reviewer
directly. This plan makes the **target agent** an explicit, required choice on
every feedback submission, routes the comment to that agent, makes the comment
**override** all other agent-produced directives, and **preserves** all work that
is still relevant when the pipeline re-runs.

---

## 2. Requirements (from the user)

1. **No default target.** The user MUST always pick a target; the submission is
   rejected (or the button disabled) until a target is chosen.
2. **Human feedback overrides everything.** The human's words take precedence over
   the spec, plan, QA report, and any other agent's directives for the targeted
   agent. Never let a stale spec/plan "win" over the human.
3. **One shared implementation.** The same mechanism for every role/phase; common
   logic (write, read, override-block, target→phase routing, artifact preservation)
   lives once and is shared by all phases.
4. **No blind cleanup / preserve work.** Re-running a phase must not discard work
   that is still relevant:
   - Spec revision must NOT delete the plan or code. The planner re-plans while
     **keeping completed subtasks that are still valid** and their already-written
     code; only affected subtasks re-run.
   - The same preservation principle applies to every phase — keep what makes sense.
5. **Tests.** Add/update unit + component tests for every change.

---

## 3. Current behavior (baseline)

Feedback entry point is `review-panel.tsx` → `handleReject` →
`rejectTask(taskId, feedback)` (server action) → `orchestrator.rejectTask` →
`rejectTask` in `src/lib/orchestrator/review-actions.ts`.

`rejectTask` today:
- writes `human_feedback.md` (`# Human Review Feedback\n\n{feedback}`),
- snapshots it to `human_feedback_before_bounce.md`,
- appends a `Change Request` FAIL criterion to `qa_report.json`,
- resets retry counters,
- **hard-codes** `advancePhase(pipeline, 'implement')` → always the coder.

The coder only reads the comment via `buildSubtaskFeedback()` in `implement.ts`,
which **early-returns `''` unless `qa_feedback.md` exists** (`if (!hasQaFeedback) return ''`).

### Known gaps this plan fixes

- **G1 — no targeting.** Only the coder is reachable (via "Request Changes"), and
  the analyst only via "Revise Spec" (which carries QA `spec_concerns`, not the
  human's own words). Planner and QA reviewer have no channel at all.
- **G2 — the comment can be dropped.** A plain reject from `awaiting-review`/
  `pr-open` (QA passed → all subtasks `completed`, no `qa_feedback.md`) hits
  `selectSubtasks` → `effectiveSubtasks` is empty → `[SKIP] All subtasks already
  completed` → straight back to QA. The comment is not reliably injected on the
  first bounce, so the task can bounce for free.
- **G3 — blind cleanup.** `autoReviseSpec` deletes `plan.json` on spec revision,
  discarding the planner's work and forcing a full re-plan; completed subtasks and
  their code are conceptually still valid but get thrown away.

---

## 4. Design

### 4.1 Feedback envelope + shared module (req 3)

New module `src/lib/orchestrator/human-feedback.ts` — the single source of truth
for everything below. No other file reads/writes feedback directly.

```ts
export type FeedbackTarget = 'analyst' | 'planner' | 'coder' | 'qa-reviewer';

export interface HumanFeedback {
  target: FeedbackTarget;
  message: string;
}
```

- **Write:** `writeHumanFeedback(specPath, feedback)` writes a single
  `human_feedback.md` with a machine-parseable header, so the existing UI banner,
  read, restore, and cleanup paths keep working without a new file:

  ```
  # Human Review Feedback
  Target: <target>

  <message>
  ```

- **Read:** `readHumanFeedback(specPath)` returns `HumanFeedback | null`, parsing
  the `Target:` header; a missing `Target:` line (legacy files) yields
  `target: undefined` and is only ever read defensively — every new write carries a
  target.
- **Override block:** `buildOverrideDirective(feedback)` returns the single,
  shared text block injected into a target agent's prompt (see 4.3).
- **Routing:** `targetToResumePhase(target): PipelinePhase`.
- **Matching:** `selectReworkTargets(plan, feedback)` — best-effort selection of
  plan subtasks to re-run for a `coder` target (see 4.5).

### 4.2 Target → resume phase (req 3)

One shared map (also exposed for the UI/validation):

| Target        | Resume phase | Cascade                         |
| ------------- | ------------ | ------------------------------- |
| `analyst`     | `spec`       | spec → plan → implement → QA    |
| `planner`     | `plan`       | plan → implement → QA           |
| `coder`       | `implement`  | implement → QA                  |
| `qa-reviewer` | `qa-review`  | QA (re-review current code)     |

### 4.3 Override semantics (req 2)

`buildOverrideDirective(feedback)` returns a block like:

```
## 🧑 HUMAN DIRECTIVE — OVERRIDES EVERYTHING ELSE

The human reviewer sent this instruction for YOU, <role>. It takes precedence
over the spec, the plan, the QA report, and any other agent's directives
wherever they conflict. If any of those documents tell you otherwise, follow
this directive instead and note the deviation in your summary.

<message>
```

Injection rule (shared, implemented once in a helper `humanDirectiveFor(pipeline, phaseRole)`):
- **Target agent** gets the full override block (matched by the phase's role vs
  `feedback.target`).
- **Downstream agents** get no override — they read the target's revised artifact
  (analyst's revised spec → planner; planner's revised plan → coder).
- **QA reviewer is the exception** (it verifies against spec/plan, so it must not
  contradict a human directive that targeted another agent): when the feedback is
  still live at QA time, QA gets a "context" block — the full override if
  `target === 'qa-reviewer'`, otherwise a lower-priority note ("the human directed
  the <target> to do X — verify it was done, don't flag it as a deviation").

Each command template (`defaults/commands/{spec,plan,implement,qa-review}.md`) and
role file (`defaults/roles/{analyst,planner,coder,qa-reviewer}.md`) gets the same
rule so the agent honors the directive even if the runtime block is stripped.

### 4.4 Shared routing (req 3)

Replace the body of `rejectTask` with a single shared function:

```ts
export async function routeHumanFeedback(
  pipeline, deps, feedback: HumanFeedback,
): Promise<void> {
  writeHumanFeedback(pipeline.specPath, feedback);          // 1. persist
  recordChangeRequest(pipeline, feedback);                  // 2. audit in qa_report.json
  resetAllCounters(pipeline);                               // 3. clean budget
  trimArtifactsForTarget(pipeline, feedback.target);        // 4. preserve (4.5)
  const next = targetToResumePhase(feedback.target);        // 5. route
  deps.advancePhase(pipeline, next);
  await deps.executePhase(pipeline);
}
```

`rejectTask(taskId, message, target)` validates the phase (still
`awaiting-review` / `pr-open`) and the target (must be one of the four), then
delegates to `routeHumanFeedback`.

`autoReviseSpec` (the QA auto-revision path) reuses `trimArtifactsForTarget(pipeline, 'analyst')`
so the auto path and the human path share the same preservation logic.

### 4.5 Artifact preservation — no blind cleanup (req 4)

New shared helper `trimArtifactsForTarget(pipeline, target)` replaces the ad-hoc
`clearArtifacts` + `REVISION_CLEANUP_EXTRA` deletions. **Default rule: keep
`spec.md`, `plan.json`, the feature branch, and all code commits unless the target
agent must regenerate them.**

| Target        | Keep (never delete)                                  | Delete (regenerated by the target)                  |
| ------------- | ---------------------------------------------------- | --------------------------------------------------- |
| `analyst`     | `plan.json`, code commits, worktree/branch           | `qa_report.json`, `qa_feedback.md`, `completion_summary.md` (QA artifacts only) |
| `planner`     | `spec.md`, code commits, `plan.json` (as input)      | `qa_report.json`, `qa_feedback.md`, `completion_summary.md` |
| `coder`       | `spec.md`, `plan.json`, code commits                 | (nothing — rework is driven by flagged subtasks)    |
| `qa-reviewer` | `spec.md`, `plan.json`, code commits                 | `qa_report.json`, `qa_feedback.md`, `completion_summary.md` |

**Spec revision no longer deletes `plan.json`.** Instead:

1. `autoReviseSpec`/analyst path snapshots the current `spec.md` → `spec_v{N+1}.md`
   (existing naming), writes `spec_revision_feedback.md` (QA `spec_concerns` +
   human message), and clears **only QA artifacts**.
2. The planner runs in a new **re-plan mode** (mirrors spec revision mode):
   - reads the existing `plan.json` and the revised `spec.md`,
   - **keeps completed subtasks whose `files` and `acceptance_criteria` are still
     covered by the revised spec** (and their code — already committed on the
     branch),
   - marks only affected/invalidated subtasks `completed: false` (and clears their
     `qa_flagged` if irrelevant) so implement re-runs just those,
   - re-plans the structure only where the feedback demands it.
3. `runPlanPhase` gains a re-plan branch (like `runSpecPhase`'s `isRevision`), and
   `selectSubtasks` continues to skip `completed` subtasks, so untouched code is
   never re-implemented or discarded.

**Coder rework fix (G2).** For a `coder` target, `selectReworkTargets(plan, feedback)`
marks affected subtasks `qa_flagged` (keyword match on `files`/`acceptance_criteria`;
fallback: all subtasks) so the existing QA-rework machinery re-runs them instead of
hitting `[SKIP]`. The `buildSubtaskFeedback` gating bug is fixed by injecting the
override block whenever `readHumanFeedback(...).target === 'coder'`, independent of
`hasQaFeedback`.

### 4.6 Feedback lifecycle (req 3)

- Write at submit (4.4 step 1); snapshot to `human_feedback_before_bounce.md` as
  today.
- The target agent reads the override (4.3); downstream agents read the revised
  artifact; QA reads the override/context block if the feedback is still live.
- **Consumption** (delete the file) happens at the phase boundary determined by the
  target, via one shared `consumeFeedbackIfDue(pipeline, phase)`:
  - `analyst` → after `spec` (intent is now baked into the revised spec),
  - `planner` → after `plan` (baked into the revised plan),
  - `coder` → after `qa-review` (coder override + QA context, then done),
  - `qa-reviewer` → after `qa-review`.
- Remove the blanket `unlinkSync(human_feedback.md)` at the end of implement and
  rely on the shared consumption rule instead (a coder-targeted directive must
  survive implement so QA can see it).
- `restoreHumanFeedbackFromSnapshot` / retry path unchanged (`.md` only).

### 4.7 UI (req 1)

`review-panel.tsx`:
- Replace the bare "Request Changes" textarea with a **required target selector**
  (segmented control or dropdown): Analyst (spec) / Planner / Engineer / QA reviewer.
- No default selection; the submit button is disabled until **both** a target and a
  non-empty message are present.
- Button label reflects the target, e.g. "Send to Engineer".
- `handleReject` calls `rejectTask(taskId, message, target)`.

Server action `app/actions/tasks.ts`:
- `rejectTask(taskId, message, target)` validates `target` against the four values
  and throws a clear error if missing/invalid.

---

## 5. Files to change

**New**
- `src/lib/orchestrator/human-feedback.ts` — shared module (4.1–4.6).
- `src/lib/orchestrator/feedback-target.ts` — client-safe target constants/labels
  (no `fs` import) so the review panel can import them without bundling Node's
  `fs` into the browser.

**Core**
- `src/lib/orchestrator/review-actions.ts` — `rejectTask` signature + delegation to
  `routeHumanFeedback`; `autoReviseSpec` uses shared `trimArtifactsForTarget('analyst')`
  and stops deleting `plan.json`.
- `src/lib/orchestrator/artifacts.ts` — replace `REVISION_CLEANUP_EXTRA` usage with
  the target-aware trim helper (keep the registry as the canonical file list).
- `src/lib/orchestrator/phase-runners.ts` — `runSpecPhase` injects the override for
  `analyst`; `runPlanPhase` gains re-plan mode + override for `planner`.
- `src/lib/orchestrator/implement.ts` — fix `buildSubtaskFeedback` gating; inject
  override for `coder`; `selectReworkTargets` to force rework (G2).
- `src/lib/orchestrator/qa-review.ts` — inject override for `qa-reviewer` when
  re-reviewing.
- `src/lib/orchestrator/helpers.ts` / `src/lib/task-artifacts.ts` — read/write via
  the shared module (single `.md` with `Target:` header); restore snapshot unchanged.

**UI**
- `src/components/review-panel.tsx` — target selector + required-target handling.
- `src/app/actions/tasks.ts` — `rejectTask` signature + validation.

**Prompt templates**
- `defaults/commands/spec.md`, `plan.md`, `implement.md`, `qa-review.md`
- `defaults/roles/analyst.md`, `planner.md`, `coder.md`, `qa-reviewer.md`
  — add the "human directive overrides everything" rule + (planner only) re-plan
  instructions.

---

## 6. Test plan (req 5)

**Unit — shared module**
- `writeHumanFeedback` writes `.md` with the `Target:` header.
- `readHumanFeedback` parses the `Target:` header; legacy `.md` without a target
  yields `target: undefined`.
- `targetToResumePhase` maps all four targets; rejects invalid ones.
- `trimArtifactsForTarget` keeps `plan.json`/code for `analyst`, deletes only QA
  artifacts, etc.

**Unit — routing**
- `rejectTask` with each target advances to the correct phase.
- `rejectTask` throws on missing/invalid target.
- `autoReviseSpec` no longer deletes `plan.json`; completed subtasks survive.
- `selectReworkTargets` marks subtasks for a `coder` reject (G2 — no `[SKIP]`).

**Unit — override injection**
- Full override appears in the target agent's prompt only; downstream (non-QA)
  phases get none.
- QA gets the full override for `qa-reviewer` target, and a context note for a
  `coder` target.
- `buildSubtaskFeedback` surfaces the human override when target is `coder` even
  with no `qa_feedback.md`.

**Component**
- `review-panel.test.tsx`: target selector renders; submit disabled until target +
  message set; `rejectTask` called with the chosen target.
- Update `task-panel`/`spec-diff-view` tests only if labels change.

**Existing suites to keep green**
- `orchestrator-human-feedback-guard.test.ts`, `reject-task-snapshots.test.ts`,
  `orchestrator.test.ts` (rejectTask describe), `review-panel.test.tsx`,
  `artifact-registry.test.ts`, `orchestrator-robustness.test.ts`,
  `select-subtasks-snapshot.test.ts`, and E2E
  (`tests/e2e/kanban-behaviors.spec.ts` "Request Changes"/"Send Back" assertions).

---

## 7. Implementation order

1. Shared module + unit tests (`human-feedback.ts`).
2. Target-aware trim + shared routing in `review-actions.ts`; keep `rejectTask`
   backwards-compatible behind the new `routeHumanFeedback`.
3. `rejectTask`/server-action signature + validation; UI target selector.
4. Override injection into spec/plan/implement/qa-review phase runners.
5. Re-plan mode in `runPlanPhase` + `autoReviseSpec` preservation (no plan.json
   delete).
6. `selectReworkTargets` + `buildSubtaskFeedback` fix (G2).
7. Prompt/role template updates.
8. Full test pass: `npm run typecheck && npm run lint && npm run test:unit`,
   then `npm run test:integration` and `npm run test:e2e:smoke`.

---

## 8. Known issue to preserve (not in scope, do not regress)

The spec-version snapshot naming has a pre-existing off-by-one (`autoReviseSpec`
snapshots `spec.md` *before* the analyst rewrites it but names it with the
post-increment number). The re-plan/preservation work must not make this worse; a
separate follow-up can correct the numbering.
