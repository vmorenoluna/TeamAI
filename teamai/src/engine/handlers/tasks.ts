/**
 * Engine-side task handlers. Each body is moved from the matching server action in
 * `src/app/actions/tasks.ts`, taking `projectPath` explicitly instead of reading the
 * active-project cookie. Handlers never call `revalidatePath` — the action wrapper does.
 */
import { TaskStore } from '@/lib/task-store';
import { pathExists } from '@/lib/fs-async';
import { getOrchestrator } from '@/lib/orchestrator';
import { RESUME_AUTO } from '@/lib/orchestrator/artifacts';
import { retryAutoMerge } from '@/lib/auto-mode';
import { processManager } from '@/lib/process-manager';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { getResumePhaseForFailedTask } from '@/lib/task-utils';
import { join, resolve } from 'path';
import { rm } from 'fs/promises';
import { NO_STOP_PHASES, RESTARTABLE_PHASES } from '@/constants/phases';
import { execGitQueued, removeStaleWorktreeRegistration } from '@/lib/orchestrator/worktree-utils';
import { isFeedbackTarget, type FeedbackTarget } from '@/lib/orchestrator/feedback-target';
import { runInBackground, isBackgroundPending } from '@/lib/background-actions';
import { preRestoreFailedTask, taskHasSpecConcerns } from '@/lib/task-retry';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (params: any) => Promise<unknown>;

/**
 * Read a task for a handler that reports failures as `{ success: false, error }`:
 * a rejected TaskStore read becomes an `error` instead of a rejected call.
 */
