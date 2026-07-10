import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, rmSync, mkdirSync } from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { processManager, type AgentSession } from './process-manager';
import { readContainerConfig, containerManager, hostToContainerPath } from './container-manager';
import { TaskStore } from './task-store';
import { slugify } from './utils';
import { isWorktreeHealthy, restoreWorktreeGitFileToHostPaths, patchWorktreeGitFile, worktreeGitEnv, execGit } from './orchestrator/worktree-utils';
import { rotateOutputLog, persistAndEmitPhase, savePipelineState, restorePipelineState, pipelineAdvancePhase } from './orchestrator/pipeline-state';
import { writeQaFeedback, writeCompletionSummary } from './orchestrator/qa-feedback';
import { runSpecPhase, runPlanPhase, runMergePhase, runCreatePRPhase } from './orchestrator/phase-runners';
import { parseSessionLimitReset, extractPrUrl, phaseHeader, restoreQaReportFromSnapshot, restoreHumanFeedbackFromSnapshot, getWorktreeBase, computePipelineConfig, buildSessionOpts, type PipelineConfig } from './orchestrator/helpers';
import { cleanStaleSubtaskWorktrees, removeWorktree as removeWorktreeFn, cleanWorktree as cleanWorktreeFn, getWorktreePath as getWorktreePathFn } from './orchestrator/worktree-ops';
import { commitArtifactsToWorktree } from './orchestrator/artifact-commit';
import { gitPush } from './orchestrator/git-push';
import { RateLimitError, NO_RESUME_PHASES, waitForCompletion, handleRateLimit as handleRateLimitFn } from './orchestrator/rate-limit';
import { runImplement } from './orchestrator/implement';
import { runQaReview } from './orchestrator/qa-review';
import { approveTask as approveTaskFn, rejectTask as rejectTaskFn, autoReviseSpec } from './orchestrator/review-actions';
import type { PipelinePhase } from '@/constants/phases';
import type { TaskPipeline, MergeStrategy, QaReport } from './orchestrator/types';

export class Orchestrator {
  private pipelines: Map<string, TaskPipeline> = new Map();
  private activeTasks: Set<string> = new Set();
  private taskStore: TaskStore;

  constructor(private projectRoot: string) {
    this.taskStore = new TaskStore(projectRoot);
  }

  /** Whether a pipeline is currently executing for the given task. */
  isTaskActive(taskId: string): boolean {
    return this.activeTasks.has(taskId);
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
    this.pipelines.delete(taskId);
    this.activeTasks.delete(taskId);
  }

