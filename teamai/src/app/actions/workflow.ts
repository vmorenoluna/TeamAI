'use server';

import { TaskStore } from '@/lib/task-store';
import { getActiveProjectPath } from './projects';
import { engineCall } from '@/engine/engine-client';
import type { Task } from '@/lib/task-store';

export interface WorkflowTask {
  task: Task;
  qaBounces: number;
  /** ISO timestamp of when the task entered its current phase */
  enteredPhaseAt: string | null;
  /** Whether this task has an active pipeline session running */
  isActive: boolean;
}

const ACTIVE_IDS_TIMEOUT_MS = 5000;

export async function getWorkflowTasks(): Promise<WorkflowTask[]> {
  const projectPath = await getActiveProjectPath();
  const taskStore = new TaskStore(projectPath);
  const tasks = await taskStore.getAllAsync();

  // Activity is advisory: when the engine is unavailable or slow, report every task idle
  // rather than failing the whole workflow view.
  let activeIds = new Set<string>();
  try {
    activeIds = new Set(await engineCall<string[]>('orchestrator.getActiveTaskIds', [{ projectPath }], { timeoutMs: ACTIVE_IDS_TIMEOUT_MS }));
  } catch (err) {
    console.error('[workflow] could not read active task ids from the engine:', err);
  }

  return Promise.all(tasks.map(async task => {
    const events = await taskStore.getEventsAsync(task.id);

    // Count QA bounces: number of times the task entered qa-review phase
    const qaBounces = events.filter(e => e.phase === 'qa-review').length;

    // Find when the task entered its current phase
    const phaseEvents = events.filter(e => e.phase === task.phase);
    const enteredPhaseAt = phaseEvents.length > 0
      ? phaseEvents[phaseEvents.length - 1].timestamp
      : null;

    return { task, qaBounces, enteredPhaseAt, isActive: activeIds.has(task.id) };
  }));
}
