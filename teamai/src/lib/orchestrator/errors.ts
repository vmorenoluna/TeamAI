/**
 * Structured error types for orchestrator pipeline failures (T14).
 *
 * Replaces plain `new Error(...)` throws with typed errors that carry
 * machine-readable `code` properties.  Message strings are preserved
 * verbatim so existing test assertions (`rejects.toThrow('...')`) and
 * log output remain compatible.
 *
 * Usage:
 *   throw new TaskStateError('Task abc not found', 'TASK_NOT_FOUND');
 *
 * Catch sites can discriminate:
 *   if (err instanceof TaskStateError) { ... }
 *   if (err instanceof RateLimitError) { ... }  // existing, in rate-limit.ts
 */

// ── Base class ─────────────────────────────────────────────────────────────

/**
 * Base class for all orchestrator errors.
 * Carries a machine-readable `code` for programmatic handling.
 */
export class OrchestratorError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'OrchestratorError';
  }
}

// ── Task state errors ──────────────────────────────────────────────────────

/** Thrown when an operation targets a task that doesn't exist. */
export class TaskNotFoundError extends OrchestratorError {
  constructor(taskId: string) {
    super(`Task ${taskId} not found`, 'TASK_NOT_FOUND');
    this.name = 'TaskNotFoundError';
  }
}

/** Thrown when a task is already running and can't be started again. */
export class TaskAlreadyRunningError extends OrchestratorError {
  constructor(taskId: string) {
    super(`Task ${taskId} is already running — wait for the current pipeline to finish.`, 'TASK_ALREADY_RUNNING');
    this.name = 'TaskAlreadyRunningError';
  }
}

/** Thrown when an operation is attempted in the wrong pipeline phase. */
export class PhaseTransitionError extends OrchestratorError {
  constructor(_taskId: string, currentPhase: string, requiredPhase: string, operation: string) {
    super(
      `cannot ${operation} a task in ${currentPhase} — must be ${requiredPhase}`,
      'INVALID_PHASE_TRANSITION',
    );
    this.name = 'PhaseTransitionError';
  }
}

// ── Pipeline configuration errors ──────────────────────────────────────────

/** Thrown when pipeline configuration is invalid or missing. */
export class PipelineConfigError extends OrchestratorError {
  constructor(message: string, code = 'PIPELINE_CONFIG_INVALID') {
    super(message, code);
    this.name = 'PipelineConfigError';
  }
}

// ── Worktree errors ────────────────────────────────────────────────────────

/** Thrown when a worktree operation fails or would be dangerous. */
export class WorktreeError extends OrchestratorError {
  constructor(message: string, code = 'WORKTREE_ERROR') {
    super(message, code);
    this.name = 'WorktreeError';
  }
}

// ── Git / push errors ──────────────────────────────────────────────────────

/** Thrown when a git push or verification step fails. */
export class PushVerificationError extends OrchestratorError {
  constructor(message: string, code = 'PUSH_FAILED') {
    super(message, code);
    this.name = 'PushVerificationError';
  }
}

// ── Session errors ─────────────────────────────────────────────────────────

/** Thrown when a Claude CLI session exits with a non-zero code. */
export class SessionExitedError extends OrchestratorError {
  constructor(public readonly exitCode: number) {
    super(`Session exited with code ${exitCode}`, 'SESSION_EXITED_NONZERO');
    this.name = 'SessionExitedError';
  }
}
