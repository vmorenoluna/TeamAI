'use server';

import { revalidatePath } from 'next/cache';
import { getActiveProjectPath } from './projects';
import {
  getRoleRefinementConfig,
  listSuggestions,
  getSuggestion,
  suggestionsForTask,
  type RoleRefinementConfig,
  type RoleRefinementSuggestion,
} from '@/lib/role-refinement';
import { engineCall } from '@/engine/engine-client';

/** Start a manual failure analysis (fire-and-forget). Guards mode !== 'off' and phase === 'failed'. */
export async function analyzeFailedTask(taskId: string, operationId?: string): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const projectPath = await getActiveProjectPath();
  const result = await engineCall<{ success: boolean; error?: string; operationId?: string }>(
    'roleRefinement.analyzeFailedTask', [{ projectPath, taskId, operationId }],
  );
  // The engine stamps refinementStatus 'analyzing' before returning.
  if (result.success) {
    revalidatePath('/');
    revalidatePath(`/task/${taskId}`);
  }
  return result;
}

export async function getRoleRefinementConfigAction(): Promise<RoleRefinementConfig> {
  const projectPath = await getActiveProjectPath();
  return getRoleRefinementConfig(projectPath);
}

export async function setRoleRefinementConfigAction(cfg: RoleRefinementConfig): Promise<void> {
  const projectPath = await getActiveProjectPath();
  await engineCall<void>('roleRefinement.setRoleRefinementConfigAction', [{ projectPath, cfg }]);
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
  const result = await engineCall<{ success: boolean; error?: string; sourceTaskId?: string | null }>(
    'roleRefinement.applyRefinementAction', [{ projectPath, suggestionId, overrides }],
  );
  if (!result.success) return { success: false, error: result.error };
  revalidatePath('/');
  revalidatePath('/settings');
  revalidatePath(`/task/${result.sourceTaskId ?? null}`);
  return { success: true };
}

/** Apply, then retry the source task (human-in-the-loop validation). */
export async function applyAndRetryRefinementAction(
  suggestionId: string,
  overrides?: Record<string, string>,
): Promise<{ success: boolean; error?: string }> {
  const projectPath = await getActiveProjectPath();
  const result = await engineCall<{ success: boolean; error?: string }>(
    'roleRefinement.applyAndRetryRefinementAction', [{ projectPath, suggestionId, overrides }],
  );
  revalidatePath('/');
  revalidatePath('/settings');
  return result;
}

export async function dismissRefinementAction(suggestionId: string): Promise<{ success: boolean; error?: string }> {
  const projectPath = await getActiveProjectPath();
  const result = await engineCall<{ success: boolean; error?: string }>(
    'roleRefinement.dismissRefinementAction', [{ projectPath, suggestionId }],
  );
  if (result.success) {
    revalidatePath('/');
    revalidatePath('/settings');
  }
  return result;
}

export async function revertRefinementAction(suggestionId: string): Promise<{ success: boolean; error?: string }> {
  const projectPath = await getActiveProjectPath();
  const result = await engineCall<{ success: boolean; error?: string }>(
    'roleRefinement.revertRefinementAction', [{ projectPath, suggestionId }],
  );
  if (result.success) {
    revalidatePath('/');
    revalidatePath('/settings');
  }
  return result;
}
