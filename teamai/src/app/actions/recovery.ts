'use server';

import { findInterruptedTasks, type InterruptedTask } from '@/lib/recovery';
import { getOrchestrator } from '@/lib/orchestrator';
import { TaskStore } from '@/lib/task-store';
import { revalidatePath } from 'next/cache';
import { error as logError } from '@/lib/logger';

export async function getInterruptedTasks(): Promise<InterruptedTask[]> {
  const tasks = findInterruptedTasks();

  // Filter out tasks that are currently being managed by an active orchestrator
  // pipeline. These tasks are not interrupted — they're actively running in this
  // server session. findInterruptedTasks() is a pure filesystem scan that has no
  // way to distinguish between genuinely interrupted tasks (orphaned after a crash
  // or restart) and tasks that are in-progress right now.
  return tasks.filter(task => {
    try {
      const orchestrator = getOrchestrator(task.projectPath);
      return !orchestrator.isTaskActive(task.taskId);
    } catch {
      // If we can't access the orchestrator, err on the side of showing the banner
      return true;
    }
  });
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
  orchestrator.runTask(task.taskId, t.description, startPhase).catch(err => logError('recovery', `resumeInterrupted ${task.taskId} failed`, err));
  revalidatePath('/');
}
