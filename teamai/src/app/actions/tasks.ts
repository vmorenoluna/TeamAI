'use server';

import { TaskStore } from '@/lib/task-store';
import { getOrchestrator } from '@/lib/orchestrator';
import { getActiveProjectPath } from './projects';
import { revalidatePath } from 'next/cache';
import type { PlanData, QAReportData } from '@/lib/stream-types';
import { randomUUID } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { execFileSync } from 'child_process';

async function getStores() {
  const projectPath = await getActiveProjectPath();
  return {
    taskStore: new TaskStore(projectPath),
    orchestrator: getOrchestrator(projectPath),
  };
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

export async function rejectTask(taskId: string, feedback: string) {
  const { orchestrator } = await getStores();
  await orchestrator.rejectTask(taskId, feedback);
  revalidatePath('/');
}

export async function getTasks() {
  const { taskStore } = await getStores();
  return taskStore.getAll();
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

  let diff: string | null = null;
  if (task.branch) {
    try {
      diff = execFileSync('git', ['diff', `main...${task.branch}`], {
        cwd: projectPath,
        encoding: 'utf-8',
      });
    } catch {
      diff = null;
    }
  }

  return { spec, qaReport, diff };
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
      diff = execFileSync('git', ['diff', `main...${task.branch}`], { cwd: projectPath, encoding: 'utf-8' });
    } catch { /* no diff yet */ }
  }

  const outputPath = join(dir, 'output.log');
  const agentOutput = existsSync(outputPath) ? readFileSync(outputPath, 'utf-8') : null;

  return { task, allTasks, dependencies, dependents, spec, plan, qaReport, diff, agentOutput };
}

export async function setTaskRoleOverride(taskId: string, role: string | null): Promise<void> {
  const { taskStore } = await getStores();
  taskStore.update(taskId, { roleOverride: role ?? undefined });
  revalidatePath(`/task/${taskId}`);
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
