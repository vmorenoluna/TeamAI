/**
 * Which kind of container engine Docker is serving, as far as container mode is concerned.
 *
 * Container mode needs Linux containers: it runs `sh -c`, uses POSIX paths under /workspaces and a
 * devcontainer remoteUser, none of which exist in a Windows container. (macOS has no containers of its own:
 * Docker on a Mac serves Linux containers from a VM, which is supported.)
 *
 * Kept apart from container-manager so the orchestrator can ask "why is container mode unusable?" without
 * depending on the whole manager. Shared on `global` like the Docker availability cache, so every module
 * instance sees the same answer.
 */
declare global {
  var __dockerEngineProblem: 'windows' | null | undefined;
}

/** 'windows' when Docker is running but serves Windows containers; null otherwise (including "unknown"). */
export function getDockerEngineProblem(): 'windows' | null {
  return global.__dockerEngineProblem ?? null;
}

export function setDockerEngineProblem(problem: 'windows' | null): void {
  global.__dockerEngineProblem = problem;
}
