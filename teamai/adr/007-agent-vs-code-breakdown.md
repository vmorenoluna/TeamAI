# ADR 007: Pipeline Phase Breakdown — Code Logic vs. Agent Sessions

**Date:** July 5, 2026  
**Status:** Accepted

## Purpose

This document catalogs, for each pipeline phase, exactly what is handled by coded logic (Node.js/TypeScript in the orchestrator) vs. what is delegated to a Claude subprocess agent session. It reflects the optimizations applied in July 2026 to replace agent sessions with direct CLI calls where the agent was doing mechanically simple, single-command work (PR creation, conflict-free merges).

## Summary Table

| Phase | Agent(s) spawned | Agent replaces? | Notes |
|-------|-----------------|-----------------|-------|
| Spec | `analyst` | ❌ No | Creative specification writing requires AI |
| Plan | `planner` | ❌ No | Task decomposition requires AI |
| Implement | `coder` (per subtask) | ❌ No | Code authoring requires AI |
| Implement — cherry-pick conflict | `merger` (only on conflict) | ⚠️ Partial | Tier-1: `git cherry-pick` (coded). Tier-2: agent resolves conflicts |
| QA Review | `qa-reviewer` | ❌ No | Code/spec comparison requires AI |
| QA Review — spec concerns | (auto-advances to spec) | N/A | Coded routing |
| Awaiting Review | (none — human gate) | N/A | Auto-approval in auto-mode is coded |
| Create PR | **✅ NONE (optimized)** | Was `merger`, now coded | `gh pr create` / `glab mr create` |
| Create PR — rebase conflict | `merger` (only on conflict) | ⚠️ Partial | Tier-1: `git rebase` (coded). Tier-2: agent |
| Merge | **✅ NONE if clean (optimized)** | Was `merger`, now coded | `git merge --no-edit` |
| Merge — rebase conflict | `merger` (only on conflict) | ⚠️ Partial | Tier-1: `git rebase` (coded). Tier-2: agent |
| Merge — merge conflict | `merger` (only on conflict) | ⚠️ Partial | Tier-1: `git merge --no-edit` (coded). Tier-2: agent |
| Merge — pre-merge sensors | `merger` (runs sensors) | N/A | Sensors are coded scripts, not agent sessions |

---

## Per-Phase Breakdown

### 1. Spec Phase (`runSpecPhase`)

**Agent:** `analyst` (1 session)

**Coded logic:**
- Output log rotation and phase header writing
- Spec revision detection (`spec_revision_feedback.md` exists → `REVISION:` prompt)
- Session lifecycle: `createSession` → `sendMessage` → `waitForCompletion` → `killSession`
- Revision feedback file cleanup after completion

**Agent does:**
- Reads task description (and revision feedback if present)
- Writes `spec.md` to the task's `.teamai/` directory
- For revisions: reads existing spec, incorporates feedback, produces revised spec

**File:** `teamai/src/lib/orchestrator/phase-runners.ts` (runSpecPhase)

---

### 2. Plan Phase (`runPlanPhase`)

**Agent:** `planner` (1 session)

**Coded logic:**
- Output log rotation and phase header writing
- Session lifecycle: `createSession` → `sendMessage` → `waitForCompletion` → `killSession`
- `git pull --ff-only origin master`
- Git worktree creation: `git worktree add <path> -b <branch>`
- Worktree creation retry with cleanup on failure

**Agent does:**
- Reads `spec.md`
- Produces `plan.json` (subtasks with files, acceptance criteria, dependencies)

**File:** `teamai/src/lib/orchestrator/phase-runners.ts` (runPlanPhase)

---

### 3. Implement Phase (`runImplement`)

**Agent:** `coder` (1 session per subtask; parallel within groups)

**Coded logic (substantial):**
- Docker gate: fails fast if Docker unavailable
- Snapshot restoration: `qa_report.json`, `human_feedback.md`
- `git pull --ff-only origin master`
- Worktree health checks and recreation
- Container mode: `.git` file patching
- Rebase onto latest master (with merger-agent fallback for conflicts)
- Stale per-subtask worktree cleanup
- Plan.json parsing and subtask filtering (QA-flagged only on bounce-back)
- Per-subtask worktree isolation (multi-subtask groups)
- Pre/post subtask sensors
- Scope violation detection: snapshots HEAD before session, runs `git diff --name-only` after, rejects subtask if unassigned files modified
- Deliverable verification: checks `files_to_create` exist on disk, circuit-breaker at `maxDeliverableFails`
- Cherry-pick from st-branches to main worktree (Tier-1: direct, Tier-2: merger agent)
- Wakeup scheduling for long-running background scripts
- Plan.json serialization lock (prevents race conditions on per-subtask checkpointing)
- `git push -u --force origin <branch>` with remote HEAD verification
- Sensor gate: failing post_subtask sensors → bounce to implement

**Agent does:**
- Reads subtask description, files, acceptance criteria
- Implements code changes, writes files
- Runs tests
- Git commits

**File:** `teamai/src/lib/orchestrator/implement.ts` (runImplement)

---

### 4. QA Review Phase (`runQaReview`)

**Agent:** `qa-reviewer` (1 session)

**Coded logic:**
- QA attempt counter increment
- Locked report detection: skips QA if `qa_report.json.locked === true`
- Manual override detection: skips QA if `reviewedBy` includes "manual override"
- Unpushed commit precheck: `git log origin/<branch>..<branch>`, auto-push if needed
- HEAD SHA stamping on report
- FAIL-type routing:
  - `fail_type === "cleanup"` → logs message, routes to implement
  - `spec_concerns` → auto-advances to spec revision
