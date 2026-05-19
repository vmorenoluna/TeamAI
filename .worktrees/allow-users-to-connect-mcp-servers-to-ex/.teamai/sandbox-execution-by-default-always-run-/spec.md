# Sandbox Execution by Default

## Goal
Make agent sandboxing the default behavior — auto-create a lightweight Docker container per project and run all agent sessions inside it.

## Current State
- `readContainerConfig()` returns `{ enabled: false }` by default
- `container.json` in `.teamai/` must opt-in with `{ "enabled": true }`
- Users must manually enable containers in Settings
- Agent pipelines run on host filesystem unless container is explicitly enabled

## Desired State
- Container isolation is ON by default when Docker is available
- `readContainerConfig()` returns `{ enabled: true }` when Docker is detected
- Container auto-starts on first pipeline task execution
- Users can opt-out via Settings if desired
- Graceful fallback to host execution when Docker is not installed

## Scope
- Change default in `src/lib/container-manager.ts` (`readContainerConfig`)
- Update `src/app/actions/containers.ts` (`getContainerConfig`)
- Update `src/components/container-config.tsx` to reflect auto-detection
- Add Docker availability check before auto-enabling

## Out of Scope
- New container runtime engines (Podman, etc.)
- Container resource limits configuration
- Multi-container orchestration

## Acceptance Criteria
- [ ] When Docker is available, new projects default to container-enabled
- [ ] Existing projects with `enabled: false` are respected (no forced change)
- [ ] Settings UI shows Docker detection status
- [ ] Graceful fallback message when Docker is unavailable
- [ ] No breaking changes to existing API