async function readTaskForAction(
  taskStore: TaskStore,
  taskId: string,
): Promise<{ task: Awaited<ReturnType<TaskStore['getByIdAsync']>>; error?: undefined } | { task?: undefined; error: string }> {
  try {
    return { task: await taskStore.getByIdAsync(taskId) };
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

function getStores(projectPath: string) {
  return {
    taskStore: new TaskStore(projectPath),
    orchestrator: getOrchestrator(projectPath),
    projectPath,
  };
}

async function createTask(params: { projectPath: string; title: string; description: string; taskType?: string | null }) {
  const { taskStore } = getStores(params.projectPath);
  const id = randomUUID();
  const { title, description } = params;
  // Conventional-Commits type for the ticket-history commit subject (§3a).
  // Optional; validated against the known set, falls back to 'feat'.
  const rawType = params.taskType?.trim().toLowerCase();
  const taskType = ['feat', 'fix', 'refactor', 'chore', 'docs'].includes(rawType ?? '') ? rawType! : undefined;
  taskStore.create(id, title, description, undefined, undefined, taskType);
  return { id };
}

/** Batch variant for importIssues / convertMultipleToTasks. */
async function createTasks(params: {
  projectPath: string;
  tasks: { id: string; title: string; description: string; source?: string; competitive_context?: string }[];
}) {
  const { taskStore } = getStores(params.projectPath);
  const ids: string[] = [];
  for (const t of params.tasks) {
    taskStore.create(t.id, t.title, t.description, t.source, t.competitive_context);
    ids.push(t.id);
  }
  return { ids };
}

async function moveTask(params: { projectPath: string; taskId: string; targetPhase: string; operationId?: string }): Promise<{ operationId: string }> {
  const { taskId, targetPhase, operationId } = params;
  const { orchestrator, projectPath } = getStores(params.projectPath);
  // Fire-and-forget (pipeline runs async); a rejection is reported over the WebSocket
  const opId = runInBackground(
    { operationId, action: 'move', taskId, projectRoot: projectPath, notify: 'failure-only' },
    () => orchestrator.moveTaskToPhase(taskId, targetPhase),
  );
  return { operationId: opId };
}

async function deleteTask(params: { projectPath: string; taskId: string }) {
  const { taskStore } = getStores(params.projectPath);
  taskStore.delete(params.taskId);
}

async function bulkDeleteTasks(params: { projectPath: string; taskIds: string[] }) {
  const { taskStore } = getStores(params.projectPath);
  for (const id of params.taskIds) {
    try { taskStore.delete(id); } catch { /* skip missing */ }
  }
}

async function retryTask(params: { projectPath: string; taskId: string; operationId?: string }): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskId, operationId } = params;
  const { taskStore, orchestrator, projectPath } = getStores(params.projectPath);
  const read = await readTaskForAction(taskStore, taskId);
  if (read.error !== undefined) return { success: false, error: read.error };
  const task = read.task;
  if (!task) return { success: false, error: 'Task not found' };
  // Auto mode gave up merging a green PR: the task is still pr-open, and
  // "retry" means handing it back to the CI poller.
  if (task.phase === 'pr-open' && task.autoMergeStalled) {
    try {
      retryAutoMerge(projectPath, taskId);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    return { success: true };
  }
  if (task.phase !== 'failed') return { success: false, error: `Task is in phase "${task.phase}", not "failed"` };

  // Determine the phase the task was in when it failed — read from events
  let resumePhase = 'qa-review'; // default for failed tasks (most common failure point)
  try {
    const events = await taskStore.getEventsAsync(taskId);
    resumePhase = getResumePhaseForFailedTask(events, task.failureReason, taskHasSpecConcerns(taskStore, taskId));
  } catch { /* fall back to default */ }

  preRestoreFailedTask(taskStore, taskId);

  // A retry always gets a fresh pipeline-state budget (qaAttempt,
  // wakeupAttemptCount, deliverableFailCounts, ...) — see clearPipelineStateFile's
  // doc comment. Carrying a near-exhausted counter into a retry means a
  // subtask that already burned its wakeup budget on the failed run gets
  // killed almost instantly on the very next wakeup, even if the underlying
  // work (e.g. a long-running script) is legitimately healthy and about to finish.
  let taskDir: string;
  try {
    taskDir = await taskStore.getDirByIdAsync(taskId);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  orchestrator.clearPipelineStateFile(taskDir);

  // Fire-and-forget — pipeline runs async, phase changes broadcast via WebSocket
  const opId = runInBackground(
    { operationId, action: 'retry', taskId, projectRoot: projectPath, notify: 'failure-only' },
    () => orchestrator.moveTaskToPhase(taskId, resumePhase),
  );
  return { success: true, operationId: opId };
}

/**
 * Retry a task with an explicit phase chosen by the user through the
 * retry-phase dialog (unlike `retryTask`, which picks the resume phase
 * automatically from events.jsonl). Always clears `.pipeline_state.json`.
 */
async function retryTaskWithOptions(params: {
  projectPath: string;
  taskId: string;
  phase: string;
  operationId?: string;
}): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskId, phase, operationId } = params;
  // "Resume where it failed" is the same operation as a phase-less retry.
  if (phase === RESUME_AUTO) return retryTask({ projectPath: params.projectPath, taskId, operationId });

  const { taskStore, orchestrator, projectPath } = getStores(params.projectPath);
  const read = await readTaskForAction(taskStore, taskId);
  if (read.error !== undefined) return { success: false, error: read.error };
  const task = read.task;
  if (!task) return { success: false, error: 'Task not found' };

  // ── Pre-restore work (only for failed tasks) ──
  if (task.phase === 'failed') {
    preRestoreFailedTask(taskStore, taskId);
  }

  // ── Budget reset (always, independent of phase choice) ──
  let taskDir: string;
  try {
    taskDir = await taskStore.getDirByIdAsync(taskId);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
  orchestrator.clearPipelineStateFile(taskDir);

  // Fire-and-forget — pipeline runs async, phase changes broadcast via WebSocket
  const opId = runInBackground(
    { operationId, action: 'retry', taskId, projectRoot: projectPath, notify: 'failure-only' },
    () => orchestrator.moveTaskToPhase(taskId, phase),
  );
  return { success: true, operationId: opId };
}

async function pauseTask(params: { projectPath: string; taskId: string }): Promise<{ success: boolean; error?: string }> {
  const { taskId } = params;
  const { taskStore, orchestrator, projectPath } = getStores(params.projectPath);
  const read = await readTaskForAction(taskStore, taskId);
  if (read.error !== undefined) return { success: false, error: read.error };
  const task = read.task;
  if (!task) return { success: false, error: 'Task not found' };

  if (NO_STOP_PHASES.has(task.phase)) return { success: false, error: `Cannot pause task in "${task.phase}" phase` };
  if (task.isPaused) return { success: false, error: 'Task is already paused' };

  // Kill the running pipeline session, but leave the task in its current phase.
  orchestrator.cancelPipeline(taskId);

  // Mark as paused — stay in current phase, no artifact cleanup.
  // Clear rate-limit and wakeup timestamps: cancelPipeline already killed
  // the timers, so these are stale. Leaving them causes a stale hourglass
  // icon to reappear when the user resumes (spinner suppressed, ⏳ shown).
  taskStore.update(taskId, { isPaused: true, rateLimitedUntil: undefined, wakeupUntil: undefined });
  processManager.emit('phase-change', { taskId, phase: task.phase, projectRoot: projectPath });
  return { success: true };
}

async function resumeTask(params: { projectPath: string; taskId: string; operationId?: string }): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskId, operationId } = params;
  const { taskStore, orchestrator, projectPath } = getStores(params.projectPath);
  const read = await readTaskForAction(taskStore, taskId);
  if (read.error !== undefined) return { success: false, error: read.error };
  const task = read.task;
  if (!task) return { success: false, error: 'Task not found' };

  if (!task.isPaused) return { success: false, error: 'Task is not paused' };

  // Clear paused flag and any stale rate-limit/wakeup timestamps.
  // pauseTask now clears these, but belt-and-suspenders: if the task
  // reached isPaused through any other path, stale timestamps here
  // would cause a false hourglass (⏳) after resume.
  taskStore.update(taskId, { isPaused: false, rateLimitedUntil: undefined, wakeupUntil: undefined });

  // Resume from current phase — re-run the pipeline at whatever phase the task was in
  const opId = runInBackground(
    { operationId, action: 'resume', taskId, projectRoot: projectPath, notify: 'failure-only' },
    () => orchestrator.moveTaskToPhase(taskId, task.phase),
  );
  return { success: true, operationId: opId };
}

