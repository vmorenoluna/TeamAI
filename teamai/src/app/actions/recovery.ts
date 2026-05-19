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

  // Clear any expired rate-limit flag so the task doesn't show hourglass forever
  if (t.rateLimitedUntil) {
    const expiresAt = new Date(t.rateLimitedUntil).getTime();
    if (expiresAt <= Date.now()) {
      taskStore.update(task.taskId, { rateLimitedUntil: undefined });
    }
  }

  // Resume from the interrupted phase instead of restarting from 'spec'
  const startPhase = t.phase as 'spec' | 'plan' | 'implement' | 'qa-review' | 'merge' | 'create-pr' | undefined;
  const orchestrator = getOrchestrator(task.projectPath);
  orchestrator.runTask(task.taskId, t.description, startPhase).catch(console.error);
  revalidatePath('/');
}
