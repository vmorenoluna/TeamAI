'use server';

import { TaskStore } from '@/lib/task-store';
import { getOrchestrator, detectDefaultBranch } from '@/lib/orchestrator';
import { getActiveProjectPath } from './projects';
import { processManager } from '@/lib/process-manager';
import { revalidatePath } from 'next/cache';
import type { PlanData, QAReportData } from '@/lib/stream-types';
import { randomUUID } from 'crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync, rmSync } from 'fs';
import { getResumePhaseForFailedTask } from '@/lib/task-utils';
import { join, resolve } from 'path';
import { execFileSync } from 'child_process';

async function getStores() {
  const projectPath = await getActiveProjectPath();
  return {
    taskStore: new TaskStore(projectPath),
    orchestrator: getOrchestrator(projectPath),
    projectPath,
  };
}

export async function readHumanFeedback(dir: string): Promise<string | null> {
  const path = join(dir, 'human_feedback.md');
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8').replace(/^# Human Review Feedback\n\n/, '').trim();
  return raw || null;
}

export async function createTask(formData: FormData) {
  const { taskStore } = await getStores();
  const id = randomUUID();
  const title = formData.get('title') as string;
  const description = formData.get('description') as string;
  taskStore.create(id, title, description);
  revalidatePath('/');
  return { id };
}

export async function moveTask(taskId: string, targetPhase: string) {
  const { orchestrator } = await getStores();
  // Fire-and-forget (pipeline runs async)
  orchestrator.moveTaskToPhase(taskId, targetPhase).catch(console.error);
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
    resumePhase = getResumePhaseForFailedTask(events);
  } catch { /* fall back to default */ }

  // ── Gap 4b: Restore qa_report.json from snapshot if deleted ──
  // Belt-and-suspenders guard: if the report was deleted before the retry,
  // restore it from any available snapshot so context is preserved.
  const dir = taskStore.getDirById(taskId);
  const reportPath = join(dir, 'qa_report.json');
  if (!existsSync(reportPath)) {
    for (const snapName of ['qa_report_before_failed.json', 'qa_report_before_bounce.json']) {
      const snapshotPath = join(dir, snapName);
      if (existsSync(snapshotPath)) {
        try {
          const snapshot = readFileSync(snapshotPath, 'utf-8');
          writeFileSync(reportPath, snapshot);
          const logFile = join(dir, 'output.log');
          appendFileSync(logFile, `\n[RETRY] Restored qa_report.json from ${snapName} — file was deleted before retry\n`);
        } catch { /* best-effort */ }
        break; // use the first available snapshot
      }
    }
  }

  // ── Gap 4b: Restore human_feedback.md from snapshot if deleted ──
  const humanFeedbackPath = join(dir, 'human_feedback.md');
  const humanFeedbackSnapshotPath = join(dir, 'human_feedback_before_bounce.md');
  if (!existsSync(humanFeedbackPath) && existsSync(humanFeedbackSnapshotPath)) {
    try {
      const snapshot = readFileSync(humanFeedbackSnapshotPath, 'utf-8');
      writeFileSync(humanFeedbackPath, snapshot);
      const logFile = join(dir, 'output.log');
      appendFileSync(logFile, '\n[RETRY] Restored human_feedback.md from human_feedback_before_bounce.md — file was deleted before retry\n');
    } catch { /* best-effort */ }
  }

  // ── Gap 5: Snapshot qa_report.json before re-running so context is preserved ──
  if (existsSync(reportPath)) {
    const snapshotPath = join(dir, 'qa_report_before_failed.json');
    try {
      const reportContent = readFileSync(reportPath, 'utf-8');
      writeFileSync(snapshotPath, reportContent);
    } catch { /* best-effort — don't block retry on snapshot failure */ }
  }

  // Clear completionSummary so the failure indicator disappears
  taskStore.update(taskId, { completionSummary: undefined });

  // Fire-and-forget — pipeline runs async, phase changes broadcast via WebSocket
  orchestrator.moveTaskToPhase(taskId, resumePhase).catch(console.error);
  revalidatePath('/');
  return { success: true };
}

export async function stopTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { taskStore, orchestrator, projectPath } = await getStores();
  const task = taskStore.getById(taskId);
  if (!task) return { success: false, error: 'Task not found' };

  const noStopPhases = new Set(['backlog', 'done', 'failed']);
  if (noStopPhases.has(task.phase)) return { success: false, error: `Cannot stop task in "${task.phase}" phase` };

  // Cancel the running pipeline
  orchestrator.cancelPipeline(taskId);

  // Clean up artifacts: keep completed phase artifacts, remove in-progress ones
  orchestrator.cleanupTaskArtifacts(taskId, task.phase);

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
  orchestrator.resumeTask(taskId).catch(console.error);
  revalidatePath('/');
  return { success: true };
}

