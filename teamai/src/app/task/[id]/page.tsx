import { notFound } from 'next/navigation';
import { getTaskFull } from '@/app/actions/tasks';
import { getActiveProject } from '@/app/actions/projects';
import { getRoles } from '@/app/actions/roles';
import { TaskDetail } from '@/components/task-detail';

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const activeProject = await getActiveProject();
  if (!activeProject) {
    return <div className="p-6 text-sm text-slate-400">No active project selected.</div>;
  }

  const [full, roles] = await Promise.all([
    getTaskFull(id).catch(() => null),
    getRoles(),
  ]);

  if (!full) notFound();

  return (
    <TaskDetail
      task={full.task}
      allTasks={full.allTasks}
      dependencies={full.dependencies}
      dependents={full.dependents}
      spec={full.spec}
      plan={full.plan}
      qaReport={full.qaReport}
      humanFeedback={full.humanFeedback}
      diff={full.diff}
      roles={roles}
    />
  );
}
