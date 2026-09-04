'use server';

import { TaskStore } from '@/lib/task-store';
import { getOrchestrator } from '@/lib/orchestrator';
import { MAX_REVISION_SNAPSHOTS } from '@/lib/orchestrator/artifacts';
import { readCommonArtifacts } from '@/lib/task-artifacts';
import { getActiveProjectPath } from './projects';
import { processManager } from '@/lib/process-manager';
import { revalidatePath } from 'next/cache';
import type { PlanData } from '@/lib/stream-types';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { getResumePhaseForFailedTask } from '@/lib/task-utils';
import { getRoleRefinementConfig, getSuggestion, buildFailureSignature, type RoleRefinementMode, type RoleRefinementSuggestion } from '@/lib/role-refinement';
import { join, resolve } from 'path';
import { readdirSync } from 'fs';
import { execFileSync } from 'child_process';
import { NO_STOP_PHASES, RESTARTABLE_PHASES } from '@/constants/phases';
import { removeStaleWorktreeRegistration } from '@/lib/orchestrator/worktree-utils';
import { isFeedbackTarget, type FeedbackTarget } from '@/lib/orchestrator/feedback-target';
import { error as logError } from '@/lib/logger';
import { preRestoreFailedTask } from '@/lib/task-retry';

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

export async function moveTask(taskId: string, targetPhase: string) {
  const { orchestrator } = await getStores();
  // Fire-and-forget (pipeline runs async)
  orchestrator.moveTaskToPhase(taskId, targetPhase).catch(err => logError('tasks', `moveTask ${taskId} failed`, err));
  revalidatePath('/');
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

export async function retryTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { taskStore, orchestrator } = await getStores();
  const task = taskStore.getById(taskId);
  if (!task) return { success: false, error: 'Task not found' };
  if (task.phase !== 'failed') return { success: false, error: `Task is in phase "${task.phase}", not "failed"` };

  // Determine the phase the task was in when it failed — read from events
  let resumePhase = 'qa-review'; // default for failed tasks (most common failure point)
  try {
    const events = taskStore.getEvents(taskId);
    resumePhase = getResumePhaseForFailedTask(events, task.failureReason);
  } catch { /* fall back to default */ }

  preRestoreFailedTask(taskStore, taskId);

  // Fire-and-forget — pipeline runs async, phase changes broadcast via WebSocket
  orchestrator.moveTaskToPhase(taskId, resumePhase).catch(err => logError('tasks', `retryTask ${taskId} failed`, err));
  revalidatePath('/');
  return { success: true };
}

/**
 * Retry a task with explicit phase and optional budget reset.
 *
 * Unlike `retryTask` which picks the resume phase automatically from
 * events.jsonl, this accepts an explicit phase chosen by the user through
 * the retry-phase dialog.  It also accepts an optional `resetBudget` flag
 * that clears `.pipeline_state.json` (resetting qaAttempt and the other
 * failure counters) regardless of target phase — decoupling the "which
 * artifacts to clear" decision from the "fresh QA-attempt budget" decision.
 */
export async function retryTaskWithOptions(
  taskId: string,
  phase: string,
  resetBudget: boolean,
): Promise<{ success: boolean; error?: string }> {
  const { taskStore, orchestrator } = await getStores();
  const task = taskStore.getById(taskId);
  if (!task) return { success: false, error: 'Task not found' };

  // ── Pre-restore work (only for failed tasks) ──
  if (task.phase === 'failed') {
    preRestoreFailedTask(taskStore, taskId);
  }

  // ── Budget reset (independent of phase choice) ──
  if (resetBudget) {
    const dir = taskStore.getDirById(taskId);
    orchestrator.clearPipelineStateFile(dir);
  }

  // Fire-and-forget — pipeline runs async, phase changes broadcast via WebSocket
  orchestrator.moveTaskToPhase(taskId, phase).catch(err => logError('tasks', `stopTask ${taskId} failed`, err));
  revalidatePath('/');
  return { success: true };
}

export async function pauseTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { taskStore, orchestrator, projectPath } = await getStores();
  const task = taskStore.getById(taskId);
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