- Max attempt circuit breaker: `qaAttempt >= maxQaAttempts` → `failed`
- QA report snapshot before bounce-back

**Agent does:**
- Reads `spec.md` and the implemented code
- Validates each acceptance criterion
- Writes `qa_report.json` with criteria statuses, `spec_concerns`, `fail_type`

**File:** `teamai/src/lib/orchestrator/qa-review.ts` (runQaReview)

---

### 5. Create PR Phase (`runCreatePRPhase`) — **OPTIMIZED**

**Agent:** ~~`merger`~~ → **None (direct CLI)**

**Coded logic:**
- Rebase onto latest master (with merger-agent fallback for conflicts)
- Artifact commit to worktree
- `git push -u --force origin <branch>`
- Platform detection (`detectGitPlatform`)
- Existing PR check: `checkExistingPRViaCLI` → `gh pr list` / `glab mr list`
- PR creation: `createPRViaCLI` → `gh pr create` / `glab mr create`
- PR body generation: `buildPRBody` (spec content + task description)
- Fallback: `extractPrUrl` for Bitbucket/unknown platforms
- Task store update with platform and PR URL
- Phase advance to `pr-open`

**What was replaced:** Previously spawned a `merger` agent session with a platform-specific prompt telling the agent to create a PR. The agent's only job was to run `gh pr create` / `glab mr create` / Bitbucket API call — purely mechanical.

**File:** `teamai/src/lib/orchestrator/phase-runners.ts` (runCreatePRPhase)

---

### 6. Merge Phase (`runMergePhase`) — **OPTIMIZED**

**Agent:** ~~`merger`~~ → **None if clean; `merger` only on conflict**

**Coded logic:**
- Rebase onto latest master (with merger-agent fallback for conflicts)
- Artifact commit to worktree
- Pre-merge sensors (coded scripts, not agent sessions)
- **Direct merge attempt:** `git merge <branch> --no-edit` (Tier-1)
- **Merge abort on conflict:** `git merge --abort` (coded)
- **Agent fallback on conflict:** spawns `merger` agent (Tier-2)
- Worktree removal
- Phase advance to `done`

**What was replaced:** Previously always spawned a `merger` agent to run the merge, regardless of whether conflicts existed. Now the agent is only spawned when `git merge --no-edit` fails.

**File:** `teamai/src/lib/orchestrator/phase-runners.ts` (runMergePhase)

---

### 7. Auto Mode (`auto-mode.ts`)

**No agents spawned.** All auto-mode operations are coded logic:

- **Tick loop:** Every 5 seconds, picks backlog tasks (FIFO, dependency-respecting), calls `orchestrator.resumeTask()`
- **Auto-approval:** Listens for `phase-change` to `awaiting-review`, calls `orchestrator.approveTask(taskId, 'pull-request')`
- **CI polling:** `gh pr view --json state,statusCheckRollup` every 30 seconds
- **Auto-merge:** `gh pr merge <number> --merge` when all checks pass
- **Stalled task adoption:** On re-enable, scans for tasks in `awaiting-review` / `pr-open` and re-adopts them

**File:** `teamai/src/lib/auto-mode.ts`

---

## Agent Session Count Per Full Pipeline Run

### Before optimizations

| Phase | Sessions |
|-------|----------|
| Spec | 1 (`analyst`) |
| Plan | 1 (`planner`) |
| Implement | N (`coder` × subtasks) |
| QA Review | 1 (`qa-reviewer`) |
| Create PR | 1 (`merger`) |
| Merge | 1 (`merger`) |
| **Total (excluding implement)** | **5 sessions** |

### After optimizations (clean path: no rebase/merge conflicts)

| Phase | Sessions |
|-------|----------|
| Spec | 1 (`analyst`) |
| Plan | 1 (`planner`) |
| Implement | N (`coder` × subtasks) |
| QA Review | 1 (`qa-reviewer`) |
| Create PR | **0** (direct CLI) |
| Merge | **0** (direct `git merge --no-edit`) |
| **Total (excluding implement)** | **3 sessions** |

**Savings:** 2 Claude sessions per full pipeline run on the clean path.

### With conflicts (pessimistic path)

Additional sessions are still spawned as needed:
- Rebase conflict in create-pr or merge phase: +1 `merger`
- Cherry-pick conflict in implement: +1 `merger`
- Merge conflict in merge phase: +1 `merger`

These are unavoidable — conflict resolution requires semantic understanding of code intent from both sides.

---

## Two-Tier Pattern

All conflict-resolution paths follow the same two-tier pattern:

```
Tier 1: Direct command (coded)
    ↓ failure (conflict)
Tier 2: Spawn merger agent (AI)
```

Implemented in three places:

| Location | Tier-1 | Tier-2 trigger |
|----------|--------|----------------|
| `rebaseOntoLatestMaster` | `git rebase origin/master` | Conflict → `/merge origin/master` agent |
| `tryCherryPickWithRecovery` | `git cherry-pick <st-branch>` | Conflict → agent resolves + `git cherry-pick --continue` |
| `runMergePhase` | `git merge <branch> --no-edit` | Conflict → `/merge <branch>` agent |

---

## Related

- ADR 006: Subtask execution model (parallel vs. sequential)
- `teamai/src/lib/git-platform.ts`: `checkExistingPRViaCLI`, `createPRViaCLI`, `buildPRBody`
- `teamai/src/lib/orchestrator/phase-runners.ts`: `runCreatePRPhase`, `runMergePhase`, `rebaseOntoLatestMaster`
- `teamai/src/lib/orchestrator/implement.ts`: `tryCherryPickWithRecovery`
