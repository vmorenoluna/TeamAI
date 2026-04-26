import { getTasks } from './actions/tasks';
import { getActiveProject } from './actions/projects';
import { getInterruptedTasks } from './actions/recovery';
import { KanbanBoard } from '@/components/kanban-board';
import type { Task } from '@/lib/task-store';

export default async function Home() {
  const activeProject = await getActiveProject();

  if (!activeProject) {
    return (
      <div className="flex flex-1 items-center justify-center text-slate-500 dark:text-slate-400">
        <p className="text-sm">Select or add a project from the sidebar to get started.</p>
      </div>
    );
  }

  let tasks: Task[] = [];
  try {
    tasks = await getTasks();
  } catch {
    // Active project path may be stale
  }

  const interrupted = await getInterruptedTasks();

  return <KanbanBoard tasks={tasks} interrupted={interrupted} />;
}
