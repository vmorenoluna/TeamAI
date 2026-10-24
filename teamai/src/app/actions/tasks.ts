'use server';

import { TaskStore } from '@/lib/task-store';
import { readTextIfExists } from '@/lib/fs-async';
import { TaskNotFoundError } from '@/lib/orchestrator/errors';
import { MAX_REVISION_SNAPSHOTS } from '@/lib/orchestrator/artifacts';
import { readCommonArtifacts } from '@/lib/task-artifacts';
import { getActiveProjectPath } from './projects';
import { revalidatePath } from 'next/cache';
import type { PlanData } from '@/lib/stream-types';
import { getAwaitingReviewReason } from '@/lib/task-utils';
import { getRoleRefinementConfig, suggestionsForTask, type RoleRefinementMode, type RoleRefinementSuggestion } from '@/lib/role-refinement';
import { join } from 'path';
import { readdir, readFile } from 'fs/promises';
import { engineCall } from '@/engine/engine-client';

async function getStores() {
  const projectPath = await getActiveProjectPath();
  return {
    taskStore: new TaskStore(projectPath),
    projectPath,
  };
}

type ActionResult = { success: boolean; error?: string; operationId?: string };

/**
 * Call a `tasks.*` engine handler for the active project. The mutating work (TaskStore
 * writes, orchestrator calls, background operations) runs in the engine process.
 */
async function callTasks<T>(method: string, params: Record<string, unknown>): Promise<T> {
  const projectPath = await getActiveProjectPath();
  return engineCall<T>(`tasks.${method}`, [{ projectPath, ...params }]);
}

export async function createTask(formData: FormData) {
  const result = await callTasks<{ id: string }>('createTask', {
    title: formData.get('title') as string,
    description: formData.get('description') as string,
    taskType: formData.get('taskType') as string | null,
  });
  revalidatePath('/');
  return result;
}

export async function moveTask(taskId: string, targetPhase: string, operationId?: string): Promise<{ operationId: string }> {
  const result = await callTasks<{ operationId: string }>('moveTask', { taskId, targetPhase, operationId });
  revalidatePath('/');
  return result;
}

export async function deleteTask(taskId: string) {
  await callTasks<void>('deleteTask', { taskId });
  revalidatePath('/');
}

export async function bulkDeleteTasks(taskIds: string[]) {
  await callTasks<void>('bulkDeleteTasks', { taskIds });
  revalidatePath('/');
}

export async function retryTask(taskId: string, operationId?: string): Promise<ActionResult> {
  const result = await callTasks<ActionResult>('retryTask', { taskId, operationId });
  if (result.success) revalidatePath('/');
  return result;
}

/**
 * Retry a task with an explicit phase chosen through the retry-phase dialog; the
 * engine handler resolves the "resume where it failed" sentinel itself.
 */
export async function retryTaskWithOptions(
  taskId: string,
  phase: string,
  operationId?: string,
): Promise<ActionResult> {
  const result = await callTasks<ActionResult>('retryTaskWithOptions', { taskId, phase, operationId });
  if (result.success) revalidatePath('/');
  return result;
}

export async function pauseTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const result = await callTasks<{ success: boolean; error?: string }>('pauseTask', { taskId });
  if (result.success) {
    revalidatePath('/');
    revalidatePath(`/task/${taskId}`);
  }
  return result;
}

export async function resumeTask(taskId: string, operationId?: string): Promise<ActionResult> {
  const result = await callTasks<ActionResult>('resumeTask', { taskId, operationId });
  if (result.success) {
    revalidatePath('/');
    revalidatePath(`/task/${taskId}`);
  }
  return result;
}

export async function stopTask(taskId: string, operationId?: string): Promise<ActionResult> {
  const result = await callTasks<ActionResult>('stopTask', { taskId, operationId });
  if (result.success) {
    revalidatePath('/');
    revalidatePath(`/task/${taskId}`);
  }
  return result;
}

export async function playTask(taskId: string, operationId?: string): Promise<ActionResult> {
  const result = await callTasks<ActionResult>('playTask', { taskId, operationId });
  if (result.success) revalidatePath('/');
  return result;
}

export async function restartCurrentPhase(taskId: string, operationId?: string): Promise<ActionResult> {
  const result = await callTasks<ActionResult>('restartCurrentPhase', { taskId, operationId });
  if (result.success) {
    revalidatePath('/');
    revalidatePath(`/task/${taskId}`);
  }
  return result;
}

export async function runTask(taskId: string, operationId?: string): Promise<{ operationId: string }> {
  const result = await callTasks<{ operationId: string }>('runTask', { taskId, operationId });
  revalidatePath('/');
  return result;
}

export async function approveTask(
  taskId: string,
  strategy: 'local-merge' | 'pull-request',
  operationId?: string,
): Promise<ActionResult> {
  const result = await callTasks<ActionResult>('approveTask', { taskId, strategy, operationId });
  if (result.success) revalidatePath('/');
  return result;
}

export async function markTaskDone(
  taskId: string,
  operationId?: string,
): Promise<ActionResult> {
  const result = await callTasks<ActionResult>('markTaskDone', { taskId, operationId });
  if (result.success) revalidatePath('/');
  return result;
}

export async function rejectTask(taskId: string, feedback: string, target: string, subtaskIds?: number[]) {
  await callTasks<void>('rejectTask', { taskId, feedback, target, subtaskIds });
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
  await callTasks<void>('addDependency', { taskId, depId });
  revalidatePath(`/task/${taskId}`);
  revalidatePath(`/task/${depId}`);
  revalidatePath('/');
}

export async function removeDependency(taskId: string, depId: string): Promise<void> {
  await callTasks<void>('removeDependency', { taskId, depId });
  revalidatePath(`/task/${taskId}`);
  revalidatePath(`/task/${depId}`);
  revalidatePath('/');
}

// "This task blocks blockedTaskId" — add thisTaskId to the other task's dependencies
export async function addBlock(thisTaskId: string, blockedTaskId: string): Promise<void> {
  await callTasks<void>('addBlock', { thisTaskId, blockedTaskId });
  revalidatePath(`/task/${thisTaskId}`);
  revalidatePath(`/task/${blockedTaskId}`);
  revalidatePath('/');
}

export async function removeBlock(thisTaskId: string, blockedTaskId: string): Promise<void> {
  await callTasks<void>('removeBlock', { thisTaskId, blockedTaskId });
  revalidatePath(`/task/${thisTaskId}`);
  revalidatePath(`/task/${blockedTaskId}`);
  revalidatePath('/');
}

export async function checkBulkTaskWorktrees(taskIds: string[]): Promise<Record<string, boolean>> {
  return callTasks<Record<string, boolean>>('checkBulkTaskWorktrees', { taskIds });
}

export async function checkTaskWorktree(taskId: string): Promise<{ exists: boolean; path: string | null }> {
  return callTasks<{ exists: boolean; path: string | null }>('checkTaskWorktree', { taskId });
}

export async function deleteTaskWorktree(taskId: string, operationId?: string): Promise<ActionResult> {
  const result = await callTasks<ActionResult>('deleteTaskWorktree', { taskId, operationId });
  if (result.success) {
    revalidatePath('/');
    revalidatePath(`/task/${taskId}`);
  }
  return result;
}
