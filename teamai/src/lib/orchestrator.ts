import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, rmSync } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { processManager } from './process-manager';
import { readContainerConfig, containerManager, hostToContainerPath, dockerAvailable, _resetDockerAvailableCache } from './container-manager';
import { TaskStore } from './task-store';
import { slugify } from './utils';
import { isWorktreeHealthy, restoreWorktreeGitFileToHostPaths, patchWorktreeGitFile, worktreeGitEnv, execGit, execGitCapture } from './orchestrator/worktree-utils';
import { rotateOutputLog, persistAndEmitPhase, savePipelineState, restorePipelineState, pipelineAdvancePhase } from './orchestrator/pipeline-state';
import { writeQaFeedback, writeCompletionSummary } from './orchestrator/qa-feedback';
import { runSpecPhase, runPlanPhase, runMergePhase, runCreatePRPhase } from './orchestrator/phase-runners';
import { parseSessionLimitReset, extractPrUrl, phaseHeader, logToOutput, restoreQaReportFromSnapshot, restoreHumanFeedbackFromSnapshot, getWorktreeBase, resolveWorktreeDirName, computePipelineConfig, buildSessionOpts, startPhaseFromArtifacts, type PipelineConfig } from './orchestrator/helpers';
import { cleanStaleSubtaskWorktrees, removeWorktree as removeWorktreeFn, cleanWorktree as cleanWorktreeFn } from './orchestrator/worktree-ops';
import { buildTicketMessageForPipeline } from './orchestrator/artifact-commit';
import { appendSessionTicket, synthesizeDoneTicket } from './history-session';
import { gitPush } from './orchestrator/git-push';
import { RateLimitError, waitForCompletion, handleRateLimit as handleRateLimitFn } from './orchestrator/rate-limit';
import { TaskNotFoundError, TaskAlreadyRunningError, PhaseTransitionError, OrchestratorError, SessionKilledError, ContainerDockerMissingError } from './orchestrator/errors';
import { NO_RESUME_PHASES } from '@/constants/phases';
import { runImplement, _recoverStBranchCommits } from './orchestrator/implement';
import { runQaReview } from './orchestrator/qa-review';
import { CLEANUP_ARTIFACTS, MAX_REVISION_SNAPSHOTS } from './orchestrator/artifacts';
import { approveTask as approveTaskFn, rejectTask as rejectTaskFn, autoReviseSpec } from './orchestrator/review-actions';
import { detectGitPlatform, isPrMerged } from './git-platform';
import { warn as logWarn, log, error as logError } from './logger';
import type { PhaseContext } from './orchestrator/phase-context';
import type { PipelinePhase } from '@/constants/phases';
import type { TaskPipeline, MergeStrategy, QaReport } from './orchestrator/types';
import type { FeedbackTarget } from './orchestrator/feedback-target';

export class Orchestrator {
  private pipelines: Map<string, TaskPipeline> = new Map();
  private activeTasks: Set<string> = new Set();
  private taskStore: TaskStore;
  private _ctx: PhaseContext;

  constructor(private projectRoot: string) {
    this.taskStore = new TaskStore(projectRoot);
    this._ctx = this._buildPhaseContext();
  }

  /** Whether a pipeline is currently executing for the given task. */
  isTaskActive(taskId: string): boolean {
    return this.activeTasks.has(taskId);
  }

  private _buildPhaseContext(): PhaseContext {
    const projectRoot = this.projectRoot;
    const taskStore = this.taskStore;

    return {
      projectRoot: this.projectRoot,
      taskStore,
      pipelines: this.pipelines,
      activeTasks: this.activeTasks,

      persistAndEmitPhase: (pipeline) => persistAndEmitPhase(pipeline, taskStore, projectRoot),
      advancePhase: (pipeline, phase, eventExtra) => this.advancePhase(pipeline, phase, eventExtra),
      savePipelineState: (pipeline) => savePipelineState(pipeline),
      executePhase: (pipeline) => this.executePhase(pipeline),
      handleRateLimit: (pipeline, resetsAt) => this.handleRateLimit(pipeline, resetsAt),

      sessionOpts: (role, cwd, taskId, logFile) => buildSessionOpts(projectRoot, role, cwd, taskId, logFile),
      waitForCompletion: (sessionId) => waitForCompletion(sessionId, { parseSessionLimitReset }),

      execGit: (args, hostCwd) => this._execGit(args, hostCwd),
      execGitCapture: (args, hostCwd) => this._execGitCapture(args, hostCwd),
      gitPush: (pushArgs, logFile) => gitPush(projectRoot, pushArgs, logFile),

      rotateOutputLog: (logFile) => rotateOutputLog(logFile),
      phaseHeader: (logFile, phase) => phaseHeader(logFile, phase),

      toAgentPath: (hostPath) => {
        if (readContainerConfig(projectRoot).enabled) {
          const info = containerManager.getRunningContainer(projectRoot);
          if (info) return hostToContainerPath(hostPath, projectRoot, info.remoteWorkspaceFolder);
        }
        return hostPath;
      },
      patchWorktreeGitFile: (hostWorktreePath, containerWorkspace) =>
        patchWorktreeGitFile(hostWorktreePath, containerWorkspace, projectRoot),
      restoreWorktreeGitFileToHostPaths: (hostWorktreePath) =>
        restoreWorktreeGitFileToHostPaths(hostWorktreePath, projectRoot),
      worktreeGitEnv: (hostCwd: string, containerWs?: string) =>
        worktreeGitEnv(hostCwd, projectRoot, containerWs),
      isWorktreeHealthy: (worktreePath) => isWorktreeHealthy(worktreePath, projectRoot),
      cleanStaleSubtaskWorktrees: (pipeline) =>
        cleanStaleSubtaskWorktrees(pipeline, { execGit: (a, c) => this._execGit(a, c), projectRoot }),
      removeWorktree: (taskId) =>
        removeWorktreeFn(taskId, { execGit: (a, c) => this._execGit(a, c), projectRoot, taskStore }),

      restoreQaReportFromSnapshot: (specPath) => restoreQaReportFromSnapshot(specPath),
      restoreHumanFeedbackFromSnapshot: (specPath) => restoreHumanFeedbackFromSnapshot(specPath),

      writeQaFeedback: (pipeline, report) => writeQaFeedback(
        pipeline.specPath,
        report,
        pipeline.persistedCriterionFailCounts,
        pipeline.persistedAdditionalIssueCounts,
      ),
      writeCompletionSummary: (pipeline, reason, detail) => writeCompletionSummary(
        pipeline.specPath,
        pipeline.taskId,
        taskStore,
        reason,
        { qaAttempt: pipeline.qaAttempt, qaRoundCount: pipeline.qaRoundCount, specRevision: pipeline.specRevision },
        detail,
      ),
      autoReviseSpec: (pipeline) => this._autoReviseSpec(pipeline),

      getPipelineConfig: () => this.getPipelineConfig(),

      planWriteLock: this._planWriteLockRef,

      scheduleWakeup: (pipeline) => this._scheduleWakeup(pipeline),

      extractPrUrl: (logFile) => extractPrUrl(logFile),
      buildTicketMessage: (pipeline) => {
        // taskType from the task record — the user-picked Conventional-Commits
        // type must reach the REAL squash commit / PR subject, not just the
        // session-preview ticket in markTaskDone.
        const t = taskStore.getById(pipeline.taskId);
        return buildTicketMessageForPipeline(pipeline, {
          recordHistoryInGit: this.getPipelineConfig().recordHistoryInGit,
          includePhasesTrailer: this.getPipelineConfig().includePhasesTrailer,
          taskType: t?.taskType,
        });
      },

      restorePipeline: (taskId, requiredPhase) => this.restorePipeline(taskId, requiredPhase),
    };
  }