async function stopTask(params: { projectPath: string; taskId: string; operationId?: string }): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskId, operationId } = params;
  const { taskStore, orchestrator, projectPath } = getStores(params.projectPath);
  if (isBackgroundPending('stop', taskId)) return { success: false, error: 'Stop is already in progress for this task' };
  const read = await readTaskForAction(taskStore, taskId);
  if (read.error !== undefined) return { success: false, error: read.error };
  const task = read.task;
  if (!task) return { success: false, error: 'Task not found' };

  if (NO_STOP_PHASES.has(task.phase)) return { success: false, error: `Cannot stop task in "${task.phase}" phase` };

  // Cancel the running pipeline
  orchestrator.cancelPipeline(taskId);

  // Pause while the cleanup runs: recovery (sweepStalledTasks,
  // autoResumeInterruptedTasks) and auto mode skip isPaused tasks, so none of
  // them re-adopts the task mid-cleanup. Also clears stale rate-limit/wakeup
  // timestamps, as pauseTask does.
  taskStore.update(taskId, { isPaused: true, rateLimitedUntil: undefined, wakeupUntil: undefined });

  const opId = runInBackground(
    { operationId, action: 'stop', taskId, projectRoot: projectPath, notify: 'always' },
    async () => {
      // Clean up artifacts: keep completed phase artifacts, remove in-progress ones.
      // Defect 8's reconciliation may retry cherry-picks after an infra hiccup
      // (reprovisioning the container), so this must settle before the task
      // moves to 'backlog' below. On rejection the task stays paused in its phase.
      await orchestrator.cleanupTaskArtifacts(taskId, task.phase);

      // Clear paused state when moving to backlog
      taskStore.update(taskId, { isPaused: false });

      // Move to backlog
      taskStore.updatePhase(taskId, 'backlog');
      processManager.emit('phase-change', { taskId, phase: 'backlog', projectRoot: projectPath });
    },
  );
  return { success: true, operationId: opId };
}

