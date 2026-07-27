# Role Refinement Assistant — Design & Implementation Plan

Status: proposed
Author: design pass (grounded in current `teamai/src` architecture, 2026-07)
Audience: any engineer picking this up to implement.

---

## 1. Problem statement

TeamAI runs multi-agent pipelines (`spec → plan → implement → qa-review → merge/create-pr`,
plus `failed`/`backlog`) against arbitrary user projects. Each project has editable role
prompts at `.claude/roles/{coder,planner,analyst,merger,qa-reviewer,qa-fixer}.md`, scaffolded
from `teamai/defaults/roles/*.md` on registration and thereafter owned per-project
(`ProjectStore.syncDefaults` intentionally never auto-syncs `roles/` — see
`project-store.ts` `_getDefaultsManifest`, which only tracks `commands/` and
`teamai-workflow.md`).

**The recurring-failure class we must catch.** In a real project (Sample-project), two tickets each
failed repeatedly — one after 7 QA attempts, one after 3 — for the *same* root cause every
time: a required verification artifact from a long (~1–2 h) sweep never got committed. The
true causes were all **role-prompt gaps**:

1. The project `.gitignore` silently blocked `git add` on the evidence path (needed
   `git add -f`), and neither `coder.md` nor `planner.md` mentioned it — the planner even
   emitted a literal `git add` example missing `-f`, so a compliant coder produced a broken
   commit.
2. The sweep outlives one coder session. TeamAI *has* a mechanism for this (the coder writes
   `subtask_wakeup-st<id>.json`; the orchestrator re-enters with a `⚠️ WAKEUP RE-ENTRY`
   header — see `implement.ts` `runSubtaskSession` and `orchestrator.ts` `_scheduleWakeup`),
   but the role prompts never documented the filename/schema or the detach (`nohup … & disown`)
   requirement. One session called an interactive `ScheduleWakeup`-style tool (a no-op in a
   headless session); another left the process attached to its shell, so it died at session
   end and every wakeup restarted the multi-hour sweep from scratch, burning QA attempts.