export async function resumeTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { taskStore, orchestrator } = await getStores();
  const task = taskStore.getById(taskId);
  if (!task) return { success: false, error: 'Task not found' };

  if (!task.isPaused) return { success: false, error: 'Task is not paused' };

  // Clear paused flag and any stale rate-limit/wakeup timestamps.
  // pauseTask now clears these, but belt-and-suspenders: if the task
  // reached isPaused through any other path, stale timestamps here
  // would cause a false hourglass (⏳) after resume.
  taskStore.update(taskId, { isPaused: false, rateLimitedUntil: undefined, wakeupUntil: undefined });

  // Resume from current phase — re-run the pipeline at whatever phase the task was in
  orchestrator.moveTaskToPhase(taskId, task.phase).catch(err => logError('tasks', `restartPhase ${taskId} failed`, err));
  revalidatePath('/');
  revalidatePath(`/task/${taskId}`);
  return { success: true };
}

export async function stopTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { taskStore, orchestrator, projectPath } = await getStores();
  const task = taskStore.getById(taskId);
  if (!task) return { success: false, error: 'Task not found' };

  if (NO_STOP_PHASES.has(task.phase)) return { success: false, error: `Cannot stop task in "${task.phase}" phase` };

  // Cancel the running pipeline
  orchestrator.cancelPipeline(taskId);

  // Clean up artifacts: keep completed phase artifacts, remove in-progress ones.
  // Awaited — Defect 8's reconciliation may retry cherry-picks after an infra
  // hiccup (reprovisioning the container), so this must settle before the
  // task moves to 'backlog' below.
  await orchestrator.cleanupTaskArtifacts(taskId, task.phase);

  // Clear paused state when moving to backlog (belt-and-suspenders)
  taskStore.update(taskId, { isPaused: false });

  // Move to backlog
  taskStore.updatePhase(taskId, 'backlog');
  processManager.emit('phase-change', { taskId, phase: 'backlog', projectRoot: projectPath });
  revalidatePath('/');
  revalidatePath(`/task/${taskId}`);
  return { success: true };
}

export async function playTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { taskStore, orchestrator } = await getStores();
  const task = taskStore.getById(taskId);
  if (!task) return { success: false, error: 'Task not found' };

  if (task.phase !== 'backlog') return { success: false, error: `Task is in "${task.phase}" phase, not "backlog"` };

  // Resume the task — detects completed artifacts and fast-forwards to the next phase
  orchestrator.resumeTask(taskId).catch(err => logError('tasks', `restart ${taskId} failed`, err));
  revalidatePath('/');
  return { success: true };
}

export async function restartCurrentPhase(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { taskStore, orchestrator } = await getStores();
  const task = taskStore.getById(taskId);
  if (!task) return { success: false, error: 'Task not found' };

  if (!RESTARTABLE_PHASES.has(task.phase)) {
    return { success: false, error: `Cannot restart task in "${task.phase}" phase` };
  }

  if (task.phase === 'qa-review') {
    // For qa-review: just re-run QA without re-implementing.
    // moveTaskToPhase would set startPhase='implement' (since plan exists),
    // but the user asked to restart _this_ phase from scratch — not the pipeline.
    taskStore.clearArtifacts(taskId, 'qa');
    orchestrator.runTask(taskId, task.description, 'qa-review').catch(err => logError('tasks', `restartCurrentPhase ${taskId} failed`, err));
  } else if (task.phase === 'implement') {
    // For implement: reset subtask completions in plan.json so the UI shows a fresh
    // slate. moveTaskToPhase clears QA artifacts but doesn't touch plan.json subtask
    // flags — unlike stopTask which does via cleanupTaskArtifacts.
    const dir = taskStore.getDirById(taskId);
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
    orchestrator.moveTaskToPhase(taskId, task.phase).catch(err => logError('tasks', `restartPhase ${taskId} failed`, err));
  } else {
    // spec / plan: moveTaskToPhase handles clearing stale artifacts
    // and setting the correct startPhase (e.g. spec redoes everything,
    // plan redoes plan→implement→qa).
    orchestrator.moveTaskToPhase(taskId, task.phase).catch(err => logError('tasks', `restartPhase ${taskId} failed`, err));
  }

  revalidatePath('/');
  revalidatePath(`/task/${taskId}`);
  return { success: true };
}

