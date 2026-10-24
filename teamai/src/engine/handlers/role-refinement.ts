/**
 * Engine-side role-refinement mutations, moved from `src/app/actions/role-refinement.ts`.
 * Read helpers stay in the API. Handlers never call `revalidatePath`; the action
 * wrapper does (using the `sourceTaskId` returned where one is relevant).
 */
import { TaskStore } from '@/lib/task-store';
import {
  getRoleRefinementConfig,
  setRoleRefinementConfig,
  analyzeFailure,
  getSuggestion,
  applyRefinement,
  dismissRefinement,
  revertRefinement,
  makeRoleRefinementAnalyzeDeps,
  type RoleRefinementConfig,
} from '@/lib/role-refinement';
import { tasksHandlers } from './tasks';
import { error as logError } from '@/lib/logger';
import { runInBackground } from '@/lib/background-actions';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (params: any) => Promise<unknown>;

type ActionResult = { success: boolean; error?: string };

/** First source task id of a suggestion. */
function getSourceTaskId(projectPath: string, suggestionId: string): string | null {
  const record = getSuggestion(projectPath, suggestionId);
  return record?.sourceTaskIds?.[0] ?? null;
}

/** Start a manual failure analysis (fire-and-forget). Guards mode !== 'off' and phase === 'failed'. */
async function analyzeFailedTask(params: { projectPath: string; taskId: string; operationId?: string }): Promise<{ success: boolean; error?: string; operationId?: string }> {
  const { projectPath, taskId, operationId } = params;
  const config = getRoleRefinementConfig(projectPath);
  if (config.mode === 'off') {
    return { success: false, error: 'Role refinement is disabled for this project (Settings → Role Refinements)' };
  }
  const taskStore = new TaskStore(projectPath);
  let task;
  try {
    task = await taskStore.getByIdAsync(taskId);
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to read task' };
  }
  if (!task) return { success: false, error: 'Task not found' };
  if (task.phase !== 'failed') {
    return { success: false, error: `Task is in phase "${task.phase}", not "failed"` };
  }

  // Stamp 'analyzing' synchronously so the UI shows the spinner immediately,
  // then run the analysis in the background.
  taskStore.update(taskId, { refinementStatus: 'analyzing' });

  const opId = runInBackground(
    { operationId, action: 'analyze-failure', taskId, projectRoot: projectPath, notify: 'failure-only' },
    () => analyzeFailure(projectPath, taskId, 'manual', makeRoleRefinementAnalyzeDeps()),
  );
  return { success: true, operationId: opId };
}

async function setRoleRefinementConfigAction(params: { projectPath: string; cfg: RoleRefinementConfig }): Promise<void> {
  setRoleRefinementConfig(params.projectPath, params.cfg);
}

async function applyRefinementAction(params: {
  projectPath: string;
  suggestionId: string;
  overrides?: Record<string, string>;
}): Promise<ActionResult & { sourceTaskId?: string | null }> {
  const { projectPath, suggestionId, overrides } = params;
  try {
    applyRefinement(projectPath, suggestionId, overrides);
    return { success: true, sourceTaskId: getSourceTaskId(projectPath, suggestionId) };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to apply refinement' };
  }
}

/** Apply, then retry the source task (human-in-the-loop validation). */
async function applyAndRetryRefinementAction(params: {
  projectPath: string;
  suggestionId: string;
  overrides?: Record<string, string>;
}): Promise<ActionResult> {
  const { projectPath, suggestionId } = params;
  const applied = await applyRefinementAction(params);
  if (!applied.success) return { success: false, error: applied.error };
  const taskId = getSourceTaskId(projectPath, suggestionId);
  if (!taskId) return { success: false, error: 'Suggestion has no source task' };
  const retry = await tasksHandlers['tasks.retryTask']({ projectPath, taskId }) as ActionResult;
  if (retry.success) {
    try {
      const taskStore = new TaskStore(projectPath);
      const task = await taskStore.getByIdAsync(taskId);
      if (task) {
        taskStore.update(taskId, { refinementRetryCount: (task.refinementRetryCount ?? 0) + 1 });
      }
    } catch (err) { logError('role-refinement', 'Failed to bump refinementRetryCount', err); }
  }
  return retry;
}

async function dismissRefinementAction(params: { projectPath: string; suggestionId: string }): Promise<ActionResult> {
  try {
    dismissRefinement(params.projectPath, params.suggestionId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to dismiss refinement' };
  }
}

async function revertRefinementAction(params: { projectPath: string; suggestionId: string }): Promise<ActionResult> {
  try {
    revertRefinement(params.projectPath, params.suggestionId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Failed to revert refinement' };
  }
}

export const roleRefinementHandlers: Record<string, Handler> = {
  'roleRefinement.analyzeFailedTask': analyzeFailedTask,
  'roleRefinement.setRoleRefinementConfigAction': setRoleRefinementConfigAction,
  'roleRefinement.applyRefinementAction': applyRefinementAction,
  'roleRefinement.applyAndRetryRefinementAction': applyAndRetryRefinementAction,
  'roleRefinement.dismissRefinementAction': dismissRefinementAction,
  'roleRefinement.revertRefinementAction': revertRefinementAction,
};