A human found this only by manually reading `output-st<id>.log`, `output-qa.log`,
`qa_report.json`, and `plan.json` across several failed attempts, then hand-editing
`coder.md`/`planner.md` (both the project copies and the shared defaults). The role prompts
have since been fixed (see `teamai/defaults/roles/coder.md` §"Running Verification Scripts &
Servers"), but the *system* still can't catch the next instance of this class on its own.

**Goal.** Give TeamAI users ongoing, low-friction support to **refine their own project's role
prompts from real ticket signal**, so "the same failure keeps recurring because a role prompt
has a gap" is surfaced and fixed by the system — not only by an attentive human reading five
log files after the fact.

---

## 2. Recommended answers to the open questions

Each is a recommendation, not a menu.

### 2.1 Most effective mechanism & best UX
**An analyst-driven failure post-mortem that emits diffable role-prompt patch *suggestions*,
surfaced in two existing places: an inline card on the failed task's Overview tab, and an
aggregated "Role Refinements" panel in Settings next to the Agent Roles editor.** The engine
reuses the proven **insights side-channel** pattern (a headless Claude session spawned via
`processManager.createSession`, exactly like `getOrCreateInsightsSession` in
`actions/insights.ts`) and the review-and-apply UX of the **defaults-updater** banner. Nothing
new is invented at the infrastructure level; we compose two patterns that already ship.
*Justification:* the failure artifacts the analyst needs (`qa_report.json`, `completion_summary.md`,
`output-*.log`, `plan.json`, `events.jsonl`) are already written per task, and the write target
(`.claude/roles/*.md`) already has a safe server-action path (`saveRole`/`resetRole` in
`actions/roles.ts`). The only genuinely new asset is the analysis prompt and a small
suggestion-record store.

### 2.2 Standalone feature vs pipeline-integrated
**A side-channel hung off the `failed` phase — not a new pipeline phase.** It listens for the
`failed` phase-change event, runs asynchronously, and writes to *project config* (role files)
rather than task artifacts. *Justification:* the pipeline state machine
(`Orchestrator.executePhase`) is deliberately tight and crash-recovery-sensitive (pipeline
state, wakeup timers, QA-attempt budgets). Inserting a refinement phase would entangle role
edits with task lifecycle, retry budgets, and worktree state for no benefit. A side-channel
that only *reads* task artifacts and *writes* config is decoupled, testable in isolation, and
can be toggled off without touching the pipeline.

### 2.3 Every failure vs selective
**Selective and tiered.** On-demand manual analysis is available on *any* single failed task
at any time. *Automatic* analysis fires only on a **recurrence signal**:
- a QA criterion has persisted-failed across ≥2 consecutive QA cycles (TeamAI already computes
  this — `qa-review.ts` `persistedCriterionFailCounts` and the `[QA-ESCALATE]` log lines), **or**
- the same task has reached `failed` ≥2 times, **or**
- ≥2 distinct tasks failed with overlapping FAIL-criterion signatures within a rolling window.

*Justification:* most single failures are genuine code/spec difficulty, not role-prompt gaps;
analyzing every one wastes tokens and produces noise. Recurrence is precisely the signal that
distinguishes "the agent keeps making the same avoidable mistake" (a prompt gap) from "this
task is hard." The manual button covers the long tail where a user *suspects* a gap after one
failure.

### 2.4 Enable/disable for token control
**Yes — a three-way per-project mode plus a hard cap.** New `.teamai/role-refinement.json`
(mirrors `auto-mode.json`): `mode: 'off' | 'manual' | 'auto'` (default **`manual`**),
`autoApply: false`, `maxAutoAnalysesPerDay: 5`. `off` hides the feature entirely and registers
no listener; `manual` never auto-runs (button only); `auto` runs on the recurrence trigger
under the daily cap. *Justification:* analysis is a full agent session (non-trivial tokens);
the default must be zero background spend, opt-in escalation, and a spend ceiling even when
opted in. Storing this per project (not global) matches how `auto-mode` and `pipeline.json`
already scope behaviour.

### 2.5 Auto-retry after a refinement is applied
**Offer it; never do it silently. Auto-retry only in `auto` mode with `autoApply` opted in
AND the pipeline auto-runner (`auto-mode`) also enabled — and even then behind a retry-loop
guard.** In the default path, applying a suggestion presents an **"Apply & Retry"** button that
re-runs the failed task via the existing `retryTask` action. *Justification:* a role edit only
takes effect on the next run (`buildSessionOpts` reloads role context per session), so retry is
the natural validation step — but a silent auto-retry loop is exactly how a bad refinement
becomes runaway spend. Human-in-the-loop retry by default; automatic retry only under
compounded explicit opt-ins, and never twice for the same failure signature (see §7).

### 2.6 User say in whether a change is applied
**Yes — always, and by default it is the only way.** A suggestion is shown as a **unified diff
against the current role file**, is **editable inline** before applying (same textarea affordance
as `RoleEditor`), and requires an explicit **Apply**. Every apply writes a timestamped backup
enabling **one-click revert**. Auto-apply is a Phase-3 opt-in, restricted to *additive,
size-capped, high-confidence* edits, and still logged + revertable. *Justification:* role
prompts are load-bearing project config that affects every future ticket; unreviewed automated
edits risk silent regressions and prompt churn. The human-review default makes the assistant a
suggester, not an autonomous editor, until the user explicitly trusts it further.

---

## 3. End-to-end flow

```
                        ┌─────────────────────────────────────────────┐
   task reaches         │  RoleRefinementWatcher (server-boot listener)│
   phase 'failed'  ───► │  on 'phase-change' {phase:'failed'}          │
   (processManager      │  • mode==='off'      → ignore                │
    .emit)              │  • mode==='manual'   → ignore (button only)  │
                        │  • mode==='auto'     → detectRecurrence()     │
                        └───────────────┬─────────────────────────────┘
                                        │ recurrence hit && under daily cap
   user clicks                          ▼
   "Analyze failure"  ─────────►  analyzeFailure(projectRoot, taskId, trigger)
   (manual, any mode≠off)               │
                                        ▼
              spawn headless 'analyst' session (insights-style)
              prompt = failure artifacts (as paths) + current role files
                                        │
                                        ▼
              analyst returns structured JSON:
              { isRolePromptGap, rootCause, confidence, edits[] }
                                        │
                        ┌───────────────┴───────────────┐
              isRolePromptGap=false            isRolePromptGap=true
                        │                               │
              persist record status            persist record status
              'no-gap' (+diagnosis)            'suggested' (+edits)
                        │                               │
                        ▼                               ▼
              inline card shows              inline card + Settings panel show
              "Not a role-prompt gap:        per-file diff, confidence,
               <diagnosis>"                  root cause
                                                        │
                              user: Edit / Apply / Apply&Retry / Dismiss
                                                        │
                        ┌───────────────────────────────┼───────────────────┐
                     Apply                         Apply&Retry            Dismiss
                        │                               │                   │
              backup + saveRole()            backup+saveRole()+retryTask   status
              status 'applied'               status 'applied'              'dismissed'
```

**When analysis triggers.** (a) Manually, via the "Analyze failure" button on any `failed`
task when `mode !== 'off'`; (b) automatically, when a task hits `failed`, `mode === 'auto'`,
`detectRecurrence()` returns a hit, and the daily cap isn't exhausted.

**What it analyzes.** For the target task (and, on the recurrence path, the sibling tasks in the
signature cluster): `qa_report.json`, `qa_report_before_bounce.json`, `qa_report_before_failed.json`,
`completion_summary.md`, `qa_feedback.md`, `plan.json`, `events.jsonl`, and the per-role logs
`output-st<id>.log` / `output-qa.log` / `output-plan.log`. Plus the current contents of the six
role files. Paths are handed to the analyst (never pre-summarized — same discipline as the
composer-log rule in project memory).

**What it produces.** One `RoleRefinementSuggestion` record (§4) with a per-role-file edit list
(each edit is a full proposed file body or an append block + rationale), a plain-language root
cause, a confidence, and an `isRolePromptGap` verdict.

**How the user sees it.** Inline card on the failed task's Overview tab; aggregated list in the
Settings "Role Refinements" panel; optional sidebar count badge (Phase 2).

**Accept/reject/edit.** Inline diff, editable textarea, `Apply` / `Apply & Retry` / `Dismiss`.
Applying writes the role file through `saveRole` after snapshotting a backup.

**What happens to the role file.** Overwritten (replace) or appended (append) via the existing
`saveRole` server action, which already validates the filename against the project's role dir.
A backup copy is written first for revert.

**Auto-retry.** Only via explicit `Apply & Retry`, or the Phase-3 auto-apply policy.

---

## 4. Data model additions

All new state lives under the project's `.teamai/` (kept out of git by the existing `.teamai/*`
ignore rule — these are runtime/config, not task artifacts).

