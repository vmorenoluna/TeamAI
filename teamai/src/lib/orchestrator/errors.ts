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

/** Thrown when container mode is enabled but Docker is not available. */
export class ContainerDockerMissingError extends OrchestratorError {
  constructor(projectRoot: string) {
    super(
      `Container mode is enabled for ${projectRoot} but Docker is not running. Start Docker Desktop and try again, or disable container mode in Settings.`,
      'CONTAINER_DOCKER_MISSING',
    );
    this.name = 'ContainerDockerMissingError';
  }
}

/** Thrown when a Claude CLI session was terminated by a signal (SIGTERM/SIGKILL).
 *  A killed session is never a successful completion — this error propagates
 *  through the pipeline so the task advances to 'failed' rather than hanging
 *  forever in a deadlocked state. Defect 7.
 *
 *  `reason` distinguishes a stall-detector kill ('stalled', recoverable —
 *  runSubtaskSession offers the coder a retry) from a deliberate stop
 *  (undefined — must never trigger an automatic retry). Populated from the
 *  killed session's own `killReason` in waitForCompletion's onExit handler.
 *
 *  `stallKind` (only meaningful when reason is 'stalled') distinguishes
 *  which of the two stall thresholds actually fired — 'idle' (session sat
 *  silent for >2min with no tool running) vs 'tool' (a single tool call ran
 *  for >30min with no output). A consumer must not assume the tool-in-flight
 *  case just because reason is 'stalled': the two are very different
 *  situations and any message shown to the coder must say which one it was.
 *  Populated from the killed session's own `stallKind` alongside `reason`. */
export class SessionKilledError extends OrchestratorError {
  constructor(public readonly signal: string, public readonly reason?: 'stalled', public readonly stallKind?: 'idle' | 'tool') {
    super(`Session killed by signal ${signal}`, 'SESSION_KILLED');
    this.name = 'SessionKilledError';
  }
}
