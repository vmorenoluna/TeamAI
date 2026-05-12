# Spec: Pipeline Crash Recovery — Auto-detect Stale Sessions and Orphaned Worktrees

## Problem
When the TeamAI server crashes or restarts mid-pipeline:
1. **Stale sessions**: The `ProcessManager` in-memory session map may contain references to processes that are no longer alive (orphaned/crashed child processes). These stale entries pollute the session map.
2. **Orphaned worktrees**: Git worktrees created for parallel agent execution may be left behind on disk after a crash, consuming disk space and causing conflicts on the next pipeline run.
3. **Incomplete cleanup**: The current `findInterruptedTasks()` only detects tasks stuck in in-progress phases — it doesn't clean up stale process references or orphaned worktrees.

## Requirements

### R1: Stale Session Detection
Add a method to `ProcessManager` that identifies sessions whose child process is no longer running (exited, killed, or never existed). These stale sessions should be removable.

### R2: Orphaned Worktree Detection
Add a function to `recovery.ts` that scans a project's worktree directory (`.teamai/worktrees/`) and identifies worktrees whose associated task is no longer active (completed, failed, or task directory missing).

### R3: Startup Cleanup Orchestration
Add a `startupCleanup()` function to `recovery.ts` that:
- Calls `findInterruptedTasks()` for all projects
- Detects stale sessions in ProcessManager
- Finds orphaned worktrees across all projects
- Logs a comprehensive summary at server startup
- Returns actionable data for the recovery banner

### R4: Server Integration
Update `server.ts` to call the new `startupCleanup()` instead of just `findInterruptedTasks()`, providing richer recovery information.

## Non-requirements
- Automatic cleanup/deletion of worktrees (manual review first — potentially destructive)
- Auto-resume of interrupted tasks (already exists via RecoveryBanner)

## Acceptance Criteria
- [ ] `ProcessManager.getStaleSessions()` returns sessions whose child process has exited
- [ ] `findOrphanedWorktrees()` scans and reports orphaned worktrees
- [ ] `startupCleanup()` returns a unified recovery report
- [ ] `server.ts` logs the full recovery report on startup
- [ ] No type errors
