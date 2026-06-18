import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, renameSync, statSync, rmSync } from 'fs';
import path from 'path';
import { warn as logWarn } from './logger';
import { processManager, type AgentSession } from './process-manager';
import { readContainerConfig, readContainerRemoteUser, containerManager, hostToContainerPath, dockerAvailable, _resetDockerAvailableCache } from './container-manager';
import { TaskStore } from './task-store';
import { resolveProvider, providerToSessionOpts } from './providers';
import { slugify } from './utils';
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

  private getPipelineConfig(): { maxQaAttempts: number; parallelSubtasks: boolean } {
    const cfgPath = path.join(this.projectRoot, '.teamai', 'pipeline.json');
    if (existsSync(cfgPath)) {
      try { return JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch (err) { logWarn('orchestrator', 'Failed to parse pipeline config, using defaults', err); }
    }
    return { maxQaAttempts: 3, parallelSubtasks: true };
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
      processManager.emit('phase-change', { taskId, phase: targetPhase });
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
    const logFile = path.join(pipeline.specPath, 'output.log');
    this._rotateOutputLog(logFile);
    this._phaseHeader(logFile, 'spec');
    // Phase committed only AFTER execution actually starts
    this._persistAndEmitPhase(pipeline);
    const sessionId = await processManager.createSession(this.sessionOpts('analyst', this.projectRoot, pipeline.taskId, logFile));
    pipeline.sessionId = sessionId;
    this._savePipelineState(pipeline);
    // Pass the explicit output path so the agent writes spec.md to the task's directory,
    // not a new directory derived from the description slug.
    const agentSpecPath = this._toAgentPath(pipeline.specPath);

    // Check for revision mode — spec_revision_feedback.md is written by reviseSpec()
    const revisionFeedbackPath = path.join(pipeline.specPath, 'spec_revision_feedback.md');
    const isRevision = existsSync(revisionFeedbackPath);

    if (isRevision) {
      processManager.sendMessage(sessionId,
        `REVISION: ${pipeline.description}\n\n` +
        `Read the existing spec at: \`${agentSpecPath}/spec.md\`\n` +
        `Read the spec revision feedback at: \`${agentSpecPath}/spec_revision_feedback.md\`\n` +
        `Revise the spec to address ALL concerns in the feedback.\n` +
        `Preserve parts of the spec that are still valid — only change what the feedback asks for.\n` +
        `IMPORTANT: Write the revised spec to \`${agentSpecPath}/spec.md\` (overwrite the existing file).`);
    } else {
      processManager.sendMessage(sessionId,
        `/spec ${pipeline.description}\n\nIMPORTANT: Write the spec file to \`${agentSpecPath}/spec.md\` (use this exact path, not a new subdirectory).`);
    }
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);
    // Clean up revision feedback after spec revision is complete
    if (isRevision && existsSync(revisionFeedbackPath)) {
      unlinkSync(revisionFeedbackPath);
    }
    this.advancePhase(pipeline, 'plan');
    await this.executePhase(pipeline);
  }

  private async runPlan(pipeline: TaskPipeline): Promise<void> {
    const logFile = path.join(pipeline.specPath, 'output.log');
    this._rotateOutputLog(logFile);
    this._phaseHeader(logFile, 'plan');
    // Phase committed only AFTER execution actually starts
    this._persistAndEmitPhase(pipeline);
    const sessionId = await processManager.createSession(this.sessionOpts('planner', this.projectRoot, pipeline.taskId, logFile));
    pipeline.sessionId = sessionId;
    this._savePipelineState(pipeline);
    processManager.sendMessage(sessionId, `/plan ${this._toAgentPath(pipeline.specPath)}/spec.md`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    // Pull latest master from remote before branching so the feature branch starts
    // from up-to-date code, minimising conflicts at PR time.
    // Uses _gitPush with 'pull' args so the OAuth token is injected — same reason
    // as the identical pull in runImplement (see comment there).
    try {
      this._gitPush(['pull', '--ff-only', 'origin', 'master'], path.join(pipeline.specPath, 'output.log'));
    } catch { /* non-fast-forward or offline — proceed with local master */ }

    if (!existsSync(pipeline.worktreePath)) {
      // ── Gap 5a: Safety guard — never rmSync the project root ──
      if (path.resolve(pipeline.worktreePath) === path.resolve(this.projectRoot)) {
        throw new Error('Refusing to create worktree at project root — this would destroy the repository');
      }
      try {
        this._execGit(['worktree', 'add', pipeline.worktreePath, '-b', pipeline.branch], this.projectRoot);
      } catch {
        // If the directory still exists after worktree remove (e.g. metadata was already
        // pruned and git doesn't know about this path), delete it directly so the
        // subsequent worktree add can succeed.
        if (existsSync(pipeline.worktreePath)) {
          try { rmSync(pipeline.worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
          try { execFileSync('git', ['worktree', 'prune'], { cwd: this.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
        }
        // Branch already exists (e.g. from a previous failed attempt) — reuse it
        this._execGit(['worktree', 'add', pipeline.worktreePath, pipeline.branch], this.projectRoot);
      }
    }

    this.advancePhase(pipeline, 'implement');
    await this.executePhase(pipeline);
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
    // fails silently on machines where HTTPS requires token auth (SSL cert issues),
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

    // Safety fallback: if QA feedback exists but no subtasks were flagged
    // (e.g., QA report criteria didn't match any subtask), run all subtasks.
    const effectiveSubtasks = hasQaFeedback && subtasksToRun.length === 0
      ? plan.subtasks
      : subtasksToRun;

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
      const results = await Promise.allSettled(
        subtasks.map(async (subtask: PlanSubtask) => {
          this._phaseHeader(logFile, `implement — subtask ${subtask.id}: ${subtask.title}`);
          let sessionId: string;
          try {
            sessionId = await processManager.createSession(this.sessionOpts(coderRole, pipeline.worktreePath, pipeline.taskId, logFile));
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            appendFileSync(logFile, `\n[ERROR] Session creation failed: ${msg}\n`);
            throw err;
          }
          // QA feedback is prepended at the top so the coder reads it first.
          // Plan.json acceptance criteria have already been patched with QA corrections.

          // In QA rework mode, only send the QA-flagged criteria — the agent
          // should focus exclusively on fixes, not re-validate passed criteria.
          const qaOnlyCriteria = hasQaFeedback
            ? subtask.acceptance_criteria.filter(
                ac => ac.includes('[QA CORRECTION') || ac.includes('[QA ISSUE')
              )
            : subtask.acceptance_criteria;
          const criteriaLine = hasQaFeedback
            ? (qaOnlyCriteria.length > 0
                ? `QA issues to fix: ${qaOnlyCriteria.join('; ')}`
                : `No specific QA criteria for this subtask — see the QA feedback above for issues to address.`)
            : `Acceptance criteria: ${subtask.acceptance_criteria.join('; ')}`;

          // Build per-subtask QA feedback — each agent only sees issues for its own subtask.
          const subtaskFeedback = (() => {
            if (!hasQaFeedback) return '';
            const lines: string[] = [];
            lines.push('## ⚠️ QA FEEDBACK — FIX THESE FIRST ⚠️');
            lines.push('');
            // Overall status from the QA report
            try {
              const reportPath = path.join(pipeline.specPath, 'qa_report.json');
              if (existsSync(reportPath)) {
                const report: QaReport = JSON.parse(readFileSync(reportPath, 'utf-8'));
                if (report.overall) lines.push(`Overall: **${report.overall}**`);
              }
            } catch { /* best-effort */ }
            // Only this subtask's issues
            if (qaOnlyCriteria.length > 0) {
              lines.push('');
              lines.push(`Issues in subtask ${subtask.id} **${subtask.title}**:`);
              for (const c of qaOnlyCriteria) {
                // Strip [QA CORRECTION: ...] / [QA ISSUE: ...] markers for readability
                const cleaned = c
                  .replace(/\s*\[QA CORRECTION:\s*/g, '[BLOCKER] ')
                  .replace(/\s*\[QA ISSUE\s*\((\w*)\):\s*/g, '[$1] ')
                  .replace(/\]$/, '');
                lines.push(`- ${cleaned}`);
              }
            }
            // Human feedback is task-level — include if present
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
            `/implement Subtask ${subtask.id}: ${subtask.title}\n\n` +
            `${subtask.description}\n\n` +
            `Files: ${subtask.files.join(', ')}\n\n` +
            `${criteriaLine}\n\n` +
            (hasQaFeedback
              ? `⚠️ Only fix the QA issues listed above. Do NOT re-validate criteria that QA already passed.\n` +
                `After fixing all issues, run the FULL test suite to verify no regressions.\n`
              : '');
          processManager.sendMessage(sessionId, prompt);
          await this.waitForCompletion(sessionId);
          processManager.killSession(sessionId);

          // Checkpoint: write plan.json immediately so completed subtasks
          // survive a crash mid-group (#2). Uses a serialized promise chain
          // to prevent concurrent write races from parallel subtasks.
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
      // If every session in the group failed (e.g. container unavailable), surface the first
      // error rather than silently advancing to QA on an empty diff.
      if (results.every(r => r.status === 'rejected')) {
        const firstReason = (results[0] as PromiseRejectedResult).reason;
        throw firstReason instanceof Error ? firstReason : new Error(String(firstReason));
      }
      // Write all completions for this group at once to avoid read-modify-write races.
      // Must go through _planWriteLock to avoid racing with per-subtask checkpoint writes.
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

      // ── Improvement 4: FAIL-type router — handle cleanup FAILs without spawning coder ──
      if (report.fail_type === 'cleanup') {
        appendFileSync(logFile, '\n[QA-ROUTER] fail_type=cleanup — handling git cleanup directly\n');
        // Log the fix_needed fields so the user can see what was required
        const failCriteria = report.criteria?.filter(c => c.status === 'FAIL') || [];
        for (const c of failCriteria) {
          appendFileSync(logFile, `[QA-ROUTER] Cleanup required: ${c.fix_needed || c.notes || c.criterion}\n`);
        }
        appendFileSync(logFile, '[QA-ROUTER] Cleanup FAILs require manual intervention or a dedicated cleanup subtask — advancing to implement for targeted fix\n');
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
    // Persist phase on disk now that work is actually starting (#5)
    this._persistAndEmitPhase(pipeline);
    const logFile = path.join(pipeline.specPath, 'output.log');
    this._phaseHeader(logFile, 'merge');
    const sessionId = await processManager.createSession(this.sessionOpts('merger', this.projectRoot, pipeline.taskId, logFile));
    pipeline.sessionId = sessionId;
    processManager.sendMessage(sessionId, `/merge ${pipeline.branch}`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    this.removeWorktree(pipeline.taskId);

    this.advancePhase(pipeline, 'done');
  }

  private async runCreatePR(pipeline: TaskPipeline): Promise<void> {
    // Persist phase on disk now that work is actually starting (#5)
    this._persistAndEmitPhase(pipeline);
    // Rebase the feature branch onto the latest master before pushing so the PR is
    // created without conflicts. This handles the common case where master advanced
    // while the implement/QA phases were running.
    const logFile = path.join(pipeline.specPath, 'output.log');
    try {
      execFileSync('git', ['fetch', 'origin', 'master'], { cwd: this.projectRoot, stdio: 'pipe' });
      this._execGit(['rebase', 'origin/master'], pipeline.worktreePath);
      appendFileSync(logFile, '\n[INFO] Feature branch rebased onto latest master — PR will be conflict-free\n');
    } catch {
      // Rebase has conflicts — abort cleanly and continue; gh pr update-branch will
      // attempt an automatic merge on GitHub's side after the PR is created.
      try { this._execGit(['rebase', '--abort'], pipeline.worktreePath); } catch { /* ignore */ }
      appendFileSync(logFile, '\n[WARN] Rebase onto master had conflicts — PR may require manual conflict resolution\n');
    }

    // Always push from the host — container git push credentials are unreliable.
    // _gitPush injects the gh OAuth token via http.extraheader, bypassing the
    // credential-helper chain entirely (same technique as GitHub Actions).
    this._gitPush(['push', '-u', '--force-with-lease', 'origin', pipeline.branch], logFile);

    // Run merger on the host — gh CLI needs host credentials (gh auth login); inside the
    // container only git HTTPS is wired (gh auth setup-git), not the full gh API token.
    const sessionId = await processManager.createSession({
      ...this.sessionOpts('merger', this.projectRoot, pipeline.taskId, logFile),
      projectRoot: undefined,
    });
    pipeline.sessionId = sessionId;

    const specContent = readFileSync(path.join(pipeline.specPath, 'spec.md'), 'utf-8');
    const platform = detectGitPlatform(this.projectRoot);
    const platformMsg = buildPlatformPrompt(platform, pipeline.branch, pipeline.description, specContent, this.projectRoot);
    processManager.sendMessage(sessionId, platformMsg);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    // Extract PR URL from the agent's output
    const prUrl = this._extractPrUrl(logFile);

    // Bring the PR branch up-to-date with master so the PR has no conflicts.
    // gh pr update-branch merges the base branch into the head branch on the remote.
    if (prUrl) {
      try {
        execFileSync('gh', ['pr', 'update-branch', prUrl], { cwd: this.projectRoot, stdio: 'pipe' });
        appendFileSync(logFile, '\n[INFO] Branch synced with master — PR is conflict-free\n');
      } catch {
        appendFileSync(logFile, '\n[WARN] Auto-sync with master failed — PR may have conflicts requiring manual resolution\n');
      }
    }

    this.taskStore.update(pipeline.taskId, {
      platform: platform !== 'unknown' ? platform : undefined,
      ...(prUrl ? { prUrl } : {}),
    });

    this.advancePhase(pipeline, 'pr-open', {
      ...(prUrl ? { prUrl } : {}),
      ...(platform !== 'unknown' ? { platform } : {}),
    });
  }

  async markTaskDone(taskId: string): Promise<void> {
    this.removeWorktree(taskId);
    this.taskStore.updatePhase(taskId, 'done');
    processManager.emit('phase-change', { taskId, phase: 'done' });
  }

  /** Scan the output log for a PR/MR URL created by the agent. */
  private _extractPrUrl(logFile: string): string | null {
    try {
      if (!existsSync(logFile)) return null;
      const content = readFileSync(logFile, 'utf-8');
      // Match GitHub PR, GitLab MR, or Bitbucket PR URLs
      const patterns = [
        /https?:\/\/github\.com\/[^\s<>"')\]]+\/pull\/\d+/gi,
        /https?:\/\/gitlab\.com\/[^\s<>"')\]]+\/-\/merge_requests\/\d+/gi,
        /https?:\/\/bitbucket\.org\/[^\s<>"')\]]+\/pull-requests\/\d+/gi,
      ];
      for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match) return match[0];
      }
    } catch { /* best-effort */ }
    return null;
  }

  // Serializes writes to plan.json to prevent race conditions during
  // per-subtask checkpointing in runImplement (#2).
  private _planWriteLock: Promise<void> = Promise.resolve();

  /** Rotate output log: keep last ~50KB when log exceeds ~100KB (#6) */
  private _rotateOutputLog(logFile: string): void {
    try {
      if (!existsSync(logFile)) return;
      const MAX_SIZE = 100_000;
      const KEEP_SIZE = 50_000;
      const stat = statSync(logFile);
      if (stat.size > MAX_SIZE) {
        const content = readFileSync(logFile, 'utf-8');
        const truncated = content.slice(-KEEP_SIZE);
        writeFileSync(logFile, truncated);
        appendFileSync(logFile, `\n── LOG TRUNCATED (${stat.size} → ${KEEP_SIZE} bytes) ──\n`);
      }
    } catch { /* best-effort */ }
  }

  /**
   * Persist phase to disk atomically and emit phase-change event.
   * Called when phase work actually starts — NOT before (#5).
   * This ensures a crash before work starts leaves the task at the previous phase.
   */
  private _persistAndEmitPhase(pipeline: TaskPipeline): void {
    this.taskStore.updatePhase(pipeline.taskId, pipeline.phase);
    processManager.emit('phase-change', { taskId: pipeline.taskId, phase: pipeline.phase });
  }

  /**
   * Save pipeline state to disk for crash recovery (#7).
   * On resume, _restorePipelineState reads this to recover sessionId, mergeStrategy, etc.
   */
  private _savePipelineState(pipeline: TaskPipeline): void {
    try {
      const statePath = path.join(pipeline.specPath, '.pipeline_state.json');
      const state = {
        taskId: pipeline.taskId,
        phase: pipeline.phase,
        sessionId: pipeline.sessionId,
        mergeStrategy: pipeline.mergeStrategy,
        qaAttempt: pipeline.qaAttempt,
        branch: pipeline.branch,
        worktreePath: pipeline.worktreePath,
        updatedAt: new Date().toISOString(),
      };
      const tmpPath = statePath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(state, null, 2));
      renameSync(tmpPath, statePath);
    } catch { /* best-effort */ }
  }

  /**
   * Restore pipeline state from disk after a crash.
   * Returns null if no saved state exists.
   */
  private _restorePipelineState(_taskId: string, specPath: string): Partial<TaskPipeline> | null {
    try {
      const statePath = path.join(specPath, '.pipeline_state.json');
      if (!existsSync(statePath)) return null;
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      unlinkSync(statePath); // clean up after reading
      return state;
    } catch { return null; }
  }

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
  private _isWorktreeHealthy(worktreePath: string): boolean {
    try {
      const gitFile = path.join(worktreePath, '.git');
      if (!existsSync(gitFile)) return false;
      const content = readFileSync(gitFile, 'utf-8').trim();
      if (!content.startsWith('gitdir:')) return false;
      const gitdir = content.slice('gitdir:'.length).trim();
      // Direct check: gitdir exists at the stated path (host mode or already-patched container path).
      if (existsSync(gitdir)) return true;
      // Container mode: gitdir is a Linux container path — translate to host and check.
      if (readContainerConfig(this.projectRoot).enabled) {
        const m = gitdir.replace(/\\/g, '/').match(/\/worktrees\/([^/]+)$/);
        if (m) {
          const hostGitdir = path.join(this.projectRoot, '.git', 'worktrees', m[1]);
          if (existsSync(hostGitdir)) return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Restore qa_report.json from a snapshot if the report was deleted (Gap 4b).
   * Checks both qa_report_before_failed.json (retryTask snapshot) and
   * qa_report_before_bounce.json (mid-pipeline QA→implement bounce snapshot).
   * Uses the first available snapshot. Best-effort — never blocks the pipeline.
   */
  private _restoreQaReportFromSnapshot(specPath: string): void {
    const reportPath = path.join(specPath, 'qa_report.json');
    if (existsSync(reportPath)) return;
    for (const snapName of ['qa_report_before_failed.json', 'qa_report_before_bounce.json']) {
      const snapshotPath = path.join(specPath, snapName);
      if (existsSync(snapshotPath)) {
        try {
          const snapshot = readFileSync(snapshotPath, 'utf-8');
          writeFileSync(reportPath, snapshot);
          const logFile = path.join(specPath, 'output.log');
          appendFileSync(logFile, `\n[GUARD] Restored qa_report.json from ${snapName} — file was deleted\n`);
          break; // use the first available snapshot
        } catch { /* best-effort — don't block the pipeline on snapshot restore failure */ }
      }
    }
  }

  /**
   * Restore human_feedback.md from snapshot if the file was deleted (Gap 4b).
   * Only checks human_feedback_before_bounce.md. Best-effort.
   */
  private _restoreHumanFeedbackFromSnapshot(specPath: string): void {
    const feedbackPath = path.join(specPath, 'human_feedback.md');
    if (existsSync(feedbackPath)) return;
    const snapshotPath = path.join(specPath, 'human_feedback_before_bounce.md');
    if (existsSync(snapshotPath)) {
      try {
        const snapshot = readFileSync(snapshotPath, 'utf-8');
        writeFileSync(feedbackPath, snapshot);
        const logFile = path.join(specPath, 'output.log');
        appendFileSync(logFile, `\n[GUARD] Restored human_feedback.md from human_feedback_before_bounce.md — file was deleted\n`);
      } catch { /* best-effort */ }
    }
  }

  private advancePhase(pipeline: TaskPipeline, phase: PipelinePhase, eventExtra?: Record<string, unknown>): void {
    pipeline.phase = phase;
    this.taskStore.updatePhase(pipeline.taskId, phase);
    processManager.emit('phase-change', { taskId: pipeline.taskId, phase, ...eventExtra });
  }

  // Parse "resets 4:30pm (UTC)" from Claude Code's session-limit message.
  // Returns a Unix timestamp (seconds) for the reset time, or null if unparseable.
  private _parseSessionLimitReset(line: string): number | null {
    const m = line.match(/resets\s+(\d+):(\d+)\s*(am|pm)\s*(?:\(UTC\))?/i);
    if (!m) return null;
    let hours = parseInt(m[1], 10);
    const minutes = parseInt(m[2], 10);
    const ampm = m[3].toLowerCase();
    if (ampm === 'pm' && hours !== 12) hours += 12;
    if (ampm === 'am' && hours === 12) hours = 0;
    const now = new Date();
    const reset = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hours, minutes, 0));
    // If the reset time is already in the past today, it must be tomorrow
    if (reset.getTime() <= Date.now()) reset.setUTCDate(reset.getUTCDate() + 1);
    return Math.floor(reset.getTime() / 1000);
  }

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
    const waitMs = Math.max(resetsAtMs - Date.now(), 0);
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
   * Rewrite the worktree's .git file and its back-reference so both point to
   * container-relative paths. Needed when the worktree was created by host git
   * (container not yet running during plan phase), which leaves Windows-style
   * gitdir paths that the Linux container cannot resolve.
   */
  private _patchWorktreeGitFile(hostWorktreePath: string, containerWorkspace: string): void {
    const gitFile = path.join(hostWorktreePath, '.git');
    if (!existsSync(gitFile)) return;
    try {
      const content = readFileSync(gitFile, 'utf-8').trim();
      if (!content.startsWith('gitdir:')) return;
      const currentGitdir = content.slice('gitdir:'.length).trim();
      // Extract worktree name — the segment after /worktrees/ in the gitdir path.
      const m = currentGitdir.replace(/\\/g, '/').match(/\/worktrees\/([^/]+)$/);
      if (!m) return;
      const worktreeName = m[1];
      const correctGitdir = `${containerWorkspace}/.git/worktrees/${worktreeName}`;
      if (currentGitdir.replace(/\\/g, '/') === correctGitdir) return; // already correct
      writeFileSync(gitFile, `gitdir: ${correctGitdir}\n`);
      // Patch the back-reference so git worktree commands from inside the container work.
      const backRefFile = path.join(this.projectRoot, '.git', 'worktrees', worktreeName, 'gitdir');
      if (existsSync(backRefFile)) {
        const containerWorktreePath = hostToContainerPath(hostWorktreePath, this.projectRoot, containerWorkspace);
        writeFileSync(backRefFile, `${containerWorktreePath}/.git\n`);
      }
    } catch { /* best-effort — don't break the pipeline on a patch failure */ }
  }

  private _execGit(args: string[], hostCwd: string): void {
    // git worktree add/remove must always run on the host filesystem — worktrees are
    // host-side directories accessed by the container via volume mount. Running them
    // via docker exec would target a container path where the .worktrees/ directory
    // doesn't exist, causing "could not create leading directories" failures.
    if (readContainerConfig(this.projectRoot).enabled && args[0] !== 'worktree') {
      const info = containerManager.getRunningContainer(this.projectRoot);
      if (info) {
        const containerCwd = hostToContainerPath(hostCwd, this.projectRoot, info.remoteWorkspaceFolder);
        const mappedArgs = args.map(a =>
          path.isAbsolute(a) && a.startsWith(this.projectRoot)
            ? hostToContainerPath(a, this.projectRoot, info.remoteWorkspaceFolder)
            : a
        );
        const remoteUser = readContainerRemoteUser(this.projectRoot);
        execFileSync('docker', ['exec', '-u', remoteUser, '-w', containerCwd, info.containerId, 'git', ...mappedArgs]);
        return;
      }
    }
    execFileSync('git', args, { cwd: hostCwd });
  }

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

  private getWorktreeBase(): string {
    return readContainerConfig(this.projectRoot).enabled
      ? path.join(this.projectRoot, '.worktrees')
      : path.join(this.projectRoot, '..', 'worktrees');
  }

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

  /** Get the filesystem path to this task's git worktree, or null if the task has no branch. */
  public getWorktreePath(taskId: string): string | null {
    const task = this.taskStore.getById(taskId);
    if (!task || !task.branch) return null;
    const slug = slugify(task.description);
    return path.join(this.getWorktreeBase(), slug);
  }

  /**
   * Remove the git worktree for this task if it exists on disk.
   * Tries a normal remove first; falls back to --force if there are uncommitted changes.
   * Always cleans up the branch and updates the task record so no stale state lingers.
   */
  private removeWorktree(taskId: string): void {
    const wtPath = this.getWorktreePath(taskId);
    if (!wtPath || !existsSync(wtPath)) return;
    try {
      this._execGit(['worktree', 'remove', wtPath], this.projectRoot);
    } catch {
      // Normal remove failed (e.g. uncommitted changes) — force it
      try {
        this._execGit(['worktree', 'remove', '--force', wtPath], this.projectRoot);
      } catch {
        // Worktree is stuck (e.g. files locked by another process).
        // Delete the worktree directory manually, then prune the stale git metadata.
        try { rmSync(wtPath, { recursive: true, force: true }); } catch { /* best-effort */ }
        try { execFileSync('git', ['worktree', 'prune'], { cwd: this.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
      }
    }
    const task = this.taskStore.getById(taskId);
    if (task?.branch) {
      // Force-delete the branch — worktree removal prunes the worktree metadata but
      // the branch may still linger if the worktree had uncommitted changes.
      try { execFileSync('git', ['branch', '-D', task.branch], { cwd: this.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
    }
    this.taskStore.update(taskId, { branch: undefined });
  }

  /** Force-remove the git worktree (discards uncommitted changes). Delegates to removeWorktree. */
  private _removeWorktreeForce(taskId: string): void {
    this.removeWorktree(taskId);
  }

  /** Discard all uncommitted changes in the worktree. Works on both host and container. */
  private _cleanWorktree(taskId: string): void {
    const wtPath = this.getWorktreePath(taskId);
    if (!wtPath || !existsSync(wtPath)) return;
    try {
      this._execGit(['checkout', 'HEAD', '--', '.'], wtPath);
    } catch { /* best-effort */ }
  }

  private sessionOpts(role: AgentSession['role'], cwd: string, taskId: string, logFile?: string) {
    const providerCfg = resolveProvider(this.projectRoot, role);
    const providerOpts = providerToSessionOpts(providerCfg);
    return { taskId, role, cwd, projectRoot: this.projectRoot, permissionMode: 'bypassPermissions', logFile, ...providerOpts };
  }

  /** Write QA feedback for bouncing back to implement */
  private _writeQaFeedback(pipeline: TaskPipeline, report: QaReport): void {
    const feedbackPath = path.join(pipeline.specPath, 'qa_feedback.md');
    let content = `# QA Feedback\n\n`;
    content += `## ⚠️ IMPORTANT: QA Feedback OVERRIDES the plan\n\n`;
    content += `The issues listed below represent the latest requirements. `;
    content += `Where QA feedback and the plan's acceptance criteria conflict, **follow the QA feedback**. `;
    content += `The plan may be outdated — QA findings are the ground truth.\n\n`;
    content += `## Overall: ${report.overall}\n\n`;
    if (report.criteria) {
      content += `## Failed Criteria\n\n`;
      for (const c of report.criteria) {
        if (c.status === 'FAIL') {
          const name = c.criterion || c.name || 'Unknown criterion';
          const fix = c.fix_needed ? ` → Fix: ${c.fix_needed}` : '';
          content += `- **${name}**: ${c.notes || c.evidence || 'No details provided'}${fix}\n`;
        }
      }
    }
    if (report.additional_issues || report.issues) {
      const issues = (report.additional_issues ?? report.issues)!;
      content += `\n## Additional Issues\n\n`;
      for (const issue of issues) {
        const desc = issue.description || issue.message || JSON.stringify(issue);
        const file = issue.file ? ` (${issue.file})` : '';
        const fix = issue.fix_needed ? ` → Fix: ${issue.fix_needed}` : '';
        content += `- [${issue.severity || 'error'}] ${desc}${file}${fix}\n`;
      }
    }
    writeFileSync(feedbackPath, content);

    // Patch plan.json subtask acceptance criteria from QA findings
    // Marks subtasks with qa_flagged:true so runImplement only re-runs those
    const planPath = path.join(pipeline.specPath, 'plan.json');
    if (existsSync(planPath)) {
      try {
        const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
        if (plan.subtasks) {
          let modified = false;
          // Patch failed criteria into matching subtasks
          if (report.criteria) {
            for (const c of report.criteria) {
              if (c.status === 'FAIL' && c.fix_needed) {
                const criterionName = c.criterion || c.name || '';
                for (const subtask of plan.subtasks) {
                  if (!subtask.acceptance_criteria) continue;
                  const idx = subtask.acceptance_criteria.findIndex(
                    (ac: string) => {
                      const acLower = ac.toLowerCase();
                      const critLower = criterionName.toLowerCase();
                      // Try exact match first, then whole-word, then prefix substring
                      return (
                        acLower.includes(critLower) ||
                        acLower.split(/\s+/).some((w: string) => critLower.split(/\s+/).every((cw: string) => w.includes(cw)))
                      );
                    }
                  );
                  if (idx >= 0) {
                    subtask.acceptance_criteria[idx] += ` [QA CORRECTION: ${c.fix_needed}]`;
                    subtask.qa_flagged = true;
                    modified = true;
                    // Don't break — one criterion may apply to multiple subtasks
                  }
                }
              }
            }
          }
          // Append additional_issues as new criteria to relevant subtasks
          const issues = report.additional_issues || report.issues;
          if (issues) {
            for (const issue of issues) {
              const desc = issue.description || issue.message || '';
              const fix = issue.fix_needed || '';
              if (!desc && !fix) continue;
              for (const subtask of plan.subtasks) {
                if (!subtask.files || !Array.isArray(subtask.files)) continue;
                // Match file by basename or suffix to avoid overly broad matches
          if (issue.file && subtask.files.some((f: string) => {
            const issueBase = issue.file!.replace(/^.*[\\/]/, '');
            const fileBase = f.replace(/^.*[\\/]/, '');
            return fileBase === issueBase || f.endsWith(issue.file!) || issue.file!.endsWith(f);
          })) {
                  if (!subtask.acceptance_criteria) subtask.acceptance_criteria = [];
                  subtask.acceptance_criteria.push(`[QA ISSUE (${issue.severity || 'unknown'}): ${desc}${fix ? ` → Fix: ${fix}` : ''}]`);
                  subtask.qa_flagged = true;
                  modified = true;
                  // Don't break — same file may appear in multiple subtasks
                }
              }
            }
          }
          if (modified) {
            writeFileSync(planPath, JSON.stringify(plan, null, 2));
          }
        }
      } catch { /* best-effort */ }
    }
  }

  /** Write a completion summary when the task fails (max QA attempts reached) */
  private _writeCompletionSummary(pipeline: TaskPipeline): void {
    const summaryPath = path.join(pipeline.specPath, 'completion_summary.md');
    let content = `# Completion Summary\n\n`;
    content += `Task failed after ${pipeline.qaAttempt} QA attempts.\n\n`;

    // Read plan.json for subtask status
    const planPath = path.join(pipeline.specPath, 'plan.json');
    if (existsSync(planPath)) {
      try {
        const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
        if (plan.subtasks) {
          content += `## Plan Subtasks\n\n`;
          for (const s of plan.subtasks) {
            const done = s.completed ? 'COMPLETED' : 'NOT COMPLETED';
            content += `- [${s.completed ? 'x' : ' '}] **${s.title}** — ${done}\n`;
          }
        }
      } catch { /* skip */ }
    }

    // Read last QA report
    const reportPath = path.join(pipeline.specPath, 'qa_report.json');
    if (existsSync(reportPath)) {
      try {
        const report = JSON.parse(readFileSync(reportPath, 'utf-8'));
        content += `\n## Last QA Report\n\n`;
        content += `Overall: **${report.overall}**\n\n`;
        if (report.criteria) {
          content += `| Criterion | Status | Notes |\n`;
          content += `|-----------|--------|-------|\n`;
          for (const c of report.criteria) {
            const name = c.criterion || c.name || '-';
            content += `| ${name} | ${c.status} | ${c.notes || c.evidence || '-'} |\n`;
          }
        }
        if (report.additional_issues || report.issues) {
          const issues = report.additional_issues || report.issues;
          content += `\n### Issues\n\n`;
          for (const issue of issues) {
            const desc = issue.description || issue.message || JSON.stringify(issue);
            content += `- ${issue.severity ? `[${issue.severity}] ` : ''}${desc}\n`;
          }
        }
      } catch { /* skip */ }
    }

    content += `\n---\n*Generated automatically on ${new Date().toISOString()}*\n`;

    writeFileSync(summaryPath, content);

    // Store summary on the task
    this.taskStore.update(pipeline.taskId, { completionSummary: content });
  }

  private _phaseHeader(logFile: string, phase: string): void {
    try {
      appendFileSync(logFile, `\n${'─'.repeat(40)}\n▶ ${phase.toUpperCase()}\n${'─'.repeat(40)}\n`);
    } catch (err) { logWarn('orchestrator', 'Failed to write phase header to log file', err); }
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
  private _gitPush(pushArgs: string[], logFile: string): void {
    const noPromptEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
    let extraConfigArgs: string[] = [];
    let token = '';
    try {
      token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8', stdio: 'pipe' }).trim();
      if (token) {
        // Rewrite https://github.com/ URLs to embed credentials directly.
        // git's credential layer runs before any HTTP request — http.extraheader
        // is too late because git still prompts for a username/password first.
        // url.insteadOf embeds credentials in the URL itself so git's credential
        // system sees them before prompting. No spaces in the config key, so
        // Windows command-line quoting is not an issue.
        extraConfigArgs = [
          '-c', 'http.sslVerify=false',
          '-c', `url.https://x-access-token:${token}@github.com/.insteadOf=https://github.com/`,
        ];
        appendFileSync(logFile, '[GIT] Using gh OAuth token via url.insteadOf\n');
      }
    } catch {
      // gh not installed or not authenticated — fall through to existing credential helper
      appendFileSync(logFile, '[GIT] gh token not available — falling back to default credential helper\n');
    }
    try {
      execFileSync('git', [...extraConfigArgs, ...pushArgs], {
        cwd: this.projectRoot, stdio: 'pipe', env: noPromptEnv,
      });
    } catch (err) {
      // Redact the token from the error message before it reaches the log file.
      // execFileSync includes the full command string in the error, which would
      // expose the token in output.log if not scrubbed.
      const raw = err instanceof Error ? err.message : String(err);
      const safe = token ? raw.replaceAll(token, '[REDACTED]') : raw;
      throw new Error(safe);
    }
  }
}

/**
 * Detect the Git hosting platform from the remote origin URL.
 * @returns 'github', 'gitlab', 'bitbucket', or 'unknown'
 */
export function detectGitPlatform(projectRoot: string): 'github' | 'gitlab' | 'bitbucket' | 'unknown' {
  try {
    const url = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: projectRoot, encoding: 'utf-8', timeout: 5000,
    }).trim().toLowerCase();
    if (url.includes('github.com') || url.includes('github.')) return 'github';
    if (url.includes('gitlab.com') || url.includes('gitlab.')) return 'gitlab';
    if (url.includes('bitbucket.org') || url.includes('bitbucket.')) return 'bitbucket';
  } catch (err) { logWarn('orchestrator', 'Failed to detect git remote platform', err); }
  return 'unknown';
}

/**
 * Detect the default branch name from the remote HEAD reference.
 * Falls back to 'main' if detection fails.
 */
export function detectDefaultBranch(projectRoot: string): string {
  try {
    const ref = execFileSync('git', ['symbolic-ref', 'refs/remotes/origin/HEAD'], {
      cwd: projectRoot, encoding: 'utf-8', timeout: 3000,
    }).trim();
    // Extract branch name from refs/remotes/origin/main → main
    const parts = ref.split('/');
    return parts[parts.length - 1] || 'main';
  } catch (err) {
    logWarn('orchestrator', 'Failed to detect default branch, falling back to main', err);
    return 'main';
  }
}

/**
 * Build a platform-specific agent prompt for PR/MR creation.
 * Generates instructions tailored to GitHub, GitLab, Bitbucket,
 * or a generic fallback for unknown platforms.
 */
export function buildPlatformPrompt(
  platform: 'github' | 'gitlab' | 'bitbucket' | 'unknown',
  branch: string,
  description: string,
  specContent: string,
  projectRoot: string,
): string {
  const defaultBranch = detectDefaultBranch(projectRoot);
  const base = `Create a Pull Request for branch "${branch}" targeting the ${defaultBranch} branch.\n\n` +
    `IMPORTANT: First check whether an open PR already exists for branch "${branch}".\n` +
    `- If an open PR exists: report its URL and stop — do not create a duplicate.\n` +
    `- If a previously merged PR exists for this branch: ignore it and CREATE A NEW PR now.\n` +
    `  A merged PR does not mean the current branch commits have been reviewed.\n` +
    `  The branch has been re-pushed with new commits that need a fresh PR.\n\n`;
  const meta = `Title: ${description}\n\n` +
    `Body: Generate a clear PR description from this spec:\n\n${specContent}\n\n` +
    `Include a summary of changes, testing done (QA passed), and any notes for reviewers.`;

  switch (platform) {
    case 'github':
      return base + `Use the GitHub MCP server's create_pull_request tool.\n\n` + meta;
    case 'gitlab':
      return base +
        `Platform: GitLab. Create a Merge Request (not a PR).\n` +
        `If the "glab" CLI is available, run: glab mr create --title "..." --description "..."` +
        ` --target-branch ${defaultBranch} --source-branch ${branch}\n` +
        `Otherwise, use the GitLab API (project is from remote origin URL).\n\n` + meta;
    case 'bitbucket':
      return base +
        `Platform: Bitbucket Cloud. Create a Pull Request.\n` +
        `Use the Bitbucket REST API v2 (https://api.bitbucket.org/2.0) if credentials are available.\n` +
        `The repository slug can be parsed from the remote origin URL.\n\n` + meta;
    default:
      return base +
        `Platform: Unknown (could not auto-detect from remote origin).\n` +
        `Create a Pull Request using whatever tools are available for this repository.\n\n` + meta;
  }
}

// Store on global for the same reason as processManager — shared across module contexts
declare global {
  var __orchestrators: Map<string, Orchestrator> | undefined;
}

const orchestrators: Map<string, Orchestrator> =
  global.__orchestrators ?? (global.__orchestrators = new Map());

export function getOrchestrator(projectPath: string): Orchestrator {
  if (!orchestrators.has(projectPath)) {
    orchestrators.set(projectPath, new Orchestrator(projectPath));
  }
  return orchestrators.get(projectPath)!;
}
