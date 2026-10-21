import { notFound } from 'next/navigation';
import { getTaskFull } from '@/app/actions/tasks';
import { getActiveProject } from '@/app/actions/projects';
import { TaskDetail } from '@/components/task-detail';
import { TaskNotFoundError } from '@/lib/orchestrator/errors';

export default async function TaskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  const activeProject = await getActiveProject();
  if (!activeProject) {
    return <div className="p-6 text-sm text-slate-400">No active project selected.</div>;
  }

  const full = await getTaskFull(id).catch((err: unknown) => {
    if (err instanceof TaskNotFoundError || (err as { code?: unknown } | null)?.code === 'TASK_NOT_FOUND') notFound();
    throw err;
  });

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
      specPath={full.specPath}
      awaitingReviewReason={full.awaitingReviewReason}
      refinementSuggestion={full.refinementSuggestion}
      refinementSuggestions={full.refinementSuggestions}
      refinementMode={full.refinementMode}
      roleFiles={full.roleFiles}
    />
  );
}
