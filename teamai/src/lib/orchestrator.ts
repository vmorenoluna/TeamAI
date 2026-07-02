import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from 'fs';
import path from 'path';
import { processManager, type AgentSession } from './process-manager';
import { readContainerConfig, containerManager, hostToContainerPath } from './container-manager';
import { TaskStore } from './task-store';
import { slugify } from './utils';
import { type SensorsConfig } from './sensors';
import { isWorktreeHealthy, restoreWorktreeGitFileToHostPaths, patchWorktreeGitFile, worktreeGitEnv, execGit } from './orchestrator/worktree-utils';
import { rotateOutputLog, persistAndEmitPhase, savePipelineState, restorePipelineState, pipelineAdvancePhase } from './orchestrator/pipeline-state';
import { writeQaFeedback, writeCompletionSummary } from './orchestrator/qa-feedback';
import { runSpecPhase, runPlanPhase, runMergePhase, runCreatePRPhase } from './orchestrator/phase-runners';
import { parseSessionLimitReset, extractPrUrl, phaseHeader, restoreQaReportFromSnapshot, restoreHumanFeedbackFromSnapshot, getWorktreeBase, computePipelineConfig, buildSessionOpts } from './orchestrator/helpers';
import { cleanStaleSubtaskWorktrees, removeWorktree as removeWorktreeFn, cleanWorktree as cleanWorktreeFn, getWorktreePath as getWorktreePathFn } from './orchestrator/worktree-ops';
import { commitArtifactsToWorktree } from './orchestrator/artifact-commit';
import { gitPush } from './orchestrator/git-push';
import { RateLimitError, NO_RESUME_PHASES, waitForCompletion, handleRateLimit as handleRateLimitFn } from './orchestrator/rate-limit';
import { runImplement } from './orchestrator/implement';
import { runQaReview } from './orchestrator/qa-review';
import type { PipelinePhase } from '@/constants/phases';

interface QaCriterion {
  status?: string;
  criterion?: string;
  name?: string;
  fix_needed?: string;
  notes?: string;
  evidence?: string;
}

interface QaIssue {
  description?: string;
  message?: string;
  file?: string;
  fix_needed?: string;
  severity?: string;
}

interface QaReport {
  overall?: string;
  criteria?: QaCriterion[];
  additional_issues?: QaIssue[];
  issues?: QaIssue[];
  spec_concerns?: SpecConcern[];
  head_at_review?: string;
  fail_type?: string;
}

interface SpecConcern {
  issue: string;
  reasoning: string;
  suggested_fix?: string;
}


type MergeStrategy = 'local-merge' | 'pull-request';

