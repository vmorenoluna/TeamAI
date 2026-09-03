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
  /** Short human-readable task title (task.title) — used for PR titles. */
  title: string;
  description: string;
  phase: PipelinePhase;
  specPath: string;
  worktreePath: string;
  branch: string;
  qaAttempt: number;
  /** Total completed QA round-trips for this task, preserved across spec revisions. */
  qaRoundCount?: number;
  maxQaAttempts: number;
  specRevision: number;
  qaRevision: number;
  mergeStrategy?: MergeStrategy;
  sessionId?: string;
  /** Per-subtask counter of consecutive files_to_create failures. Key = subtask ID, value = count. */
  deliverableFailCounts?: Record<number, number>;
  /** Per-subtask counter of stall-detector kills recovered from (session
   *  killed with killReason 'stalled', then retried with a fresh session).
   *  Key = subtask ID, value = count. Capped by maxStallRecoveries — once
   *  exceeded, the subtask fails with a clear reason instead of retrying
   *  forever against a command that's genuinely, repeatedly too slow. */
  stallRecoveryCounts?: Record<number, number>;
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
  /**
   * mtime (epoch ms) of `wakeupArtifact` at the moment the current wakeup
   * cycle was (re)scheduled, or null if the artifact didn't exist yet.
   * Lets a wakeup re-entry session that ends WITHOUT writing a fresh
   * wakeup file be verified rather than blindly trusted: if the artifact's
   * mtime hasn't advanced past this value, nothing was actually produced
   * during this cycle — the coder likely ran out of turns mid-monitoring
   * without reaching its own "reschedule if still running" instruction,
   * not that the job genuinely finished.
   */
  wakeupArtifactMtimeAtSchedule?: number | null;
  /** Map of FAIL criterion text → number of consecutive QA cycles it has appeared unchanged.
   *  Used by the orchestrator to escalate persisted failures in the rework prompt. */
  persistedCriterionFailCounts?: Record<string, number>;
  /** Map of normalized file + issue description → consecutive QA-cycle count. */
  persistedAdditionalIssueCounts?: Record<string, number>;
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
  /** The spec version this QA report was produced against (1 = initial spec). */
  spec_revision?: number;
  fail_type?: string;
  /** When true, the QA phase skips re-running and advances to awaiting-review. */
  locked?: boolean;
  /** Human reviewer identifier — "manual override" triggers QA skip. */
  reviewedBy?: string;
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
