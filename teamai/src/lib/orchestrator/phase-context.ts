/**
 * PhaseContext — the single dependency-injection object passed to all phase runners.
 *
 * Previously, each phase-runner call site in Orchestrator built a fresh ad-hoc
 * object of ~10 arrow-function closures.  This interface centralises every
 * dependency so the Orchestrator builds it ONCE and passes it everywhere.
 * Because it is a structural superset of every individual Deps interface
 * (CascadePhaseDeps, ImplementDeps, QaReviewDeps, etc.), TypeScript accepts it
 * anywhere those narrower types are expected.
 */

import type { PipelinePhase } from '@/constants/phases';
import type { AgentSession } from '../process-manager';
import type { TaskStore } from '../task-store';
import type { TaskPipeline, QaReport, SessionOptsResult } from './types';
import type { SensorsConfig } from '../sensors';

// Forward-declare to avoid circular imports with implement.ts
export interface ImplementPipeline extends TaskPipeline {
  _wakeupJustCompleted?: boolean;
}

export interface PhaseContext {
  // ── Identity ──
  projectRoot: string;
  taskStore: TaskStore;

  // ── Pipeline state ──
  /** Persist phase to disk AND emit via processManager. */
  persistAndEmitPhase: (pipeline: TaskPipeline) => void;
  /** Advance to the next phase (persists + emits). */
  advancePhase: (pipeline: TaskPipeline, phase: PipelinePhase, eventExtra?: Record<string, unknown>) => void;
  /** Save crash-recovery state to .pipeline_state.json. */
  savePipelineState: (pipeline: TaskPipeline) => void;
  /** Resume execution from the pipeline's current phase. */
  executePhase: (pipeline: TaskPipeline) => Promise<void>;
  /** For rate-limit recursive reuse — unwinds the failed attempt budget. */
  handleRateLimit: (pipeline: TaskPipeline, resetsAt: number) => void;

  // ── Session management ──
  sessionOpts: (role: AgentSession['role'], cwd: string, taskId: string, logFile?: string) => SessionOptsResult;
  waitForCompletion: (sessionId: string) => Promise<void>;

  // ── Git operations ──
  execGit: (args: string[], hostCwd: string) => void;
  /** Same routing as execGit, but returns captured stdout — for read
   *  commands (status, log, diff) against a worktree that may be
   *  container-patched and thus unresolvable via a plain host execFileSync. */
  execGitCapture: (args: string[], hostCwd: string) => string;
  gitPush: (pushArgs: string[], logFile: string) => void;

  // ── Logging / output ──
  rotateOutputLog: (logFile: string) => void;
  phaseHeader: (logFile: string, phase: string) => void;

  // ── Container / worktree ──
  toAgentPath: (hostPath: string) => string;
  patchWorktreeGitFile: (hostWorktreePath: string, containerWorkspace: string) => void;
  /** Restore host-side paths in a worktree .git file (used by tests + artifact-commit). */
  restoreWorktreeGitFileToHostPaths: (hostWorktreePath: string) => void;
  /** Get GIT_DIR / GIT_WORK_TREE env vars for worktree git commands. */
  worktreeGitEnv: (hostCwd: string, containerWs?: string) => Record<string, string>;
  isWorktreeHealthy: (worktreePath: string) => boolean;
  cleanStaleSubtaskWorktrees: (pipeline: TaskPipeline) => void;
  removeWorktree: (taskId: string) => void;

  // ── Snapshots ──
  restoreQaReportFromSnapshot: (specPath: string) => void;
  restoreHumanFeedbackFromSnapshot: (specPath: string) => void;

  // ── QA / review ──
  writeQaFeedback: (pipeline: TaskPipeline, report: QaReport) => void;
  writeCompletionSummary: (pipeline: TaskPipeline) => void;
  autoReviseSpec: (pipeline: TaskPipeline) => Promise<void>;

  // ── Config ──
  getPipelineConfig: () => { maxQaAttempts: number; parallelSubtasks: boolean; sensors?: SensorsConfig; maxDeliverableFails: number; maxWakeupAttempts: number; maxStallRecoveries: number; idleStallMinutes: number; toolStallMinutes: number };

  // ── Plan write lock ──
  /** Mutable reference to the plan-write serialisation lock. */
  planWriteLock: { current: Promise<void> };

  // ── Wakeup scheduling (ADR 002) ──
  scheduleWakeup: (pipeline: TaskPipeline) => void;

  // ── PR / merge ──
  extractPrUrl: (logFile: string) => string | null;
  commitArtifactsToWorktree: (pipeline: TaskPipeline) => void;

  // ── Pipeline multi-task state ──
  pipelines: Map<string, TaskPipeline>;
  activeTasks: Set<string>;
  restorePipeline: (taskId: string, requiredPhase: PipelinePhase) => TaskPipeline;
}
