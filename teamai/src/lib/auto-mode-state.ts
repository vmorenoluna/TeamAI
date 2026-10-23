/**
 * Lightweight module for reading auto-mode state without pulling in the full
 * auto-mode dependency chain (orchestrator, process-manager, helpers, etc.).
 *
 * Used by server components (layout.tsx) that only need to know whether auto
 * mode is enabled — not to start/stop it.
 */
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
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

/**
 * The auto-mode runner lives in the engine process, so the API process reads the
 * persisted `.teamai/auto-mode.json` rather than an in-memory map. Never throws:
 * this runs on every layout render.
 */
function readPersistedState(projectRoot: string): { enabled: boolean; maxParallel: number } {
  try {
    const p = join(projectRoot, '.teamai', 'auto-mode.json');
    if (!existsSync(p)) return { enabled: false, maxParallel: 1 };
    const parsed = JSON.parse(readFileSync(p, 'utf-8')) as Partial<AutoProjectState>;
    return {
      enabled: parsed.enabled === true,
      maxParallel: typeof parsed.maxParallel === 'number' && parsed.maxParallel >= 1 ? parsed.maxParallel : 1,
    };
  } catch {
    return { enabled: false, maxParallel: 1 };
  }
}

export function getAutoModeState(projectRoot: string): {
  enabled: boolean;
  maxParallel: number;
  activeCount: number;
} {
  const { enabled, maxParallel } = readPersistedState(projectRoot);
  let activeCount = 0;
  try {
    const taskStore = new TaskStore(projectRoot);
    activeCount = countSlotOccupyingTasks(taskStore.getAll());
  } catch { /* taskStore may fail if projectRoot doesn't exist yet */ }
  return { enabled, maxParallel, activeCount };
}
