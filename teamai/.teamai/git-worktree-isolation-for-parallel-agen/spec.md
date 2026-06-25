# Spec: Git Worktree Isolation for Parallel Agents

## Context

Per-TASK git worktree isolation already exists: `runPlan` creates a dedicated worktree for each task pipeline, and `runImplement` ensures it's healthy before spawning agent sessions. However, **parallel subtasks within the same implement group share this single worktree**. If two concurrent subtasks modify overlapping files, git conflicts occur silently — one subtask's changes may be clobbered or the worktree enters a conflicted state.

The planner already has rules to prevent overlap (`depends_on` or merge subtasks touching the same file), but these are advisory — there is no technical enforcement. A planner can produce a plan with overlapping parallel subtasks, and the orchestrator will execute them concurrently in the same worktree.

This spec adds **per-subtask worktree isolation for multi-subtask parallel groups**, giving each parallel agent its own sandbox. Changes from successful subtasks are cherry-picked back to the main task worktree after the group completes.

---

## Acceptance Criteria

### AC1 — Per-Subtask Worktree Creation (Multi-Subtask Groups)
**Given** a parallel group with 2+ subtasks  
**When** `runImplement` begins processing the group  
**Then** each subtask in the group gets its own git worktree, created from the task's feature branch, named `<task-worktree>-st<subtask-id>`

### AC2 — Single-Subtask Groups Use Main Worktree (No Overhead)
**Given** a parallel group with exactly 1 subtask  
**When** `runImplement` processes the group  
**Then** the single subtask uses `pipeline.worktreePath` directly (no per-subtask worktree created)

### AC3 — Agent Session Runs in Isolated Worktree
**Given** a subtask with its own worktree  
**When** the coder session is spawned  
**Then** `processManager.createSession` receives `cwd: <subtask-worktree-path>` instead of `cwd: pipeline.worktreePath`

### AC4 — Successful Changes Cherry-Picked Back
**Given** a subtask completes successfully in its isolated worktree  
**When** all subtasks in the group have settled (all fulfilled/rejected)  
**Then** each successful subtask's commits are cherry-picked onto the main task worktree in subtask-ID order

### AC5 — Failed Subtask Changes Discarded
**Given** a subtask fails (rejected promise) in its isolated worktree  
**When** the group settles  
**Then** the failed subtask's worktree is removed without cherry-picking, and its changes are discarded

### AC6 — Per-Subtask Worktree Cleanup
**Given** all subtasks in a group have completed (success or failure)  
**When** cherry-picks are done and group post-processing completes  
**Then** all per-subtask worktrees are removed via `git worktree remove --force`

### AC7 — Container Mode Support
**Given** container mode is enabled (`readContainerConfig(projectRoot).enabled`)  
**When** per-subtask worktrees are created and agent sessions spawned  
**Then** the `.git` file of each per-subtask worktree is patched for container paths (same as the main worktree), and sessions run inside the container

### AC8 — Full Group Failure Surface
**Given** every subtask in a group fails  
**When** the group settles  
**Then** the original error (first rejection reason) is surfaced, per-subtask worktrees are cleaned up, and the pipeline throws (preserving existing behavior)

### AC9 — Crash Recovery
**Given** a server crash mid-group with some per-subtask worktrees active  
**When** the pipeline resumes via `runImplement`  
**Then** stale per-subtask worktrees are detected and removed, and the group is retried from scratch (subtle completions in `plan.json` are checked as before)

---

## Out of Scope

- Cherry-pick conflict resolution — if cherry-pick fails (e.g., both subtasks modified the same file in conflicting ways), the orchestrator surfaces the error and fails the task. The planner should prevent this scenario.
- Per-subtask worktree reuse across QA bounce-back cycles (always created fresh)
- Changing the planner's overlapping-file detection rules (this is an orchestrator-only change)