export async function runTask(taskId: string) {
  const { taskStore, orchestrator } = await getStores();
  const task = taskStore.getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  // Fire and forget — pipeline runs asynchronously, phase changes broadcast via WebSocket
  orchestrator.runTask(taskId, task.description).catch(err => logError('tasks', `restartFromSpec ${taskId} failed`, err));
  revalidatePath('/');
}

export async function approveTask(taskId: string, strategy: 'local-merge' | 'pull-request') {
  const { orchestrator } = await getStores();
  await orchestrator.approveTask(taskId, strategy);
  revalidatePath('/');
}

export async function markTaskDone(taskId: string) {
  const { orchestrator } = await getStores();
  await orchestrator.markTaskDone(taskId);
  revalidatePath('/');
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
  const tasks = taskStore.getAll();

  // Enrich each task with subtask progress from plan.json
  for (const task of tasks) {
    const dir = taskStore.getDirById(task.id);
    const planPath = join(dir, 'plan.json');
    if (existsSync(planPath)) {
      try {
        const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
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
  return taskStore.getById(id);
}

export async function getTaskEvents(taskId: string) {
  const { taskStore } = await getStores();
  return taskStore.getEvents(taskId);
}

export async function getTaskArtifacts(taskId: string) {
  const { taskStore } = await getStores();
  const projectPath = await getActiveProjectPath();
  const task = taskStore.getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const dir = taskStore.getDirById(taskId);
  return readCommonArtifacts(dir, projectPath, task.branch);
}

export async function getTaskFull(taskId: string) {
  const { taskStore } = await getStores();
  const projectPath = await getActiveProjectPath();

  const task = taskStore.getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);

  const allTasks = taskStore.getAll();
  const dependencies = allTasks.filter(t => task.dependencies?.includes(t.id));
  const dependents = allTasks.filter(t => t.dependencies?.includes(taskId));

  const dir = taskStore.getDirById(taskId);

  // ── Common artifacts (spec, qa, feedback, diff) ──
  const { spec, qaReport, humanFeedback, diff } = readCommonArtifacts(
    dir,
    projectPath,
    task.branch,
  );

  const planPath = join(dir, 'plan.json');
  let plan: PlanData | null = null;
  if (existsSync(planPath)) {
    try { plan = JSON.parse(readFileSync(planPath, 'utf-8')); } catch { /* skip */ }
  }

  const outputPath = join(dir, 'output.log');
  const agentOutput = existsSync(outputPath) ? readFileSync(outputPath, 'utf-8') : null;

  // Read per-subtask log files for the expandable terminal list
  const subtaskTerminals: { id: number; title: string; log: string | null }[] = [];
  if (plan?.subtasks) {
    for (const s of plan.subtasks) {
      const stLogPath = join(dir, `output-st${s.id}.log`);
      if (existsSync(stLogPath)) {
        subtaskTerminals.push({ id: Number(s.id), title: s.title, log: readFileSync(stLogPath, 'utf-8') });
      }
    }
  }
  subtaskTerminals.sort((a, b) => a.id - b.id);

  // Read QA log (accumulates across QA retries)
  const qaLogPath = join(dir, 'output-qa.log');
  const qaLog = existsSync(qaLogPath) ? readFileSync(qaLogPath, 'utf-8') : null;

  // Read per-role log files
  const specLogPath = join(dir, 'output-spec.log');
  const specLog = existsSync(specLogPath) ? readFileSync(specLogPath, 'utf-8') : null;
  const planLogPath = join(dir, 'output-plan.log');
  const planLog = existsSync(planLogPath) ? readFileSync(planLogPath, 'utf-8') : null;
  const mergeLogPath = join(dir, 'output-merge.log');
  const mergeLog = existsSync(mergeLogPath) ? readFileSync(mergeLogPath, 'utf-8') : null;

  // Load spec versions for the comparison UI. Under the rename-at-revision
  // scheme the on-disk layout is: spec_v{1..N}.md are archived versions and
  // spec.md is the CURRENT version (N+1) — except before the first revision,
  // where spec.md alone IS v1 and no snapshot exists. Legacy copy-scheme dirs
  // (where spec_v{N}.md was a byte-copy of the live spec) map to the same
  // view: a highest snapshot byte-identical to the live spec collapses into
  // that entry instead of double-counting it.
  const specVersions: Record<string, string> = {};
  for (let version = 1; version <= MAX_REVISION_SNAPSHOTS; version++) {
    const vPath = join(dir, `spec_v${version}.md`);
    if (existsSync(vPath)) {
      specVersions[`v${version}`] = readFileSync(vPath, 'utf-8');
    }
  }
  const liveSpecPath = join(dir, 'spec.md');
  if (existsSync(liveSpecPath)) {
    const liveContent = readFileSync(liveSpecPath, 'utf-8');
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
  const sessionMapPath = join(dir, 'session_map.json');
  if (existsSync(sessionMapPath)) {
    try { sessionMap = JSON.parse(readFileSync(sessionMapPath, 'utf-8')); } catch { /* skip */ }
  }

  const specPath = join(dir, 'spec.md');

  // Read events to surface approval-failure info in the review panel.
  let approvalError: string | null = null;
  try {
    const events = taskStore.getEvents(taskId);
    const lastEvent = events[events.length - 1];
    if (lastEvent && typeof lastEvent.approvalError === 'string' && lastEvent.phase === 'awaiting-review') {
      approvalError = lastEvent.approvalError;
    }
  } catch { /* best-effort */ }

  // ── Role Refinement Assistant ──
  // The inline card is driven by the task's refinementStatus, with the
  // suggestion record + current role file contents passed as props (the
  // props-over-async-fetch rule) so the diff renders without a client fetch.
  let refinementSuggestion: RoleRefinementSuggestion | null = null;
  if (task.refinementSuggestionId) {
    refinementSuggestion = getSuggestion(projectPath, task.refinementSuggestionId);
  }
  // A suggestion's signature is a snapshot of the FAIL criteria that
  // triggered it. If the task has since failed again for a different reason
  // (a new qa_report.json with different FAIL criteria, or an implement-phase
  // failure with no report at all), that suggestion describes a failure that
  // no longer exists — most commonly a stale 'no-gap' verdict that would
  // otherwise permanently hide the "Analyze failure" button behind an
  // unrelated old diagnosis, since RoleRefinementCard only shows the idle
  // prompt when no suggestion is present at all. Drop it here (display-time
  // only — task.json's stored refinementSuggestionId is left untouched) so a
  // genuinely new failure always gets a fresh "Analyze failure" prompt.
  if (refinementSuggestion && task.phase === 'failed') {
    const currentSignature = buildFailureSignature(dir, taskId);
    if (!refinementSuggestion.signature || refinementSuggestion.signature !== currentSignature) {
      refinementSuggestion = null;
    }
  }
  let refinementMode: RoleRefinementMode = 'manual';
  try { refinementMode = getRoleRefinementConfig(projectPath).mode; } catch { /* default */ }
  const roleFiles: Record<string, string> = {};
  try {
    const rolesDir = join(projectPath, '.claude', 'roles');
    for (const f of readdirSync(rolesDir).filter(f => f.endsWith('.md'))) {
      roleFiles[f] = readFileSync(join(rolesDir, f), 'utf-8');
    }
  } catch { /* roles dir missing — empty map is fine */ }

  return { task, allTasks, dependencies, dependents, spec, specVersions, plan, qaReport, humanFeedback, diff, agentOutput, subtaskTerminals, qaLog, specLog, planLog, mergeLog, sessionMap, specPath, approvalError, refinementSuggestion, refinementMode, roleFiles };
}

export async function addDependency(taskId: string, depId: string): Promise<void> {
  const { taskStore } = await getStores();
  const task = taskStore.getById(taskId);
  if (!task) return;
  const deps = task.dependencies ?? [];
  if (!deps.includes(depId)) taskStore.update(taskId, { dependencies: [...deps, depId] });
  revalidatePath(`/task/${taskId}`);
  revalidatePath(`/task/${depId}`);
  revalidatePath('/');
}

export async function removeDependency(taskId: string, depId: string): Promise<void> {
  const { taskStore } = await getStores();
  const task = taskStore.getById(taskId);
  if (!task) return;
  taskStore.update(taskId, { dependencies: (task.dependencies ?? []).filter(id => id !== depId) });
  revalidatePath(`/task/${taskId}`);
  revalidatePath(`/task/${depId}`);
  revalidatePath('/');
}

// "This task blocks blockedTaskId" — add thisTaskId to the other task's dependencies
export async function addBlock(thisTaskId: string, blockedTaskId: string): Promise<void> {
  const { taskStore } = await getStores();
  const blocked = taskStore.getById(blockedTaskId);
  if (!blocked) return;
  const deps = blocked.dependencies ?? [];
  if (!deps.includes(thisTaskId)) taskStore.update(blockedTaskId, { dependencies: [...deps, thisTaskId] });
  revalidatePath(`/task/${thisTaskId}`);
  revalidatePath(`/task/${blockedTaskId}`);
  revalidatePath('/');
}

export async function removeBlock(thisTaskId: string, blockedTaskId: string): Promise<void> {
  const { taskStore } = await getStores();
  const blocked = taskStore.getById(blockedTaskId);
  if (!blocked) return;
  taskStore.update(blockedTaskId, { dependencies: (blocked.dependencies ?? []).filter(id => id !== thisTaskId) });
  revalidatePath(`/task/${thisTaskId}`);
  revalidatePath(`/task/${blockedTaskId}`);
  revalidatePath('/');
}

export async function checkBulkTaskWorktrees(taskIds: string[]): Promise<Record<string, boolean>> {
  const { taskStore } = await getStores();
  const result: Record<string, boolean> = {};
  for (const id of taskIds) {
    const task = taskStore.getById(id);
    if (!task || !task.branch) {
      result[id] = false;
      continue;
    }
    const { orchestrator } = await getStores();
    const wtPath = orchestrator.getWorktreePath(id);
    result[id] = wtPath ? existsSync(wtPath) : false;
  }
  return result;
}

export async function checkTaskWorktree(taskId: string): Promise<{ exists: boolean; path: string | null }> {
  const { taskStore, orchestrator } = await getStores();
  const task = taskStore.getById(taskId);
  if (!task || !task.branch) return { exists: false, path: null };
  const wtPath = orchestrator.getWorktreePath(taskId);
  if (!wtPath) return { exists: false, path: null };
  return { exists: existsSync(wtPath), path: wtPath };
}

export async function deleteTaskWorktree(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { taskStore, orchestrator } = await getStores();
  const projectPath = await getActiveProjectPath();
  const task = taskStore.getById(taskId);
  if (!task || !task.branch) return { success: false, error: 'No branch found for this task' };
  const wtPath = orchestrator.getWorktreePath(taskId);
  if (!wtPath || !existsSync(wtPath)) return { success: false, error: 'Worktree directory not found on disk' };
  // ── Gap 5a: Safety guard — never rmSync the project root ──
  const resolvedWt = resolve(wtPath);
  const resolvedProject = resolve(projectPath);
  if (resolvedWt === resolvedProject) {
    return { success: false, error: 'Refusing to delete worktree at project root — this would destroy the repository' };
  }
  try {
    execFileSync('git', ['worktree', 'remove', wtPath], { cwd: projectPath, encoding: 'utf-8' });
    taskStore.update(taskId, { branch: undefined });
    revalidatePath('/');
    revalidatePath(`/task/${taskId}`);
    return { success: true };
  } catch {
    // Normal remove failed (e.g. uncommitted changes) — try --force
    try {
      execFileSync('git', ['worktree', 'remove', '--force', wtPath], { cwd: projectPath, encoding: 'utf-8' });
      taskStore.update(taskId, { branch: undefined });
      revalidatePath('/');
      revalidatePath(`/task/${taskId}`);
      return { success: true };
    } catch {
      // --force also failed (e.g. files locked) — delete manually and prune
      try {
        rmSync(wtPath, { recursive: true, force: true });
        removeStaleWorktreeRegistration(projectPath, wtPath);
        taskStore.update(taskId, { branch: undefined });
        revalidatePath('/');
        revalidatePath(`/task/${taskId}`);
        return { success: true };
      } catch (e) {
        const err = e as { stderr?: string; message?: string };
        return { success: false, error: err.stderr || err.message || 'Failed to remove worktree' };
      }
    }
  }
}
