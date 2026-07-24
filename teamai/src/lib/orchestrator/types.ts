/**
 * Shared types for the orchestrator module.
 *
 * All pipeline interfaces and QA report types live here to prevent
 * duplication and type drift across the phase runners and helpers.
 */
import type { PipelinePhase } from '@/constants/phases';
import type { AgentSession } from '../process-manager';

// ── Merge strategy ────────────────────────────────────────────────────────

export type MergeStrategy = 'local-merge' | 'pull-request';

// ── Pipeline ──────────────────────────────────────────────────────────────

export interface TaskPipeline {
  taskId: string;
  description: string;
  phase: PipelinePhase;
  specPath: string;
  worktreePath: string;
  branch: string;
  qaAttempt: number;
  maxQaAttempts: number;
  specRevision: number;
  mergeStrategy?: MergeStrategy;
  sessionId?: string;
  /** Per-subtask counter of consecutive files_to_create failures. Key = subtask ID, value = count. */
  deliverableFailCounts?: Record<number, number>;
  /** ISO timestamp — wakeup scheduled until this time (ADR 002) */
  wakeupUntil?: string;
  /** Subtask ID that triggered the wakeup (ADR 002) */
  wakeupSubtaskId?: number;
  /** Background command the engineer was running (informational) (ADR 002) */
  wakeupCommand?: string;
  /** Artifact the engineer should verify on re-entry (ADR 002) */
  wakeupArtifact?: string;
  /**
   * Path (relative to the worktree) to the background job's own progress
   * log, if the coder provided one. Lets the periodic sweep
   * (recovery.ts sweepStalledTasks) detect a dead background process from
   * its real output — the log going stale — and end the wait early
   * instead of blindly waiting out the full `wakeupUntil` window.
   */
  wakeupProgressPath?: string;
  /** Consecutive wakeup attempts for the current subtask (ADR 002) */
  wakeupAttemptCount?: number;
  /** Map of FAIL criterion text → number of consecutive QA cycles it has appeared unchanged.
   *  Used by the orchestrator to escalate persisted failures in the rework prompt. */
  persistedCriterionFailCounts?: Record<string, number>;
  /** Handle for a pending rate-limit or wakeup setTimeout — cleared by cancelPipeline. */
  pendingTimer?: ReturnType<typeof setTimeout>;
}

// ── QA report types ───────────────────────────────────────────────────────

export interface QaCriterion {
  status?: string;
  criterion?: string;
  name?: string;
  fix_needed?: string;
  notes?: string;
  evidence?: string;
}

export interface QaIssue {
  description?: string;
  message?: string;
  file?: string;
  fix_needed?: string;
  /** @deprecated Severity is no longer used — all additional_issues are mandatory. */
  severity?: string;
}

export interface SpecConcern {
  issue: string;
  reasoning: string;
  suggested_fix?: string;
}

export interface QaReport {
  overall?: string;
  criteria?: QaCriterion[];
  additional_issues?: QaIssue[];
  issues?: QaIssue[];
  spec_concerns?: SpecConcern[];
  head_at_review?: string;
  fail_type?: string;
}

// -- Plan subtask shape (plan.json) ------------------------------------

export interface PlanSubtask {
  id: number;
  title: string;
  description: string;
  files: string[];
  acceptance_criteria: string[];
  parallel_group?: string;
  completed?: boolean;
  qa_flagged?: boolean;
  depends_on?: number[];
  /** Files or directories this subtask must create on disk.
   *  Verified after the session ends -- subtask stays incomplete if any are missing. */
  files_to_create?: string[];
}

// ── Session options ─────────────────────────────────────────────────────

/** Return type for sessionOpts builder — used by processManager.createSession() */
export type SessionOptsResult = {
  taskId: string;
  role: AgentSession['role'];
  cwd: string;
  [key: string]: unknown;
};