### 4.1 `.teamai/role-refinement.json` — feature config (new, mirrors `auto-mode.json`)
```jsonc
{
  "mode": "manual",              // 'off' | 'manual' | 'auto'
  "autoApply": false,            // Phase 3 only; additive/low-risk edits only
  "maxAutoAnalysesPerDay": 5,    // hard spend ceiling for the 'auto' trigger
  "recurrenceThreshold": 2       // consecutive/aggregate failures before auto-trigger
}
```
Load/save helpers mirror `auto-mode.ts` `loadAutoModeState`/`saveAutoModeState`.

### 4.2 `.teamai/role-refinements/<suggestionId>.json` — suggestion records (new dir)
A sibling of the per-task dirs (scanned like tasks; small volume). One file per suggestion:
```jsonc
{
  "id": "<uuid>",
  "createdAt": "<ISO8601>",
  "updatedAt": "<ISO8601>",
  "status": "pending" | "analyzing" | "suggested" | "no-gap" | "applied" | "dismissed" | "superseded",
  "trigger": "manual" | "recurrence" | "auto",
  "sourceTaskIds": ["<taskId>", "..."],     // failures that motivated this
  "signature": "sha256:<hash>",              // dedupe key: sorted FAIL-criterion names + role set
  "isRolePromptGap": true,
  "rootCause": "Coder never force-adds gitignored evidence logs; planner emits `git add` without -f.",
  "confidence": "high" | "medium" | "low",
  "diagnosis": "<free text, always present — the 'why', shown even when isRolePromptGap=false>",
  "edits": [
    {
      "roleFile": "planner.md",             // must be an existing file in .claude/roles/
      "mode": "append" | "replace",
      "rationale": "Planner must instruct coders to use `git add -f` for gitignored evidence.",
      "proposedContent": "<full new file body if replace; block to append if append>",
      "riskClass": "additive" | "modifying"  // gates Phase-3 auto-apply
    }
  ],
  "appliedAt": null,
  "appliedBy": null,                          // 'human' | 'auto'
  "backups": [                                // one per edited file, for revert
    { "roleFile": "planner.md", "backupPath": ".teamai/role-refinements/backups/<id>-planner.md" }
  ]
}
```
*Why full `proposedContent` instead of before/after snippets:* exact-match snippet application
is fragile (whitespace, drift). The UI diffs `proposedContent` against the live file; applying
is a whole-file `saveRole` (replace) or `current + "\n\n" + block` (append). No brittle string
matching at apply time.