  // Move a task to a target phase, smart-detecting which earlier phase to start from
  // based on which artifacts already exist, then run the pipeline from there.
  async moveTaskToPhase(taskId: string, targetPhase: string): Promise<void> {
    // Cancel any currently running pipeline for this task before starting a new one
    this.cancelPipeline(taskId);

    const task = this.taskStore.getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const dir = this.taskStore.getDirById(taskId);

    // Phases that require no pipeline action
    if (NO_RESUME_PHASES.has(targetPhase)) {
      // Auto-delete the git worktree when moving to 'done', 'backlog', or 'failed'
      if (targetPhase === 'done' || targetPhase === 'backlog' || targetPhase === 'failed') {
        this.removeWorktree(taskId);
      }
      this.taskStore.updatePhase(taskId, targetPhase);
      processManager.emit('phase-change', { taskId, phase: targetPhase, projectRoot: this.projectRoot });
      return;
    }

    const hasSpec = existsSync(path.join(dir, 'spec.md'));
    const hasPlan = existsSync(path.join(dir, 'plan.json'));

    // Determine actual start phase and clear stale artifacts
    let startPhase: PipelinePhase = 'spec';
    if (targetPhase === 'spec') {
      this.taskStore.clearArtifacts(taskId, 'spec');
      startPhase = 'spec';
    } else if (targetPhase === 'plan') {
      this.taskStore.clearArtifacts(taskId, 'plan');
      startPhase = hasSpec ? 'plan' : 'spec';
    } else if (targetPhase === 'implement') {
      this.taskStore.clearArtifacts(taskId, 'qa');
      if (hasPlan) startPhase = 'implement';
      else if (hasSpec) startPhase = 'plan';
      else startPhase = 'spec';
    } else if (targetPhase === 'qa-review') {
      this.taskStore.clearArtifacts(taskId, 'qa');
      if (hasPlan) startPhase = 'implement';
      else if (hasSpec) startPhase = 'plan';
      else startPhase = 'spec';
    } else if (targetPhase === 'merge' || targetPhase === 'create-pr') {
      // Merge/PR requires the worktree and branch to exist. If missing,
      // restart from the earliest phase needed to recreate them.
      const worktreeBase = this.getWorktreeBase();
      const worktreePath = path.join(worktreeBase, slugify(task.description));
      const worktreeExists = existsSync(worktreePath);
      const branchExists = !!task.branch;

      if (hasPlan && worktreeExists && branchExists) {
        startPhase = targetPhase as PipelinePhase;
      } else if (hasPlan) {
        // Plan exists but worktree/branch missing — recreate from implement
        startPhase = 'implement';
      } else if (hasSpec) {
        startPhase = 'plan';
      } else {
        startPhase = 'spec';
      }
    } else {
      startPhase = targetPhase as PipelinePhase;
    }

    await this.runTask(taskId, task.description, startPhase);
  }