  private _pipelineConfigCache: PipelineConfig | null = null;
  private getPipelineConfig(): PipelineConfig {
    if (!this._pipelineConfigCache) {
      this._pipelineConfigCache = computePipelineConfig(this.projectRoot);
    }
    return this._pipelineConfigCache;
  }

  // Cancel a running pipeline for a task — kills the active session and removes
  // the in-memory pipeline so a new one can start cleanly.
  cancelPipeline(taskId: string): void {
    const pipeline = this.pipelines.get(taskId);
    if (pipeline?.sessionId) {
      processManager.killSession(pipeline.sessionId);
    }
    if (pipeline?.pendingTimer) {
      clearTimeout(pipeline.pendingTimer);
    }
    this.pipelines.delete(taskId);
    this.activeTasks.delete(taskId);
  }

  // Move a task to a target phase, smart-detecting which earlier phase to start from
  // based on which artifacts already exist, then run the pipeline from there.
  async moveTaskToPhase(taskId: string, targetPhase: string): Promise<void> {
    // Cancel any currently running pipeline for this task before starting a new one
    this.cancelPipeline(taskId);

    const task = this.taskStore.getById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    const dir = this.taskStore.getDirById(taskId);

    // Phases that require no pipeline action
    if (NO_RESUME_PHASES.has(targetPhase)) {
      // Auto-delete the git worktree when moving to 'done', 'backlog', or 'failed'
      if (targetPhase === 'done' || targetPhase === 'backlog' || targetPhase === 'failed') {
        this._ctx.removeWorktree(taskId);
      }
      this.taskStore.updatePhase(taskId, targetPhase);
      processManager.emit('phase-change', { taskId, phase: targetPhase, projectRoot: this.projectRoot });
      return;
    }

    const hasSpec = existsSync(path.join(dir, 'spec.md'));
    const hasPlan = existsSync(path.join(dir, 'plan.json'));

    // A retry to spec/plan/implement/qa-review clears qa_report.json AND
    // qa_feedback.md below (see PHASE_ARTIFACTS) — silently dropping the last
    // QA verdict unless a human happens to re-type it via reject/feedback.
    // Read it before the clear so it can be re-derived into a fresh
    // qa_feedback.md afterward: the existing hasQaFeedback rework path in
    // implement.ts (criterion matching + fallback synthesis for unmatched
    // additional_issues) then picks it up exactly as it would after an
    // automatic QA-fail bounce, with no change needed there.
    const clearsQaArtifacts = targetPhase === 'spec' || targetPhase === 'plan'
      || targetPhase === 'implement' || targetPhase === 'qa-review';
    let priorQaReport: QaReport | undefined;
    if (clearsQaArtifacts) {
      try { priorQaReport = JSON.parse(readFileSync(path.join(dir, 'qa_report.json'), 'utf-8')); } catch { /* no report to carry forward */ }
    }

    // Determine actual start phase and clear stale artifacts
    let startPhase: PipelinePhase = 'spec';
    if (targetPhase === 'spec') {
      this.taskStore.clearArtifacts(taskId, 'spec');
      this.clearPipelineStateFile(dir);
      startPhase = 'spec';
    } else if (targetPhase === 'plan') {
      this.taskStore.clearArtifacts(taskId, 'plan');
      this.clearPipelineStateFile(dir);
      startPhase = startPhaseFromArtifacts(false, hasSpec);
    } else if (targetPhase === 'implement' || targetPhase === 'qa-review') {
      this.taskStore.clearArtifacts(taskId, 'qa');
      startPhase = startPhaseFromArtifacts(hasPlan, hasSpec);
    } else if (targetPhase === 'merge' || targetPhase === 'create-pr') {
      // Merge/PR requires the worktree and branch to exist. If missing,
      // restart from the earliest phase needed to recreate them.
      const worktreeBase = this.getWorktreeBase();
      const worktreePath = path.join(worktreeBase, resolveWorktreeDirName(task));
      const worktreeExists = existsSync(worktreePath);
      const branchExists = !!task.branch;

      if (hasPlan && worktreeExists && branchExists) {
        startPhase = targetPhase as PipelinePhase;
      } else if (hasPlan) {
        // Plan exists but worktree/branch missing — recreate from implement
        startPhase = 'implement';
      } else {
        startPhase = startPhaseFromArtifacts(false, hasSpec);
      }
    } else {
      startPhase = targetPhase as PipelinePhase;
    }

    if (clearsQaArtifacts && priorQaReport?.overall === 'FAIL') {
      writeQaFeedback(dir, priorQaReport);
    }

    // Do NOT persist startPhase here — persistAndEmitPhase (called from deep
    // inside the phase runner once work actually starts, via runTask below)
    // is the sole authoritative writer of a task's in-progress phase. Writing
    // it here first would let a crash between this line and the real work
    // starting leave the task "stuck" at a phase with no session evidence,
    // undetectable by findInterruptedTasks/sweepStalledTasks (see
    // pipeline-state.ts's persistAndEmitPhase doc comment). runTask reaches
    // that authoritative write synchronously (no I/O-bound await precedes
    // it), so the UI sees the correct resolved startPhase just as promptly.
    await this.runTask(taskId, task.description, startPhase);
  }

