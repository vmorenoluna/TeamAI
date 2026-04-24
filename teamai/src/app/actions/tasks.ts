'use server';

import { TaskStore } from '@/lib/task-store';
import { Orchestrator } from '@/lib/orchestrator';
import { getActiveProjectPath } from './projects';
import { revalidatePath } from 'next/cache';
import { randomUUID } from 'crypto';

async function getStores() {
  const projectPath = await getActiveProjectPath();
  return {
    taskStore: new TaskStore(projectPath),
    orchestrator: new Orchestrator(projectPath),
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

export async function runTask(taskId: string) {
  const { taskStore, orchestrator } = await getStores();
  const task = taskStore.getById(taskId);
  if (!task) throw new Error(`Task ${taskId} not found`);
  orchestrator.runTask(taskId, task.description);
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