interface TaskPipeline {
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
}

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

  private _pipelineConfigCache: { maxQaAttempts: number; parallelSubtasks: boolean; sensors?: SensorsConfig } | null = null;
  private getPipelineConfig(): { maxQaAttempts: number; parallelSubtasks: boolean; sensors?: SensorsConfig } {
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
    // Prevent concurrent runs of the same task
    if (this.activeTasks.has(taskId)) {
      throw new Error(`Task ${taskId} is already running — wait for the current pipeline to finish.`);
    }

    // Cancel any currently running pipeline for this task before starting a new one
    this._pipelineConfigCache = null; // invalidate cache so pipeline.json changes take effect
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
      // For rate-limited tasks the lock is re-acquired in handleRateLimit
      // and must not be deleted here — the setTimeout callback owns cleanup.
      if (!rateLimited) {
        this.pipelines.delete(taskId);
        this.activeTasks.delete(taskId);
      }
    }
  }

  async approveTask(taskId: string, strategy: MergeStrategy): Promise<void> {
    const task = this.taskStore.getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const phase = task.phase;
    if (phase !== 'awaiting-review') {
      throw new Error(`cannot approve a task in ${phase} — must be awaiting-review`);
    }
    const pipeline = this.pipelines.get(taskId) ?? this.restorePipeline(taskId, 'awaiting-review');
    pipeline.mergeStrategy = strategy;
    // Persist the chosen strategy so recovery can restore it after a crash
    this.taskStore.update(taskId, { mergeStrategy: strategy });
    const next = strategy === 'local-merge' ? 'merge' : 'create-pr';
    this.advancePhase(pipeline, next);
    try {
      await this.executePhase(pipeline);
    } catch (err) {
      this.advancePhase(pipeline, 'awaiting-review');
      throw err;
    }
  }

  async rejectTask(taskId: string, feedback: string): Promise<void> {
    const task = this.taskStore.getById(taskId);
    if (!task) throw new Error(`Task ${taskId} not found`);
    const phase = task.phase;
    if (phase !== 'awaiting-review' && phase !== 'pr-open') {
      throw new Error(`cannot reject a task in ${phase} — must be awaiting-review or pr-open`);
    }

    const pipeline = this.pipelines.get(taskId) ?? this.restorePipeline(taskId, phase);
    const feedbackPath = path.join(pipeline.specPath, 'human_feedback.md');
    writeFileSync(feedbackPath, `# Human Review Feedback\n\n${feedback}\n`);

    // ── Snapshot: preserve human_feedback before bouncing back to implement ──
    // The feedback file is deleted after implement completes (cleanup at end of runImplement).
    // If the pipeline later bounces back again (e.g. QA → implement → review → implement),
    // this snapshot ensures the feedback survives repeated bounce cycles.
    try {
      const snapshotPath = path.join(pipeline.specPath, 'human_feedback_before_bounce.md');
      writeFileSync(snapshotPath, readFileSync(feedbackPath, 'utf-8'));
    } catch { /* best-effort */ }

    // Update the QA report so the engineer can see what changes were requested
    const reportPath = path.join(pipeline.specPath, 'qa_report.json');
    if (existsSync(reportPath)) {
      try {
        const report: QaReport = JSON.parse(readFileSync(reportPath, 'utf-8'));
        if (!report.criteria) report.criteria = [];
        report.overall = 'FAIL';
        report.criteria.push({
          name: 'Change Request',
          status: 'FAIL',
          notes: feedback,
        });
        writeFileSync(reportPath, JSON.stringify(report, null, 2));
      } catch { /* best-effort: if qa_report.json is malformed, don't block the rejection */ }
    }

    pipeline.qaAttempt = 0;
    this.advancePhase(pipeline, 'implement');
    await this.executePhase(pipeline);
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

  /**
   * Auto-triggered spec revision when QA finds spec_concerns.
   * Writes revision feedback, snapshots the old spec, clears downstream artifacts,
   * and restarts the pipeline from the spec phase (analyst).
   */
  private async _autoReviseSpec(pipeline: TaskPipeline): Promise<void> {
    const specPath = pipeline.specPath;
    const logFile = path.join(specPath, 'output.log');

    // Guard: max 3 spec revisions before falling back to human review.
    // Prevents infinite loops when the analyst produces the same flawed spec.
    pipeline.specRevision++;
    if (pipeline.specRevision > 3) {
      try {
        appendFileSync(logFile, `\n[REFINE] Max spec revisions (3) reached — pausing for human review\n`);
      } catch { /* best-effort */ }
      this.advancePhase(pipeline, 'awaiting-review');
      return;
    }

    // Write spec_revision_feedback.md from QA report's spec_concerns
    const reportPath = path.join(specPath, 'qa_report.json');
    let feedbackContent = '# Spec Revision Feedback\n\n';
    feedbackContent += 'The QA reviewer identified issues with the specification itself ';
    feedbackContent += '(not the implementation). The spec needs to be revised to address these concerns.\n\n';
    if (existsSync(reportPath)) {
      try {
        const report: QaReport = JSON.parse(readFileSync(reportPath, 'utf-8'));
        if (report.spec_concerns && report.spec_concerns.length > 0) {
          for (const sc of report.spec_concerns) {
            feedbackContent += `## ${sc.issue}\n\n`;
            feedbackContent += `**Reasoning:** ${sc.reasoning}\n\n`;
            if (sc.suggested_fix) {
              feedbackContent += `**Suggested fix:** ${sc.suggested_fix}\n\n`;
            }
          }
        }
      } catch { /* best-effort — produce feedback from whatever we can read */ }
    }
    writeFileSync(path.join(specPath, 'spec_revision_feedback.md'), feedbackContent);

    // Snapshot the current spec before revision (preserves history)
    const specMdPath = path.join(specPath, 'spec.md');
    if (existsSync(specMdPath)) {
      try {
        writeFileSync(path.join(specPath, `spec_v${pipeline.specRevision}.md`), readFileSync(specMdPath, 'utf-8'));
      } catch { /* best-effort */ }
    }

    // Clear downstream artifacts — plan, QA, and feedback all need regeneration
    // from the revised spec. clearArtifacts('plan') clears plan.json + qa_report.json.
    this.taskStore.clearArtifacts(pipeline.taskId, 'plan');

    // Also clear additional revision-related files that should not persist
    const extraFiles = ['qa_feedback.md', 'completion_summary.md', 'human_feedback.md', 'human_feedback_before_bounce.md'];
    for (const f of extraFiles) {
      try { const p = path.join(specPath, f); if (existsSync(p)) unlinkSync(p); } catch { /* best-effort */ }
    }

    // Reset QA attempt counter — the revised spec gets a fresh QA cycle
    pipeline.qaAttempt = 0;
    this._savePipelineState(pipeline);

    try {
      appendFileSync(logFile, `\n[REFINE] Spec concerns detected — auto-revising spec with analyst (revision ${pipeline.specRevision}/3)\n`);
    } catch { /* best-effort */ }
    this.advancePhase(pipeline, 'spec');
    await this.executePhase(pipeline);
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
    this.removeWorktree(taskId);
    this.taskStore.updatePhase(taskId, 'done');
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

  /**
   * Verify the worktree is a valid git worktree (#4).
   * Checks that .git file exists inside the worktree and points to a valid gitdir.
   * Returns true if the worktree is healthy, false if it needs to be recreated.
   *
   * Container mode: the .git file may contain a Linux container path (e.g.
   * /workspaces/…) that doesn't resolve on the Windows host. In that case we
   * extract the worktree name from the path and check the host-side git metadata
   * directory — if it exists the worktree is healthy and _patchWorktreeGitFile
   * will update the pointer before the agent session starts.
   */
  private _isWorktreeHealthy(worktreePath: string): boolean { return isWorktreeHealthy(worktreePath, this.projectRoot); }

  /**
   * Restore qa_report.json from a snapshot if the report was deleted (Gap 4b).
   * Checks both qa_report_before_failed.json (retryTask snapshot) and
   * qa_report_before_bounce.json (mid-pipeline QA→implement bounce snapshot).
   * Uses the first available snapshot. Best-effort — never blocks the pipeline.
   */
  private _restoreQaReportFromSnapshot(specPath: string): void { restoreQaReportFromSnapshot(specPath); }

  /**
   * Restore human_feedback.md from snapshot if the file was deleted (Gap 4b).
   * Only checks human_feedback_before_bounce.md. Best-effort.
   */
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

  // Run a git command either directly on the host or via docker exec inside the container.
  // Any arg that is a subpath of projectRoot is automatically translated to the container path.
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

  /**
   * Rewrite the worktree's .git file and its back-reference to use host-side paths.
   * Needed before running host-side git in the worktree when a prior
   * _patchWorktreeGitFile call may have written container-relative paths that the host
   * cannot resolve (the container workspace path doesn't exist on the host filesystem).
   * Both methods compare current content to expected and are no-ops when already correct.
   *
   * Also rewrites commondir to the relative path '../..' — correct on every OS since
   * .git/worktrees/<name> is always two levels deep inside .git.
   */

  /**
   * Like writeFileSync but works around the Windows security descriptor git
   * places on linked-worktree metadata files (.git, gitdir, commondir).
   * Neither chmodSync nor attrib -R can clear it, but writing to a temp file
   * and atomically renaming over the target bypasses the descriptor.
   */


  private _execGit(args: string[], hostCwd: string): void { execGit(args, hostCwd, this.projectRoot); }

  /**
   * Returns GIT_DIR and GIT_WORK_TREE environment variables for git commands
   * running inside a linked worktree, bypassing the .git pointer file entirely.
   *
   * Looks up the worktree metadata at
   * <projectRoot>/.git/worktrees/<basename(hostCwd)>. Returns {} when that
   * directory does not exist (e.g. hostCwd is the main project root), so
   * standard git path resolution applies for non-worktree invocations.
   *
   * This is safe across all host/container OS combinations: each execution
   * context receives paths in its own format — host paths for host git,
   * container paths (via hostToContainerPath) for docker exec git — so there
   * is never a cross-OS path mismatch.
   *
   * @param hostCwd     Host-side working directory for the git command.
   * @param containerWs Container workspace root. When provided, paths are
   *                    expressed in container form for docker exec use and
   *                    must use POSIX forward slashes.
   */
  private _worktreeGitEnv(hostCwd: string, containerWs?: string): Record<string, string> { return worktreeGitEnv(hostCwd, this.projectRoot, containerWs); }


  /**
   * Rewrite the worktree's .git file and its back-reference so both point to
   * container-relative paths. Compares current file content to the expected value
   * derived from containerWorkspace (runtime value from docker inspect) and is a
   * no-op when already correct — safe to call unconditionally before any docker exec.
   *
   * Also rewrites commondir to the relative path '../..' — correct on every OS since
   * .git/worktrees/<name> is always two levels deep inside .git.
   */
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
      'qa-review': ['qa_report.json', 'qa_feedback.md', 'completion_summary.md'],
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
    const hasSpec = existsSync(path.join(dir, 'spec.md'));
    const hasPlan = existsSync(path.join(dir, 'plan.json'));

    let startPhase: PipelinePhase;
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

  private _writeQaFeedback(pipeline: TaskPipeline, report: QaReport): void { writeQaFeedback(pipeline.specPath, report); }

  private _writeCompletionSummary(pipeline: TaskPipeline): void { writeCompletionSummary(pipeline.specPath, pipeline.qaAttempt, pipeline.taskId, this.taskStore); }

  private _phaseHeader(logFile: string, phase: string): void { phaseHeader(logFile, phase); }

  /**
   * Copy the task's TeamAI artifacts into the worktree and commit them
   * so the PR includes the full story of the implementation (spec, plan,
   * QA report, spec revisions, events timeline, etc.).
   *
   * Throws on failure — the pipeline must not create a PR or merge without
   * artifacts.  The caller (`runTask`) catches and advances to 'failed'.
   */
  private _commitArtifactsToWorktree(pipeline: TaskPipeline): void {
    commitArtifactsToWorktree(pipeline, {
      restoreWorktreeGitFileToHostPaths: hostWorktreePath => this._restoreWorktreeGitFileToHostPaths(hostWorktreePath),
      worktreeGitEnv: (hostCwd, containerWs) => this._worktreeGitEnv(hostCwd, containerWs),
    });
  }

  /**
   * Push a branch to origin, injecting a GitHub OAuth token via http.extraheader
   * when the gh CLI is available. This is the same technique GitHub Actions uses
   * internally — it bypasses the git credential-helper chain entirely, so it works
   * reliably in non-interactive Node.js-spawned processes regardless of how the
   * global ~/.gitconfig credential section is configured.
   *
   * Falls back to a plain git push (relying on whatever credential helper is already
   * registered) when gh is not installed or not authenticated.
   */
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
export { detectGitPlatform, detectDefaultBranch, buildPlatformPrompt } from './git-platform';