  /**
   * Delete the crash-recovery pipeline-state file for a task, if present.
   *
   * `.pipeline_state.json` persists qaAttempt, deliverableFailCounts,
   * stallRecoveryCounts, and persistedCriterionFailCounts across a server
   * restart mid-pipeline (savePipelineState/restorePipelineState in
   * pipeline-state.ts) — it's write-every-run, read-once-then-delete. But
   * "once" only happens on the NEXT run; nothing else ever cleans it up,
   * and it isn't in PHASE_ARTIFACTS, so clearArtifacts('spec'/'plan') never
   * touches it. Re-planning or re-speccing a failed task is meant to give
   * a materially different plan a fresh QA budget — without this, runTask's
   * restorePipelineState call silently carries the OLD, already-exhausted
   * qaAttempt count into the new plan, so a task that failed QA 3/3 times
   * under a bad plan gets effectively 0 fresh attempts to prove a
   * genuinely improved plan actually works. This method itself is only
   * invoked directly, unconditionally, for 'spec'/'plan' targets below —
   * but every retry entry point (`retryTask`, `retryTaskWithOptions`,
   * `retryFailedTask`) also calls it unconditionally before resuming
   * 'implement'/'qa-review', for the same reason: a retry must never
   * inherit a near-exhausted qaAttempt/wakeupAttemptCount/
   * deliverableFailCounts from the run that just failed, or a subtask can
   * get killed almost instantly on the very next wakeup/QA pass even
   * though the underlying work (e.g. a long-running sweep) is legitimately
   * healthy. This used to be an opt-in choice (the retry-phase dialog's
   * "Reset QA-attempt budget" toggle, ADR 005's circuit breaker preserved
   * across manual retries) but a carried-over counter proved unsafe often
   * enough that a fresh budget is no longer optional — the choice was
   * removed and this is now always called.
   */
  clearPipelineStateFile(dir: string): void {
    try {
      const statePath = path.join(dir, '.pipeline_state.json');
      if (existsSync(statePath)) unlinkSync(statePath);
    } catch { /* best-effort */ }
  }

  async runTask(taskId: string, description: string, startPhase?: PipelinePhase): Promise<void> {
    // Invalidate pipeline config cache so pipeline.json changes take effect.
    // Must happen BEFORE the demo check — otherwise stale demo:true survives
    // config edits and prevents the project from ever running tasks.
    this._pipelineConfigCache = null;

    // Demo mode: when pipeline.json has demo:true, skip all pipeline processing
    if (this.getPipelineConfig().demo) return;

    // Container-mode gate: refuse to start when container mode is enabled but
    // Docker is not running. Resets the dockerAvailable cache so a just-started
    // Docker is detected immediately on retry (mirrors ensureWorktree's pattern).
    // Emits a container-docker-missing event so the UI can show a dialog prompting
    // the user to start Docker or disable container mode.
    const containerCfg = readContainerConfig(this.projectRoot);
    if (containerCfg.enabled && !dockerAvailable()) {
      _resetDockerAvailableCache();
      if (!dockerAvailable()) {
        processManager.emit('container-docker-missing', { projectRoot: this.projectRoot });
        throw new ContainerDockerMissingError(this.projectRoot);
      }
    }

    // Prevent concurrent runs of the same task
    if (this.activeTasks.has(taskId)) {
      throw new TaskAlreadyRunningError(taskId);
    }
    this.cancelPipeline(taskId);
    this.activeTasks.add(taskId);

    const config = this.getPipelineConfig();
    const taskRecord = this.taskStore.getById(taskId);
    // Canonical slug from the task record (BUG-13); legacy tasks fall back
    // to the historical slugify(description) so existing branches still match.
    // The branch name always derives from slug, even if the worktree
    // directory has since relocated (resolveWorktreeDirName) — only the
    // local worktree path changes, never the branch identity.
    const slug = taskRecord?.slug ?? slugify(description);
    const branch = `feat/${slug}`;
    const worktreePath = path.join(this.getWorktreeBase(), taskRecord ? resolveWorktreeDirName(taskRecord) : slug);
    const specPath = this.taskStore.getDirById(taskId);

    const pipeline: TaskPipeline = {
      taskId,
      title: taskRecord?.title ?? description,
      description,
      phase: 'spec',
      specPath,
      worktreePath,
      branch,
      qaAttempt: 0,
      maxQaAttempts: config.maxQaAttempts,
      // Restore from disk (not hardcoded 1) — moveTaskToPhase can re-enter
      // runTask on a task that already has spec_v*.md history (e.g. reset to
      // 'plan' keeps prior spec revisions on disk). Under the rename-at-
      // revision scheme, beginSpecRevision renames spec.md straight onto
      // spec_v{specRevision - 1}.md — a stale specRevision here would collide
      // with and clobber a real archived version. Mirrors restorePipeline.
      specRevision: this._restoreSpecRevision(taskId),
      qaRevision: 0,
    };

    // Use provided startPhase, else first phase in config.
    // Set in-memory only — _persistAndEmitPhase commits to disk once work starts (#5).
    const firstPhase = startPhase ?? 'spec';
    pipeline.phase = firstPhase;

    this.pipelines.set(taskId, pipeline);
    this.taskStore.update(taskId, { branch });

    // Restore pipeline state from a previous crash if available (#7)
    const savedState = this._restorePipelineState(taskId, specPath);
    if (savedState) {
      if (savedState.mergeStrategy) pipeline.mergeStrategy = savedState.mergeStrategy;
      if (savedState.qaAttempt !== undefined) pipeline.qaAttempt = savedState.qaAttempt;
      if (savedState.deliverableFailCounts !== undefined) pipeline.deliverableFailCounts = savedState.deliverableFailCounts;
      if (savedState.stallRecoveryCounts !== undefined) pipeline.stallRecoveryCounts = savedState.stallRecoveryCounts;
      if (savedState.wakeupUntil !== undefined) pipeline.wakeupUntil = savedState.wakeupUntil;
      if (savedState.wakeupSubtaskId !== undefined) pipeline.wakeupSubtaskId = savedState.wakeupSubtaskId;
      if (savedState.wakeupCommand !== undefined) pipeline.wakeupCommand = savedState.wakeupCommand;
      if (savedState.wakeupArtifact !== undefined) pipeline.wakeupArtifact = savedState.wakeupArtifact;
      if (savedState.wakeupProgressPath !== undefined) pipeline.wakeupProgressPath = savedState.wakeupProgressPath;
      if (savedState.wakeupAttemptCount !== undefined) pipeline.wakeupAttemptCount = savedState.wakeupAttemptCount;
      if (savedState.persistedCriterionFailCounts !== undefined) pipeline.persistedCriterionFailCounts = savedState.persistedCriterionFailCounts;
      if (savedState.persistedAdditionalIssueCounts !== undefined) pipeline.persistedAdditionalIssueCounts = savedState.persistedAdditionalIssueCounts;
      if (savedState.qaRoundCount !== undefined) pipeline.qaRoundCount = savedState.qaRoundCount;
      if (savedState.specRevision !== undefined) pipeline.specRevision = savedState.specRevision;
      if (savedState.qaRevision !== undefined) pipeline.qaRevision = savedState.qaRevision;
      if (savedState.sessionId) pipeline.sessionId = savedState.sessionId;
    }

    this._ctx.savePipelineState(pipeline);
    let rateLimited = false;
    try {
      await this.executePhase(pipeline);
    } catch (e) {
      if (e instanceof SessionKilledError && !this.pipelines.has(taskId)) {
        // Defect 7: the pipeline was already cancelled (e.g. stopTask killed
        // the session). The cancelled session's exit event fired with a signal,
        // causing waitForCompletion to reject with SessionKilledError. Don't
        // overwrite the phase that stopTask already set to 'backlog'.
        return;
      }
      if (e instanceof RateLimitError) {
        rateLimited = true;
        this.handleRateLimit(pipeline, e.resetsAt);
      } else {
        if (e instanceof OrchestratorError) {
          // Structured error — log with error code for observability
          logToOutput(pipeline.specPath, `\n[ERROR] Task failed [${e.code}]: ${e.message}\n`);
          if (e.stack) logToOutput(pipeline.specPath, `${e.stack}\n`);
          logError('orchestrator', `Task ${taskId} failed [${e.code}]`, e);
        } else {
          const errMsg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
          logToOutput(pipeline.specPath, `\n[ERROR] Task failed: ${errMsg}\n`);
          logError('orchestrator', `Task ${taskId} failed`, e);
        }
        this.advancePhase(pipeline, 'failed');
      }
    } finally {
      // Release lock after pipeline completes or fails.
      // For rate-limited or wakeup-paused tasks the lock is re-acquired
      // in handleRateLimit / _scheduleWakeup and must not be deleted here —
      // the setTimeout callback owns cleanup.
      if (!rateLimited && !pipeline.wakeupUntil) {
        this.pipelines.delete(taskId);
        this.activeTasks.delete(taskId);
      }
    }
  }

