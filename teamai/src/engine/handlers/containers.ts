/**
 * Engine-side container handlers, moved from `src/app/actions/containers.ts`.
 * Config-file reads/writes and revalidation stay in the action wrapper; the engine
 * owns the container manager, Docker probing and the background bootstrap/validation.
 */
import { existsSync } from 'fs';
import { join } from 'path';
import { runInBackground } from '@/lib/background-actions';
import { containerManager, checkDockerAvailable, type ContainerState, type ValidationStep, type ValidationStatus } from '@/lib/container-manager';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Handler = (params: any) => Promise<unknown>;

interface BootstrapResult {
  enabled: boolean;
  dockerAvailable: boolean;
  generated?: boolean;
  projectType?: string;
}

/** The bootstrap part of saveContainerConfig (container.json is already written). */
async function saveContainerConfig(params: { projectPath: string; enabled: boolean }): Promise<BootstrapResult> {
  const { projectPath, enabled } = params;
  const available = await checkDockerAvailable();

  // Enabling containers always (re)validates the setup — generating a
  // devcontainer.json first only when none exists. An invalid setup blocks the
  // pipeline, so a hand-written devcontainer.json must be checked too.
  const devCfgPath = join(projectPath, '.devcontainer', 'devcontainer.json');
  if (enabled) {
    const needsGeneration = !existsSync(devCfgPath);
    // Detect project type synchronously so the UI can show it immediately
    let projectType = 'unknown';
    try {
      const { analyzeProject } = await import('@/lib/devcontainer-generator');
      projectType = analyzeProject(projectPath).type;
    } catch { /* ignore */ }

    // Fire-and-forget: (generate +) start + validate in the background
    runInBackground(
      { action: 'container-bootstrap', projectRoot: projectPath, notify: 'failure-only' },
      () => containerManager.bootstrapContainer(projectPath),
    );

    return needsGeneration
      ? { enabled, dockerAvailable: available, generated: true, projectType }
      : { enabled, dockerAvailable: available };
  }

  return { enabled, dockerAvailable: available };
}

/** Re-run container validation on demand (clears a "container invalid" block once fixed). */
async function revalidateContainer(params: { projectPath: string; operationId?: string }): Promise<{ operationId: string }> {
  const { projectPath, operationId } = params;
  // Fire-and-forget: progress streams over the container-validation channel.
  const opId = runInBackground(
    { operationId, action: 'container-revalidate', projectRoot: projectPath, notify: 'failure-only' },
    () => containerManager.revalidate(projectPath),
  );
  return { operationId: opId };
}

async function getValidationStatus(params: { projectPath: string }): Promise<ValidationStatus> {
  return containerManager.getValidationStatus(params.projectPath);
}

async function getContainerState(params: { projectPath: string }): Promise<ContainerState> {
  return await containerManager.getState(params.projectPath);
}

async function getValidationSteps(params: { projectPath: string }): Promise<ValidationStep[]> {
  return containerManager.getValidationSteps(params.projectPath);
}

async function isDockerAvailable(_params?: unknown): Promise<boolean> {
  return checkDockerAvailable();
}

/** Reset the dockerAvailable cache so the next check probes Docker fresh. */
async function resetDockerAvailability(_params?: unknown): Promise<void> {
  await checkDockerAvailable({ force: true });
}

export const containersHandlers: Record<string, Handler> = {
  'containers.saveContainerConfig': saveContainerConfig,
  'containers.revalidateContainer': revalidateContainer,
  'containers.getValidationStatus': getValidationStatus,
  'containers.getContainerState': getContainerState,
  'containers.getValidationSteps': getValidationSteps,
  'containers.isDockerAvailable': isDockerAvailable,
  'containers.resetDockerAvailability': resetDockerAvailability,
};
