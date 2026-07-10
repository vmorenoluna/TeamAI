import { notFound } from 'next/navigation';
import { getTaskFull } from '@/app/actions/tasks';
import { getActiveProject } from '@/app/actions/projects';
import { TaskDetail } from '@/components/task-detail';

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const activeProject = await getActiveProject();
  if (!activeProject) {
    return <div className="p-6 text-sm text-slate-400">No active project selected.</div>;
  }

  const full = await getTaskFull(id).catch(() => null);

  if (!full) notFound();

  return (
    <TaskDetail
      task={full.task}
      allTasks={full.allTasks}
      dependencies={full.dependencies}
      dependents={full.dependents}
      spec={full.spec}
      specVersions={full.specVersions}
      plan={full.plan}
      qaReport={full.qaReport}
      humanFeedback={full.humanFeedback}
      diff={full.diff}
      agentOutput={full.agentOutput}
      subtaskTerminals={full.subtaskTerminals}
      qaLog={full.qaLog}
      specLog={full.specLog}
      planLog={full.planLog}
      mergeLog={full.mergeLog}
      sessionMap={full.sessionMap}
    />
  );
}