  async approveTask(taskId: string, strategy: MergeStrategy): Promise<void> {
    await approveTaskFn(taskId, strategy, this._ctx);
  }

  async rejectTask(taskId: string, feedback: string, target: FeedbackTarget, subtaskIds?: number[]): Promise<void> {
    await rejectTaskFn(taskId, feedback, target, subtaskIds, this._ctx);
  }

  // Delegates to review-actions.autoReviseSpec
  private async _autoReviseSpec(pipeline: TaskPipeline): Promise<void> {
    await autoReviseSpec(pipeline, this._ctx);
  }

  private async executePhase(pipeline: TaskPipeline): Promise<void> {
    // Cooperative pause/cancellation check: cancelPipeline deletes the
    // pipeline from this.pipelines, and a restart/move creates a fresh
    // pipeline object for the same taskId. If our pipeline reference is
    // not the one currently tracked in the map (either because it was
    // deleted entirely, or because a newer pipeline replaced it), bail
    // out without spawning a new agent session.
    //
    // This fixes the race where a user pauses or restarts a task right
    // as one phase finishes and the cascade is about to spawn the next
    // phase's session. Without this check, the old cascading pipeline
    // reference would proceed to spawn a session for a task the user
    // believes they stopped. An identity check (not just membership)
    // is needed because runTask / moveTaskToPhase both call cancelPipeline
    // (which deletes the old pipeline) then create a fresh pipeline for
    // the same taskId — a membership-only check would see the new
    // pipeline and let the old one's cascade proceed.
    if (this.pipelines.get(pipeline.taskId) !== pipeline) {
      return;
    }

    // Container-mode gate: also checked here (not just in runTask) because
    // phase transitions via advancePhase (e.g. autoReviseSpec → spec,
    // approveTask → create-pr, rate-limit-resume) bypass runTask entirely.
    // No-op phases (awaiting-review, pr-open) skip the check.
    if (pipeline.phase !== 'awaiting-review' && pipeline.phase !== 'pr-open') {
      const containerCfg = readContainerConfig(this.projectRoot);
      if (containerCfg.enabled && !dockerAvailable()) {
        _resetDockerAvailableCache();
        if (!dockerAvailable()) {
          processManager.emit('container-docker-missing', { projectRoot: this.projectRoot });
          throw new ContainerDockerMissingError(this.projectRoot);
        }
      }
    }

    switch (pipeline.phase) {
      case 'spec':         return this.runSpec(pipeline);
      case 'plan':         return this.runPlan(pipeline);
      case 'implement':    return this.runImplement(pipeline);
      case 'qa-review':    return this.runQaReview(pipeline);
      case 'awaiting-review': return; // Paused — waiting for human
      case 'pr-open':         return; // Paused — PR created, waiting for human to merge + mark done
      case 'merge':        return this.runMerge(pipeline);
      case 'create-pr':    return this.runCreatePR(pipeline);
    }
  }

  private async runSpec(pipeline: TaskPipeline): Promise<void> {
    await runSpecPhase(pipeline, this._ctx);
  }

  private async runPlan(pipeline: TaskPipeline): Promise<void> {
    await runPlanPhase(pipeline, this._ctx);
  }

  private async runImplement(pipeline: TaskPipeline): Promise<void> {
    await runImplement(pipeline, this._ctx);
  }

  private async runQaReview(pipeline: TaskPipeline): Promise<void> {
    await runQaReview(pipeline, this._ctx);
  }

  private async runMerge(pipeline: TaskPipeline): Promise<void> {
    await runMergePhase(pipeline, this._ctx);
  }

  private async runCreatePR(pipeline: TaskPipeline): Promise<void> {
    await runCreatePRPhase(pipeline, this._ctx);
  }

