import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, renameSync, rmSync } from 'fs';
import path from 'path';
import { processManager, type AgentSession } from './process-manager';
import { readContainerConfig, containerManager, hostToContainerPath, dockerAvailable, _resetDockerAvailableCache } from './container-manager';
import { TaskStore } from './task-store';
import { slugify } from './utils';
import { runSensors, sensorRunSummary, type SensorsConfig } from './sensors';
import { isWorktreeHealthy, restoreWorktreeGitFileToHostPaths, patchWorktreeGitFile, worktreeGitEnv, execGit } from './orchestrator/worktree-utils';
import { rotateOutputLog, persistAndEmitPhase, savePipelineState, restorePipelineState, pipelineAdvancePhase } from './orchestrator/pipeline-state';
import { writeQaFeedback, writeCompletionSummary } from './orchestrator/qa-feedback';
import { runSpecPhase, runPlanPhase, runMergePhase, runCreatePRPhase } from './orchestrator/phase-runners';
import { parseSessionLimitReset, extractPrUrl, phaseHeader, restoreQaReportFromSnapshot, restoreHumanFeedbackFromSnapshot, getWorktreeBase, computePipelineConfig, buildSessionOpts } from './orchestrator/helpers';
import { cleanStaleSubtaskWorktrees, removeWorktree as removeWorktreeFn, cleanWorktree as cleanWorktreeFn, getWorktreePath as getWorktreePathFn } from './orchestrator/worktree-ops';
import { commitArtifactsToWorktree } from './orchestrator/artifact-commit';
import { gitPush } from './orchestrator/git-push';
import type { PipelinePhase } from '@/constants/phases';

interface PlanSubtask {
  id: number;
  title: string;
  description: string;
  files: string[];
  acceptance_criteria: string[];
  parallel_group?: string;
  completed?: boolean;
  qa_flagged?: boolean;
}

interface RateLimitInfo {
  status: string;
  resetsAt?: number;
}

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


class RateLimitError extends Error {
  constructor(public resetsAt: number) {
    super(`Rate limited until ${new Date(resetsAt * 1000).toISOString()}`);
  }
}