async function playTask(params: { projectPath: string; taskId: string; operationId?: string }): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskId, operationId } = params;
  const { taskStore, orchestrator, projectPath } = getStores(params.projectPath);
  const read = await readTaskForAction(taskStore, taskId);
  if (read.error !== undefined) return { success: false, error: read.error };
  const task = read.task;
  if (!task) return { success: false, error: 'Task not found' };

  if (task.phase !== 'backlog') return { success: false, error: `Task is in "${task.phase}" phase, not "backlog"` };

  // Resume the task — detects completed artifacts and fast-forwards to the next phase
  const opId = runInBackground(
    { operationId, action: 'play', taskId, projectRoot: projectPath, notify: 'failure-only' },
    () => orchestrator.resumeTask(taskId),
  );
  return { success: true, operationId: opId };
}

async function restartCurrentPhase(params: { projectPath: string; taskId: string; operationId?: string }): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskId, operationId } = params;
  const { taskStore, orchestrator, projectPath } = getStores(params.projectPath);
  const read = await readTaskForAction(taskStore, taskId);
  if (read.error !== undefined) return { success: false, error: read.error };
  const task = read.task;
  if (!task) return { success: false, error: 'Task not found' };

  if (!RESTARTABLE_PHASES.has(task.phase)) {
    return { success: false, error: `Cannot restart task in "${task.phase}" phase` };
  }

  const restart = (work: () => Promise<unknown>): string => runInBackground(
    { operationId, action: 'restart-phase', taskId, projectRoot: projectPath, notify: 'failure-only' },
    work,
  );
  let opId: string;

  if (task.phase === 'qa-review') {
    // For qa-review: just re-run QA without re-implementing.
    // moveTaskToPhase would set startPhase='implement' (since plan exists),
    // but the user asked to restart _this_ phase from scratch — not the pipeline.
    //
    // cancelPipeline first: a genuinely still-running qa-review session would
    // otherwise race clearArtifacts below (deleting qa_report.json etc. out
    // from under a live agent) and then runTask would just throw
    // TaskAlreadyRunningError, leaving that live session to finish against
    // now-mutated artifacts. Mirrors moveTaskToPhase, which always cancels
    // any in-flight pipeline before touching artifacts.
    orchestrator.cancelPipeline(taskId);
    taskStore.clearArtifacts(taskId, 'qa');
    opId = restart(() => orchestrator.runTask(taskId, task.description, 'qa-review'));
  } else if (task.phase === 'implement') {
    // For implement: reset subtask completions in plan.json so the UI shows a fresh
    // slate. moveTaskToPhase clears QA artifacts but doesn't touch plan.json subtask
    // flags — unlike stopTask which does via cleanupTaskArtifacts.
    //
    // cancelPipeline first — see the qa-review branch above for why.
    orchestrator.cancelPipeline(taskId);
    let dir: string;
    try {
      dir = await taskStore.getDirByIdAsync(taskId);
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    const planPath = join(dir, 'plan.json');
    if (existsSync(planPath)) {
      try {
        const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
        if (plan.subtasks) {
          for (const s of plan.subtasks) s.completed = false;
        }
        writeFileSync(planPath, JSON.stringify(plan, null, 2));
      } catch { /* best-effort */ }
    }
    opId = restart(() => orchestrator.runTask(taskId, task.description, 'implement'));
  } else {
    // spec / plan: moveTaskToPhase handles clearing stale artifacts
    // and setting the correct startPhase (e.g. spec redoes everything,
    // plan redoes plan→implement→qa).
    opId = restart(() => orchestrator.moveTaskToPhase(taskId, task.phase));
  }

  return { success: true, operationId: opId };
}

