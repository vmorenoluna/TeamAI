import { getTasks } from './actions/tasks';
import { getActiveProject } from './actions/projects';
import { KanbanBoard } from '@/components/kanban-board';
import type { Task } from '@/lib/task-store';

export default async function Home() {
  const activeProject = await getActiveProject();

  if (!activeProject) {
    return (
      <div className="flex flex-1 items-center justify-center text-slate-400">
        <p className="text-sm">Select or add a project from the sidebar to get started.</p>
      </div>
    );
  }

  let tasks: Task[] = [];
  let tasksError: string | null = null;
  try {
    tasks = await getTasks();
  } catch (err) {
    // Active project path may be stale; surface a meaningful message rather than
    // silently rendering an empty board (silent-failure regression fix).
    tasksError = err instanceof Error ? err.message : 'Failed to load tasks for this project';
  }

  if (tasksError) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <div
          role="alert"
          className="max-w-md p-4 bg-red-900/30 border border-red-800/50 rounded-lg"
        >
          <p className="text-sm font-semibold text-red-300 mb-1">Could not load tasks</p>
          <p className="text-xs text-red-400">{tasksError}</p>
          <p className="text-[11px] text-slate-500 mt-2">
            This often happens when the active project path is stale — pick another project from the sidebar to retry.
          </p>
        </div>
      </div>
    );
  }

  return <KanbanBoard tasks={tasks} projectPath={activeProject.path} />;
}