export async function restartCurrentPhase(taskId: string): Promise<{ success: boolean; error?: string }> {
  const { taskStore, orchestrator } = await getStores();
  const task = taskStore.getById(taskId);
  if (!task) return { success: false, error: 'Task not found' };

  const restartablePhases = new Set(['spec', 'plan', 'implement', 'qa-review']);
  if (!restartablePhases.has(task.phase)) {
    return { success: false, error: `Cannot restart task in "${task.phase}" phase` };
  }

  if (task.phase === 'qa-review') {
    // For qa-review: just re-run QA without re-implementing.
    // moveTaskToPhase would set startPhase='implement' (since plan exists),
    // but the user asked to restart _this_ phase from scratch — not the pipeline.
    taskStore.clearArtifacts(taskId, 'qa');
    orchestrator.runTask(taskId, task.description, 'qa-review').catch(console.error);
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
    orchestrator.moveTaskToPhase(taskId, task.phase).catch(console.error);
  } else {
    // spec / plan: moveTaskToPhase handles clearing stale artifacts
    // and setting the correct startPhase (e.g. spec redoes everything,
    // plan redoes plan→implement→qa).
    orchestrator.moveTaskToPhase(taskId, task.phase).catch(console.error);
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
  orchestrator.runTask(taskId, task.description).catch(console.error);
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

export async function rejectTask(taskId: string, feedback: string) {
  const { orchestrator } = await getStores();
  await orchestrator.rejectTask(taskId, feedback);
  revalidatePath('/');
}

export async function reviseSpec(taskId: string) {
  const { orchestrator } = await getStores();
  await orchestrator.reviseSpec(taskId);
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

  const specPath = join(dir, 'spec.md');
  const spec = existsSync(specPath) ? readFileSync(specPath, 'utf-8') : null;

  const qaPath = join(dir, 'qa_report.json');
  const qaReport = existsSync(qaPath)
    ? JSON.parse(readFileSync(qaPath, 'utf-8'))
    : null;

  const humanFeedback = await readHumanFeedback(dir);

  let diff: string | null = null;
  if (task.branch) {
    try {
      const base = detectDefaultBranch(projectPath);
      diff = execFileSync('git', ['diff', `${base}...${task.branch}`], {
        cwd: projectPath,
        encoding: 'utf-8',
      });
    } catch {
      diff = null;
    }
  }
  // Fallback: read pre-canned diff.txt from task directory (for demo / mocked tasks)
  if (!diff) {
    const diffPath = join(dir, 'diff.txt');
    if (existsSync(diffPath)) diff = readFileSync(diffPath, 'utf-8');
  }

  return { spec, qaReport, humanFeedback, diff };
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

  const specPath = join(dir, 'spec.md');
  const spec = existsSync(specPath) ? readFileSync(specPath, 'utf-8') : null;

  const planPath = join(dir, 'plan.json');
  let plan: PlanData | null = null;
  if (existsSync(planPath)) {
    try { plan = JSON.parse(readFileSync(planPath, 'utf-8')); } catch { /* skip */ }
  }

  const qaPath = join(dir, 'qa_report.json');
  let qaReport: QAReportData | null = null;
  if (existsSync(qaPath)) {
    try { qaReport = JSON.parse(readFileSync(qaPath, 'utf-8')); } catch { /* skip */ }
  }

  let diff: string | null = null;
  if (task.branch) {
    try {
      const base = detectDefaultBranch(projectPath);
      diff = execFileSync('git', ['diff', `${base}...${task.branch}`], { cwd: projectPath, encoding: 'utf-8' });
    } catch { /* no diff yet */ }
  }
  // Fallback: read pre-canned diff.txt from task directory (for demo / mocked tasks)
  if (!diff) {
    const diffPath = join(dir, 'diff.txt');
    if (existsSync(diffPath)) diff = readFileSync(diffPath, 'utf-8');
  }

  const humanFeedback = await readHumanFeedback(dir);

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

  // Load spec revision snapshots for comparison UI
  const specVersions: Record<string, string> = {};
  for (const version of [1, 2, 3]) {
    const vPath = join(dir, `spec_v${version}.md`);
    if (existsSync(vPath)) {
      specVersions[`v${version}`] = readFileSync(vPath, 'utf-8');
    }
  }

  // Read session map for live streaming per terminal
  let sessionMap: Record<string, string> = {};
  const sessionMapPath = join(dir, 'session_map.json');
  if (existsSync(sessionMapPath)) {
    try { sessionMap = JSON.parse(readFileSync(sessionMapPath, 'utf-8')); } catch { /* skip */ }
  }

  return { task, allTasks, dependencies, dependents, spec, specVersions, plan, qaReport, humanFeedback, diff, agentOutput, subtaskTerminals, qaLog, specLog, planLog, mergeLog, sessionMap };
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
        execFileSync('git', ['worktree', 'prune'], { cwd: projectPath, stdio: 'pipe' });
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