async function runTask(params: { projectPath: string; taskId: string; operationId?: string }): Promise<{ operationId: string }> {
  const { taskId, operationId } = params;
  const { taskStore, orchestrator, projectPath } = getStores(params.projectPath);
  const task = await taskStore.getByIdAsync(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  // orchestrator.runTask reaches persistAndEmitPhase (the authoritative
  // phase-change write) synchronously before any I/O-bound await, so the UI
  // sees the new phase promptly without this handler persisting it up front.
  const opId = runInBackground(
    { operationId, action: 'run', taskId, projectRoot: projectPath, notify: 'failure-only' },
    () => orchestrator.runTask(taskId, task.description),
  );
  return { operationId: opId };
}

async function approveTask(params: {
  projectPath: string;
  taskId: string;
  strategy: 'local-merge' | 'pull-request';
  operationId?: string;
}): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskId, strategy, operationId } = params;
  const { taskStore, orchestrator, projectPath } = getStores(params.projectPath);
  if (isBackgroundPending('approve', taskId)) return { success: false, error: 'Approve is already in progress for this task' };
  const read = await readTaskForAction(taskStore, taskId);
  if (read.error !== undefined) return { success: false, error: read.error };
  const task = read.task;
  if (!task) return { success: false, error: 'Task not found' };
  if (task.phase !== 'awaiting-review') {
    return { success: false, error: `Task is in phase "${task.phase}", not "awaiting-review"` };
  }
  const opId = runInBackground(
    { operationId, action: 'approve', taskId, projectRoot: projectPath, notify: 'always' },
    () => orchestrator.approveTask(taskId, strategy),
  );
  return { success: true, operationId: opId };
}

async function markTaskDone(params: {
  projectPath: string;
  taskId: string;
  operationId?: string;
}): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskId, operationId } = params;
  const { taskStore, orchestrator, projectPath } = getStores(params.projectPath);
  if (isBackgroundPending('mark-done', taskId)) return { success: false, error: 'Mark done is already in progress for this task' };
  const read = await readTaskForAction(taskStore, taskId);
  if (read.error !== undefined) return { success: false, error: read.error };
  if (!read.task) return { success: false, error: 'Task not found' };
  const opId = runInBackground(
    { operationId, action: 'mark-done', taskId, projectRoot: projectPath, notify: 'always' },
    () => orchestrator.markTaskDone(taskId),
  );
  return { success: true, operationId: opId };
}

async function rejectTask(params: { projectPath: string; taskId: string; feedback: string; target: string; subtaskIds?: number[] }) {
  const { taskId, feedback, target, subtaskIds } = params;
  if (!isFeedbackTarget(target)) {
    throw new Error(`Invalid feedback target: ${String(target)}`);
  }
  const { orchestrator } = getStores(params.projectPath);
  await orchestrator.rejectTask(taskId, feedback, target as FeedbackTarget, subtaskIds);
}

async function addDependency(params: { projectPath: string; taskId: string; depId: string }): Promise<void> {
  const { taskId, depId } = params;
  const { taskStore } = getStores(params.projectPath);
  const task = await taskStore.getByIdAsync(taskId);
  if (!task) return;
  const deps = task.dependencies ?? [];
  if (!deps.includes(depId)) taskStore.update(taskId, { dependencies: [...deps, depId] });
}

async function removeDependency(params: { projectPath: string; taskId: string; depId: string }): Promise<void> {
  const { taskId, depId } = params;
  const { taskStore } = getStores(params.projectPath);
  const task = await taskStore.getByIdAsync(taskId);
  if (!task) return;
  taskStore.update(taskId, { dependencies: (task.dependencies ?? []).filter(id => id !== depId) });
}

// "This task blocks blockedTaskId" — add thisTaskId to the other task's dependencies
async function addBlock(params: { projectPath: string; thisTaskId: string; blockedTaskId: string }): Promise<void> {
  const { thisTaskId, blockedTaskId } = params;
  const { taskStore } = getStores(params.projectPath);
  const blocked = await taskStore.getByIdAsync(blockedTaskId);
  if (!blocked) return;
  const deps = blocked.dependencies ?? [];
  if (!deps.includes(thisTaskId)) taskStore.update(blockedTaskId, { dependencies: [...deps, thisTaskId] });
}

async function removeBlock(params: { projectPath: string; thisTaskId: string; blockedTaskId: string }): Promise<void> {
  const { thisTaskId, blockedTaskId } = params;
  const { taskStore } = getStores(params.projectPath);
  const blocked = await taskStore.getByIdAsync(blockedTaskId);
  if (!blocked) return;
  taskStore.update(blockedTaskId, { dependencies: (blocked.dependencies ?? []).filter(id => id !== thisTaskId) });
}

