'use server';

import { TaskStore } from '@/lib/task-store';
import { getActiveProjectPath } from './projects';
import { getOrchestrator } from '@/lib/orchestrator';
import type { Task } from '@/lib/task-store';

export interface WorkflowTask {
  task: Task;
  qaBounces: number;
  /** ISO timestamp of when the task entered its current phase */
  enteredPhaseAt: string | null;
  /** Whether this task has an active pipeline session running */
  isActive: boolean;
}

export async function getWorkflowTasks(): Promise<WorkflowTask[]> {
  const projectPath = await getActiveProjectPath();
  const taskStore = new TaskStore(projectPath);
  const tasks = taskStore.getAll();
  const orchestrator = getOrchestrator(projectPath);

  return tasks.map(task => {
    const events = taskStore.getEvents(task.id);

    // Count QA bounces: number of times the task entered qa-review phase
    const qaBounces = events.filter(e => e.phase === 'qa-review').length;

    // Find when the task entered its current phase
    const phaseEvents = events.filter(e => e.phase === task.phase);
    const enteredPhaseAt = phaseEvents.length > 0
      ? phaseEvents[phaseEvents.length - 1].timestamp
      : null;

    return { task, qaBounces, enteredPhaseAt, isActive: orchestrator.isTaskActive(task.id) };
  });
}