/** Phases where a rate-limited task should NOT auto-resume */
const NO_RESUME_PHASES = new Set(['backlog', 'done', 'failed', 'awaiting-review', 'pr-open']);

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
      taskStore: this.taskStore,
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
      taskStore: this.taskStore,
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
    // Persist phase on disk now that work is actually starting (#5)
    this._persistAndEmitPhase(pipeline);
    // Fail fast if Docker is not available — prevents silent no-op runs where all sessions exit
    // immediately and QA marks the task failed on an empty diff.
    // When container.json explicitly opts in (explicit=true), skip this gate: the user has declared
    // Docker is available. ensureContainer will detect the running container via docker ps label
    // lookup and produce a clear error if Docker truly is not running.
    const containerCfg = readContainerConfig(this.projectRoot);
    if (containerCfg.enabled && !containerCfg.explicit) {
      _resetDockerAvailableCache(); // fresh check every pipeline start (don't use stale cached result)
      if (!dockerAvailable()) {
        throw new Error('Docker is not running. Start Docker Desktop and move the task back to In Progress to retry.');
      }
    }

    // ── Gap 4b: Programmatic guard — restore qa_report.json from snapshot if deleted ──
    this._restoreQaReportFromSnapshot(pipeline.specPath);
    // ── Gap 4b (human_feedback): restore human_feedback.md from snapshot if deleted ──
    // Belt-and-suspenders: the file is deleted after a successful implement bounce-back
    // but may be needed again if the pipeline bounces back a second time.
    this._restoreHumanFeedbackFromSnapshot(pipeline.specPath);

    // Pull latest master before creating the worktree so the feature branch starts
    // from up-to-date code, minimising conflicts at PR time.
    // (runPlan does the same pull; this covers the resume-directly-to-implement path.)
    // Uses _gitPush with 'pull' args so the OAuth token is injected — plain git pull
    // fails silently on machines where HTTPS requires token auth,
    // leaving local master stale and causing avoidable PR conflicts.
    try {
      this._gitPush(['pull', '--ff-only', 'origin', 'master'], path.join(pipeline.specPath, 'output.log'));
    } catch { /* non-fast-forward or offline — proceed with local master */ }

    // Ensure worktree exists and is healthy — may be absent/corrupt when resuming (#4)
    if (!existsSync(pipeline.worktreePath) || !this._isWorktreeHealthy(pipeline.worktreePath)) {
      // Remove broken worktree first if it exists but is unhealthy
      if (existsSync(pipeline.worktreePath)) {
        // ── Gap 5a: Safety guard — never rmSync the project root ──
        if (path.resolve(pipeline.worktreePath) === path.resolve(this.projectRoot)) {
          throw new Error('Refusing to remove worktree at project root — this would destroy the repository');
        }
        try {
          this._execGit(['worktree', 'remove', '--force', pipeline.worktreePath], this.projectRoot);
        } catch { /* best-effort — proceed to recreate */ }
        // If the directory still exists after worktree remove (e.g. metadata was already
        // pruned and git doesn't know about this path), delete it directly so the
        // subsequent worktree add can succeed.
        if (existsSync(pipeline.worktreePath)) {
          try { rmSync(pipeline.worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
          try { execFileSync('git', ['worktree', 'prune'], { cwd: this.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
        }
      }
      try {
        this._execGit(['worktree', 'add', pipeline.worktreePath, '-b', pipeline.branch], this.projectRoot);
      } catch {
        this._execGit(['worktree', 'add', pipeline.worktreePath, pipeline.branch], this.projectRoot);
      }
    }

    // When container mode is enabled, ensure the worktree .git file uses a container-relative
    // gitdir path. If the worktree was created while the container was not running (host git
    // was used), the .git file contains a Windows path the container can't resolve — causing
    // Claude to exit immediately with no output. This is idempotent: no-op if already correct.
    if (readContainerConfig(this.projectRoot).enabled) {
      const earlyLog = path.join(pipeline.specPath, 'output.log');
      const containerInfo = await containerManager.ensureContainer(this.projectRoot, earlyLog);
      this._patchWorktreeGitFile(pipeline.worktreePath, containerInfo.remoteWorkspaceFolder);
    }

    // ── AC9: Crash recovery — clean up stale per-subtask worktrees from previous runs ──
    this._cleanStaleSubtaskWorktrees(pipeline);

    const planPath = path.join(pipeline.specPath, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    const coderRole = 'coder' as AgentSession['role'];

    // Check for QA feedback if bouncing back from QA, and human feedback if bouncing from review
    const qaFeedbackPath = path.join(pipeline.specPath, 'qa_feedback.md');
    const humanFeedbackPath = path.join(pipeline.specPath, 'human_feedback.md');
    const hasQaFeedback = existsSync(qaFeedbackPath);
    const hasHumanFeedback = existsSync(humanFeedbackPath);
    if (hasHumanFeedback) {
      // ── Belt-and-suspenders: snapshot human_feedback if rejectTask didn't create it ──
      const snapshotPath = path.join(pipeline.specPath, 'human_feedback_before_bounce.md');
      if (!existsSync(snapshotPath)) {
        try {
          writeFileSync(snapshotPath, readFileSync(humanFeedbackPath, 'utf-8'));
        } catch { /* best-effort */ }
      }
    }

    // When bouncing back from QA, only re-run subtasks flagged by the QA report.
    // Non-flagged subtasks already passed QA — no need to redo them.
    const subtasksToRun = hasQaFeedback
      ? plan.subtasks.filter((s: PlanSubtask) => s.qa_flagged)
      : plan.subtasks.filter((s: PlanSubtask) => !s.completed);

    // Safety fallback: if QA feedback exists but criterion matching flagged no subtasks,
    // synthesise a targeted rework subtask from qa_feedback.md content rather than
    // re-running all original subtasks. Re-running all subtasks sends the engineer back
    // to stale "add X" descriptions for features that already exist, causing it to mark
    // them complete without making any code changes.
    let effectiveSubtasks: PlanSubtask[];
    if (hasQaFeedback && subtasksToRun.length === 0) {
      const allFiles: string[] = [...new Set<string>(
        plan.subtasks.flatMap((s: PlanSubtask) => s.files ?? [])
      )];
      let qaContent = '';
      try { qaContent = readFileSync(qaFeedbackPath, 'utf-8'); } catch { /* best-effort */ }
      const logFile = path.join(pipeline.specPath, 'output.log');
      appendFileSync(logFile, '\n[QA-FALLBACK] Criterion matching flagged no subtasks — synthesising targeted rework subtask from qa_feedback.md\n');
      effectiveSubtasks = [{
        id: 9999,
        title: 'QA Rework: fix failing criteria (criterion matching found no flagged subtasks)',
        description:
          `QA found failures that could not be automatically mapped to specific plan subtasks. ` +
          `The original plan subtasks are already implemented — do NOT re-read or re-implement them. ` +
          `Instead, read the QA feedback below and fix every listed issue in the codebase.\n\n` +
          `**QA feedback (source of truth):**\n\n${qaContent}`,
        files: allFiles,
        depends_on: [],
        acceptance_criteria: ['All criteria listed in the QA feedback above are satisfied'],
        parallel_group: 'QA-REWORK',
        qa_flagged: true,
        completed: false,
      } as unknown as PlanSubtask];
    } else {
      effectiveSubtasks = subtasksToRun;
    }

    // Guard: if every subtask is already completed and we're not in QA rework,
    // skip implement entirely — advance directly to QA review.
    if (!hasQaFeedback && effectiveSubtasks.length === 0 && plan.subtasks.length > 0) {
      const logFile = path.join(pipeline.specPath, 'output.log');
      appendFileSync(logFile, '\n[SKIP] All subtasks already completed — skipping implement, advancing to QA review\n');
      this.advancePhase(pipeline, 'qa-review');
      await this.executePhase(pipeline);
      return;
    }

    // Reset completed only for subtasks we're about to re-run
    if (hasQaFeedback) {
      for (const s of effectiveSubtasks) {
        s.completed = false;
      }
    }

    const groups = new Map<string, PlanSubtask[]>();
    for (const subtask of effectiveSubtasks) {
      const group = subtask.parallel_group || String(subtask.id);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(subtask);
    }

    const logFile = path.join(pipeline.specPath, 'output.log');
    for (const [, subtasks] of groups) {
      // Track completed subtask IDs in memory to avoid race conditions
      // when multiple subtasks complete near-simultaneously
      const completedIds: number[] = [];

      // ── AC1/AC2: Per-subtask worktree isolation for multi-subtask groups ──
      const isMultiGroup = subtasks.length >= 2;
      const subtaskWorktrees = new Map();
      let containerWorkspace;

      if (isMultiGroup) {
        if (readContainerConfig(this.projectRoot).enabled) {
          const info = containerManager.getRunningContainer(this.projectRoot);
          containerWorkspace = info && info.remoteWorkspaceFolder;
        }

        for (const subtask of subtasks) {
          const stWorktreePath = pipeline.worktreePath + '-st' + subtask.id;
          const stBranch = pipeline.branch + '-st' + subtask.id;

          // Clean up stale worktree from a previous crash
          try {
            this._execGit(['worktree', 'remove', '--force', stWorktreePath], this.projectRoot);
          } catch { /* best-effort */ }
          if (existsSync(stWorktreePath)) {
            try { rmSync(stWorktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
            try { execFileSync('git', ['worktree', 'prune'], { cwd: this.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
          }
          try {
            execFileSync('git', ['branch', '-D', stBranch], { cwd: this.projectRoot, stdio: 'pipe' });
          } catch { /* best-effort */ }

          // AC1: Create worktree from the task branch
          this._execGit(['worktree', 'add', stWorktreePath, '-b', stBranch, pipeline.branch], this.projectRoot);

          // AC7: Container mode - patch .git file
          if (containerWorkspace) {
            this._patchWorktreeGitFile(stWorktreePath, containerWorkspace);
          }

          subtaskWorktrees.set(subtask.id, stWorktreePath);
          appendFileSync(logFile, '\n[WORKTREE] Created isolated worktree for subtask ' + subtask.id + ' at ' + stWorktreePath + '\n');
        }
      }

      try {
        const results = await Promise.allSettled(
          subtasks.map(async (subtask) => {
            this._phaseHeader(logFile, 'implement — subtask ' + subtask.id + ': ' + subtask.title);
            const cwd = isMultiGroup ? subtaskWorktrees.get(subtask.id) : pipeline.worktreePath;
            // ── Sensor: pre_subtask hook ──
            try {
              const pipelineConfig = this.getPipelineConfig();
              if (pipelineConfig.sensors?.pre_subtask?.length) {
                const preResult = await runSensors(pipelineConfig.sensors.pre_subtask, 'pre_subtask', {
                  cwd,
                  specPath: pipeline.specPath,
                  files: subtask.files || [],
                  subtaskId: subtask.id,
                  logFile,
                });
                if (!preResult.allPassed) {
                  appendFileSync(logFile, sensorRunSummary(preResult));
                }
              }
            } catch (preSensorErr) {
              // pre_subtask failures are warnings — they don't block the session
              const msg = preSensorErr instanceof Error ? preSensorErr.message : String(preSensorErr);
              appendFileSync(logFile, '\n[SENSOR:pre_subtask] pre-subtask sensors failed (non-blocking): ' + msg + '\n');
            }

            let sessionId;
            try {
              sessionId = await processManager.createSession(this.sessionOpts(coderRole, cwd, pipeline.taskId, logFile));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              appendFileSync(logFile, '\n[ERROR] Session creation failed: ' + msg + '\n');
              throw err;
            }

            const qaOnlyCriteria = hasQaFeedback
              ? subtask.acceptance_criteria.filter(
                  ac => ac.includes('[QA CORRECTION') || ac.includes('[QA ISSUE')
                )
              : subtask.acceptance_criteria;
            const criteriaLine = hasQaFeedback
              ? (qaOnlyCriteria.length > 0
                  ? 'QA issues to fix: ' + qaOnlyCriteria.join('; ')
                  : 'No specific QA criteria for this subtask — see the QA feedback above for issues to address.')
              : 'Acceptance criteria: ' + subtask.acceptance_criteria.join('; ');

            const subtaskFeedback = (() => {
              if (!hasQaFeedback) return '';
              const lines = [];
              lines.push('## ⚠️ QA FEEDBACK — FIX THESE FIRST ⚠️');
              lines.push('');
              try {
                const reportPath = path.join(pipeline.specPath, 'qa_report.json');
                if (existsSync(reportPath)) {
                  const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
                  if (report.overall) lines.push('Overall: **' + report.overall + '**');
                }
              } catch { /* best-effort */ }
              if (qaOnlyCriteria.length > 0) {
                lines.push('');
                lines.push('Issues in subtask ' + subtask.id + ' **' + subtask.title + '**:');
                for (const c of qaOnlyCriteria) {
                  const cleaned = c
                    .replace(/\s*\[QA CORRECTION:\s*/g, '[BLOCKER] ')
                    .replace(/\s*\[QA ISSUE\s*\((\w*)\):\s*/g, '[$1] ')
                    .replace(/\]$/, '');
                  lines.push('- ' + cleaned);
                }
              }
              if (hasHumanFeedback) {
                try {
                  const hf = readFileSync(humanFeedbackPath, 'utf-8');
                  lines.push('');
                  lines.push('---');
                  lines.push('');
                  lines.push(hf);
                } catch { /* best-effort */ }
              }
              lines.push('');
              return lines.join('\n');
            })();

            const prompt =
              (subtaskFeedback
                ? subtaskFeedback + '\n---\n'
                : '') +
              '/implement Subtask ' + subtask.id + ': ' + subtask.title + '\n\n' +
              subtask.description + '\n\n' +
              'Files: ' + subtask.files.join(', ') + '\n\n' +
              criteriaLine + '\n' +
              'PROJECT_ROOT=' + this.projectRoot + '\n\n' +
              (hasQaFeedback
                ? '⚠️ Only fix the QA issues listed above. Do NOT re-validate criteria that QA already passed.\n' +
                  'After fixing all issues, run the FULL test suite to verify no regressions.\n'
                : '');
            processManager.sendMessage(sessionId, prompt);
            await this.waitForCompletion(sessionId);
            processManager.killSession(sessionId);

            // ── Sensor: post_subtask hook ──
            try {
              const pipelineConfig = this.getPipelineConfig();
              if (pipelineConfig.sensors?.post_subtask?.length) {
                const postResult = await runSensors(pipelineConfig.sensors.post_subtask, 'post_subtask', {
                  cwd,
                  specPath: pipeline.specPath,
                  files: subtask.files || [],
                  subtaskId: subtask.id,
                  logFile,
                });
                appendFileSync(logFile, sensorRunSummary(postResult));
                if (!postResult.allPassed) {
                  // Write sensor failures to sensor_report.json (separate from QA's qa_report.json)
                  const sensorReportPath = path.join(pipeline.specPath, `sensor_report-st${subtask.id}.json`);
                  const failMsg = postResult.reports.filter(r => !r.passed).map(r => r.sensor + ': ' + (r.error || 'exit ' + r.exitCode)).join('; ');
                  const failures = postResult.reports.filter(r => !r.passed).map(r => ({
                    subtask: subtask.title,
                    sensor: r.sensor,
                    error: r.error || `exit code ${r.exitCode}`,
                    fix_needed: `Fix sensor failures: ${failMsg}. Run the sensor locally to reproduce.`,
                  }));
                  const sensorReport = { failures, overall: 'FAIL' };
                  writeFileSync(sensorReportPath, JSON.stringify(sensorReport, null, 2));
                }
              }
            } catch (postSensorErr) {
              const msg = postSensorErr instanceof Error ? postSensorErr.message : String(postSensorErr);
              appendFileSync(logFile, '\n[SENSOR:post_subtask] post-subtask sensors error: ' + msg + '\n');
            }

            completedIds.push(subtask.id);
            this._planWriteLock = this._planWriteLock.then(() => {
              try {
                const cpPlanPath = path.join(pipeline.specPath, 'plan.json');
                if (!existsSync(cpPlanPath)) return;
                const cpPlan = JSON.parse(readFileSync(cpPlanPath, 'utf-8'));
                if (cpPlan.subtasks) {
                  for (const s of cpPlan.subtasks) {
                    if (completedIds.includes(s.id)) {
                      s.completed = true;
                    }
                  }
                }
                const tmpPath = cpPlanPath + '.tmp';
                writeFileSync(tmpPath, JSON.stringify(cpPlan, null, 2));
                renameSync(tmpPath, cpPlanPath);
              } catch { /* best-effort checkpoint */ }
            });
          })
        );

        if (results.every(r => r.status === 'rejected')) {
          const firstReason = results[0].reason;
          throw firstReason instanceof Error ? firstReason : new Error(String(firstReason));
        }

        // ── AC4/AC5: Cherry-pick successful commits back to main worktree ──
        if (isMultiGroup) {
          for (let i = 0; i < results.length; i++) {
            if (results[i].status !== 'fulfilled') continue;
            const stBranch = pipeline.branch + '-st' + subtasks[i].id;
            const range = pipeline.branch + '..' + stBranch;
            try {
              appendFileSync(logFile, '\n[WORKTREE] Cherry-picking commits from ' + stBranch + ' onto ' + pipeline.branch + '\n');
              this._execGit(['cherry-pick', range], pipeline.worktreePath);
              appendFileSync(logFile, '[WORKTREE] Cherry-pick succeeded for subtask ' + subtasks[i].id + '\n');
            } catch (cherryErr) {
              const cherryMsg = cherryErr instanceof Error ? cherryErr.message : String(cherryErr);
              try { this._execGit(['cherry-pick', '--abort'], pipeline.worktreePath); } catch { /* best-effort */ }
              appendFileSync(logFile, '[WORKTREE] Cherry-pick FAILED for subtask ' + subtasks[i].id + ': ' + cherryMsg + '\n');
              throw new Error('Cherry-pick conflict for subtask ' + subtasks[i].id + ' — overlapping file changes detected. The planner should have prevented this.\n' + cherryMsg);
            }
          }
        }

        if (completedIds.length > 0) {
          this._planWriteLock = this._planWriteLock.then(() => {
            const planPath = path.join(pipeline.specPath, 'plan.json');
            try {
              const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
              if (plan.subtasks) {
                for (const s of plan.subtasks) {
                  if (completedIds.includes(s.id)) {
                    s.completed = true;
                  }
                }
              }
              writeFileSync(planPath, JSON.stringify(plan, null, 2));
            } catch { /* best-effort */ }
          });
        }
      } finally {
        // ── AC6: Clean up per-subtask worktrees ──
        if (isMultiGroup) {
          for (const stWorktreePath of subtaskWorktrees.values()) {
            try {
              this._execGit(['worktree', 'remove', '--force', stWorktreePath], this.projectRoot);
            } catch {
              try { rmSync(stWorktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
              try { execFileSync('git', ['worktree', 'prune'], { cwd: this.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
            }
          }
          for (const subtask of subtasks) {
            try {
              execFileSync('git', ['branch', '-D', pipeline.branch + '-st' + subtask.id], { cwd: this.projectRoot, stdio: 'pipe' });
            } catch { /* best-effort */ }
          }
          appendFileSync(logFile, '\n[WORKTREE] Cleaned up ' + subtaskWorktrees.size + ' per-subtask worktree(s)\n');
        }
      }
    }

    // Clean up QA feedback after implementing
    if (hasQaFeedback && existsSync(qaFeedbackPath)) {
      unlinkSync(qaFeedbackPath);
    }
    if (hasHumanFeedback && existsSync(humanFeedbackPath)) {
      unlinkSync(humanFeedbackPath);
    }
    // Clean up qa_flagged markers — they're only relevant during bounce-back
    if (hasQaFeedback) {
      try {
        const planAfter = JSON.parse(readFileSync(planPath, 'utf-8'));
        let cleaned = false;
        if (planAfter.subtasks) {
          for (const s of planAfter.subtasks) {
            if (s.qa_flagged) {
              delete s.qa_flagged;
              cleaned = true;
            }
          }
        }
        if (cleaned) writeFileSync(planPath, JSON.stringify(planAfter, null, 2));
      } catch { /* best-effort */ }
    }

    // ── Gap 2: Mandatory git push before advancing to QA ──
    // Always push from the host, never from the container — host credentials
    // (Windows Credential Manager / gh CLI) are reliable; container HTTPS
    // credentials are not. GIT_TERMINAL_PROMPT=0 prevents git from trying to open
    // /dev/tty for interactive credential prompting, which fails when spawned by
    // Node.js (no TTY available). If credentials aren't cached the push fails fast
    // with a clear error rather than hanging.
    this._phaseHeader(logFile, 'implement — push to remote');
    try {
      // Use --force for recovery scenarios (crash recovery, QA bounce-back, re-run).
      // --force-with-lease rejects pushes when the local remote-tracking ref is stale
      // (e.g. worktree recreated without fetching), which breaks automated pipelines.
      // --force is safe here: orchestrator is the sole writer to these feat/ branches.
      this._gitPush(['push', '-u', '--force', 'origin', pipeline.branch], logFile);
      appendFileSync(logFile, `[PUSH] Successfully pushed ${pipeline.branch} to origin\n`);

      // Verify remote HEAD matches local HEAD.
      // No separate fetch needed — a successful push already updates the local
      // remote-tracking ref (refs/remotes/origin/<branch>) to match what was pushed.
      // Fetching again would require auth and adds no signal when push returned success.
      try {
        const localHead = execFileSync('git', ['rev-parse', pipeline.branch], {
          cwd: this.projectRoot, encoding: 'utf-8', stdio: 'pipe',
        }).trim();
        const remoteHead = execFileSync('git', ['rev-parse', `origin/${pipeline.branch}`], {
          cwd: this.projectRoot, encoding: 'utf-8', stdio: 'pipe',
        }).trim();
        if (localHead !== remoteHead) {
          throw new Error(`Push succeeded but HEADs differ — local=${localHead} remote=${remoteHead}`);
        }
        appendFileSync(logFile, '[PUSH] Verified remote HEAD matches local HEAD\n');
      } catch (verifyErr) {
        const verifyMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
        appendFileSync(logFile, `[PUSH] Remote verification failed: ${verifyMsg}\n`);
        throw verifyErr;
      }
    } catch (pushErr) {
      const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
      appendFileSync(logFile, `[PUSH] Push failed: ${pushMsg}\n`);
      appendFileSync(logFile, '[PUSH] Task cannot advance — engineer must be able to push before QA can verify\n');
      // Write a failure report so the reason is visible
      const reportPath = path.join(pipeline.specPath, 'qa_report.json');
      const failReport: QaReport = {
        overall: 'FAIL',
        criteria: [{
          criterion: 'Git push verification',
          name: 'Git push verification',
          status: 'FAIL',
          notes: `Git push failed: ${pushMsg}. The engineer must be able to push commits before QA can verify.`,
        }],
      };
      writeFileSync(reportPath, JSON.stringify(failReport, null, 2));
      this.advancePhase(pipeline, 'failed');
      return;
    }

    // ── Sensor gate: check per-subtask sensor reports before advancing to QA ──
    // Each subtask writes sensor_report-st{id}.json (no race: per-subtask filename)
    const allSensorFailures: { subtask: string; sensor: string; error: string; fix_needed: string }[] = [];
    if (existsSync(planPath)) {
      try {
        const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
        for (const s of (plan.subtasks || [])) {
          const srPath = path.join(pipeline.specPath, `sensor_report-st${s.id}.json`);
          if (existsSync(srPath)) {
            try {
              const report = JSON.parse(readFileSync(srPath, 'utf-8'));
              if (report.failures) allSensorFailures.push(...report.failures);
            } catch { /* best-effort */ }
            try { unlinkSync(srPath); } catch { /* best-effort */ }
          }
        }
      } catch { /* best-effort */ }
    }
    if (allSensorFailures.length > 0) {
      appendFileSync(logFile, `\n[SENSOR-GATE] post_subtask sensors failed (${allSensorFailures.length} failure(s)) — bouncing to implement for sensor fixes\n`);
      this._writeQaFeedback(pipeline, {
        overall: 'FAIL',
        fail_type: 'cleanup',
        criteria: allSensorFailures.map(f => ({
          name: `Sensor: ${f.subtask} — ${f.sensor}`,
          criterion: `Sensor: ${f.subtask} — ${f.sensor}`,
          status: 'FAIL' as const,
          notes: f.error,
          fix_needed: f.fix_needed,
        })),
      });
      this.advancePhase(pipeline, 'implement');
      this._savePipelineState(pipeline);
      await this.executePhase(pipeline);
      return;
    }

    this.advancePhase(pipeline, 'qa-review');
    await this.executePhase(pipeline);
  }

  private async runQaReview(pipeline: TaskPipeline): Promise<void> {
    // Persist phase on disk now that work is actually starting (#5)
    this._persistAndEmitPhase(pipeline);
    pipeline.qaAttempt++;
    this._savePipelineState(pipeline); // persist incremented qaAttempt so crash recovery doesn't lose it
    const logFile = path.join(pipeline.specPath, 'output.log');
    this._phaseHeader(logFile, `qa-review (attempt ${pipeline.qaAttempt})`);

    // ── Gap 3: Respect locked QA reports (manual human overrides) ──
    const reportPath = path.join(pipeline.specPath, 'qa_report.json');
    if (existsSync(reportPath)) {
      try {
        const existingReport = JSON.parse(readFileSync(reportPath, 'utf-8'));
        if (existingReport.locked === true) {
          appendFileSync(logFile, '\n[INFO] qa_report.json is locked — skipping QA review\n');
          this.advancePhase(pipeline, 'awaiting-review');
          return;
        }
        // Detect human override: "reviewedBy" text containing "manual override"
        if (existingReport.reviewedBy && typeof existingReport.reviewedBy === 'string' &&
            existingReport.reviewedBy.toLowerCase().includes('manual override')) {
          appendFileSync(logFile, '\n[INFO] qa_report.json has manual override — skipping QA review\n');
          this.advancePhase(pipeline, 'awaiting-review');
          return;
        }
      } catch { /* malformed JSON — proceed with fresh QA review */ }
    }

    // ── Gap 1: Verify worktree state matches remote branch ──
    // If there are unpushed commits, QA would review local state that differs
    // from what reviewers see on the remote branch. Push them or fail early.
    try {
      execFileSync('git', ['fetch', 'origin', pipeline.branch], { cwd: this.projectRoot, stdio: 'pipe' });
    } catch { /* branch doesn't exist on remote yet — that's ok */ }

    let hasUnpushed = false;
    try {
      // Use the main repo with branch refs to check unpushed commits — worktree
      // branch refs may not be fully synced with origin in container mode.
      const unpushed = execFileSync('git', ['log', `origin/${pipeline.branch}..${pipeline.branch}`, '--oneline'], {
        cwd: this.projectRoot, encoding: 'utf-8', stdio: 'pipe',
      }).trim();
      hasUnpushed = unpushed.length > 0;
      if (hasUnpushed) {
        appendFileSync(logFile, `\n[QA-PRECHECK] Unpushed commits detected on ${pipeline.branch}:\n${unpushed}\n`);
        // Attempt to push them automatically
        try {
          this._gitPush(['push', 'origin', pipeline.branch], logFile);
          appendFileSync(logFile, '[QA-PRECHECK] Pushed unpushed commits successfully — remote matches worktree\n');
          hasUnpushed = false;
        } catch (pushErr) {
          const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
          appendFileSync(logFile, `[QA-PRECHECK] Auto-push failed: ${pushMsg}\n`);
        }
      }
    } catch { /* branch doesn't exist on remote — no unpushed check needed */ }

    if (hasUnpushed) {
      // Write a FAIL report and bail out — engineer must push before QA can verify
      const failReport: QaReport = {
        overall: 'FAIL',
        criteria: [{
          criterion: 'Unpushed commits',
          name: 'Unpushed commits',
          status: 'FAIL',
          notes: 'Unpushed commits detected — engineer must push before QA can verify. ' +
            'The worktree has local commits not present on the remote branch, ' +
            'so QA cannot verify the same code that reviewers will see.',
        }],
      };
      writeFileSync(reportPath, JSON.stringify(failReport, null, 2));
      appendFileSync(logFile, '[QA-PRECHECK] FAIL — unpushed commits detected, engineer must push first\n');

      if (pipeline.qaAttempt >= pipeline.maxQaAttempts) {
        this._writeCompletionSummary(pipeline);
        this.advancePhase(pipeline, 'failed');
      } else {
        // ── Gap 5b: Snapshot qa_report.json before bouncing back ──
        // Preserve the QA report context so it can be restored if deleted
        // during the implement phase (engineer accidentally deletes it, etc.)
        if (existsSync(reportPath)) {
          try {
            const bounceSnapshot = path.join(pipeline.specPath, 'qa_report_before_bounce.json');
            writeFileSync(bounceSnapshot, readFileSync(reportPath, 'utf-8'));
          } catch { /* best-effort */ }
        }
        this._writeQaFeedback(pipeline, failReport);
        this.advancePhase(pipeline, 'implement');
        this._savePipelineState(pipeline);
        await this.executePhase(pipeline);
      }
      return;
    }

    // Fetch latest origin/master so the QA agent's git diff is compared against the
    // actual current remote baseline, not a stale local cache.
    try {
      execFileSync('git', ['fetch', 'origin', 'master'], { cwd: this.projectRoot, stdio: 'pipe' });
    } catch { /* offline or unreachable — QA proceeds with cached refs */ }

    const sessionId = await processManager.createSession(this.sessionOpts('qa-reviewer', pipeline.worktreePath, pipeline.taskId, logFile));
    pipeline.sessionId = sessionId;
    const agentSpecPath = this._toAgentPath(pipeline.specPath);
    processManager.sendMessage(sessionId,
      `/qa-review ${agentSpecPath}/spec.md\n\n` +
      `IMPORTANT: Write the QA report to \`${agentSpecPath}/qa_report.json\` (use this exact absolute path, not a relative path).\n` +
      `The working directory is a git worktree — do NOT write to a .teamai/ subdirectory relative to the current directory.`);
    // ── Improvement 6: Session budget cap — timeout after 20 minutes ──
    const QA_TIMEOUT_MS = 20 * 60 * 1000; // 20 minutes
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error('QA session timed out after 20 minutes')), QA_TIMEOUT_MS)
    );
    try {
      await Promise.race([this.waitForCompletion(sessionId), timeoutPromise]);
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      processManager.killSession(sessionId);
      const timeoutReport: QaReport = {
        overall: 'FAIL',
        criteria: [{
          criterion: 'QA session timeout',
          name: 'QA session timeout',
          status: 'FAIL',
          notes: 'QA agent did not complete within 20 minutes — session was killed. Re-run QA.',
        }],
      };
      writeFileSync(reportPath, JSON.stringify(timeoutReport, null, 2));
      appendFileSync(logFile, `\n[QA-TIMEOUT] ${err instanceof Error ? err.message : String(err)}\n`);
      // Bounce back to QA-review on next attempt (don't bounce to implement — no code change needed)
      if (pipeline.qaAttempt >= pipeline.maxQaAttempts) {
        this._writeCompletionSummary(pipeline);
        this.advancePhase(pipeline, 'failed');
      } else {
        this.advancePhase(pipeline, 'qa-review');
        this._savePipelineState(pipeline);
        await this.executePhase(pipeline);
      }
      return;
    }
    processManager.killSession(sessionId);

    const report: QaReport = JSON.parse(readFileSync(reportPath, 'utf-8'));

    // Stamp the HEAD sha so rework passes can delta-scope their review
    try {
      const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: pipeline.worktreePath, encoding: 'utf-8', stdio: 'pipe'
      }).trim();
      report.head_at_review = headSha;
      writeFileSync(reportPath, JSON.stringify(report, null, 2));
    } catch { /* best-effort — QA proceeds without sha stamp if git fails */ }

    // When spec concerns exist, go to human review regardless of overall verdict.
    // The spec itself needs changes — the reviewer decides whether to revise the spec
    // or bounce back to implement with the standard QA feedback.
    const hasSpecConcerns = report.spec_concerns && Array.isArray(report.spec_concerns) && report.spec_concerns.length > 0;

    if (hasSpecConcerns) {
      // Auto-revise the spec via the analyst instead of pausing for human review.
      // The analyst reads the revision feedback, fixes the spec, then the pipeline
      // proceeds normally through plan → implement → qa-review.
      await this._autoReviseSpec(pipeline);
      return;
    } else if (report.overall === 'PASS') {
      this.advancePhase(pipeline, 'awaiting-review');
    } else if (pipeline.qaAttempt >= pipeline.maxQaAttempts) {
      // Write completion summary before marking as failed
      this._writeCompletionSummary(pipeline);
      this.advancePhase(pipeline, 'failed');
    } else {
      // ── Gap 5b: Snapshot qa_report.json before bouncing back ──
      // Preserve the QA report context so it can be restored if deleted
      // during the implement phase (engineer accidentally deletes it, etc.)
      try {
        const bounceSnapshot = path.join(pipeline.specPath, 'qa_report_before_bounce.json');
        writeFileSync(bounceSnapshot, readFileSync(reportPath, 'utf-8'));
      } catch { /* best-effort */ }

      // ── Improvement 4: FAIL-type router — handle cleanup FAILs with lightweight coder session ──
      if (report.fail_type === 'cleanup') {
        appendFileSync(logFile, '\n[QA-ROUTER] fail_type=cleanup — routing to implement for automated mechanical fix\n');
        // Log the fix_needed fields so the user can see what was required
        const failCriteria = report.criteria?.filter(c => c.status === 'FAIL') || [];
        for (const c of failCriteria) {
          appendFileSync(logFile, `[QA-ROUTER] Cleanup required: ${c.fix_needed || c.notes || c.criterion}\n`);
        }
        appendFileSync(logFile, '[QA-ROUTER] Cleanup fix is automated — executing via implement cleanup-only rework mode (no spec re-read, no test suite)\n');
      }

      // Write QA feedback and bounce back to implement instead of auto-fixing
      this._writeQaFeedback(pipeline, report);
      this.advancePhase(pipeline, 'implement');
      // Save state before bouncing back — if a crash happens during the implement cascade,
      // the resumed pipeline will still have the correct qaAttempt and mergeStrategy.
      this._savePipelineState(pipeline);
      await this.executePhase(pipeline);
    }
  }

  private async runMerge(pipeline: TaskPipeline): Promise<void> {
    await runMergePhase(pipeline, {
      projectRoot: this.projectRoot,
      taskStore: this.taskStore,
      rotateOutputLog: logFile => this._rotateOutputLog(logFile),
      phaseHeader: (logFile, phase) => this._phaseHeader(logFile, phase),
      persistAndEmitPhase: p => this._persistAndEmitPhase(p),
      savePipelineState: p => this._savePipelineState(p),
      sessionOpts: (role, cwd, taskId, logFile) => this.sessionOpts(role, cwd, taskId, logFile),
      toAgentPath: hostPath => this._toAgentPath(hostPath),
      waitForCompletion: sessionId => this.waitForCompletion(sessionId),
      advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
      executePhase: p => this.executePhase(p),
      commitArtifactsToWorktree: p => this._commitArtifactsToWorktree(p),
      getPipelineConfig: () => this.getPipelineConfig(),
      removeWorktree: taskId => this.removeWorktree(taskId),
    });
  }

  private async runCreatePR(pipeline: TaskPipeline): Promise<void> {
    await runCreatePRPhase(pipeline, {
      projectRoot: this.projectRoot,
      taskStore: this.taskStore,
      rotateOutputLog: logFile => this._rotateOutputLog(logFile),
      phaseHeader: (logFile, phase) => this._phaseHeader(logFile, phase),
      persistAndEmitPhase: p => this._persistAndEmitPhase(p),
      savePipelineState: p => this._savePipelineState(p),
      sessionOpts: (role, cwd, taskId, logFile) => this.sessionOpts(role, cwd, taskId, logFile),
      toAgentPath: hostPath => this._toAgentPath(hostPath),
      waitForCompletion: sessionId => this.waitForCompletion(sessionId),
      advancePhase: (p, phase, eventExtra) => this.advancePhase(p, phase, eventExtra),
      executePhase: p => this.executePhase(p),
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
  // per-subtask checkpointing in runImplement (#2).
  private _planWriteLock: Promise<void> = Promise.resolve();

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

  // Parse "resets 4:30pm (UTC)" from Claude Code's session-limit message.
  // Returns a Unix timestamp (seconds) for the reset time, or null if unparseable.
  private _parseSessionLimitReset(line: string): number | null { return parseSessionLimitReset(line); }

  private waitForCompletion(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let rateLimitResetsAt: number | null = null;
      // Tracks Claude Code's per-session usage limit (distinct from API rate limits).
      // When hit, the session exits cleanly with code 0 and result.is_error=false, so
      // the orchestrator would incorrectly treat it as success. Detecting it here lets
      // handleRateLimit pause and retry the task after the usage window resets.
      let sessionLimitResetsAt: number | null = null;

      const cleanup = () => {
        processManager.off('event', onEvent);
        processManager.off('exit', onExit);
        processManager.off('raw', onRaw);
      };

      // Claude Code prints "You've hit your session limit · resets H:MMam (UTC)" as
      // plain text (not JSON) before emitting a clean result event. Capture it here.
      const onRaw = ({ sessionId: sid, data }: { sessionId: string; data: string }) => {
        if (sid !== sessionId) return;
        if (/session.?limit/i.test(data)) {
          sessionLimitResetsAt = this._parseSessionLimitReset(data) ?? Math.floor(Date.now() / 1000) + 3600;
        }
      };

      const onEvent = ({ sessionId: sid, event }: { sessionId: string; event: Record<string, unknown> }) => {
        if (sid !== sessionId) return;

        // Capture rate-limit reset time if the limit is hit
        if (event.type === 'rate_limit_event' && event.rate_limit_info) {
          const info = event.rate_limit_info as RateLimitInfo;
          if (info.status !== 'allowed' && info.resetsAt) {
            rateLimitResetsAt = info.resetsAt as number;
          }
        }

        if (event.type === 'result') {
          cleanup();
          // Session limit takes priority: exit is clean (is_error=false) but no work was done
          if (sessionLimitResetsAt) {
            reject(new RateLimitError(sessionLimitResetsAt));
          } else if (event.is_error && rateLimitResetsAt) {
            reject(new RateLimitError(rateLimitResetsAt));
          } else {
            resolve();
          }
        }
      };
      const onExit = ({ sessionId: sid, code }: { sessionId: string; code: number | null }) => {
        if (sid !== sessionId) return;
        cleanup();
        if (sessionLimitResetsAt) reject(new RateLimitError(sessionLimitResetsAt));
        else if (code === 0 || code === null) resolve();
        else if (rateLimitResetsAt) reject(new RateLimitError(rateLimitResetsAt));
        else reject(new Error(`Session exited with code ${code}`));
      };

      processManager.on('event', onEvent);
      processManager.on('exit', onExit);
      processManager.on('raw', onRaw);
    });
  }

  private handleRateLimit(pipeline: TaskPipeline, resetsAt: number): void {
    const resetsAtMs = resetsAt * 1000;
    const MAX_DELAY_MS = 2_147_483_647; // 32-bit signed int max (~24.8 days)
    const rawWaitMs = Math.max(resetsAtMs - Date.now(), 0);
    const waitMs = Math.min(rawWaitMs, MAX_DELAY_MS);
    const resetsAtISO = new Date(resetsAtMs).toISOString();

    this.taskStore.update(pipeline.taskId, { rateLimitedUntil: resetsAtISO });

    // Re-acquire the lock that was released in runTask's finally block
    // so no other caller can start this task while we wait for the rate limit.
    this.activeTasks.add(pipeline.taskId);
    this.pipelines.set(pipeline.taskId, pipeline);

    // Broadcast so the UI can show the countdown
    processManager.emit('phase-change', {
      taskId: pipeline.taskId,
      phase: pipeline.phase,
      projectRoot: this.projectRoot,
      rateLimitedUntil: resetsAtISO,
    });

    const mins = Math.ceil(waitMs / 60000);
    console.log(`[rate-limit] Task ${pipeline.taskId} paused for ~${mins}min. Resuming at ${resetsAtISO}`);

    setTimeout(async () => {
      // Before resuming, check if the task was manually moved to a terminal phase
      // (e.g. user dragged it to backlog to pause it). Respect the user's intent.
      const task = this.taskStore.getById(pipeline.taskId);
      if (!task || NO_RESUME_PHASES.has(task.phase)) {
        console.log(`[rate-limit] Task ${pipeline.taskId} is in terminal phase "${task?.phase}" — skipping resume`);
        this.taskStore.update(pipeline.taskId, { rateLimitedUntil: undefined });
        this.pipelines.delete(pipeline.taskId);
        this.activeTasks.delete(pipeline.taskId);
        return;
      }

      // Before resuming, verify the pipeline object hasn't been replaced
      // (e.g. user stopped and restarted the task while waiting). A different
      // pipeline object means a new run is active — skip this stale one.
      const currentPipeline = this.pipelines.get(pipeline.taskId);
      if (currentPipeline !== pipeline) {
        console.log(`[rate-limit] Task ${pipeline.taskId} pipeline was replaced — skipping stale resume`);
        this.taskStore.update(pipeline.taskId, { rateLimitedUntil: undefined });
        return;
      }

      console.log(`[rate-limit] Resuming task ${pipeline.taskId}`);
      this.taskStore.update(pipeline.taskId, { rateLimitedUntil: undefined });
      let wasRateLimited = false;
      try {
        await this.executePhase(pipeline);
      } catch (e) {
        if (e instanceof RateLimitError) {
          wasRateLimited = true;
          this.handleRateLimit(pipeline, e.resetsAt);
        } else {
          const errMsg = e instanceof Error ? `${e.message}\n${e.stack ?? ''}` : String(e);
          appendFileSync(path.join(pipeline.specPath, 'output.log'), `\n[ERROR] Task failed after rate-limit retry: ${errMsg}\n`);
          console.error(`[orchestrator] Task ${pipeline.taskId} failed after rate-limit retry:`, e);
          this.advancePhase(pipeline, 'failed');
        }
      } finally {
        // Clean up after rate-limit retry completes or fails permanently.
        // When rate-limited again, handleRateLimit re-acquires the lock.
        if (!wasRateLimited) {
          this.pipelines.delete(pipeline.taskId);
          this.activeTasks.delete(pipeline.taskId);
        }
      }
    }, waitMs);
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
