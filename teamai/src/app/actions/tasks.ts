'use server';

import { TaskStore } from '@/lib/task-store';
import { pathExists, readTextIfExists } from '@/lib/fs-async';
import { TaskNotFoundError } from '@/lib/orchestrator/errors';
import { getOrchestrator } from '@/lib/orchestrator';
import { MAX_REVISION_SNAPSHOTS, RESUME_AUTO } from '@/lib/orchestrator/artifacts';
import { retryAutoMerge } from '@/lib/auto-mode';
import { readCommonArtifacts } from '@/lib/task-artifacts';
import { getActiveProjectPath } from './projects';
import { processManager } from '@/lib/process-manager';
import { revalidatePath } from 'next/cache';
import type { PlanData } from '@/lib/stream-types';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { getResumePhaseForFailedTask, getAwaitingReviewReason } from '@/lib/task-utils';
import { getRoleRefinementConfig, suggestionsForTask, type RoleRefinementMode, type RoleRefinementSuggestion } from '@/lib/role-refinement';
import { join, resolve } from 'path';
import { readdir, readFile, rm } from 'fs/promises';
import { NO_STOP_PHASES, RESTARTABLE_PHASES } from '@/constants/phases';
import { execGitQueued, removeStaleWorktreeRegistration } from '@/lib/orchestrator/worktree-utils';
import { isFeedbackTarget, type FeedbackTarget } from '@/lib/orchestrator/feedback-target';
import { runInBackground, isBackgroundPending } from '@/lib/background-actions';
import { preRestoreFailedTask, taskHasSpecConcerns } from '@/lib/task-retry';

/**
 * Read a task for an action that reports failures as `{ success: false, error }`:
 * a rejected TaskStore read becomes an `error` instead of a rejected action.
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

async function getStores() {
  const projectPath = await getActiveProjectPath();
  return {
    taskStore: new TaskStore(projectPath),
    orchestrator: getOrchestrator(projectPath),
    projectPath,
  };
}

export async function createTask(formData: FormData) {
  const { taskStore } = await getStores();
  const id = randomUUID();
  const title = formData.get('title') as string;
  const description = formData.get('description') as string;
  // Conventional-Commits type for the ticket-history commit subject (§3a).
  // Optional; validated against the known set, falls back to 'feat'.
  const rawType = (formData.get('taskType') as string | null)?.trim().toLowerCase();
  const taskType = ['feat', 'fix', 'refactor', 'chore', 'docs'].includes(rawType ?? '') ? rawType! : undefined;
  taskStore.create(id, title, description, undefined, undefined, taskType);
  revalidatePath('/');
  return { id };
}

export async function moveTask(taskId: string, targetPhase: string, operationId?: string): Promise<{ operationId: string }> {
  const { orchestrator, projectPath } = await getStores();
  // Fire-and-forget (pipeline runs async); a rejection is reported over the WebSocket
  const opId = runInBackground(
    { operationId, action: 'move', taskId, projectRoot: projectPath, notify: 'failure-only' },
    () => orchestrator.moveTaskToPhase(taskId, targetPhase),
  );
  revalidatePath('/');
  return { operationId: opId };
}

export async function deleteTask(taskId: string) {
  const { taskStore } = await getStores();
  taskStore.delete(taskId);
  revalidatePath('/');
}

export async function bulkDeleteTasks(taskIds: string[]) {
  const { taskStore } = await getStores();
  for (const id of taskIds) {
    try { taskStore.delete(id); } catch { /* skip missing */ }
  }
  revalidatePath('/');
}

export async function retryTask(taskId: string, operationId?: string): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskStore, orchestrator, projectPath } = await getStores();
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
    revalidatePath('/');
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
  revalidatePath('/');
  return { success: true, operationId: opId };
}

/**
 * Retry a task with an explicit phase chosen by the user through the
 * retry-phase dialog (unlike `retryTask`, which picks the resume phase
 * automatically from events.jsonl).
 *
 * Always clears `.pipeline_state.json` (qaAttempt, wakeupAttemptCount,
 * deliverableFailCounts, ...) before resuming — this used to be a
 * user-chosen `resetBudget` flag, but a carried-over counter from the
 * failed run can trip a wakeup/deliverable-fail cap almost immediately on
 * the retry regardless of target phase, so a fresh budget is no longer
 * optional. See `clearPipelineStateFile`'s doc comment for the full
 * rationale.
 */
export async function retryTaskWithOptions(
  taskId: string,
  phase: string,
  operationId?: string,
): Promise<{ success: boolean; error?: string; operationId?: string }> {
  // "Resume where it failed" is the same operation as a phase-less retry.
  if (phase === RESUME_AUTO) return retryTask(taskId, operationId);

  const { taskStore, orchestrator, projectPath } = await getStores();
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
  revalidatePath('/');
  return { success: true, operationId: opId };
}