### 4.3 `Task` field additions (`task-store.ts` `interface Task`)
Purely to drive the inline card without a directory scan on every render:
```ts
refinementStatus?: 'none' | 'analyzing' | 'suggested' | 'no-gap';  // latest analysis outcome
refinementSuggestionId?: string;                                    // newest suggestion for this task
refinementRetryCount?: number;                                      // retry-loop guard (§7)
```

---

## 5. UI additions

### 5.1 Inline card on the failed task — `components/task-detail.tsx`
Add directly **below** the existing red "Task Failed" completion-summary banner (the
`task.phase === 'failed' && task.completionSummary` block, lines ~340–367). New component
`components/role-refinement-card.tsx`:

- **Idle** (`refinementStatus` absent/`none`, mode ≠ `off`): a slim row —
  *"Keeps failing the same way? Analyze whether a role prompt has a gap."* + button
  **`🔍 Analyze failure`**. Calls `analyzeFailedTask(task.id)`.
- **Analyzing** (`analyzing`): spinner + *"Reading QA reports and agent logs…"* (reuse the
  `useStreamProgress` progress-line trick from `insights-chat.tsx` for live status if streaming
  the analyst session; otherwise a static pending state polled via `refinementStatus`).
- **No gap** (`no-gap`): neutral card — *"Not a role-prompt gap"* + the analyst `diagnosis`
  text + a `Dismiss` link. No edits offered.
- **Suggested** (`suggested`): the payoff card:
  - Header: *"Suggested role-prompt refinement"* + confidence pill (`high`/`medium`/`low`)
    styled like the existing phase badges.
  - `rootCause` one-liner.
  - Per edit: filename + `append`/`replace` tag + rationale + a **unified diff** of
    `proposedContent` vs current file. Reuse the diff renderer from `spec-diff-view.tsx`
    (`SpecDiffView` already does line-diff rendering for spec versions — factor its diff body
    into a shared `<UnifiedDiff current=… proposed=… />` or call it directly).
  - An **Edit** toggle that swaps the diff for an editable `<textarea>` (same styling as
    `RoleEditor`), letting the user hand-tune `proposedContent` before applying.
  - Buttons: **`Apply`**, **`Apply & Retry`**, **`Dismiss`**. Apply/Retry disabled while a
    server mutation is pending (reuse `useServerMutation`).

### 5.2 Settings "Role Refinements" panel — `app/settings/page.tsx`
New `<section>` above the existing "Agent Roles" section, plus new component
`components/role-refinement-settings.tsx`:

