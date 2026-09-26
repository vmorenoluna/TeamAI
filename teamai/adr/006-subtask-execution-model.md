# ADR 006: Subtask Execution Model — Parallel vs. Sequential

**Date:** July 5, 2026
**Status:** Decision pending

## Context

The implement phase (`runImplement` in `src/lib/orchestrator/implement.ts`) executes plan subtasks by spawning Claude agent sessions. Subtasks are grouped by `parallel_group`; within a group, they can run in parallel. The system supports two modes controlled by the `parallelSubtasks` pipeline config flag (default: `true`).

When `parallelSubtasks` is `true` and a group has ≥2 subtasks, each subtask gets its own isolated git worktree and branch, runs in parallel via `Promise.allSettled`, and then each subtask's branch is cherry-picked sequentially onto the main worktree branch.

This document captures the current architecture and the trade-offs involved, so future decisions about simplifying or removing parallel mode are well-informed.

## Current Architecture (Parallel Mode)

### Worktree layout

When a group has 2+ subtasks, each subtask gets a dedicated worktree and branch:

| Subtask | Worktree | Branch |
|---------|----------|--------|
| Subtask 5 | `<main-worktree>-st5` | `<main-branch>-st5` |
| Subtask 7 | `<main-worktree>-st7` | `<main-branch>-st7` |

Both branches are created off the main worktree branch (`pipeline.branch`), so they start from the same base commit.

Single-subtask groups run directly in the main worktree — no isolation needed.

### Execution order

1. **Subtask grouping**: Subtasks are bucketed by `parallel_group`. Groups execute sequentially.

   > **2026-09-26 addition (group completion barrier):** "Sequentially" used
   > to mean only "the next `[group, subtasks]` Map entry is visited after
   > this one, and each subtask's OWN `depends_on` is checked against what's
   > completed so far" — it did NOT mean "the next group waits for every
   > subtask in THIS group to actually finish." A subtask that ran, ended
   > its session, but didn't complete (a deliverable check failed, a scope
   > violation — anything short of a wakeup, which already blocked
   > advancement) let the loop move straight on to the next group in the
   > SAME pass, as long as that later group's own declared `depends_on`
   > happened to be satisfied. Found on task
   > `add-per-constraint-soft-score-attributio`: a later group's subtask
   > didn't name the earlier group's subtasks in `depends_on` at all (its
   > ordering requirement lived only in its description — see ADR 006's
   > sibling fix in `defaults/commands/plan.md`), so nothing held it back
   > when the earlier group silently failed its deliverable check. It was
   > dispatched anyway and burned its full wakeup budget on work whose real
   > prerequisite was never done. The group loop now breaks before starting
   > the next group whenever any subtask in the current group didn't
   > complete, for any reason — matching what "groups execute sequentially"
   > was always supposed to mean. See `implement.ts`, search
   > `[GROUP-BARRIER]`.

2. **Within a group (parallel)**:
   - Per-subtask worktrees are created and branches checked out
   - All subtasks spawn Claude agent sessions simultaneously (`Promise.allSettled`)
   - Each agent works in its own isolated worktree, unaware of other subtasks

3. **Post-session scope check**: For each subtask, the orchestrator snapshots HEAD before the session starts, then runs `git diff --name-only <pre-session-HEAD>..HEAD` after. Any changed file not in the subtask's `files` array is a scope violation — the subtask is rejected and must re-run.

4. **Cherry-pick (sequential)**: After all subtasks in a group finish successfully, each subtask's branch is cherry-picked onto the main worktree branch, one at a time:
   ```
   main branch  ←── cherry-pick st5 branch
   main branch  ←── cherry-pick st7 branch
   ```

5. **Cherry-pick recovery**: If a cherry-pick fails with conflicts:
   - **Tier 1**: Normal `git cherry-pick`
   - **Tier 2**: Spawn a **merger agent** to resolve conflicts semantically
   - **Exhausted**: Retain worktrees and branches for manual recovery, fail the pipeline

6. **Cleanup**: Per-subtask worktrees and branches are deleted (unless recovery was exhausted).

7. **Push**: The main branch is force-pushed to the remote (`git push --force origin <branch>`).

### Code locations

