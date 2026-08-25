'use server';

import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import { processManager } from '@/lib/process-manager';
import { waitForCompletion } from '@/lib/orchestrator/rate-limit';
import { parseSessionLimitReset } from '@/lib/orchestrator/helpers';
import { TaskStore } from '@/lib/task-store';
import {
  getRoleRefinementConfig,
  setRoleRefinementConfig,
  analyzeFailure,
  listSuggestions,
  getSuggestion,
  suggestionsForTask,
  applyRefinement,
  dismissRefinement,
  revertRefinement,
  type RoleRefinementConfig,
  type RoleRefinementSuggestion,
} from '@/lib/role-refinement';
import { retryTask } from './tasks';
import { error as logError } from '@/lib/logger';

/** Session seam for analyzeFailure — real processManager + rate-limit-aware wait. */
function makeAnalyzeDeps() {
  return {
    createSession: (opts: Parameters<typeof processManager.createSession>[0]) =>
      processManager.createSession(opts),
    sendMessage: (sessionId: string, content: string) => processManager.sendMessage(sessionId, content),
    waitForCompletion: (sessionId: string) => waitForCompletion(sessionId, { parseSessionLimitReset }),
    killSession: (sessionId: string) => processManager.killSession(sessionId),
  };
}

/** Start a manual failure analysis (fire-and-forget). Guards mode !== 'off' and phase === 'failed'. */
export async function analyzeFailedTask(taskId: string): Promise<{ success: boolean; error?: string }> {
  const projectPath = await getActiveProjectPath();
  const config = getRoleRefinementConfig(projectPath);
  if (config.mode === 'off') {
    return { success: false, error: 'Role refinement is disabled for this project (Settings → Role Refinements)' };
  }
  const taskStore = new TaskStore(projectPath);
  const task = taskStore.getById(taskId);
  if (!task) return { success: false, error: 'Task not found' };
  if (task.phase !== 'failed') {
    return { success: false, error: `Task is in phase "${task.phase}", not "failed"` };
  }

  // Stamp 'analyzing' synchronously so the UI shows the spinner immediately,
  // then run the analysis in the background.
  taskStore.update(taskId, { refinementStatus: 'analyzing' });
  revalidatePath('/');
  revalidatePath(`/task/${taskId}`);

  analyzeFailure(projectPath, taskId, 'manual', makeAnalyzeDeps())
    .catch(err => logError('role-refinement', `analyzeFailure ${taskId} failed`, err));
  return { success: true };
}

export async function getRoleRefinementConfigAction(): Promise<RoleRefinementConfig> {
  const projectPath = await getActiveProjectPath();
  return getRoleRefinementConfig(projectPath);
}

export async function setRoleRefinementConfigAction(cfg: RoleRefinementConfig): Promise<void> {
  const projectPath = await getActiveProjectPath();
  setRoleRefinementConfig(projectPath, cfg);
  revalidatePath('/');
  revalidatePath('/settings');
}

export async function getRefinementSuggestions(): Promise<RoleRefinementSuggestion[]> {
  const projectPath = await getActiveProjectPath();
  return listSuggestions(projectPath);
}

export async function getSuggestionsForTask(taskId: string): Promise<RoleRefinementSuggestion[]> {
  const projectPath = await getActiveProjectPath();
  return suggestionsForTask(projectPath, taskId);
}

export async function getSuggestionById(id: string): Promise<RoleRefinementSuggestion | null> {
  const projectPath = await getActiveProjectPath();
  return getSuggestion(projectPath, id);
}

export async function applyRefinementAction(
  suggestionId: string,
  overrides?: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  const projectPath = await getActiveProjectPath();
  try {
    applyRefinement(projectPath, suggestionId, overrides);
    revalidatePath('/');
    revalidatePath('/settings');
    revalidatePath(`/task/${getSourceTaskId(projectPath, suggestionId)}`);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to apply refinement' };
  }
}

/** Apply, then retry the source task (human-in-the-loop validation). */
export async function applyAndRetryRefinementAction(
  suggestionId: string,
  overrides?: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  const projectPath = await getActiveProjectPath();
  const applied = await applyRefinementAction(suggestionId, overrides);
  if (!applied.success) return applied;
  const taskId = getSourceTaskId(projectPath, suggestionId);
  if (!taskId) return { success: false, error: 'Suggestion has no source task' };
  const retry = await retryTask(taskId);
  if (retry.success) {
    try {
      const taskStore = new TaskStore(projectPath);
      const task = taskStore.getById(taskId);
      if (task) {
        taskStore.update(taskId, { refinementRetryCount: (task.refinementRetryCount ?? 0) + 1 });
      }
    } catch (err) { logError('role-refinement', 'Failed to bump refinementRetryCount', err); }
  }
  return retry;
}

export async function dismissRefinementAction(suggestionId: string): Promise<{ success: boolean; error?: string }> {
  const projectPath = await getActiveProjectPath();
  try {
    dismissRefinement(projectPath, suggestionId);
    revalidatePath('/');
    revalidatePath('/settings');
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to dismiss refinement' };
  }
}

export async function revertRefinementAction(suggestionId: string): Promise<{ success: boolean; error?: string }> {
  const projectPath = await getActiveProjectPath();
  try {
    revertRefinement(projectPath, suggestionId);
    revalidatePath('/');
    revalidatePath('/settings');
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to revert refinement' };
  }
}

/** First source task id of a suggestion (used for revalidate path targeting). */
function getSourceTaskId(projectPath: string, suggestionId: string): string | null {
  const record = getSuggestion(projectPath, suggestionId);
  return record?.sourceTaskIds?.[0] ?? null;
}