- **Mode control**: segmented `Off / Manual / Auto` (writes `role-refinement.json` via
  `setRoleRefinementConfig`); when `Auto`, reveal `autoApply` checkbox (with a warning:
  *"Only additive, low-risk edits are ever auto-applied, and every change is backed up and
  revertable."*) and the `maxAutoAnalysesPerDay` number input.
- **Pending suggestions list** (across all tasks), rendered defaults-updater-style
  (`defaults-updater.tsx` is the visual template): each row shows source-task title(s),
  root cause, affected role files, confidence, and `Review` (jump to the task card) / `Apply` /
  `Dismiss`. Applied/dismissed items collapse into a details summary like `CompletedResults`.
- **Applied-refinements history** with per-item **Revert** (restores the backup via
  `revertRefinement`).

### 5.3 Sidebar badge (Phase 2, optional) — `components/sidebar.tsx`
A small count bubble on the **Settings** nav item equal to the number of `suggested`-status
records, so users notice pending refinements without opening each failed task.

---

## 6. Backend / orchestrator additions

### 6.1 New lib: `teamai/src/lib/role-refinement.ts`
- **Config**: `getRoleRefinementConfig(projectRoot)`, `setRoleRefinementConfig(projectRoot, cfg)`
  — load/save `.teamai/role-refinement.json` (copy the shape of `auto-mode.ts`).
- **Store**: `listSuggestions(projectRoot)`, `getSuggestion(projectRoot, id)`,
  `writeSuggestion(...)`, `updateSuggestion(...)`, `suggestionsForTask(projectRoot, taskId)` —
  read/write `.teamai/role-refinements/*.json` (atomic temp-then-rename, like the plan writes in
  `implement.ts`).
- **Recurrence detection**: `detectRecurrence(projectRoot, taskId): { hit: boolean; cluster: string[]; signature: string }`.
  Reads the target's `qa_report.json` vs `qa_report_before_bounce.json`/`_before_failed.json` for
  identical FAIL-criterion names, counts prior `failed` transitions from `events.jsonl`, and scans
  other recently-`failed` tasks for overlapping FAIL-criterion signatures within the window.
  Builds `signature` = `sha256(sortedFailCriterionNames + affectedRoleGuess)`.
- **Analyzer**: `analyzeFailure(projectRoot, taskId, trigger): Promise<string /*suggestionId*/>`.
  1. Create/mark a suggestion record `analyzing`; stamp `task.refinementStatus = 'analyzing'`.
  2. Spawn a headless session: `processManager.createSession({ taskId: 'role-refinement::'+taskId,
     role: 'analyst', cwd: projectRoot, ...containerSessionOpts(projectRoot),
     ...providerToSessionOpts(resolveProvider(projectRoot,'analyst')) })` — i.e. the
     insights-session recipe with role `analyst` and the project's configured analyst model.
  3. `sendMessage` the analysis prompt (§6.3); `waitForCompletion`; `killSession`.
  4. Parse the structured JSON block from the transcript (same discipline as reading
     `qa_report.json`: instruct an exact output path/format; parse defensively).
  5. Write edits/rootCause/confidence/verdict into the record → status `suggested` or `no-gap`;
     update the task's `refinementStatus`/`refinementSuggestionId`.
  Runs **in the background** (fire-and-forget from the server action, like `orchestrator.runTask`).
- **Apply / dismiss / revert**:
  - `applyRefinement(projectRoot, id, overrides?)`: for each edit, snapshot the current role
    file to `backups/<id>-<file>`, then write via the **existing** `saveRole` logic
    (import/refactor `actions/roles.ts` `saveRole` into a lib fn so it's callable server-side
    without the action boundary), applying `overrides[roleFile]` if the user hand-edited.
    Mark `applied`, record `appliedBy`.
  - `dismissRefinement`, `revertRefinement` (restore backups, mark `dismissed`/reverted).
- **Dedupe/supersede**: before writing a new record, if a `suggested`/`pending` record with the
  same `signature` exists, mark the old one `superseded` (never stack duplicates).

### 6.2 New watcher: `teamai/src/lib/role-refinement-watcher.ts`
A boot-time listener, independent of `auto-mode` so manual/auto works even when the pipeline
auto-runner is off. `startRoleRefinementWatcher()` (called from `server.ts` startup next to
`restoreAutoModeStates()`): subscribes to `processManager.on('phase-change')`; on
`phase === 'failed'`, loads config, and if `mode === 'auto'` + `detectRecurrence().hit` +
under the daily cap + no `superseded`/`applied` record already covers this signature +
`task.refinementRetryCount` below the loop cap → calls `analyzeFailure(…, 'auto')`.

### 6.3 Analyst prompt (the actual analysis instruction)
Sent as the session message. Key elements:
- Role framing: *"You are diagnosing why a TeamAI pipeline ticket failed repeatedly. Decide
  whether the root cause is a **gap in a role prompt** (`.claude/roles/*.md`) — a missing
  instruction, a wrong example, or an undocumented mechanism — as opposed to genuine task
  difficulty, a spec problem, or a code bug."*
- Inputs as **paths** to read (never pre-summarized): the failure artifacts (§3) and the six
  role files.
- Guidance on the known gap-classes (from the case study): undocumented orchestrator mechanisms
  (e.g. the `subtask_wakeup-st<id>.json` schema and detach requirement), `.gitignore`/`git add -f`
  traps, planner-authored example commands that mislead the coder, interactive-only tools that
  no-op in headless sessions.
- Output contract: write a single JSON object to `.teamai/role-refinements/<id>.analysis.json`
  with `{ isRolePromptGap, rootCause, confidence, diagnosis, edits:[{roleFile, mode, rationale,
  proposedContent, riskClass}] }`, `mode:"append"` preferred for additive fixes. *"If it is not
  a role-prompt gap, set `isRolePromptGap:false`, leave `edits` empty, and explain the real cause
  in `diagnosis`."*
- Model: the project's configured **analyst** model (`providers.json`), defaulting to the analyst
  default (Sonnet-class) — analysis is a read-and-reason task, not a long agentic edit.

### 6.4 New server actions: `teamai/src/app/actions/role-refinement.ts` (`'use server'`)
`analyzeFailedTask(taskId)` (guards `mode !== 'off'`, task in `failed`; fire-and-forget),
`getRefinementSuggestions()`, `getSuggestionsForTask(taskId)`,
`applyRefinement(suggestionId, overrides?)`, `applyAndRetryRefinement(suggestionId, overrides?)`
(applies then calls `retryTask`, incrementing `refinementRetryCount`),
`dismissRefinement(suggestionId)`, `revertRefinement(suggestionId)`,
`getRoleRefinementConfig()`, `setRoleRefinementConfig(cfg)`. All `revalidatePath('/')` +
`revalidatePath('/settings')` as appropriate.

### 6.5 Touched existing files (summary)
- `task-store.ts` — three new optional `Task` fields (§4.3).
- `actions/roles.ts` — extract `saveRole`'s write body into a lib fn reusable by
  `applyRefinement` (keep the action as a thin wrapper).
- `server.ts` (custom server boot) — call `startRoleRefinementWatcher()` alongside
  `restoreAutoModeStates()`.
- `app/settings/page.tsx` — render the new settings panel + `getRoleRefinementConfig`.
- `components/task-detail.tsx` — mount `<RoleRefinementCard>` under the failure banner.
- `components/sidebar.tsx` — (Phase 2) pending-count badge.

---

## 7. Guardrails (anti-churn, anti-runaway-spend, anti-regression)

- **Human review is the default and only apply path** (Phases 1–2). Auto-apply is a distinct
  Phase-3 opt-in, restricted to `riskClass:"additive"`, size-capped (e.g. appended block
  ≤ ~1.5 KB), and `confidence:"high"` with `isRolePromptGap:true`.
- **Every apply is backed up + revertable.** `backups/<id>-<file>` is written before any
  `saveRole`; `revertRefinement` restores it. An applied-history list in Settings makes churn
  auditable.
- **Diff-before-apply, always.** The user sees exactly what changes; they can hand-edit
  `proposedContent` before applying.
- **Spend ceilings.** `mode` gating (`off` registers no listener); auto-trigger only on
  recurrence, not every failure; `maxAutoAnalysesPerDay` cap; **dedupe by `signature`** so the
  same root cause never spawns stacked analyses (old pending records are `superseded`).
- **Retry-loop guard.** `Apply & Retry` (and auto-apply retry) increments
  `task.refinementRetryCount`. If a task fails **again with the same `signature`** after a
  refinement was applied, the watcher does **not** auto-analyze/auto-apply again — it escalates
  to the user (*"A role refinement was applied but the task failed the same way — human review
  needed"*). This is the single most important guard: it converts a potential
  edit→retry→fail→edit loop into a one-shot with human fallback.
- **Project-scoped edits only.** Refinements edit the *project's* `.claude/roles/*.md`, never the
  shared `teamai/defaults/roles/*.md`. Upstreaming a good fix to the shared defaults stays a
  manual, human decision (explicitly out of scope here; a future "propose to defaults" affordance
  could reuse this record shape).
- **Non-gap outcomes are first-class.** When the analyst says it's not a role-prompt gap, we
  record the diagnosis and offer nothing to apply — the assistant must be comfortable saying
  "this isn't a prompt problem," or it will manufacture edits and cause regressions.
- **No pipeline coupling.** The watcher only reads task artifacts and writes config/records; it
  can never block, delay, or corrupt a running pipeline, and turning the feature `off` is
  instantaneous.

---

## 8. Phased implementation plan

**Phase 1 — Manual analysis + review UI (no automation).**
- `role-refinement.json` config (default `manual`) + `getRoleRefinementConfig`/`setRoleRefinementConfig`.
- Suggestion store (`.teamai/role-refinements/`), record shape, atomic writes.
- `analyzeFailure` engine (analyst session + prompt + JSON parse) — manual trigger only.
- Actions: `analyzeFailedTask`, `getSuggestionsForTask`, `applyRefinement`, `dismissRefinement`,
  `revertRefinement`.
- `<RoleRefinementCard>` on the failed task; backups + revert; extract `saveRole` write into a
  lib fn.
- Settings: mode toggle (Off/Manual) + pending list + history.
*Ships the core value: one-click post-mortem → diff → apply/edit/revert, fully human-driven.*

**Phase 2 — Auto-trigger on recurrence (still human-approval to apply).**
- `detectRecurrence` (persisted-criterion / repeated-task / cross-task signature clustering).
- `role-refinement-watcher.ts` + `startRoleRefinementWatcher()` at boot; `mode:'auto'` path with
  `maxAutoAnalysesPerDay` cap and `signature` dedupe/supersede.
- Sidebar pending-count badge; Settings gains the `Auto` mode option.
*Now the system catches recurring gaps unprompted, but a human still approves every edit.*

**Phase 3 — Auto-apply + auto-retry (opt-in, guarded).**
- `autoApply` policy: additive + size-capped + high-confidence only; `applyAndRetry` wired into
  the watcher **only** when `auto-mode` (pipeline auto-runner) is also enabled.
- Retry-loop guard (`refinementRetryCount` + same-signature escalation) enforced end-to-end.
- Applied-history/audit surfacing and one-click revert hardened.
*Full closed loop for users who opt in, with the loop guard preventing churn/runaway spend.*

---

## 9. Notes for the implementer
- The insights side-channel (`actions/insights.ts` + `components/insights-chat.tsx`) is the
  closest working prior art for spawning and (optionally) streaming the analyst session — copy
  its session lifecycle, including the `containerSessionOpts` + provider-resolution recipe.
- The defaults-updater (`components/defaults-updater.tsx`) is the closest prior art for the
  "here's a proposed change to your config — Apply/Dismiss" list UX; the Settings panel should
  read as its sibling.
- `SpecDiffView` (`components/spec-diff-view.tsx`) already renders line diffs for spec versions;
  factor out or reuse its diff body for the role-file diff.
- Keep role-file documentation *in the role files themselves* — this feature edits
  those files; it must not also write summaries of them into `Architecture.md`/README.
```
