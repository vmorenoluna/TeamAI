# Spec: Prevent Concurrent Edits — Phase-Lock Per Task

## Problem
If two pipeline runs or drag-and-drop events target the same task simultaneously, they can create duplicate subprocesses or corrupt the task's state directory. The `Orchestrator` has no mechanism to prevent two executions of the same task from overlapping.

## Requirements

### R1: In-memory per-task lock
Add a lock mechanism to the `Orchestrator` class that prevents `runTask()` or `moveTaskToPhase()` from executing concurrently on the same task ID.

### R2: Graceful rejection
When a task is already locked (pipeline running), subsequent attempts to run it should either:
- Return a clear error/status indicating the task is busy
- Queue the request (non-goal; just reject for now)

### R3: Lock lifecycle
- Lock is acquired at the start of `runTask()` / `moveTaskToPhase()`
- Lock is released when the pipeline completes (success or failure)
- Lock must be released even if the pipeline throws an error (use try/finally)

## Non-requirements
- Persistent locks across server restarts (in-memory only)
- Queueing/retry of rejected requests
- File-level locks for parallel agents within the same pipeline (existing git worktree isolation handles this)

## Acceptance Criteria
- [ ] Orchestrator tracks which tasks are currently executing
- [ ] Duplicate `runTask()` for same task while running returns error
- [ ] Lock released after pipeline completes or fails
- [ ] No type errors
