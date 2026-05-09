import { TerminalsView } from '@/components/terminals-view';
import { getRoles } from '@/app/actions/roles';
import { getActiveProject } from '@/app/actions/projects';

export default async function TerminalsPage() {
  const activeProject = await getActiveProject();
  if (!activeProject) {
    return <div className="p-6 text-sm text-slate-500">No active project selected.</div>;
  }
  const roles = await getRoles();
  return <TerminalsView roles={roles} />;
}