  async runTask(taskId: string, description: string, startPhase?: PipelinePhase): Promise<void> {
    // Invalidate pipeline config cache so pipeline.json changes take effect.
    // Must happen BEFORE the demo check — otherwise stale demo:true survives
    // config edits and prevents the project from ever running tasks.
    this._pipelineConfigCache = null;

    // Demo mode: when pipeline.json has demo:true, skip all pipeline processing
    if (this.getPipelineConfig().demo) return;

    // Prevent concurrent runs of the same task
    if (this.activeTasks.has(taskId)) {
      throw new Error(`Task ${taskId} is already running — wait for the current pipeline to finish.`);
    }
    this.cancelPipeline(taskId);
    this.activeTasks.add(taskId);

    const config = this.getPipelineConfig();
    const slug = slugify(description);
    const branch = `feat/${slug}`;
    const worktreePath = path.join(this.getWorktreeBase(), slug);
    const specPath = this.taskStore.getDirById(taskId);

    const pipeline: TaskPipeline = {
      taskId,
      description,
      phase: 'spec',
      specPath,
      worktreePath,
      branch,
      qaAttempt: 0,
      maxQaAttempts: config.maxQaAttempts,
      specRevision: 0,
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
      if (savedState.wakeupUntil !== undefined) pipeline.wakeupUntil = savedState.wakeupUntil;
      if (savedState.wakeupSubtaskId !== undefined) pipeline.wakeupSubtaskId = savedState.wakeupSubtaskId;
      if (savedState.wakeupCommand !== undefined) pipeline.wakeupCommand = savedState.wakeupCommand;
      if (savedState.wakeupArtifact !== undefined) pipeline.wakeupArtifact = savedState.wakeupArtifact;
      if (savedState.wakeupAttemptCount !== undefined) pipeline.wakeupAttemptCount = savedState.wakeupAttemptCount;
      if (savedState.persistedCriterionFailCounts !== undefined) pipeline.persistedCriterionFailCounts = savedState.persistedCriterionFailCounts;
      if (savedState.sessionId) pipeline.sessionId = savedState.sessionId;
    }

    this._savePipelineState(pipeline);
    let rateLimited = false;
    try {
      await this.executePhase(pipeline);
    } catch (e) {
      if (e instanceof RateLimitError) {
        rateLimited = true;
        this.handleRateLimit(pipeline, e.resetsAt);
      } else {
        const errMsg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
        const logFile = path.join(pipeline.specPath, 'output.log');
        appendFileSync(logFile, `\n[ERROR] Task failed: ${errMsg}\n`);
        console.error(`[orchestrator] Task ${taskId} failed:`, e);
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
    await approveTaskFn(taskId, strategy, {
      taskStore: this.taskStore,
      pipelines: this.pipelines,
      restorePipeline: (id, phase) => this.restorePipeline(id, phase),
      advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
      executePhase: p => this.executePhase(p),
      savePipelineState: p => this._savePipelineState(p),
    });
  }

  async rejectTask(taskId: string, feedback: string): Promise<void> {
    await rejectTaskFn(taskId, feedback, {
      taskStore: this.taskStore,
      pipelines: this.pipelines,
      restorePipeline: (id, phase) => this.restorePipeline(id, phase),
      advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
      executePhase: p => this.executePhase(p),
      savePipelineState: p => this._savePipelineState(p),
    });
  }

  async reviseSpec(taskId: string): Promise<void> {
    const task = this.taskStore.getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const phase = task.phase;
    if (phase !== 'awaiting-review') {
      throw new Error(`cannot revise spec for a task in ${phase} — must be awaiting-review`);
    }
    const pipeline = this.pipelines.get(taskId) ?? this.restorePipeline(taskId, 'awaiting-review');
    await this._autoReviseSpec(pipeline);
  }

  // Delegates to review-actions.autoReviseSpec
  private async _autoReviseSpec(pipeline: TaskPipeline): Promise<void> {
    await autoReviseSpec(pipeline, {
      taskStore: this.taskStore,
      pipelines: this.pipelines,
      restorePipeline: (id, phase) => this.restorePipeline(id, phase),
      advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
      executePhase: p => this.executePhase(p),
      savePipelineState: p => this._savePipelineState(p),
    });
  }

  private async executePhase(pipeline: TaskPipeline): Promise<void> {
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
    await runSpecPhase(pipeline, {
      projectRoot: this.projectRoot,
      rotateOutputLog: logFile => this._rotateOutputLog(logFile),
      phaseHeader: (logFile, phase) => this._phaseHeader(logFile, phase),
      persistAndEmitPhase: p => this._persistAndEmitPhase(p),
      savePipelineState: p => this._savePipelineState(p),
      sessionOpts: (role, cwd, taskId, logFile) => this.sessionOpts(role, cwd, taskId, logFile),
      toAgentPath: hostPath => this._toAgentPath(hostPath),
      waitForCompletion: sessionId => this.waitForCompletion(sessionId),
      advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
      executePhase: p => this.executePhase(p),
    });
  }

  private async runPlan(pipeline: TaskPipeline): Promise<void> {
    await runPlanPhase(pipeline, {
      projectRoot: this.projectRoot,
      rotateOutputLog: logFile => this._rotateOutputLog(logFile),
      phaseHeader: (logFile, phase) => this._phaseHeader(logFile, phase),
      persistAndEmitPhase: p => this._persistAndEmitPhase(p),
      savePipelineState: p => this._savePipelineState(p),
      sessionOpts: (role, cwd, taskId, logFile) => this.sessionOpts(role, cwd, taskId, logFile),
      toAgentPath: hostPath => this._toAgentPath(hostPath),
      waitForCompletion: sessionId => this.waitForCompletion(sessionId),
      advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
      executePhase: p => this.executePhase(p),
      gitPush: (pushArgs, logFile) => this._gitPush(pushArgs, logFile),
      execGit: (args, hostCwd) => this._execGit(args, hostCwd),
    });
  }

  private async runImplement(pipeline: TaskPipeline): Promise<void> {
    await runImplement(pipeline, {
      projectRoot: this.projectRoot,
      persistAndEmitPhase: p => this._persistAndEmitPhase(p),
      advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
      savePipelineState: p => this._savePipelineState(p),
      executePhase: p => this.executePhase(p),
      sessionOpts: (role, cwd, taskId, logFile) => this.sessionOpts(role, cwd, taskId, logFile),
      waitForCompletion: sessionId => this.waitForCompletion(sessionId),
      execGit: (args, hostCwd) => this._execGit(args, hostCwd),
      gitPush: (pushArgs, logFile) => this._gitPush(pushArgs, logFile),
      patchWorktreeGitFile: (hostWorktreePath, containerWorkspace) => this._patchWorktreeGitFile(hostWorktreePath, containerWorkspace),
      isWorktreeHealthy: worktreePath => this._isWorktreeHealthy(worktreePath),
      cleanStaleSubtaskWorktrees: p => this._cleanStaleSubtaskWorktrees(p),
      restoreQaReportFromSnapshot: specPath => this._restoreQaReportFromSnapshot(specPath),
      restoreHumanFeedbackFromSnapshot: specPath => this._restoreHumanFeedbackFromSnapshot(specPath),
      writeQaFeedback: (p, report) => this._writeQaFeedback(p, report),
      getPipelineConfig: () => this.getPipelineConfig(),
      phaseHeader: (logFile, phase) => this._phaseHeader(logFile, phase),
      planWriteLock: this._planWriteLockRef,
      scheduleWakeup: (pipeline) => this._scheduleWakeup(pipeline),
    });
  }

  private async runQaReview(pipeline: TaskPipeline): Promise<void> {
    await runQaReview(pipeline, {
      projectRoot: this.projectRoot,
      persistAndEmitPhase: p => this._persistAndEmitPhase(p),
      advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
      savePipelineState: p => this._savePipelineState(p),
      executePhase: p => this.executePhase(p),
      sessionOpts: (role, cwd, taskId, logFile) => this.sessionOpts(role, cwd, taskId, logFile),
      waitForCompletion: sessionId => this.waitForCompletion(sessionId),
      gitPush: (pushArgs, logFile) => this._gitPush(pushArgs, logFile),
      writeQaFeedback: (p, report) => this._writeQaFeedback(p, report),
      writeCompletionSummary: p => this._writeCompletionSummary(p),
      phaseHeader: (logFile, phase) => this._phaseHeader(logFile, phase),
      toAgentPath: hostPath => this._toAgentPath(hostPath),
      autoReviseSpec: p => this._autoReviseSpec(p),
    });
  }

  private async runMerge(pipeline: TaskPipeline): Promise<void> {
    await runMergePhase(pipeline, {
      projectRoot: this.projectRoot,
      phaseHeader: (logFile, phase) => this._phaseHeader(logFile, phase),
      persistAndEmitPhase: p => this._persistAndEmitPhase(p),
      sessionOpts: (role, cwd, taskId, logFile) => this.sessionOpts(role, cwd, taskId, logFile),
      waitForCompletion: sessionId => this.waitForCompletion(sessionId),
      advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
      execGit: (args, hostCwd) => this._execGit(args, hostCwd),
      commitArtifactsToWorktree: p => this._commitArtifactsToWorktree(p),
      getPipelineConfig: () => this.getPipelineConfig(),
      removeWorktree: taskId => this.removeWorktree(taskId),
    });
  }

  private async runCreatePR(pipeline: TaskPipeline): Promise<void> {
    await runCreatePRPhase(pipeline, {
      projectRoot: this.projectRoot,
      taskStore: this.taskStore,
      persistAndEmitPhase: p => this._persistAndEmitPhase(p),
      sessionOpts: (role, cwd, taskId, logFile) => this.sessionOpts(role, cwd, taskId, logFile),
      waitForCompletion: sessionId => this.waitForCompletion(sessionId),
      advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
      execGit: (args, hostCwd) => this._execGit(args, hostCwd),
      commitArtifactsToWorktree: p => this._commitArtifactsToWorktree(p),
      gitPush: (pushArgs, logFile) => this._gitPush(pushArgs, logFile),
      extractPrUrl: logFile => this._extractPrUrl(logFile),
    });
  }

  async markTaskDone(taskId: string): Promise<void> {
    // Snapshot task data before deleting the directory (needed for fallback).
    const task = this.taskStore.getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

    this.removeWorktree(taskId);

    // Delete the live .teamai/{slug}/ directory so pulling the just-merged
    // commit won't collide with local files.
    const dir = this.taskStore.getDirById(taskId);
    rmSync(dir, { recursive: true, force: true });

    // Try to pull the just-merged commit into the main project root.
    // On success, the pulled .teamai/{slug}/task.json already has phase: "done"
    // (set by commitArtifactsToWorktree before the merge).
    let pulled = false;
    try {
      execFileSync('git', ['pull', '--ff-only', 'origin', 'master'], {
        cwd: this.projectRoot,
        stdio: 'pipe',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      pulled = true;
    } catch {
      // Pull failed — non-fast-forward, offline, etc.
      // Fall through to recreate the task so it doesn't disappear from kanban.
    }

    // If the pull restored the committed snapshot, leave it untouched: the
    // snapshot's task.json already has phase: "done" (set by
    // commitArtifactsToWorktree), and those files are tracked — rewriting
    // updatedAt or appending to events.jsonl would leave the repo dirty on
    // every completed task.
    let settled = false;
    const pulledTaskJson = path.join(dir, 'task.json');
    if (pulled && existsSync(pulledTaskJson)) {
      try {
        settled = JSON.parse(readFileSync(pulledTaskJson, 'utf-8')).phase === 'done';
      } catch { /* unreadable — patch it below */ }
      if (!settled) {
        // Snapshot came back without phase: "done" — patch it in place.
        this.taskStore.updatePhase(taskId, 'done');
        settled = true;
      }
    }

    if (!settled) {
      // Pull failed (non-fast-forward, offline, ...) or brought no artifacts
      // for this task (e.g. .teamai/ is gitignored in the repo, so the
      // artifact commit was skipped). Fallback: recreate a minimal task.json
      // so the task stays visible in the kanban.
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'task.json'), JSON.stringify({
        ...task,
        phase: 'done',
        updatedAt: new Date().toISOString(),
      }, null, 2));
      const event = { phase: 'done', timestamp: new Date().toISOString() };
      appendFileSync(path.join(dir, 'events.jsonl'), JSON.stringify(event) + '\n');
    }

    // Only emit phase-change once, after the full delete→pull(→fallback)
    // sequence resolves — UI listeners refetch exactly once against the
    // final, settled state.
    processManager.emit('phase-change', { taskId, phase: 'done', projectRoot: this.projectRoot });
  }

  /** Scan the output log for a PR/MR URL created by the agent. */
  private _extractPrUrl(logFile: string): string | null { return extractPrUrl(logFile); }

  // Serializes writes to plan.json to prevent race conditions during
  // per-subtask checkpointing in runImplement (#2). Wrapped in an object
  // so the extracted runImplement can mutate the current promise through
  // its deps reference without aliasing `this`.
  private _planWriteLockRef = { current: Promise.resolve() };

  private _rotateOutputLog(logFile: string): void { rotateOutputLog(logFile); }

  private _persistAndEmitPhase(pipeline: TaskPipeline): void { persistAndEmitPhase(pipeline, this.taskStore, this.projectRoot); }

  private _savePipelineState(pipeline: TaskPipeline): void { savePipelineState(pipeline); }

  private _restorePipelineState(_taskId: string, specPath: string): Partial<TaskPipeline> | null { return restorePipelineState(_taskId, specPath); }

  // Delegates to worktree-utils.isWorktreeHealthy
  private _isWorktreeHealthy(worktreePath: string): boolean { return isWorktreeHealthy(worktreePath, this.projectRoot); }

  // Delegates to helpers.restoreQaReportFromSnapshot
  private _restoreQaReportFromSnapshot(specPath: string): void { restoreQaReportFromSnapshot(specPath); }

  // Delegates to helpers.restoreHumanFeedbackFromSnapshot
  private _restoreHumanFeedbackFromSnapshot(specPath: string): void { restoreHumanFeedbackFromSnapshot(specPath); }

  private advancePhase(pipeline: TaskPipeline, phase: PipelinePhase, eventExtra?: Record<string, unknown>): void { pipelineAdvancePhase(pipeline, phase, this.taskStore, this.projectRoot, eventExtra); }

  private waitForCompletion(sessionId: string): Promise<void> {
    return waitForCompletion(sessionId, { parseSessionLimitReset });
  }

  private handleRateLimit(pipeline: TaskPipeline, resetsAt: number): void {
    handleRateLimitFn(pipeline, resetsAt, {
      taskStore: this.taskStore,
      projectRoot: this.projectRoot,
      activeTasks: this.activeTasks,
      pipelines: this.pipelines,
      executePhase: p => this.executePhase(p),
      advancePhase: (p, phase) => this.advancePhase(p, phase),
      handleRateLimit: (p, r) => this.handleRateLimit(p, r),
    });
  }

  // Translate a host absolute path to the container-relative equivalent when
  // container mode is enabled. Used so message content sent to agents inside
  // the container references paths that actually exist there.
  private _toAgentPath(hostPath: string): string {
    if (readContainerConfig(this.projectRoot).enabled) {
      const info = containerManager.getRunningContainer(this.projectRoot);
      if (info) return hostToContainerPath(hostPath, this.projectRoot, info.remoteWorkspaceFolder);
    }
    return hostPath;
  }

  private _execGit(args: string[], hostCwd: string): void { execGit(args, hostCwd, this.projectRoot); }

  // Delegates to worktree-utils.worktreeGitEnv
  private _worktreeGitEnv(hostCwd: string, containerWs?: string): Record<string, string> { return worktreeGitEnv(hostCwd, this.projectRoot, containerWs); }


  // Delegates to worktree-utils.patchWorktreeGitFile
  private _patchWorktreeGitFile(hostWorktreePath: string, containerWorkspace: string): void { patchWorktreeGitFile(hostWorktreePath, containerWorkspace, this.projectRoot); }

  private _restoreWorktreeGitFileToHostPaths(hostWorktreePath: string): void { restoreWorktreeGitFileToHostPaths(hostWorktreePath, this.projectRoot); }
  private restorePipeline(taskId: string, requiredPhase: PipelinePhase): TaskPipeline {
    const task = this.taskStore.getById(taskId);
    if (!task || task.phase !== requiredPhase) {
      throw new Error(`Task ${taskId} is not ${requiredPhase}`);
    }
    const branch = task.branch ?? `feat/${slugify(task.description)}`;
    const slug = branch.replace(/^feat\//, '');
    const pipeline: TaskPipeline = {
      taskId,
      description: task.description,
      phase: requiredPhase,
      specPath: this.taskStore.getDirById(taskId),
      worktreePath: path.join(this.getWorktreeBase(), slug),
      branch,
      qaAttempt: 0,
      maxQaAttempts: this.getPipelineConfig().maxQaAttempts,
      specRevision: 0,
    };
    this.pipelines.set(taskId, pipeline);
    return pipeline;
  }

  private getWorktreeBase(): string { return getWorktreeBase(this.projectRoot); }

  /**
   * Clean up artifacts from the given phase and beyond (inclusive).
   * Artifacts from phases BEFORE the given phase are kept as-is.
   * Called by stopTask before moving the task to backlog.
   */
  cleanupTaskArtifacts(taskId: string, currentPhase: string): void {
    const dir = this.taskStore.getDirById(taskId);
    const pipelineOrder = ['spec', 'plan', 'implement', 'qa-review', 'merge'];
    const startIndex = pipelineOrder.indexOf(currentPhase);
    if (startIndex < 0) return;

    // Remove output.log — stale terminal output should not persist
    const outputPath = path.join(dir, 'output.log');
    try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch { /* best-effort */ }

    // Files to delete by phase (each list covers that phase's artifacts)
    const phaseFiles: Record<string, string[]> = {
      spec: ['spec.md', 'plan.json'],
      plan: ['plan.json'],
      implement: [],
      'qa-review': ['qa_report.json', 'qa_feedback.md', 'completion_summary.md', 'qa_report_before_bounce.json'],
      merge: [],
    };

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

    // Reset subtask completions if stopping during/after implement so they re-run from scratch
    if (startIndex >= pipelineOrder.indexOf('implement')) {
      const planPath = path.join(dir, 'plan.json');
      if (existsSync(planPath)) {
        try {
          const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
          if (plan.subtasks) {
            for (const s of plan.subtasks) s.completed = false;
          }
          writeFileSync(planPath, JSON.stringify(plan, null, 2));
        } catch { /* best-effort */ }
      }
    }

    // Clean the worktree for plan/implement phases so the next run starts with a clean slate
    if (currentPhase === 'plan') {
      // Worktree was created during plan — remove it so it gets recreated fresh
      this._removeWorktreeForce(taskId);
    } else if (currentPhase === 'implement') {
      // Worktree has partial changes — discard them
      this._cleanWorktree(taskId);
    }
  }

  /**
   * Resume a stopped/backlog task — detect which phases have completed artifacts
   * and start from the next unfinished phase. Does NOT clear artifacts so completed
   * phases are fast-forwarded automatically.
   */
  async resumeTask(taskId: string): Promise<void> {
    const task = this.taskStore.getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);

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
      // backlog / done / failed — restart from artifact detection
      const hasSpec = existsSync(path.join(dir, 'spec.md'));
      const hasPlan = existsSync(path.join(dir, 'plan.json'));
      if (hasPlan) {
        startPhase = 'implement';
        // Subtask completions are preserved — runImplement skips already-completed
        // subtasks. If the user wants a full re-run, they should stop the task
        // (move to backlog) and restart it, which calls cleanupTaskArtifacts.
      } else if (hasSpec) {
        startPhase = 'plan';
      } else {
        startPhase = 'spec';
      }
    }

    // Clear output.log for a fresh terminal view
    const outputPath = path.join(dir, 'output.log');
    try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch { /* best-effort */ }

    // ── Gap 4b: Restore qa_report.json if deleted (also done in runImplement) ──
    // Belt-and-suspenders: restore here too so the report exists before the pipeline
    // starts, not just when runImplement is reached. Covers scenarios where
    // resumeTask skips directly to implement on a previously-failed task.
    this._restoreQaReportFromSnapshot(dir);

    await this.runTask(taskId, task.description, startPhase);
  }

  /**
   * Clean up stale per-subtask worktrees from a previous crashed run (AC9).
   * Scans for directories matching <worktree-base>/<task-slug>-st* and removes them
   * along with their branches and git worktree metadata.
   */
  private _cleanStaleSubtaskWorktrees(pipeline: TaskPipeline): void {
    cleanStaleSubtaskWorktrees(pipeline, {
      execGit: (args, hostCwd) => this._execGit(args, hostCwd),
      projectRoot: this.projectRoot,
    });
  }

  /** Get the filesystem path to this task's git worktree, or null if the task has no branch. */
  public getWorktreePath(taskId: string): string | null {
    return getWorktreePathFn(taskId, this.taskStore, getWorktreeBase(this.projectRoot));
  }

  /**
   * Remove the git worktree for this task if it exists on disk.
   * Tries a normal remove first; falls back to --force if there are uncommitted changes.
   * Always cleans up the branch and updates the task record so no stale state lingers.
   */
  private removeWorktree(taskId: string): void {
    removeWorktreeFn(taskId, {
      execGit: (args, hostCwd) => this._execGit(args, hostCwd),
      projectRoot: this.projectRoot,
      taskStore: this.taskStore,
    });
  }

  /** Force-remove the git worktree (discards uncommitted changes). Delegates to removeWorktree. */
  private _removeWorktreeForce(taskId: string): void {
    this.removeWorktree(taskId);
  }

  /** Discard all uncommitted changes in the worktree. Works on both host and container. */
  private _cleanWorktree(taskId: string): void {
    cleanWorktreeFn(taskId, {
      execGit: (args, hostCwd) => this._execGit(args, hostCwd),
      projectRoot: this.projectRoot,
      taskStore: this.taskStore,
    });
  }

  private sessionOpts(role: AgentSession['role'], cwd: string, taskId: string, logFile?: string) {
    return buildSessionOpts(this.projectRoot, role, cwd, taskId, logFile);
  }

  private _writeQaFeedback(pipeline: TaskPipeline, report: QaReport): void { writeQaFeedback(pipeline.specPath, report, pipeline.persistedCriterionFailCounts); }

  private _writeCompletionSummary(pipeline: TaskPipeline): void { writeCompletionSummary(pipeline.specPath, pipeline.qaAttempt, pipeline.taskId, this.taskStore); }

  private _phaseHeader(logFile: string, phase: string): void { phaseHeader(logFile, phase); }

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
    console.log(`[wakeup] Task ${pipeline.taskId} paused for ~${mins}min. Resuming at ${pipeline.wakeupUntil}`);

    setTimeout(async () => {
      const task = this.taskStore.getById(pipeline.taskId);
      if (!task || NO_RESUME_PHASES.has(task.phase)) {
        console.log(`[wakeup] Task ${pipeline.taskId} is in terminal phase "${task?.phase}" — skipping resume`);
        this.taskStore.update(pipeline.taskId, { wakeupUntil: undefined });
        return;
      }
      const currentPipeline = this.pipelines.get(pipeline.taskId);
      if (currentPipeline !== pipeline) {
        console.log(`[wakeup] Task ${pipeline.taskId} pipeline was replaced — skipping stale resume`);
        this.taskStore.update(pipeline.taskId, { wakeupUntil: undefined });
        return;
      }
      console.log(`[wakeup] Resuming task ${pipeline.taskId}`);
      this.taskStore.update(pipeline.taskId, { wakeupUntil: undefined });
      try {
        await this.executePhase(pipeline);
      } catch (e) {
        const errMsg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
        appendFileSync(path.join(pipeline.specPath, 'output.log'), `\n[ERROR] Task failed after wakeup: ${errMsg}\n`);
        console.error(`[orchestrator] Task ${pipeline.taskId} failed after wakeup:`, e);
        this.advancePhase(pipeline, 'failed');
      } finally {
        this.pipelines.delete(pipeline.taskId);
        this.activeTasks.delete(pipeline.taskId);
      }
    }, waitMs);
  }

  // Delegates to artifact-commit.commitArtifactsToWorktree
  private _commitArtifactsToWorktree(pipeline: TaskPipeline): void {
    commitArtifactsToWorktree(pipeline, {
      restoreWorktreeGitFileToHostPaths: hostWorktreePath => this._restoreWorktreeGitFileToHostPaths(hostWorktreePath),
      worktreeGitEnv: (hostCwd, containerWs) => this._worktreeGitEnv(hostCwd, containerWs),
    });
  }

  // Delegates to git-push.gitPush
  private _gitPush(pushArgs: string[], logFile: string): void { gitPush(this.projectRoot, pushArgs, logFile); }
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
