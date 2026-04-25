'use server';

import { findInterruptedTasks, type InterruptedTask } from '@/lib/recovery';
import { getOrchestrator } from '@/lib/orchestrator';
import { TaskStore } from '@/lib/task-store';
import { revalidatePath } from 'next/cache';

export async function getInterruptedTasks(): Promise<InterruptedTask[]> {
  return findInterruptedTasks();
}

export async function resumeTask(task: InterruptedTask): Promise<void> {
  const taskStore = new TaskStore(task.projectPath);
  const t = taskStore.getById(task.taskId);
  if (!t) return;
  const orchestrator = getOrchestrator(task.projectPath);
  orchestrator.runTask(task.taskId, t.description).catch(console.error);
  revalidatePath('/');
}