export async function pauseTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { taskStore, orchestrator, projectPath } = await getStores();
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
  revalidatePath('/');
  revalidatePath(`/task/${taskId}`);
  return { success: true };
}

export async function resumeTask(taskId: string, operationId?: string): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskStore, orchestrator, projectPath } = await getStores();
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
  revalidatePath('/');
  revalidatePath(`/task/${taskId}`);
  return { success: true, operationId: opId };
}

export async function stopTask(taskId: string, operationId?: string): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskStore, orchestrator, projectPath } = await getStores();
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
  revalidatePath('/');
  revalidatePath(`/task/${taskId}`);
  return { success: true, operationId: opId };
}

export async function playTask(taskId: string, operationId?: string): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskStore, orchestrator, projectPath } = await getStores();
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
  revalidatePath('/');
  return { success: true, operationId: opId };
}

export async function restartCurrentPhase(taskId: string, operationId?: string): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskStore, orchestrator, projectPath } = await getStores();
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

  revalidatePath('/');
  revalidatePath(`/task/${taskId}`);
  return { success: true, operationId: opId };
}

export async function runTask(taskId: string, operationId?: string): Promise<{ operationId: string }> {
  const { taskStore, orchestrator, projectPath } = await getStores();
  const task = await taskStore.getByIdAsync(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  // orchestrator.runTask reaches persistAndEmitPhase (the authoritative
  // phase-change write) synchronously before any I/O-bound await, so the UI
  // sees the new phase promptly without this action persisting it up front —
  // see the crash-safety comments on moveTaskToPhase/resumeTask.
  const opId = runInBackground(
    { operationId, action: 'run', taskId, projectRoot: projectPath, notify: 'failure-only' },
    () => orchestrator.runTask(taskId, task.description),
  );
  revalidatePath('/');
  return { operationId: opId };
}

export async function approveTask(
  taskId: string,
  strategy: 'local-merge' | 'pull-request',
  operationId?: string,
): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskStore, orchestrator, projectPath } = await getStores();
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
  revalidatePath('/');
  return { success: true, operationId: opId };
}

export async function markTaskDone(
  taskId: string,
  operationId?: string,
): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskStore, orchestrator, projectPath } = await getStores();
  if (isBackgroundPending('mark-done', taskId)) return { success: false, error: 'Mark done is already in progress for this task' };
  const read = await readTaskForAction(taskStore, taskId);
  if (read.error !== undefined) return { success: false, error: read.error };
  if (!read.task) return { success: false, error: 'Task not found' };
  const opId = runInBackground(
    { operationId, action: 'mark-done', taskId, projectRoot: projectPath, notify: 'always' },
    () => orchestrator.markTaskDone(taskId),
  );
  revalidatePath('/');
  return { success: true, operationId: opId };
}

export async function rejectTask(taskId: string, feedback: string, target: string, subtaskIds?: number[]) {
  if (!isFeedbackTarget(target)) {
    throw new Error(`Invalid feedback target: ${String(target)}`);
  }
  const { orchestrator } = await getStores();
  await orchestrator.rejectTask(taskId, feedback, target as FeedbackTarget, subtaskIds);
  revalidatePath('/');
}

export async function getTasks() {
  const { taskStore } = await getStores();
  await getActiveProjectPath();
  const tasks = await taskStore.getAllAsync();

  // Enrich each task with subtask progress from plan.json
  for (const task of tasks) {
    const dir = await taskStore.getDirByIdAsync(task.id);
    const planText = await readTextIfExists(join(dir, 'plan.json'));
    if (planText !== null) {
      try {
        const plan = JSON.parse(planText);
        const subtasks = plan.subtasks ?? [];
        const completed = subtasks.filter((s: { completed: boolean }) => s.completed).length;
        task.subtaskProgress = { completed, total: subtasks.length };
      } catch {
        // invalid plan.json — skip
      }
    }
  }

  return tasks;
}

export async function getTask(id: string) {
  const { taskStore } = await getStores();
  return taskStore.getByIdAsync(id);
}

export async function getTaskEvents(taskId: string) {
  const { taskStore } = await getStores();
  return taskStore.getEventsAsync(taskId);
}

