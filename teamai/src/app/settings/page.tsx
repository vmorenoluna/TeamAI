import { getRoles } from '@/app/actions/roles';
import { getActiveProject } from '@/app/actions/projects';
import { getPipelineConfig } from '@/app/actions/pipeline';
import { RoleEditor } from '@/components/role-editor';
import { PipelineConfigEditor } from '@/components/pipeline-config';

export default async function SettingsPage() {
  const activeProject = await getActiveProject();

  if (!activeProject) {
    return <div className="p-6 text-sm text-slate-500">No active project selected.</div>;
  }

  const [roles, pipelineConfig] = await Promise.all([getRoles(), getPipelineConfig()]);

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-6 py-4 border-b border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900">
        <h1 className="text-base font-semibold text-slate-900 dark:text-white">Settings</h1>
        <p className="text-xs text-slate-500 mt-0.5">{activeProject.path}</p>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-8">
        {/* Pipeline config */}
        <section>
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Pipeline Configuration</h2>
          <p className="text-xs text-slate-500 mb-4">
            Choose which phases run and configure QA behaviour.
          </p>
          <PipelineConfigEditor config={pipelineConfig} />
        </section>

        {/* Role editor */}
        <section>
          <h2 className="text-sm font-semibold text-slate-700 dark:text-slate-300 mb-1">Agent Roles</h2>
          <p className="text-xs text-slate-500 mb-4">
            Edit agent personas to tailor behaviour to your project. Changes take effect on the next pipeline run.
          </p>
          <div className="space-y-2">
            {roles.map(role => (
              <RoleEditor key={role.filename} role={role} />
            ))}
          </div>
        </section>
      </div>
    </div>
  );
}
