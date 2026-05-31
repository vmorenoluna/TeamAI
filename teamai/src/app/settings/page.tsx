import { getRoles } from '@/app/actions/roles';
import { getActiveProject } from '@/app/actions/projects';
import { getPipelineConfig } from '@/app/actions/pipeline';
import { getProvidersConfig } from '@/app/actions/providers';
import { getContainerConfig, getContainerState } from '@/app/actions/containers';
import { RoleEditor } from '@/components/role-editor';
import { PipelineConfigEditor } from '@/components/pipeline-config';
import { ProviderConfigEditor } from '@/components/provider-config';
import { ContainerConfigEditor } from '@/components/container-config';

export default async function SettingsPage() {
  const activeProject = await getActiveProject();

  if (!activeProject) {
    return <div className="p-6 text-sm text-slate-400">No active project selected.</div>;
  }

  const [roles, pipelineConfig, providersConfig, containerConfig, containerState] = await Promise.all([
    getRoles(), getPipelineConfig(), getProvidersConfig(), getContainerConfig(), getContainerState(),
  ]);

  return (
    <div className="flex flex-col h-full">
      <div className="shrink-0 px-6 py-4 border-b border-[#1e293b] bg-[#11131b]">
        <h1 className="text-base font-semibold text-white">Settings</h1>
        <p className="text-xs text-slate-400 mt-0.5">{activeProject.path}</p>
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-8">
        {/* Container config */}
        <section>
          <h2 className="text-sm font-semibold text-slate-200 mb-1">Container Isolation</h2>
          <p className="text-xs text-slate-400 mb-4">
            Run pipeline agents inside the project&apos;s devcontainer for OS-level isolation.
          </p>
          <ContainerConfigEditor
            config={containerConfig}
            initialState={containerState}
            projectPath={activeProject.path}
          />
        </section>

        {/* Pipeline config */}
        <section>
          <h2 className="text-sm font-semibold text-slate-200 mb-1">Pipeline Configuration</h2>
          <p className="text-xs text-slate-400 mb-4">
            Configure QA behaviour and parallel subtask execution.
          </p>
          <PipelineConfigEditor config={pipelineConfig} />
        </section>

        {/* Provider config */}
        <section>
          <h2 className="text-sm font-semibold text-slate-200 mb-1">Providers</h2>
          <p className="text-xs text-slate-400 mb-4">
            Configure which model and backend each agent role uses. Leave role fields blank to inherit the default.
          </p>
          <ProviderConfigEditor config={providersConfig} />
        </section>

        {/* Role editor */}
        <section>
          <h2 className="text-sm font-semibold text-slate-200 mb-1">Agent Roles</h2>
          <p className="text-xs text-slate-400 mb-4">
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