async function checkBulkTaskWorktrees(params: { projectPath: string; taskIds: string[] }): Promise<Record<string, boolean>> {
  const { taskStore, orchestrator } = getStores(params.projectPath);
  const result: Record<string, boolean> = {};
  for (const id of params.taskIds) {
    const task = await taskStore.getByIdAsync(id);
    if (!task || !task.branch) {
      result[id] = false;
      continue;
    }
    const wtPath = orchestrator.getWorktreePath(id);
    result[id] = wtPath ? await pathExists(wtPath) : false;
  }
  return result;
}

async function checkTaskWorktree(params: { projectPath: string; taskId: string }): Promise<{ exists: boolean; path: string | null }> {
  const { taskId } = params;
  const { taskStore, orchestrator } = getStores(params.projectPath);
  const task = await taskStore.getByIdAsync(taskId);
  if (!task || !task.branch) return { exists: false, path: null };
  const wtPath = orchestrator.getWorktreePath(taskId);
  if (!wtPath) return { exists: false, path: null };
  return { exists: await pathExists(wtPath), path: wtPath };
}

async function deleteTaskWorktree(params: { projectPath: string; taskId: string; operationId?: string }): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskId, operationId } = params;
  const { taskStore, orchestrator, projectPath } = getStores(params.projectPath);
  if (isBackgroundPending('delete-worktree', taskId)) {
    return { success: false, error: 'Delete worktree is already in progress for this task' };
  }
  const read = await readTaskForAction(taskStore, taskId);
  if (read.error !== undefined) return { success: false, error: read.error };
  const task = read.task;
  if (!task || !task.branch) return { success: false, error: 'No branch found for this task' };
  const wtPath = orchestrator.getWorktreePath(taskId);
  if (!wtPath || !existsSync(wtPath)) return { success: false, error: 'Worktree directory not found on disk' };
  // ── Gap 5a: Safety guard — never rm the project root ──
  const resolvedWt = resolve(wtPath);
  const resolvedProject = resolve(projectPath);
  if (resolvedWt === resolvedProject) {
    return { success: false, error: 'Refusing to delete worktree at project root — this would destroy the repository' };
  }
  const opId = runInBackground(
    { operationId, action: 'delete-worktree', taskId, projectRoot: projectPath, notify: 'always' },
    async () => {
      try {
        await execGitQueued(['worktree', 'remove', wtPath], projectPath, projectPath);
      } catch {
        // Normal remove failed (e.g. uncommitted changes) — try --force
        try {
          await execGitQueued(['worktree', 'remove', '--force', wtPath], projectPath, projectPath);
        } catch {
          // --force also failed (e.g. files locked) — delete manually and prune
          try {
            await rm(wtPath, { recursive: true, force: true });
            await removeStaleWorktreeRegistration(projectPath, wtPath);
          } catch (e) {
            const err = e as { stderr?: string; message?: string };
            throw new Error(err.stderr || err.message || 'Failed to remove worktree');
          }
        }
      }
      taskStore.update(taskId, { branch: undefined });
    },
  );
  return { success: true, operationId: opId };
}

export const tasksHandlers: Record<string, Handler> = {
  'tasks.createTask': createTask,
  'tasks.createTasks': createTasks,
  'tasks.deleteTask': deleteTask,
  'tasks.bulkDeleteTasks': bulkDeleteTasks,
  'tasks.moveTask': moveTask,
  'tasks.retryTask': retryTask,
  'tasks.retryTaskWithOptions': retryTaskWithOptions,
  'tasks.pauseTask': pauseTask,
  'tasks.resumeTask': resumeTask,
  'tasks.stopTask': stopTask,
  'tasks.playTask': playTask,
  'tasks.restartCurrentPhase': restartCurrentPhase,
  'tasks.runTask': runTask,
  'tasks.approveTask': approveTask,
  'tasks.markTaskDone': markTaskDone,
  'tasks.rejectTask': rejectTask,
  'tasks.addDependency': addDependency,
  'tasks.removeDependency': removeDependency,
  'tasks.addBlock': addBlock,
  'tasks.removeBlock': removeBlock,
  'tasks.deleteTaskWorktree': deleteTaskWorktree,
  'tasks.checkBulkTaskWorktrees': checkBulkTaskWorktrees,
  'tasks.checkTaskWorktree': checkTaskWorktree,
};