export async function getTaskArtifacts(taskId: string) {
  const { taskStore } = await getStores();
  const projectPath = await getActiveProjectPath();
  const task = await taskStore.getByIdAsync(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const dir = await taskStore.getDirByIdAsync(taskId);
  return await readCommonArtifacts(dir, projectPath, task.branch);
}

export async function getTaskFull(taskId: string) {
  const { taskStore } = await getStores();
  const projectPath = await getActiveProjectPath();

  const task = await taskStore.getByIdAsync(taskId);
  if (!task) throw new TaskNotFoundError(taskId);

  const allTasks = await taskStore.getAllAsync();
  const dependencies = allTasks.filter(t => task.dependencies?.includes(t.id));
  const dependents = allTasks.filter(t => t.dependencies?.includes(taskId));

  const dir = await taskStore.getDirByIdAsync(taskId);

  // ── Common artifacts (spec, qa, feedback, diff) ──
  const { spec, qaReport, humanFeedback, diff } = await readCommonArtifacts(
    dir,
    projectPath,
    task.branch,
  );

  const planText = await readTextIfExists(join(dir, 'plan.json'));
  let plan: PlanData | null = null;
  if (planText !== null) {
    try { plan = JSON.parse(planText); } catch { /* skip */ }
  }

  const agentOutput = await readTextIfExists(join(dir, 'output.log'));

  // Read per-subtask log files for the expandable terminal list
  const subtaskTerminals: { id: number; title: string; log: string | null }[] = [];
  if (plan?.subtasks) {
    for (const s of plan.subtasks) {
      const log = await readTextIfExists(join(dir, `output-st${s.id}.log`));
      if (log !== null) {
        subtaskTerminals.push({ id: Number(s.id), title: s.title, log });
      }
    }
  }
  subtaskTerminals.sort((a, b) => a.id - b.id);

  // Read QA log (accumulates across QA retries)
  const qaLog = await readTextIfExists(join(dir, 'output-qa.log'));

  // Read per-role log files
  const specLog = await readTextIfExists(join(dir, 'output-spec.log'));
  const planLog = await readTextIfExists(join(dir, 'output-plan.log'));
  const mergeLog = await readTextIfExists(join(dir, 'output-merge.log'));

  // Load spec versions for the comparison UI. Under the rename-at-revision
  // scheme the on-disk layout is: spec_v{1..N}.md are archived versions and
  // spec.md is the CURRENT version (N+1) — except before the first revision,
  // where spec.md alone IS v1 and no snapshot exists. Legacy copy-scheme dirs
  // (where spec_v{N}.md was a byte-copy of the live spec) map to the same
  // view: a highest snapshot byte-identical to the live spec collapses into
  // that entry instead of double-counting it.
  const specVersions: Record<string, string> = {};
  for (let version = 1; version <= MAX_REVISION_SNAPSHOTS; version++) {
    const snapshot = await readTextIfExists(join(dir, `spec_v${version}.md`));
    if (snapshot !== null) {
      specVersions[`v${version}`] = snapshot;
    }
  }
  const liveContent = await readTextIfExists(join(dir, 'spec.md'));
  if (liveContent !== null) {
    const snapshotNums = Object.keys(specVersions)
      .map(k => parseInt(k.slice(1), 10))
      .sort((a, b) => a - b);
    const highest = snapshotNums.length > 0 ? snapshotNums[snapshotNums.length - 1] : 0;
    // Only surface the live spec as its own version when it differs from the
    // highest archived snapshot — otherwise it IS that version (legacy dirs)
    // and adding another key would double-count it.
    if (highest === 0 || specVersions[`v${highest}`] !== liveContent) {
      specVersions[`v${highest + 1}`] = liveContent;
    }
  }

  // Read session map for live streaming per terminal
  let sessionMap: Record<string, string> = {};
  const sessionMapText = await readTextIfExists(join(dir, 'session_map.json'));
  if (sessionMapText !== null) {
    try { sessionMap = JSON.parse(sessionMapText); } catch { /* skip */ }
  }

  const specPath = join(dir, 'spec.md');

  // Surface why the task is sitting in awaiting-review — either an approval
  // attempt that failed and bounced back, or the spec phase auto-parking
  // (no-op revision, missing spec.md/spec_summary.md) instead of a genuine
  // QA pass. Both cases advance to 'awaiting-review' the same way a real
  // pass does, so without this the review panel can't tell them apart.
  // task.awaitingReviewReason (updatePhase persists it there directly) is
  // the source of truth going forward; the events.jsonl derivation is kept
  // as a fallback for a task that was already parked before that field
  // existed.
  let awaitingReviewReason: string | null = task.awaitingReviewReason ?? null;
  if (!awaitingReviewReason) {
    try {
      awaitingReviewReason = getAwaitingReviewReason(await taskStore.getEventsAsync(taskId));
    } catch { /* best-effort */ }
  }

  // ── Role Refinement Assistant ──
  // The inline card is driven by the task's refinementStatus, with the
  // suggestion record + current role file contents passed as props (the
  // props-over-async-fetch rule) so the diff renders without a client fetch.
  // Keep every non-dismissed outcome for this task visible. The task record
  // still stores the newest ID for compatibility, but the suggestion directory
  // is the source of truth for repeat analyses and their history.
  const refinementSuggestions = suggestionsForTask(projectPath, taskId)
    .filter(s => s.status !== 'dismissed' && s.status !== 'superseded');
  const refinementSuggestion: RoleRefinementSuggestion | null =
    refinementSuggestions.find(s => s.id === task.refinementSuggestionId)
    ?? refinementSuggestions[0]
    ?? null;
  let refinementMode: RoleRefinementMode = 'manual';
  try { refinementMode = getRoleRefinementConfig(projectPath).mode; } catch { /* default */ }
  const roleFiles: Record<string, string> = {};
  try {
    const rolesDir = join(projectPath, '.claude', 'roles');
    for (const f of (await readdir(rolesDir)).filter(f => f.endsWith('.md'))) {
      roleFiles[f] = await readFile(join(rolesDir, f), 'utf-8');
    }
  } catch { /* roles dir missing — empty map is fine */ }

  return { task, allTasks, dependencies, dependents, spec, specVersions, plan, qaReport, humanFeedback, diff, agentOutput, subtaskTerminals, qaLog, specLog, planLog, mergeLog, sessionMap, specPath, awaitingReviewReason, refinementSuggestion, refinementSuggestions, refinementMode, roleFiles };
}

export async function addDependency(taskId: string, depId: string): Promise<void> {
  const { taskStore } = await getStores();
  const task = await taskStore.getByIdAsync(taskId);
  if (!task) return;
  const deps = task.dependencies ?? [];
  if (!deps.includes(depId)) taskStore.update(taskId, { dependencies: [...deps, depId] });
  revalidatePath(`/task/${taskId}`);
  revalidatePath(`/task/${depId}`);
  revalidatePath('/');
}

export async function removeDependency(taskId: string, depId: string): Promise<void> {
  const { taskStore } = await getStores();
  const task = await taskStore.getByIdAsync(taskId);
  if (!task) return;
  taskStore.update(taskId, { dependencies: (task.dependencies ?? []).filter(id => id !== depId) });
  revalidatePath(`/task/${taskId}`);
  revalidatePath(`/task/${depId}`);
  revalidatePath('/');
}

// "This task blocks blockedTaskId" — add thisTaskId to the other task's dependencies
export async function addBlock(thisTaskId: string, blockedTaskId: string): Promise<void> {
  const { taskStore } = await getStores();
  const blocked = await taskStore.getByIdAsync(blockedTaskId);
  if (!blocked) return;
  const deps = blocked.dependencies ?? [];
  if (!deps.includes(thisTaskId)) taskStore.update(blockedTaskId, { dependencies: [...deps, thisTaskId] });
  revalidatePath(`/task/${thisTaskId}`);
  revalidatePath(`/task/${blockedTaskId}`);
  revalidatePath('/');
}

export async function removeBlock(thisTaskId: string, blockedTaskId: string): Promise<void> {
  const { taskStore } = await getStores();
  const blocked = await taskStore.getByIdAsync(blockedTaskId);
  if (!blocked) return;
  taskStore.update(blockedTaskId, { dependencies: (blocked.dependencies ?? []).filter(id => id !== thisTaskId) });
  revalidatePath(`/task/${thisTaskId}`);
  revalidatePath(`/task/${blockedTaskId}`);
  revalidatePath('/');
}

export async function checkBulkTaskWorktrees(taskIds: string[]): Promise<Record<string, boolean>> {
  const { taskStore, orchestrator } = await getStores();
  const result: Record<string, boolean> = {};
  for (const id of taskIds) {
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

export async function checkTaskWorktree(taskId: string): Promise<{ exists: boolean; path: string | null }> {
  const { taskStore, orchestrator } = await getStores();
  const task = await taskStore.getByIdAsync(taskId);
  if (!task || !task.branch) return { exists: false, path: null };
  const wtPath = orchestrator.getWorktreePath(taskId);
  if (!wtPath) return { exists: false, path: null };
  return { exists: await pathExists(wtPath), path: wtPath };
}

export async function deleteTaskWorktree(taskId: string, operationId?: string): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { taskStore, orchestrator } = await getStores();
  const projectPath = await getActiveProjectPath();
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
  revalidatePath('/');
  revalidatePath(`/task/${taskId}`);
  return { success: true, operationId: opId };
}
