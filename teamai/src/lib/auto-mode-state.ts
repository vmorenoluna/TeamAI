/**
 * Lightweight module for reading auto-mode state without pulling in the full
 * auto-mode dependency chain (orchestrator, process-manager, helpers, etc.).
 *
 * Used by server components (layout.tsx) that only need to know whether auto
 * mode is enabled — not to start/stop it.
 */
import { TaskStore } from './task-store';
import { TERMINAL_PHASES } from '@/constants/phases';

/** Mirrors the subset of AutoProjectState from auto-mode.ts that this module needs. */
interface AutoProjectState {
  enabled: boolean;
  maxParallel: number;
}

// Access the shared state Map from auto-mode.ts — do NOT re-declare the global
// (auto-mode.ts owns the declaration with the full AutoProjectState type).
function getProjectStates(): Map<string, AutoProjectState> {
  const g = globalThis as unknown as { __autoModeProjectStates?: Map<string, AutoProjectState> };
  if (!g.__autoModeProjectStates) g.__autoModeProjectStates = new Map();
  return g.__autoModeProjectStates;
}

/**
 * Count the tasks occupying an auto-mode slot: every task between leaving the
 * backlog and reaching a terminal phase, including tasks paused in
 * awaiting-review / create-pr / pr-open. A paused task's branch is not yet on
 * the base branch, so starting the next backlog task in its slot would spec,
 * plan and implement against a codebase missing that unmerged work — with
 * maxParallel 1, auto mode must run tickets strictly one after another.
 */
export function countSlotOccupyingTasks(tasks: ReadonlyArray<{ phase: string }>): number {
  return tasks.filter(t => !TERMINAL_PHASES.has(t.phase)).length;
}

export function isAutoModeEnabled(projectRoot: string): boolean {
  return getProjectStates().get(projectRoot)?.enabled ?? false;
}

export function getAutoModeState(projectRoot: string): {
  enabled: boolean;
  maxParallel: number;
  activeCount: number;
} {
  const state = getProjectStates().get(projectRoot);
  const enabled = state?.enabled ?? false;
  const maxParallel = state?.maxParallel ?? 1;
  let activeCount = 0;
  try {
    const taskStore = new TaskStore(projectRoot);
    activeCount = countSlotOccupyingTasks(taskStore.getAll());
  } catch { /* taskStore may fail if projectRoot doesn't exist yet */ }
  return { enabled, maxParallel, activeCount };
}
