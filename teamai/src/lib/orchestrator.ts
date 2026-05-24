import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync } from 'fs';
import path from 'path';
import { warn as logWarn } from './logger';
import { processManager, type AgentSession } from './process-manager';
import { readContainerConfig, readContainerRemoteUser, containerManager, hostToContainerPath, dockerAvailable, _resetDockerAvailableCache } from './container-manager';
import { TaskStore } from './task-store';
import { resolveProvider, providerToSessionOpts } from './providers';
import { slugify } from './utils';

interface PlanSubtask {
  id: number;
  title: string;
  description: string;
  files: string[];
  acceptance_criteria: string[];
  parallel_group?: string;
  completed?: boolean;
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
}

const PIPELINE_TIMEOUT_MS = 600_000; // 10 minutes

class RateLimitError extends Error {
  constructor(public resetsAt: number) {
    super(`Rate limited until ${new Date(resetsAt * 1000).toISOString()}`);
  }
}

type PipelinePhase =
  | 'spec'
  | 'plan'
  | 'implement'
  | 'qa-review'
  | 'awaiting-review'
  | 'merge'
  | 'create-pr'
  | 'done'
  | 'failed';

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

  private getPipelineConfig(): { phases: string[]; maxQaAttempts: number; parallelSubtasks: boolean } {
    const cfgPath = path.join(this.projectRoot, '.teamai', 'pipeline.json');
    if (existsSync(cfgPath)) {
      try { return JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch (err) { logWarn('orchestrator', 'Failed to parse pipeline config, using defaults', err); }
    }
    return { phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'], maxQaAttempts: 3, parallelSubtasks: true };
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
    const noRunPhases = ['backlog', 'awaiting-review', 'failed', 'done'];
    if (noRunPhases.includes(targetPhase)) {
      // Auto-delete the git worktree when moving to 'done'
      if (targetPhase === 'done') {
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
    };

    // Use provided startPhase, else first phase in config
    const firstPhase = startPhase ?? (config.phases[0] ?? 'spec') as PipelinePhase;
    pipeline.phase = firstPhase;

    this.pipelines.set(taskId, pipeline);
    this.taskStore.update(taskId, { branch });
    this.advancePhase(pipeline, firstPhase);
    try {
      await this.executePhase(pipeline);
    } catch (e) {
      if (e instanceof RateLimitError) {
        this.handleRateLimit(pipeline, e.resetsAt);
      } else {
        console.error(`[orchestrator] Task ${taskId} failed:`, e);
        this.advancePhase(pipeline, 'failed');
      }
    } finally {
      // Release lock after pipeline completes or fails.
      // For rate-limited tasks the lock is re-acquired in handleRateLimit.
      this.pipelines.delete(taskId);
      this.activeTasks.delete(taskId);
    }
  }

  async approveTask(taskId: string, strategy: MergeStrategy): Promise<void> {
    const pipeline = this.pipelines.get(taskId) ?? this.restorePipeline(taskId, 'awaiting-review');
    pipeline.mergeStrategy = strategy;
    const next = strategy === 'local-merge' ? 'merge' : 'create-pr';
    this.advancePhase(pipeline, next);
    await this.executePhase(pipeline);
  }

  async rejectTask(taskId: string, feedback: string): Promise<void> {
    const pipeline = this.pipelines.get(taskId) ?? this.restorePipeline(taskId, 'awaiting-review');
    const feedbackPath = path.join(pipeline.specPath, 'human_feedback.md');
    writeFileSync(feedbackPath, `# Human Review Feedback\n\n${feedback}\n`);
    pipeline.qaAttempt = 0;
    this.advancePhase(pipeline, 'implement');
    await this.executePhase(pipeline);
  }

  private async executePhase(pipeline: TaskPipeline): Promise<void> {
    switch (pipeline.phase) {
      case 'spec':         return this.runSpec(pipeline);
      case 'plan':         return this.runPlan(pipeline);
      case 'implement':    return this.runImplement(pipeline);
      case 'qa-review':    return this.runQaReview(pipeline);
      case 'awaiting-review': return; // Paused — waiting for human
      case 'merge':        return this.runMerge(pipeline);
      case 'create-pr':    return this.runCreatePR(pipeline);
    }
  }

  private async runSpec(pipeline: TaskPipeline): Promise<void> {
    const logFile = path.join(pipeline.specPath, 'output.log');
    this._phaseHeader(logFile, 'spec');
    const sessionId = await processManager.createSession(this.sessionOpts('analyst', this.projectRoot, pipeline.taskId, logFile));
    pipeline.sessionId = sessionId;
    // Pass the explicit output path so the agent writes spec.md to the task's directory,
    // not a new directory derived from the description slug.
    const agentSpecPath = this._toAgentPath(pipeline.specPath);
    processManager.sendMessage(sessionId,
      `/spec ${pipeline.description}\n\nIMPORTANT: Write the spec file to \`${agentSpecPath}/spec.md\` (use this exact path, not a new subdirectory).`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);
    this.advancePhase(pipeline, 'plan');
    await this.executePhase(pipeline);
  }

  private async runPlan(pipeline: TaskPipeline): Promise<void> {
    const logFile = path.join(pipeline.specPath, 'output.log');
    this._phaseHeader(logFile, 'plan');
    const sessionId = await processManager.createSession(this.sessionOpts('planner', this.projectRoot, pipeline.taskId, logFile));
    pipeline.sessionId = sessionId;
    processManager.sendMessage(sessionId, `/plan ${this._toAgentPath(pipeline.specPath)}/spec.md`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    try {
      this._execGit(['worktree', 'add', pipeline.worktreePath, '-b', pipeline.branch], this.projectRoot);
    } catch {
      // Branch already exists (e.g. from a previous failed attempt) — reuse it
      this._execGit(['worktree', 'add', pipeline.worktreePath, pipeline.branch], this.projectRoot);
    }

    this.advancePhase(pipeline, 'implement');
    await this.executePhase(pipeline);
  }

  private async runImplement(pipeline: TaskPipeline): Promise<void> {
    // Fail fast if Docker is not available — prevents silent no-op runs where all sessions exit
    // immediately and QA marks the task failed on an empty diff.
    if (readContainerConfig(this.projectRoot).enabled) {
      _resetDockerAvailableCache(); // fresh check every pipeline start (don't use stale cached result)
      if (!dockerAvailable()) {
        throw new Error('Docker is not running. Start Docker Desktop and move the task back to In Progress to retry.');
      }
    }

    // Ensure worktree exists — may be absent when resuming directly to implement
    if (!existsSync(pipeline.worktreePath)) {
      try {
        this._execGit(['worktree', 'add', pipeline.worktreePath, '-b', pipeline.branch], this.projectRoot);
      } catch {
        this._execGit(['worktree', 'add', pipeline.worktreePath, pipeline.branch], this.projectRoot);
      }
    }

    const planPath = path.join(pipeline.specPath, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    // Honour per-task role override set by the user in the UI
    const task = this.taskStore.getById(pipeline.taskId);
    const coderRole = (task?.roleOverride ?? 'coder.md').replace('.md', '') as AgentSession['role'];

    // Check for QA feedback if bouncing back from QA
    const qaFeedbackPath = path.join(pipeline.specPath, 'qa_feedback.md');
    const hasQaFeedback = existsSync(qaFeedbackPath);
    let qaFeedbackContent = '';
    if (hasQaFeedback) {
      const fullFeedback = readFileSync(qaFeedbackPath, 'utf-8');
      qaFeedbackContent = fullFeedback;
    }

    const groups = new Map<string, PlanSubtask[]>();
    for (const subtask of plan.subtasks) {
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

          const prompt =
            (hasQaFeedback && qaFeedbackContent
              ? `## ⚠️ QA FEEDBACK — FIX THESE FIRST ⚠️\n\n` +
                `${qaFeedbackContent}\n\n` +
                `---\n`
              : '') +
            `/implement Subtask ${subtask.id}: ${subtask.title}\n\n` +
            `${subtask.description}\n\n` +
            `Files: ${subtask.files.join(', ')}\n\n` +
            `Acceptance criteria: ${subtask.acceptance_criteria.join('; ')}`;
          processManager.sendMessage(sessionId, prompt);
          await this.waitForCompletion(sessionId);
          processManager.killSession(sessionId);

          completedIds.push(subtask.id);
        })
      );
      // If every session in the group failed (e.g. container unavailable), surface the first
      // error rather than silently advancing to QA on an empty diff.
      if (results.every(r => r.status === 'rejected')) {
        const firstReason = (results[0] as PromiseRejectedResult).reason;
        throw firstReason instanceof Error ? firstReason : new Error(String(firstReason));
      }
      // Write all completions for this group at once to avoid read-modify-write races
      if (completedIds.length > 0) {
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
      }
    }

    // Clean up QA feedback after implementing
    if (hasQaFeedback && existsSync(qaFeedbackPath)) {
      unlinkSync(qaFeedbackPath);
    }

    this.advancePhase(pipeline, 'qa-review');
    await this.executePhase(pipeline);
  }

  private async runQaReview(pipeline: TaskPipeline): Promise<void> {
    pipeline.qaAttempt++;
    const logFile = path.join(pipeline.specPath, 'output.log');
    this._phaseHeader(logFile, `qa-review (attempt ${pipeline.qaAttempt})`);
    const sessionId = await processManager.createSession(this.sessionOpts('qa-reviewer', pipeline.worktreePath, pipeline.taskId, logFile));
    pipeline.sessionId = sessionId;
    processManager.sendMessage(sessionId, `/qa-review ${this._toAgentPath(pipeline.specPath)}/spec.md`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    const reportPath = path.join(pipeline.specPath, 'qa_report.json');
    const report = JSON.parse(readFileSync(reportPath, 'utf-8'));

    if (report.overall === 'PASS') {
      this.advancePhase(pipeline, 'awaiting-review');
    } else if (pipeline.qaAttempt >= pipeline.maxQaAttempts) {
      // Write completion summary before marking as failed
      this._writeCompletionSummary(pipeline);
      this.advancePhase(pipeline, 'failed');
    } else {
      // Write QA feedback and bounce back to implement instead of auto-fixing
      this._writeQaFeedback(pipeline, report);
      this.advancePhase(pipeline, 'implement');
      await this.executePhase(pipeline);
    }
  }

  private async runMerge(pipeline: TaskPipeline): Promise<void> {
    const logFile = path.join(pipeline.specPath, 'output.log');
    this._phaseHeader(logFile, 'merge');
    const sessionId = await processManager.createSession(this.sessionOpts('merger', this.projectRoot, pipeline.taskId, logFile));
    pipeline.sessionId = sessionId;
    processManager.sendMessage(sessionId, `/merge ${pipeline.branch}`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    this._execGit(['worktree', 'remove', pipeline.worktreePath], this.projectRoot);
    this._execGit(['branch', '-d', pipeline.branch], this.projectRoot);

    this.advancePhase(pipeline, 'done');
  }

  private async runCreatePR(pipeline: TaskPipeline): Promise<void> {
    this._execGit(['push', '-u', 'origin', pipeline.branch], pipeline.worktreePath);

    const logFile = path.join(pipeline.specPath, 'output.log');
    const sessionId = await processManager.createSession(this.sessionOpts('merger', pipeline.worktreePath, pipeline.taskId, logFile));
    pipeline.sessionId = sessionId;

    const specContent = readFileSync(path.join(pipeline.specPath, 'spec.md'), 'utf-8');
    const platform = detectGitPlatform(this.projectRoot);
    const platformMsg = buildPlatformPrompt(platform, pipeline.branch, pipeline.description, specContent, this.projectRoot);
    processManager.sendMessage(sessionId, platformMsg);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    // Extract PR URL from the agent's output
    const prUrl = this._extractPrUrl(logFile);

    this.taskStore.update(pipeline.taskId, {
      platform: platform !== 'unknown' ? platform : undefined,
      ...(prUrl ? { prUrl } : {}),
    });

    this.advancePhase(pipeline, 'done');
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

  private advancePhase(pipeline: TaskPipeline, phase: PipelinePhase): void {
    pipeline.phase = phase;
    this.taskStore.updatePhase(pipeline.taskId, phase);
    processManager.emit('phase-change', { taskId: pipeline.taskId, phase });
  }

  private waitForCompletion(sessionId: string, timeoutMs: number = PIPELINE_TIMEOUT_MS): Promise<void> {
    return new Promise((resolve, reject) => {
      let rateLimitResetsAt: number | null = null;
      let settled = false;

      const cleanup = () => {
        processManager.off('event', onEvent);
        processManager.off('exit', onExit);
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
          settled = true;
          cleanup();
          clearTimeout(timeout);
          if (event.is_error && rateLimitResetsAt) {
            reject(new RateLimitError(rateLimitResetsAt));
          } else {
            resolve();
          }
        }
      };
      const onExit = ({ sessionId: sid, code }: { sessionId: string; code: number | null }) => {
        if (sid !== sessionId) return;
        settled = true;
        cleanup();
        clearTimeout(timeout);
        if (code === 0 || code === null) resolve();
        else if (rateLimitResetsAt) reject(new RateLimitError(rateLimitResetsAt));
        else reject(new Error(`Session exited with code ${code}`));
      };

      processManager.on('event', onEvent);
      processManager.on('exit', onExit);

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        processManager.killSession(sessionId);
        reject(new Error(`Pipeline timed out after ${timeoutMs / 60000} minutes`));
      }, timeoutMs);
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

  private _execGit(args: string[], hostCwd: string): void {
    if (readContainerConfig(this.projectRoot).enabled) {
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
    const pipelineOrder = this.getPipelineConfig().phases;
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
      // Reset subtask completions so implement phases re-do all work from scratch
      const planPath = path.join(dir, 'plan.json');
      try {
        const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
        if (plan.subtasks) {
          for (const s of plan.subtasks) s.completed = false;
        }
        writeFileSync(planPath, JSON.stringify(plan, null, 2));
      } catch { /* best-effort */ }
    } else if (hasSpec) {
      startPhase = 'plan';
    } else {
      startPhase = 'spec';
    }

    // Clear output.log for a fresh terminal view
    const outputPath = path.join(dir, 'output.log');
    try { if (existsSync(outputPath)) unlinkSync(outputPath); } catch { /* best-effort */ }

    await this.runTask(taskId, task.description, startPhase);
  }

  /** Get the filesystem path to this task's git worktree, or null if the task has no branch. */
  public getWorktreePath(taskId: string): string | null {
    const task = this.taskStore.getById(taskId);
    if (!task || !task.branch) return null;
    const slug = slugify(task.description);
    return path.join(this.getWorktreeBase(), slug);
  }

  /** Remove the git worktree for this task if it exists on disk. Silently no-ops if not found. */
  private removeWorktree(taskId: string): void {
    const wtPath = this.getWorktreePath(taskId);
    if (!wtPath || !existsSync(wtPath)) return;
    try {
      this._execGit(['worktree', 'remove', wtPath], this.projectRoot);
      this.taskStore.update(taskId, { branch: undefined });
    } catch {
      // Worktree removal can fail if there are uncommitted changes; ignore silently
    }
  }

  /** Force-remove the git worktree (discards uncommitted changes). Used during cleanup. */
  private _removeWorktreeForce(taskId: string): void {
    const wtPath = this.getWorktreePath(taskId);
    if (!wtPath || !existsSync(wtPath)) return;
    try {
      this._execGit(['worktree', 'remove', '--force', wtPath], this.projectRoot);
    } catch { /* best-effort */ }
    this.taskStore.update(taskId, { branch: undefined });
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
                    modified = true;
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
                  subtask.acceptance_criteria.push(`[QA ISSUE: ${desc}${fix ? ` → Fix: ${fix}` : ''}]`);
                  modified = true;
                  break;
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
  const base = `Create a Pull Request for branch "${branch}" targeting the ${defaultBranch} branch.\n\n`;
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