  async markTaskDone(taskId: string): Promise<void> {
    // Load the task record for the PR-merge guard below.
    const task = this.taskStore.getById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    // Guard: refuse to mark a PR-routed task done until the PR has actually
    // merged. Without this, clicking "Mark as Done" (the button is enabled
    // as soon as a PR exists — see review-panel.tsx's isPrOpen) or any other
    // premature caller would finalize the task as done even though the PR's
    // commits haven't landed on master — the task would read as complete on
    // the board while the code it describes never actually shipped.
    if (task.mergeStrategy === 'pull-request' && task.prUrl) {
      const platform = (task.platform as 'github' | 'unknown' | undefined)
        ?? detectGitPlatform(this.projectRoot);
      const merged = isPrMerged(platform, task.prUrl, this.projectRoot);
      if (merged === false) {
        throw new Error(
          `Cannot mark task done: PR ${task.prUrl} has not been merged yet.`
        );
      }
      // merged === null: platform/CLI couldn't confirm either way (e.g.
      // gh temporarily unreachable). Proceed rather than block
      // rest of the codebase treats unverifiable platforms.
    }

    this._ctx.removeWorktree(taskId);

    // Ticket-history refactor (§3d): no committed artifact snapshot exists
    // anymore (the folder-commit mechanism was replaced by the
    // trailer-bearing pre-merge squash), so the old fetch → ls-tree →
    // fast-forward → scoped-checkout → restore machinery is gone.
    // Finalization is deterministic:
    //   1. flip the task record to 'done' (task.json + events.jsonl),
    //   2. delete the local .teamai/<slug>/ folder — unconditionally, for
    //      both merge strategies and regardless of recordHistoryInGit
    //      (§3j). The PR body (spec summary embedded by buildPRBody) and
    //      the trailer-bearing merge commit are the durable record now.
    const dir = this.taskStore.getDirById(taskId);

    // §3f incremental append: synthesize the fresh DONE card from data the
    // pipeline already built (message builder over the artifacts) BEFORE the
    // folder is deleted — no history re-query needed. Also covers the
    // recordHistoryInGit-off case: the card shows for the rest of the
    // session (from the task record), then disappears on restart, exactly as
    // the doc specifies. Best-effort: never block completion on this.
    try {
      const config = this.getPipelineConfig();
      const msg = buildTicketMessageForPipeline(
        { taskId, title: task.title, description: task.description, specPath: dir },
        { recordHistoryInGit: config.recordHistoryInGit, includePhasesTrailer: config.includePhasesTrailer, taskType: task.taskType },
      );
      const slug = path.basename(dir);
      if (msg) {
        // Message = subject + blank + body + blank + trailer lines. Summary
        // = body lines (what was done); trailers parsed separately.
        const lines = msg.message.replace(/\n+$/, '').split('\n');
        const trailerStart = lines.findIndex((l, i) => i > 0 && /^(Task|Task-ID|QA|Phases|Reviewed-by):/i.test(l));
        const bodyLines = (trailerStart > 0 ? lines.slice(1, trailerStart) : lines.slice(1))
          .filter(l => l.trim());
        appendSessionTicket(this.projectRoot, synthesizeDoneTicket({
          slug,
          taskId,
          title: task.title,
          summary: bodyLines.slice(0, 4).join(' ') || task.description,
          trailerLines: msg.trailerLines,
          prUrl: task.prUrl || undefined,
        }));
      } else {
        // recordHistoryInGit off — session-only card from the task record.
        appendSessionTicket(this.projectRoot, synthesizeDoneTicket({
          slug,
          taskId,
          title: task.title,
          summary: task.description,
          trailerLines: [],
          prUrl: task.prUrl || undefined,
        }));
      }
    } catch (err) {
      logWarn('orchestrator', `markTaskDone: failed to append session DONE ticket for ${taskId}`, err);
    }

    this.taskStore.updatePhase(taskId, 'done');
    // The task directory is removed below, but dependency chains still need a
    // durable answer when they ask whether this task completed.
    this.taskStore.markCompletedTask(taskId);
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (err) {
      // Non-fatal: the task is already finalized as done. Surface it for
      // visibility but never fail the completion flow over cleanup.
      logWarn('orchestrator', `markTaskDone: failed to delete task folder ${dir} for ${taskId}`, err);
    }

    // Only emit phase-change once, after the record is finalized and the
    // folder removed — UI listeners refetch exactly once against the final,
    // settled state.
    processManager.emit('phase-change', { taskId, phase: 'done', projectRoot: this.projectRoot });
  }

  // Serializes writes to plan.json to prevent race conditions during
  // per-subtask checkpointing in runImplement (#2). Wrapped in an object
  // so the extracted runImplement can mutate the current promise through
  // its deps reference without aliasing `this`.
  private _planWriteLockRef = { current: Promise.resolve() };

  private _restorePipelineState(_taskId: string, specPath: string): Partial<TaskPipeline> | null { return restorePipelineState(_taskId, specPath); }

  private advancePhase(pipeline: TaskPipeline, phase: PipelinePhase, eventExtra?: Record<string, unknown>): void { pipelineAdvancePhase(pipeline, phase, this.taskStore, this.projectRoot, eventExtra); }

  private _execGit(args: string[], hostCwd: string): void { execGit(args, hostCwd, this.projectRoot); }
  private _execGitCapture(args: string[], hostCwd: string): string { return execGitCapture(args, hostCwd, this.projectRoot); }

