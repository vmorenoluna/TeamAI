import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, renameSync, statSync, rmSync, copyFileSync, mkdirSync, readdirSync } from 'fs';
import path from 'path';
import { warn as logWarn } from './logger';
import { processManager, containerSessionOpts, type AgentSession } from './process-manager';
import { readContainerConfig, readContainerRemoteUser, containerManager, hostToContainerPath, dockerAvailable, _resetDockerAvailableCache } from './container-manager';
import { TaskStore } from './task-store';
import { resolveProvider, providerToSessionOpts } from './providers';
import { slugify } from './utils';
import { detectGitPlatform, buildPlatformPrompt } from './git-platform';
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
    // Persist phase on disk now that work is actually starting (#5)
    this._persistAndEmitPhase(pipeline);
    const logFile = path.join(pipeline.specPath, 'output.log');
    this._phaseHeader(logFile, 'merge');

    // Commit TeamAI artifacts to the worktree so the merge includes the full
    // implementation story (spec, plan, QA, events, etc.).
    this._commitArtifactsToWorktree(pipeline);

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
      // Rebase has conflicts — abort and use the merger agent to semantically
      // merge origin/master into the feature branch. The merger resolves conflicts,
      // runs tests, and commits — producing a clean, conflict-free PR.
      try { this._execGit(['rebase', '--abort'], pipeline.worktreePath); } catch { /* ignore */ }
      appendFileSync(logFile, '\n[INFO] Rebase had conflicts — spawning merger to resolve via git merge\n');
      try {
        const mergeSessionId = await processManager.createSession(
          this.sessionOpts('merger', pipeline.worktreePath, pipeline.taskId, logFile)
        );
        processManager.sendMessage(mergeSessionId, `/merge origin/master`);
        await this.waitForCompletion(mergeSessionId);
        processManager.killSession(mergeSessionId);
        appendFileSync(logFile, '\n[INFO] Merger resolved conflicts — PR will be conflict-free\n');
      } catch (mergeErr) {
        const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
        appendFileSync(logFile, `\n[WARN] Merger could not resolve all conflicts: ${mergeMsg}\n`);
        appendFileSync(logFile, '\n[WARN] PR may require manual conflict resolution\n');
      }
    }

    // Commit TeamAI artifacts to the worktree so the PR includes the full
    // implementation story (spec, plan, QA, events, etc.).
    this._commitArtifactsToWorktree(pipeline);

    // Always push from the host — container git push credentials are unreliable.
    // _gitPush injects the gh OAuth token via http.extraheader, bypassing the
    // credential-helper chain entirely (same technique as GitHub Actions).
    // Use --force, not --force-with-lease: the local remote-tracking ref may be stale
    // (e.g. branch was pushed earlier via a raw URL, or the worktree was recreated
    // without a fetch), causing --force-with-lease to reject the push with "stale info"
    // even though the orchestrator is the sole writer to these feat/ branches.
    this._gitPush(['push', '-u', '--force', 'origin', pipeline.branch], logFile);

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

    // Extract PR URL from the agent’s output
    const prUrl = this._extractPrUrl(logFile);

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
    processManager.emit('phase-change', { taskId, phase: 'done', projectRoot: this.projectRoot });
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
    processManager.emit('phase-change', { taskId: pipeline.taskId, phase: pipeline.phase, projectRoot: this.projectRoot });
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
    processManager.emit('phase-change', { taskId: pipeline.taskId, phase, projectRoot: this.projectRoot, ...eventExtra });
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
  private _writeFileEnsuringWritable(filePath: string, content: string): void {
    try {
      writeFileSync(filePath, content);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException)?.code !== 'EPERM') throw e;
      // Write to a temp file, then atomically rename over the locked file.
      // renameSync uses MoveFileEx with REPLACE_EXISTING, which bypasses
      // the security descriptor git places on linked-worktree metadata files.
      const tmpPath = filePath + '.tmp';
      writeFileSync(tmpPath, content);
      try {
        renameSync(tmpPath, filePath);
      } catch (renameErr) {
        // Clean up the temp file on rename failure so it doesn't leak.
        try { unlinkSync(tmpPath); } catch { /* best-effort */ }
        throw renameErr;
      }
    }
  }

  /**
   * Rewrite .git/worktrees/<name>/commondir to the relative path '../..'.
   * Since .git/worktrees/<name> is always two levels deep inside .git,
   * this path resolves correctly on every OS. No-op if already correct.
   */
  private _patchCommondirToRelative(worktreeName: string): void {
    const commondirFile = path.join(this.projectRoot, '.git', 'worktrees', worktreeName, 'commondir');
    if (existsSync(commondirFile)) {
      const current = readFileSync(commondirFile, 'utf-8').trim().replace(/\\/g, '/');
      if (current !== '../..') {
        this._writeFileEnsuringWritable(commondirFile, '../..\n');
      }
    }
  }

  private _restoreWorktreeGitFileToHostPaths(hostWorktreePath: string): void {
    const gitFile = path.join(hostWorktreePath, '.git');
    if (!existsSync(gitFile)) return;
    try {
      const content = readFileSync(gitFile, 'utf-8').trim();
      if (!content.startsWith('gitdir:')) return;
      const currentGitdir = content.slice('gitdir:'.length).trim().replace(/\\/g, '/');
      const m = currentGitdir.match(/\/worktrees\/([^/]+)$/);
      if (!m) return;
      const worktreeName = m[1];
      // Normalise the host project root to forward slashes so git on Windows can read it.
      const hostRoot = this.projectRoot.replace(/\\/g, '/');
      const hostGitdir = `${hostRoot}/.git/worktrees/${worktreeName}`;
      if (currentGitdir === hostGitdir) return; // already correct
      this._writeFileEnsuringWritable(gitFile, `gitdir: ${hostGitdir}\n`);
      // Restore the back-reference so git worktree commands from the host work.
      const backRefFile = path.join(this.projectRoot, '.git', 'worktrees', worktreeName, 'gitdir');
      if (existsSync(backRefFile)) {
        const hostWorktreeGitFile = `${hostWorktreePath.replace(/\\/g, '/')}/.git`;
        this._writeFileEnsuringWritable(backRefFile, `${hostWorktreeGitFile}\n`);
      }
      this._patchCommondirToRelative(worktreeName);
    } catch { /* best-effort — don't break the pipeline on a patch failure */ }
  }

  /**
   * Rewrite the worktree's .git file and its back-reference so both point to
   * container-relative paths. Compares current file content to the expected value
   * derived from containerWorkspace (runtime value from docker inspect) and is a
   * no-op when already correct — safe to call unconditionally before any docker exec.
   *
   * Also rewrites commondir to the relative path '../..' — correct on every OS since
   * .git/worktrees/<name> is always two levels deep inside .git.
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
      this._writeFileEnsuringWritable(gitFile, `gitdir: ${correctGitdir}\n`);
      // Patch the back-reference so git worktree commands from inside the container work.
      const backRefFile = path.join(this.projectRoot, '.git', 'worktrees', worktreeName, 'gitdir');
      if (existsSync(backRefFile)) {
        const containerWorktreePath = hostToContainerPath(hostWorktreePath, this.projectRoot, containerWorkspace);
        this._writeFileEnsuringWritable(backRefFile, `${containerWorktreePath}/.git\n`);
      }
      this._patchCommondirToRelative(worktreeName);
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
        // Inject GIT_DIR + GIT_WORK_TREE so the container git resolves the gitdir
        // directly, bypassing the .git pointer file. The .git file holds host paths
        // (as written by git worktree add); the container cannot resolve host paths.
        // Using env vars is OS-agnostic and never requires modifying the .git file.
        const gitEnv = this._worktreeGitEnv(hostCwd, info.remoteWorkspaceFolder);
        const envFlags = Object.entries(gitEnv).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
        execFileSync('docker', ['exec', '-u', remoteUser, ...envFlags, '-w', containerCwd, info.containerId, 'git', ...mappedArgs]);
        return;
      }
    }
    // Host git: inject GIT_DIR + GIT_WORK_TREE for linked-worktree operations so
    // host git resolves the gitdir directly, bypassing the .git pointer file.
    // This works regardless of whether the .git file currently holds host or
    // container paths. Skip for 'git worktree' subcommands — these operate on
    // the main repo and must not have GIT_DIR overridden.
    const gitEnv = args[0] !== 'worktree' ? this._worktreeGitEnv(hostCwd) : {};
    execFileSync('git', args, { cwd: hostCwd, ...(Object.keys(gitEnv).length ? { env: { ...process.env, ...gitEnv } } : {}) });
  }

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
  private _worktreeGitEnv(hostCwd: string, containerWs?: string): Record<string, string> {
    const worktreeName = path.basename(hostCwd);
    const hostGitDir = path.join(this.projectRoot, '.git', 'worktrees', worktreeName);
    if (!existsSync(hostGitDir)) return {};

    if (containerWs) {
      // Container context: both paths must be container-resolvable (POSIX slashes).
      return {
        GIT_DIR: `${containerWs}/.git/worktrees/${worktreeName}`,
        GIT_WORK_TREE: hostToContainerPath(hostCwd, this.projectRoot, containerWs),
      };
    }

    // Host context: normalise to forward slashes — git accepts them on all
    // platforms (Linux, macOS, Windows/git-for-windows).
    return {
      GIT_DIR: hostGitDir.replace(/\\/g, '/'),
      GIT_WORK_TREE: hostCwd.replace(/\\/g, '/'),
    };
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

  /**
   * Clean up stale per-subtask worktrees from a previous crashed run (AC9).
   * Scans for directories matching <worktree-base>/<task-slug>-st* and removes them
   * along with their branches and git worktree metadata.
   */
  private _cleanStaleSubtaskWorktrees(pipeline: TaskPipeline): void {
    const slug = path.basename(pipeline.worktreePath);
    const prefix = slug + '-st';
    const worktreeBase = this.getWorktreeBase();
    if (!existsSync(worktreeBase)) return;

    let entries;
    try {
      entries = readdirSync(worktreeBase, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!entry.name.startsWith(prefix)) continue;
      if (!entry.name.slice(prefix.length).match(/^\d+$/)) continue;
      const stPath = path.join(worktreeBase, entry.name);
      const stBranch = pipeline.branch + entry.name.slice(slug.length);

      try {
        this._execGit(['worktree', 'remove', '--force', stPath], this.projectRoot);
      } catch {
        try { rmSync(stPath, { recursive: true, force: true }); } catch { /* best-effort */ }
        try { execFileSync('git', ['worktree', 'prune'], { cwd: this.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
      }

      try {
        execFileSync('git', ['branch', '-D', stBranch], { cwd: this.projectRoot, stdio: 'pipe' });
      } catch { /* best-effort */ }
    }
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
    return { taskId, role, cwd, ...containerSessionOpts(this.projectRoot), logFile, ...providerOpts };
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
    if (report.fail_type) {
      content += `**fail_type**: ${report.fail_type}\n\n`;
    }
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

  /** Files excluded from artifact commit — internal/transient orchestrator state. */
  private static readonly ARTIFACT_EXCLUDE = new Set([
    'output.log',
    '.pipeline_state.json',
  ]);

  /**
   * Copy the task's TeamAI artifacts into the worktree and commit them
   * so the PR includes the full story of the implementation (spec, plan,
   * QA report, spec revisions, events timeline, etc.).
   *
   * Throws on failure — the pipeline must not create a PR or merge without
   * artifacts.  The caller (`runTask`) catches and advances to 'failed'.
   */
  private _commitArtifactsToWorktree(pipeline: TaskPipeline): void {
    const logFile = path.join(pipeline.specPath, 'output.log');
    this._phaseHeader(logFile, 'artifacts — commit to worktree');

    // Use the task's actual directory name (derived from its title at creation time),
    // not slugify(description) — these differ and produce a second orphan directory
    // after merge, causing duplicate UUID entries in TaskStore.getAll().
    const slug = path.basename(pipeline.specPath);
    const targetDir = path.join(pipeline.worktreePath, '.teamai', slug);

    if (!existsSync(targetDir)) {
      mkdirSync(targetDir, { recursive: true });
    }

    // Copy all files except excluded ones
    const sourceDir = pipeline.specPath;
    let copied = 0;
    if (existsSync(sourceDir)) {
      const entries = readdirSync(sourceDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        if (Orchestrator.ARTIFACT_EXCLUDE.has(entry.name)) continue;
        copyFileSync(path.join(sourceDir, entry.name), path.join(targetDir, entry.name));
        copied++;
      }
    }

    // ── Rewrite task.json phase to "done" in the committed copy ──
    // The live pipeline workspace still has the current phase (merge/create-pr),
    // but by the time this branch is merged and pulled into main, the task will
    // be done.  Committing "done" prevents a stale kanban entry (TaskStore scans
    // every .teamai/ subdirectory for task.json to discover tasks).
    const committedTaskJson = path.join(targetDir, 'task.json');
    if (existsSync(committedTaskJson)) {
      try {
        const t = JSON.parse(readFileSync(committedTaskJson, 'utf-8'));
        t.phase = 'done';
        t.updatedAt = new Date().toISOString();
        writeFileSync(committedTaskJson, JSON.stringify(t, null, 2));
      } catch { /* best-effort — commit what we have */ }
    }

    if (copied === 0) {
      appendFileSync(logFile, '[ARTIFACTS] No artifacts to commit\n');
      return;
    }

    // Artifact files are written by the host-side Node.js process, so we always
    // commit using HOST git (execFileSync directly) — no docker exec needed.
    // Use _worktreeGitEnv to bypass the .git pointer file: _patchWorktreeGitFile
    // is called before every agent session and leaves container paths in the file;
    // setting GIT_DIR/GIT_WORK_TREE makes git immune to whatever the file contains.
    //
    // Best-effort restore of the .git file so external tools (VS Code, user
    // terminal) that look up the worktree via the .git file continue to work.
    this._restoreWorktreeGitFileToHostPaths(pipeline.worktreePath);

    const gitEnv = this._worktreeGitEnv(pipeline.worktreePath);
    const gitOpts = Object.keys(gitEnv).length
      ? { cwd: pipeline.worktreePath, env: { ...process.env, ...gitEnv } }
      : { cwd: pipeline.worktreePath };

    execFileSync('git', ['add', '.teamai/'], gitOpts);

    try {
      execFileSync('git', ['commit', '-m', `Add TeamAI pipeline artifacts for "${pipeline.description}"`], gitOpts);
    } catch (gitErr) {
      const msg = gitErr instanceof Error ? gitErr.message : String(gitErr);
      // "nothing to commit, working tree clean" — artifacts already committed
      // (e.g. re-running create-pr after a reject-bounce cycle). No-op.
      if (/nothing\s+to\s+commit.*working\s+tree\s+clean/i.test(msg)) {
        appendFileSync(logFile, '[ARTIFACTS] Already committed — no new changes\n');
        return;
      }
      // "nothing added to commit" — .teamai-artifacts/ is gitignored.
      // Respect the user's choice; log a warning and continue without artifacts.
      if (/nothing\s+added\s+to\s+commit/i.test(msg)) {
        appendFileSync(logFile, '[ARTIFACTS] Warning: .teamai/ appears to be gitignored — skipping artifact commit\n');
        return;
      }
      throw gitErr;
    }

    appendFileSync(logFile, `[ARTIFACTS] Committed ${copied} artifact file(s) to worktree\n`);
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

    // Helper: obtain the gh OAuth token.  Returns '' when gh is not installed
    // or not authenticated.
    const _getToken = (): string => {
      try {
        return execFileSync('gh', ['auth', 'token'], { encoding: 'utf-8', stdio: 'pipe' }).trim();
      } catch {
        return '';
      }
    };

        const token = _getToken();

    // Resolve the actual remote URL so we can embed the token directly.
    // url.insteadOf doesn't work reliably on Windows git-for-windows, so
    // we embed the token directly in the remote URL instead.
    let _remoteUrl: string | null = null;
    let _remoteIdx = -1;
    if (token) {
      try {
        for (let i = 1; i < pushArgs.length; i++) {
          if (!pushArgs[i].startsWith('-')) {
            _remoteIdx = i;
            _remoteUrl = execFileSync('git', ['remote', 'get-url', pushArgs[i]], {
              encoding: 'utf-8', stdio: 'pipe', cwd: this.projectRoot,
            }).trim();
            break;
          }
        }
      } catch {
        // Remote resolution failed — fall back to pushArgs as-is
      }
    }

    // Helper: inject the token via http.extraheader, keeping the remote name intact.
    // Previously this embedded the token in the URL (replacing 'origin' with the full
    // HTTPS URL). URL-embedding causes git to push to a raw URL rather than to the
    // named remote, so git never updates refs/remotes/origin/* locally — making the
    // post-push `git rev-parse origin/<branch>` verification fail even when the push
    // to GitHub succeeded. Using http.extraheader preserves 'origin' as the remote
    // name, so git correctly updates the local remote-tracking ref after the push.
    //
    // Auth format: git HTTPS uses HTTP Basic auth (not Bearer/OAuth2). The token is
    // the password with a dummy username — same credential as the old URL-embedded form
    // (https://x-access-token:TOKEN@...) but expressed as a Base64-encoded header so
    // the remote name is preserved.
    const _buildInjectedArgs = (t: string): string[] | null => {
      if (!t || _remoteIdx < 0 || !_remoteUrl?.startsWith('https://')) return null;
      const encoded = Buffer.from(`x-access-token:${t}`).toString('base64');
      return ['-c', `http.extraheader=Authorization: Basic ${encoded}`, ...pushArgs];
    };

    // ── Execute the git command.  On the first auth failure with a gh token,
    //     attempt to refresh the token via `gh auth refresh` and retry once.
    //     If the token is still rejected, falls back to the system credential
    //     helper (Windows Credential Manager / macOS Keychain). ──

    const AUTH_RE = /invalid username or token|authentication failed|http basic: access denied|returned error: 401\b/i;
    const _exec = (t: string, attempt: number): void => {
      const args = _buildInjectedArgs(t) ?? pushArgs;
      try {
        execFileSync('git', args, { cwd: this.projectRoot, stdio: 'pipe', env: noPromptEnv });
      } catch (err) {
        const raw = err instanceof Error ? err.message : String(err);
        const safe = t ? raw.replaceAll(t, '[REDACTED]') : raw;

        // Tier 1: On first auth failure with a gh token, refresh and retry once.
        // The try/catch only wraps the external CLI commands (gh auth refresh
        // and _getToken) — NOT the retry.  If the retry throws, the error
        // propagates up; if it were caught here Tier 2 would fire in the wrong
        // scope (attempt 0 instead of 1), consuming the mock chain incorrectly.
        if (attempt === 0 && t && AUTH_RE.test(raw)) {
          appendFileSync(logFile,
            '[GIT] gh token rejected by remote — attempting gh auth refresh\n');
          let freshToken = null;
          try {
            const hostname = _remoteUrl ? new URL(_remoteUrl).hostname : 'github.com';
            execFileSync('gh', ['auth', 'refresh', '-s', 'repo', '--hostname', hostname], {
              encoding: 'utf-8', stdio: 'pipe', timeout: 30_000,
            });
            freshToken = _getToken();
          } catch (refreshErr) {
            const refreshMsg = refreshErr instanceof Error
              ? refreshErr.message : String(refreshErr);
            appendFileSync(logFile, `[GIT] gh auth refresh failed: ${refreshMsg}\n`);
          }

          if (freshToken) {
            appendFileSync(logFile, '[GIT] Token refreshed — retrying\n');
            _exec(freshToken, 1);
            return;
          }
        }

        // Tier 2: gh token still rejected (even after refresh) — fall back
        // to the system credential helper.  On Windows this is the Credential
        // Manager; on macOS the Keychain.  credential.helper= is NOT used so
        // git resolves credentials through its normal chain.
        if (attempt <= 1 && t && AUTH_RE.test(raw)) {
          appendFileSync(logFile,
            '[GIT] gh token rejected — falling back to system credential helper\n');
          _exec('', 2);
          return;
        }

        throw new Error(safe);
      }
    };

    // Log token availability
    if (token) {
      appendFileSync(logFile, '[GIT] Using gh OAuth token via http.extraheader\n');
    } else {
      appendFileSync(logFile,
        '[GIT] gh token not available — falling back to default credential helper\n');
    }

    _exec(token, 0);
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
export { detectGitPlatform, detectDefaultBranch, buildPlatformPrompt } from './git-platform';
