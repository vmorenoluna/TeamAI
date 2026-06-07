import { getWorkflowTasks } from '@/app/actions/workflow';
import { getActiveProject } from '@/app/actions/projects';
import { WorkflowView } from '@/components/workflow-view';

export default async function WorkflowPage() {
  const activeProject = await getActiveProject();

  if (!activeProject) {
    return (
      <div className="flex flex-1 items-center justify-center text-slate-400">
        <p className="text-sm">Select or add a project from the sidebar to get started.</p>
      </div>
    );
  }

  const workflowTasks = await getWorkflowTasks();

  return <WorkflowView workflowTasks={workflowTasks} />;
}