  private handleRateLimit(pipeline: TaskPipeline, resetsAt: number): void {
    handleRateLimitFn(pipeline, resetsAt, this._ctx);
  }
  private restorePipeline(taskId: string, requiredPhase: PipelinePhase): TaskPipeline {
    const task = this.taskStore.getById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);
    if (task.phase !== requiredPhase) {
      throw new PhaseTransitionError(taskId, task.phase, requiredPhase, 'restore pipeline');
    }
    const branch = task.branch ?? `feat/${task.slug ?? slugify(task.description)}`;
    const pipeline: TaskPipeline = {
      taskId,
      title: task.title,
      description: task.description,
      phase: requiredPhase,
      specPath: this.taskStore.getDirById(taskId),
      worktreePath: path.join(this.getWorktreeBase(), resolveWorktreeDirName(task)),
      branch,
      qaAttempt: 0,
      maxQaAttempts: this.getPipelineConfig().maxQaAttempts,
      specRevision: this._restoreSpecRevision(taskId),
      qaRevision: this._restoreQaRevision(taskId),
    };
    this.pipelines.set(taskId, pipeline);
    return pipeline;
  }

  private getWorktreeBase(): string { return getWorktreeBase(this.projectRoot); }

  /**
   * Restore specRevision from persistent state or by counting on-disk snapshots.
   *
   * When the in-memory pipeline is destroyed (runTask completes, server
   * restarts), restorePipeline() and runTask() itself (retry/restart/
   * moveTaskToPhase paths) both call this rather than hardcoding
   * specRevision: 1 — this method recovers the real revision count so the
   * next autoReviseSpec()/beginSpecRevision() call renames spec.md onto
   * spec_v{N+1}.md instead of clobbering an existing spec_v{N}.md.
   *
   * Precedence:
   *   1. .pipeline_state.json (persisted by savePipelineState during autoReviseSpec)
   *   2. Count existing spec_v{N}.md files on disk (robust fallback)
   */
  private _restoreSpecRevision(taskId: string): number {
    const dir = this.taskStore.getDirById(taskId);
    // Prefer the persisted pipeline state (most accurate)
    try {
      const statePath = path.join(dir, '.pipeline_state.json');
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, 'utf-8'));
        if (typeof state.specRevision === 'number' && state.specRevision > 0) {
          return state.specRevision;
        }
      }
    } catch { /* fall through to on-disk counting */ }
    // Fallback: find the highest existing spec_v{N}.md on disk. Scan a fixed
    // range and take the max instead of stopping at the first gap — v1 can
    // legitimately be missing on tasks whose pipeline entered tracked
    // execution after spec.md already existed, and breaking at the first
    // missing file would return 0 for a task with v2..v4 on disk, silently
    // resetting revision numbering if .pipeline_state.json is ever lost.
    let maxN = 0;
    for (let v = 1; v <= MAX_REVISION_SNAPSHOTS; v++) {
      if (existsSync(path.join(dir, `spec_v${v}.md`))) {
        maxN = v;
      }
    }
    // Under the rename-at-revision scheme the live spec.md is one version
    // AHEAD of the highest snapshot (snapshots = completed revisions − the
    // pre-revision archives; the current spec is always un-archived at
    // spec.md). The next beginSpecRevision renames spec.md to
    // spec_v{maxN + 1}.md, so the restored counter must be maxN + 1 — under
    // the old copy scheme maxN alone was correct, and reusing it here would
    // clobber the highest snapshot on the next revision.
    return maxN + 1;
  }

  /**
   * Restore qaRevision from persistent state or by counting on-disk snapshots.
   * Mirrors _restoreSpecRevision — recovers the real revision count so the next
   * QA cycle creates qa_report_v{N+1}.json instead of overwriting v1 repeatedly.
   */
  private _restoreQaRevision(taskId: string): number {
    const dir = this.taskStore.getDirById(taskId);
    try {
      const statePath = path.join(dir, '.pipeline_state.json');
      if (existsSync(statePath)) {
        const state = JSON.parse(readFileSync(statePath, 'utf-8'));
        if (typeof state.qaRevision === 'number' && state.qaRevision > 0) {
          return state.qaRevision;
        }
      }
    } catch { /* fall through to on-disk counting */ }
    // Same gap-tolerant max scan as _restoreSpecRevision (qa_report_v1.json
    // can be absent while v2+ exist).
    let maxN = 0;
    for (let v = 1; v <= MAX_REVISION_SNAPSHOTS; v++) {
      if (existsSync(path.join(dir, `qa_report_v${v}.json`))) {
        maxN = v;
      }
    }
    return maxN;
  }

  /**
   * Clean up artifacts from the given phase and beyond (inclusive).
   * Artifacts from phases BEFORE the given phase are kept as-is.
   * Called by stopTask before moving the task to backlog.
   */
  async cleanupTaskArtifacts(taskId: string, currentPhase: string): Promise<void> {
    const dir = this.taskStore.getDirById(taskId);
    const pipelineOrder = ['spec', 'plan', 'implement', 'qa-review', 'merge'];
    const startIndex = pipelineOrder.indexOf(currentPhase);
    if (startIndex < 0) return;

    // Remove output.log — stale terminal output should not persist
    const outputPath = path.join(dir, 'output.log');
    try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch { /* best-effort */ }

    // Files to delete by phase (each list covers that phase's artifacts)
    const phaseFiles = CLEANUP_ARTIFACTS;

    // Delete artifacts for the in-progress phase and all subsequent phases
    for (let i = startIndex; i < pipelineOrder.length; i++) {
      const files = phaseFiles[pipelineOrder[i]];
      if (files) {
        for (const f of files) {
          const p = path.join(dir, f);
          try { if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
        }
      }
    }

    // Reconcile subtask completions if stopping during/after implement.
    // Defect 8: instead of blindly resetting all completions, reconcile
    // multi-group subtasks whose completed: true may only exist on an
    // isolated -stN branch — cherry-pick forward if possible, only reset
    // what can't be integrated.
    if (startIndex >= pipelineOrder.indexOf('implement')) {
      await this._reconcileSubtaskCompletionsOnStop(taskId, dir);
    }

    // Clean the worktree for plan/implement phases so the next run starts with a clean slate
    if (currentPhase === 'plan') {
      // Worktree was created during plan — remove it so it gets recreated fresh
      this._ctx.removeWorktree(taskId);
    } else if (currentPhase === 'implement') {
      // Worktree has partial changes — discard them
      this._cleanWorktree(taskId);
    }
  }

  /**
   * Reconcile subtask completed flags against durable git state before
   * pausing a task (Stop).
   *
   * Defect 8: the old code blindly set completed=false for every subtask,
   * discarding bookkeeping for subtasks whose commits are genuinely present
   * on the feature branch.  The naive fix — "just don't reset completed" —
   * is unsafe for multi-group subtasks: checkpoint #1 (runSubtaskSession)
   * writes completed=true to plan.json *before* integrateGroup cherry-picks
   * the st-branch back onto pipeline.branch.  If Stop fires in that window,
   * the code only exists on a -stN branch that Defect 4's retry logic would
   * eventually recover, but treating it as durably done is wrong.
   *
   * Strategy per subtask:
   *  1. Non-multi-group (no -stN branch) → completed=true is always durable.
   *  2. Multi-group + commits already on pipeline.branch → durable, keep.
   *  3. Multi-group + commits only on -stN branch → try cherry-pick forward
   *     into the main worktree.  Success → keep.  Failure → reset *this
   *     subtask only* (not the whole task).
   */
  private async _reconcileSubtaskCompletionsOnStop(taskId: string, dir: string): Promise<void> {
    const planPath = path.join(dir, 'plan.json');
    if (!existsSync(planPath)) return;

    const task = this.taskStore.getById(taskId);
    if (!task?.branch) return;

    let plan: { subtasks?: Array<{ id: number; completed?: boolean }> };
    try { plan = JSON.parse(readFileSync(planPath, 'utf-8')); } catch { return; }
    if (!plan.subtasks) return;

    const pipelineBranch = task.branch;
    const worktreePath = this.getWorktreePath(taskId);
    const worktreeExists = worktreePath && existsSync(worktreePath);
    const logFile = path.join(dir, 'output.log');
    const execGitFn = (args: string[], hostCwd: string) => this._execGit(args, hostCwd);

    // Guarded so a log write failure can't abort reconciliation mid-loop
    // (which would skip later subtasks and the plan.json write below).
    const logStop = (message: string) => {
      try {
        appendFileSync(logFile, message);
      } catch (err) {
        logWarn('orchestrator', `Failed to write reconcile log for ${taskId}`, err);
      }
    };

    let dirty = false;

    for (const subtask of plan.subtasks) {
      if (!subtask.completed) continue;

      const stBranch = `${pipelineBranch}-st${subtask.id}`;

      // Check branch existence first — non-multi-group subtasks
      // (no -stN branch) are always safe, regardless of worktree state.
      // Only multi-group subtasks with an isolated branch need reconciliation.
      let stBranchExists = false;
      try {
        execFileSync('git', ['rev-parse', '--verify', stBranch], {
          cwd: this.projectRoot, encoding: 'utf-8', stdio: 'pipe',
        });
        stBranchExists = true;
      } catch { /* no st-branch → non-multi-group, completed: true is durable */ }

      if (!stBranchExists) continue; // safe — non-multi-group

      // Multi-group subtask: need a worktree to cherry-pick into.
      // Without one, we can't integrate — reset this subtask only.
      if (!worktreeExists) {
        logStop(
          '[STOP] Subtask ' + subtask.id + ' has unintegrated commits on ' + stBranch +
          ' but worktree is missing — resetting completed: false\n'
        );
        subtask.completed = false;
        dirty = true;
        continue;
      }

      // Delegate to the shared recovery helper (Defects 4 & 8).
      const result = await _recoverStBranchCommits(
        this.projectRoot, execGitFn, logFile,
        pipelineBranch, stBranch, worktreePath, subtask.id,
      );

      if (result.recovered) {
        if (result.commits.length > 0) {
          logStop(
            '[STOP] Subtask ' + subtask.id + ' commits recovered onto ' +
            pipelineBranch + ' — keeping completed: true\n'
          );
        }
        continue; // safe — completed: true is durable
      }

      // Couldn't integrate — reset this subtask only
      logStop(
        '[STOP] Subtask ' + subtask.id + ' recovery failed (' +
        result.commits.length + ' commits on ' + stBranch + ') — resetting completed: false\n'
      );
      subtask.completed = false;
      dirty = true;
    }

    if (dirty) {
      try {
        writeFileSync(planPath, JSON.stringify(plan, null, 2));
      } catch (err) {
        // A failed write silently loses the completed→false reset, so on the
        // next run the subtask is still (wrongly) marked completed. Surface it.
        logWarn('orchestrator', `Failed to persist plan.json after reconciling subtask completions for ${taskId}`, err);
      }
    }
  }

  /**
   * Resume a stopped/backlog task — detect which phases have completed artifacts
   * and start from the next unfinished phase. Does NOT clear artifacts so completed
   * phases are fast-forwarded automatically.
   */
  async resumeTask(taskId: string): Promise<void> {
    const task = this.taskStore.getById(taskId);
    if (!task) throw new TaskNotFoundError(taskId);

    // Refuse to resume a user-paused task — the pause is deliberate and
    // must only be lifted by the user clicking Resume in the UI.
    if (task.isPaused) {
      throw new Error(
        `Task ${taskId} is paused — cannot auto-resume. ` +
        `The user must click Resume to unpause it.`
      );
    }

    const dir = this.taskStore.getDirById(taskId);

    // Determine start phase:
    // - Active pipeline phase (rate-limited / crash-recovered): resume from current phase
    // - Backlog/done/failed: detect phase from existing artifacts (spec.md, plan.json)
    // - Paused phases (awaiting-review, pr-open): throw — these should be handled
    //   by review actions (approveTask/rejectTask) or CI polling, not resumeTask.
    //   Re-entering implement from a paused phase causes redundant work and can
    //   produce spurious failures when the worktree was already cleaned up.
    let startPhase: PipelinePhase;
    if (!NO_RESUME_PHASES.has(task.phase)) {
      // Task was mid-pipeline — resume from its actual phase instead of
      // restarting from implement. This preserves the phase that handleRateLimit
      // paused at, preventing unnecessary re-work.
      startPhase = task.phase as PipelinePhase;
    } else if (task.phase === 'awaiting-review' || task.phase === 'pr-open') {
      // Paused phases: re-entering implement from here causes redundant work
      // and spurious push failures (worktree was cleaned up after PR creation).
      // These phases are handled by review actions or CI polling.
      throw new Error(
        `Task ${taskId} is in paused phase "${task.phase}" — ` +
        `use approve/reject instead of resume. ` +
        `If called from auto-mode, the adoption flow (_adoptStalledTasks) ` +
        `should have handled this task, not the tick loop.`
      );
    } else {
      // backlog / done / failed — restart from artifact detection.
      // Subtask completions are preserved when hasPlan — runImplement skips
      // already-completed subtasks. If the user wants a full re-run, they
      // should stop the task (move to backlog) and restart it, which calls
      // cleanupTaskArtifacts.
      const hasSpec = existsSync(path.join(dir, 'spec.md'));
      const hasPlan = existsSync(path.join(dir, 'plan.json'));
      startPhase = startPhaseFromArtifacts(hasPlan, hasSpec);
    }

    // Clear output.log for a fresh terminal view
    const outputPath = path.join(dir, 'output.log');
    try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch { /* best-effort */ }

    // ── Gap 4b: Restore qa_report.json if deleted (also done in runImplement) ──
    // Belt-and-suspenders: restore here too so the report exists before the pipeline
    // starts, not just when runImplement is reached. Covers scenarios where
    // resumeTask skips directly to implement on a previously-failed task.
    this._ctx.restoreQaReportFromSnapshot(dir);

    // Do NOT persist startPhase here — see the matching comment in
    // moveTaskToPhase. persistAndEmitPhase (reached synchronously via
    // runTask below, before any I/O-bound await) is the sole authoritative
    // writer of a task's in-progress phase.
    await this.runTask(taskId, task.description, startPhase);
  }

  /** Get the filesystem path to this task's git worktree, or null if the task has no branch. */
  public getWorktreePath(taskId: string): string | null {
    const worktreeBase = getWorktreeBase(this.projectRoot);
    const task = this.taskStore.getById(taskId);
    if (!task || !task.branch) return null;
    return path.join(worktreeBase, resolveWorktreeDirName(task));
  }

  private _cleanWorktree(taskId: string): void {
    cleanWorktreeFn(taskId, {
      execGit: (args, hostCwd) => this._execGit(args, hostCwd),
      projectRoot: this.projectRoot,
      taskStore: this.taskStore,
    });
  }

  /**
   * Execute a phase with rate-limit protection, shared by normal-path
   * (runTask), rate-limit-resume (handleRateLimit), and wakeup-resume
   * (_scheduleWakeup) so the three paths can't drift apart (#1).
   *
   * On RateLimitError: reschedules via handleRateLimit and returns true.
   * On other errors: logs, advances to failed, and returns false.
   * The caller should guard cleanup in finally blocks on the return value.
   */
  private async _executePhaseSafe(pipeline: TaskPipeline, errorContext: string): Promise<boolean> {
    try {
      await this.executePhase(pipeline);
      return false;
    } catch (e) {
      if (e instanceof RateLimitError) {
        this.handleRateLimit(pipeline, e.resetsAt);
        return true;
      }
      const errMsg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
      logToOutput(pipeline.specPath, `\n[ERROR] Task failed ${errorContext}: ${errMsg}\n`);
      logError('orchestrator', `Task ${pipeline.taskId} failed ${errorContext}`, e);
      this.advancePhase(pipeline, 'failed');
      return false;
    }
  }

  /**
   * Fire a wakeup — resume the paused pipeline right now. Shared by the
   * scheduled setTimeout callback (_scheduleWakeup) and triggerEarlyWakeup
   * (a stale background-job progress log decided not to wait out the rest
   * of the window), so the two paths can't drift apart.
   */
  private async _fireWakeup(pipeline: TaskPipeline): Promise<void> {
    const task = this.taskStore.getById(pipeline.taskId);
    if (!task || NO_RESUME_PHASES.has(task.phase)) {
      log('wakeup', `Task ${pipeline.taskId} is in terminal phase "${task?.phase}" — skipping resume`);
      this.taskStore.update(pipeline.taskId, { wakeupUntil: undefined });
      return;
    }
    if (task.isPaused) {
      log('wakeup', `Task ${pipeline.taskId} is paused — skipping resume (user must unpause)`);
      this.taskStore.update(pipeline.taskId, { wakeupUntil: undefined });
      return;
    }
    const currentPipeline = this.pipelines.get(pipeline.taskId);
    if (currentPipeline !== pipeline) {
      log('wakeup', `Task ${pipeline.taskId} pipeline was replaced — skipping stale resume`);
      this.taskStore.update(pipeline.taskId, { wakeupUntil: undefined });
      return;
    }
    log('wakeup', `Resuming task ${pipeline.taskId}`);
    this.taskStore.update(pipeline.taskId, { wakeupUntil: undefined });
    // Clear the fired wakeup on the in-memory pipeline too — after this point
    // wakeupUntil is only truthy if the resumed phase scheduled a NEW wakeup.
    pipeline.wakeupUntil = undefined;
    const wasRateLimited = await this._executePhaseSafe(pipeline, 'after wakeup');
    // Guard cleanup like runTask does: if the resumed phase scheduled another
    // wakeup (chained wakeup — background job still running), _scheduleWakeup
    // re-acquired the lock and its timer owns cleanup; deleting here would
    // orphan that timer ("pipeline was replaced" on fire) and hang the task.
    if (!wasRateLimited && !pipeline.wakeupUntil) {
      this.pipelines.delete(pipeline.taskId);
      this.activeTasks.delete(pipeline.taskId);
    }
  }

  /** Schedule a wakeup timer (ADR 002). Follows the handleRateLimit setTimeout pattern. */
  private _scheduleWakeup(pipeline: TaskPipeline): void {
    const wakeupAt = new Date(pipeline.wakeupUntil!).getTime();
    let waitMs = Math.max(wakeupAt - Date.now(), 0);
    // Minimum 5-minute delay for overly-past timestamps (prevents tight loops)
    if (waitMs === 0 && (Date.now() - wakeupAt > 5 * 60 * 1000)) {
      waitMs = 5 * 60 * 1000;
    }
    const MAX_DELAY_MS = 2_147_483_647;
    waitMs = Math.min(waitMs, MAX_DELAY_MS);

    this.taskStore.update(pipeline.taskId, { wakeupUntil: pipeline.wakeupUntil, wakeupSubtaskId: pipeline.wakeupSubtaskId });
    processManager.emit('phase-change', { taskId: pipeline.taskId, phase: pipeline.phase, projectRoot: this.projectRoot, wakeupUntil: pipeline.wakeupUntil });

    // Re-acquire pipeline lock before setTimeout — runTask's finally block
    // deletes the pipeline from both maps. Without this re-acquire, the
    // timer callback finds no pipeline and skips resumption.
    // (Same pattern as handleRateLimit in rate-limit.ts)
    this.activeTasks.add(pipeline.taskId);
    this.pipelines.set(pipeline.taskId, pipeline);

    const mins = Math.ceil(waitMs / 60000);
    log('wakeup', `Task ${pipeline.taskId} paused for ~${mins}min. Resuming at ${pipeline.wakeupUntil}`);

    // Track the timer so cancelPipeline can clear it
    if (pipeline.pendingTimer) clearTimeout(pipeline.pendingTimer);
    pipeline.pendingTimer = setTimeout(() => { void this._fireWakeup(pipeline); }, waitMs);
  }

  /**
   * End a pending wakeup wait immediately instead of waiting for
   * `wakeupUntil` — re-enters the coder right away with the same
   * `⚠️ WAKEUP RE-ENTRY` prompt it would have gotten naturally. Used by
   * sweepStalledTasks() (recovery.ts) when a background job's own progress
   * log has gone stale: no point waiting out a window we have good reason
   * to believe is already over. The coder itself still makes the actual
   * "is this really dead" call — this only decides not to blindly wait.
   *
   * Logs to the task's own output.log (not just the server console) so the
   * decision is visible in the ticket's terminal tab, not just server logs.
   *
   * @returns true if a pending wakeup was found and triggered; false if
   * there was nothing to trigger (task not live in memory right now, or no
   * wakeup currently armed) — the caller should not assume the task will
   * resume in that case.
   */
  triggerEarlyWakeup(taskId: string, reason: string): boolean {
    const pipeline = this.pipelines.get(taskId);
    if (!pipeline || !pipeline.wakeupUntil) return false;
    if (pipeline.pendingTimer) clearTimeout(pipeline.pendingTimer);
    try {
      logToOutput(pipeline.specPath, `\n[WAKEUP] Ending wait early — ${reason}\n`);
    } catch { /* best-effort */ }
    log('wakeup', `Task ${taskId} early wakeup triggered — ${reason}`);
    void this._fireWakeup(pipeline);
    return true;
  }

}

// ── Global orchestrator manager ────────────────────────────────────────────

// Use global to survive Next.js module reloads in dev (single map across all compilations)
const g = global as unknown as Record<string, unknown>;
if (!g.__orchestrators) g.__orchestrators = new Map<string, Orchestrator>();
const orchestrators = g.__orchestrators as Map<string, Orchestrator>;

export function getOrchestrator(projectPath: string): Orchestrator {
  if (!orchestrators.has(projectPath)) {
    orchestrators.set(projectPath, new Orchestrator(projectPath));
  }
  return orchestrators.get(projectPath)!;
}

// Re-export git platform utilities (extracted to git-platform.ts)
export { detectGitPlatform, detectDefaultBranch, buildPlatformPrompt, checkExistingPRViaCLI, createPRViaCLI, buildPRBody } from './git-platform';