| Component | File | Lines (approx) |
|-----------|------|---------------|
| Per-subtask worktree creation | `src/lib/orchestrator/implement.ts` | ~25 |
| Parallel spawn (`Promise.allSettled`) | `src/lib/orchestrator/implement.ts` | ~15 |
| Scope enforcement | `src/lib/orchestrator/implement.ts` | ~30 |
| Cherry-pick + merger agent | `src/lib/orchestrator/implement.ts` | ~100 |
| Stale worktree cleanup | `src/lib/orchestrator/worktree-ops.ts` | ~50 |
| Worktree lifecycle ops | `src/lib/orchestrator/worktree-ops.ts` | ~70 |

### Planner constraints forced by parallel mode

Because subtasks in a parallel group must not touch the same files (or the cherry-pick will conflict), the planner (`defaults/roles/planner.md`) and plan command (`defaults/commands/plan.md`) must enforce file-ownership discipline:

- No two subtasks may list the same file path in their `files` arrays
- Subtasks that would touch the same file must be merged into one, regardless of logical separation
- The coder (`defaults/commands/implement.md`) must not modify files outside its assigned `files` array

These constraints exist **solely** to prevent cherry-pick conflicts. In sequential mode, they would be unnecessary.

## Sequential Mode (parallelSubtasks: false)

When `parallelSubtasks` is `false`, each subtask is its own group (no `parallel_group` grouping), so `isMultiGroup` is never true. All agents run sequentially in the main worktree — no per-subtask worktrees, no cherry-pick, no scope enforcement, no merger agent.

This is already fully supported by the existing code. No new code paths needed.

## Trade-off Analysis

### What parallel mode costs

| Cost | Impact |
|------|--------|
| Orchestrator complexity | ~200 lines of worktree/cherry-pick/scope code |
| Planner complexity | Must partition work into disjoint file sets |
| Cherry-pick risk | Conflicts require merger agent or cause pipeline failure |
| Scope violation risk | Agent modifies an unassigned file → subtask rejected |
| Debugging difficulty | Parallel failures are harder to diagnose than sequential ones |
| Rule proliferation | File-ownership rules in plan.md, implement.md, planner.md (the uncommitted changes) |

### What parallel mode buys

| Benefit | Impact |
|---------|--------|
| Speed | 2–4x faster on multi-subtask plans (typical agent session: 2–10 min) |
| Independence | Subtask agents can't interfere with each other's in-progress work |

### When parallel mode actually delivers

Parallel mode is most beneficial when:
- Plans have 3+ subtasks that are genuinely independent
- Subtasks touch disjoint sets of files (planner gets it right)
- No agent exceeds its file scope

Parallel mode provides little benefit when:
- Plans have only 1–2 subtasks (most common case?)
- Subtasks naturally share files (e.g., a refactor touches many files)
- Scope violations cause re-runs, negating the speedup

## Options

### Option A: Keep parallel mode as-is, harden the rules

Commit the uncommitted file-ownership rules to prevent the most common failure mode (shared files causing cherry-pick conflicts). Keep `parallelSubtasks: true` as default.

**Pros**: Preserves speed. Fixes the known gap.
**Cons**: Planner complexity remains. Cherry-pick/scope failures still possible.

### Option B: Default to sequential, keep parallel as opt-in

Change `parallelSubtasks` default to `false`. Simplify the planner/coder rules since the default path won't need file-ownership enforcement. Power users enable parallel when they have large, independent subtask sets.

**Pros**: Simplifies the common path. Power users still have the option.
**Cons**: Two code paths to maintain. Users may not know when to enable it.

### Option C: Remove parallel mode entirely

Delete per-subtask worktrees, cherry-pick, scope enforcement, and the merger agent. Remove `parallel_group` from the plan schema and file-ownership rules from command templates.

**Pros**: ~200+ lines of code removed. Planner simplified. No cherry-pick conflicts ever. Easier to debug.
**Cons**: Pipelines take longer. Permanently lose the ability to parallelize.

### Option D: Remove parallel mode but add concurrent Claude sessions in the same worktree

A hybrid: subtasks still run sequentially (each sees accumulated changes), but the Claude API calls for independent subtasks could be concurrent. This would require Claude to coordinate via the shared worktree state, which is riskier than isolated worktrees but simpler than cherry-pick orchestration.

**Pros**: Some speed retained without cherry-pick complexity.
**Cons**: Race conditions possible. Claude sessions editing the same file simultaneously would corrupt it. Unclear if this is actually simpler.

## Related

- ADR 002: Schedule-wakeup subtask state (wakeup interacts with parallel mode — only one subtask at a time can be in wakeup)
- ADR 004: Failure budgets and retry policy
- ADR 005: Verification gate failure tracking

## Decision

TBD — this document captures the analysis for a future decision.
