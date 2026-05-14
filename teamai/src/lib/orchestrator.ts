import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import path from 'path';
import { warn as logWarn } from './logger';
import { processManager, type AgentSession } from './process-manager';
import { readContainerConfig, containerManager, hostToContainerPath } from './container-manager';
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
}

interface RateLimitInfo {
  status: string;
  resetsAt?: number;
}

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
  | 'qa-fix'
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
    const pipeline = this.pipelines.get(taskId);
    if (!pipeline || pipeline.phase !== 'awaiting-review') {
      throw new Error(`Task ${taskId} is not awaiting review`);
    }
    pipeline.mergeStrategy = strategy;
    const next = strategy === 'local-merge' ? 'merge' : 'create-pr';
    this.advancePhase(pipeline, next);
    await this.executePhase(pipeline);
  }

  async rejectTask(taskId: string, feedback: string): Promise<void> {
    const pipeline = this.pipelines.get(taskId);
    if (!pipeline || pipeline.phase !== 'awaiting-review') {
      throw new Error(`Task ${taskId} is not awaiting review`);
    }
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
      case 'qa-fix':       return this.runQaFix(pipeline);
      case 'awaiting-review': return; // Paused — waiting for human
      case 'merge':        return this.runMerge(pipeline);
      case 'create-pr':    return this.runCreatePR(pipeline);
    }
  }

  private async runSpec(pipeline: TaskPipeline): Promise<void> {
    const logFile = path.join(pipeline.specPath, 'output.log');
    this._phaseHeader(logFile, 'spec');
    const sessionId = await processManager.createSession(this.sessionOpts('planner', this.projectRoot, pipeline.taskId, logFile));
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

    this._execGit(['worktree', 'add', pipeline.worktreePath, '-b', pipeline.branch], this.projectRoot);

    this.advancePhase(pipeline, 'implement');
    await this.executePhase(pipeline);
  }

  private async runImplement(pipeline: TaskPipeline): Promise<void> {
    const planPath = path.join(pipeline.specPath, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    // Honour per-task role override set by the user in the UI
    const task = this.taskStore.getById(pipeline.taskId);
    const coderRole = (task?.roleOverride ?? 'coder.md').replace('.md', '') as AgentSession['role'];

    const groups = new Map<string, PlanSubtask[]>();
    for (const subtask of plan.subtasks) {
      const group = subtask.parallel_group || String(subtask.id);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(subtask);
    }

    const logFile = path.join(pipeline.specPath, 'output.log');
    for (const [, subtasks] of groups) {
      await Promise.allSettled(
        subtasks.map(async (subtask: PlanSubtask) => {
          this._phaseHeader(logFile, `implement — subtask ${subtask.id}: ${subtask.title}`);
          const sessionId = await processManager.createSession(this.sessionOpts(coderRole, pipeline.worktreePath, pipeline.taskId, logFile));
          const prompt =
            `/implement Subtask ${subtask.id}: ${subtask.title}\n\n` +
            `${subtask.description}\n\n` +
            `Files: ${subtask.files.join(', ')}\n\n` +
            `Acceptance criteria: ${subtask.acceptance_criteria.join('; ')}`;
          processManager.sendMessage(sessionId, prompt);
          await this.waitForCompletion(sessionId);
          processManager.killSession(sessionId);
        })
      );
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
      this.advancePhase(pipeline, 'failed');
    } else {
      this.advancePhase(pipeline, 'qa-fix');
      await this.executePhase(pipeline);
    }
  }

  private async runQaFix(pipeline: TaskPipeline): Promise<void> {
    const logFile = path.join(pipeline.specPath, 'output.log');
    this._phaseHeader(logFile, 'qa-fix');
    const sessionId = await processManager.createSession(this.sessionOpts('qa-fixer', pipeline.worktreePath, pipeline.taskId, logFile));
    pipeline.sessionId = sessionId;
    processManager.sendMessage(sessionId, `/qa-fix ${this._toAgentPath(pipeline.specPath)}/qa_report.json`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);
    this.advancePhase(pipeline, 'qa-review');
    await this.executePhase(pipeline);
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

    const sessionId = await processManager.createSession(this.sessionOpts('merger', pipeline.worktreePath, pipeline.taskId));
    pipeline.sessionId = sessionId;

    const specContent = readFileSync(path.join(pipeline.specPath, 'spec.md'), 'utf-8');
    const platform = detectGitPlatform(this.projectRoot);
    const platformMsg = buildPlatformPrompt(platform, pipeline.branch, pipeline.description, specContent, this.projectRoot);
    processManager.sendMessage(sessionId, platformMsg);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);



    this.taskStore.update(pipeline.taskId, { platform: platform !== 'unknown' ? platform : undefined });

    this.advancePhase(pipeline, 'done');
  }

  private advancePhase(pipeline: TaskPipeline, phase: PipelinePhase): void {
    pipeline.phase = phase;
    this.taskStore.updatePhase(pipeline.taskId, phase);
    processManager.emit('phase-change', { taskId: pipeline.taskId, phase });
  }

  private waitForCompletion(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      let rateLimitResetsAt: number | null = null;

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
          processManager.off('event', onEvent);
          processManager.off('exit', onExit);
          if (event.is_error && rateLimitResetsAt) {
            reject(new RateLimitError(rateLimitResetsAt));
          } else {
            resolve();
          }
        }
      };
      const onExit = ({ sessionId: sid, code }: { sessionId: string; code: number | null }) => {
        if (sid !== sessionId) return;
        processManager.off('event', onEvent);
        processManager.off('exit', onExit);
        if (code === 0 || code === null) resolve();
        else if (rateLimitResetsAt) reject(new RateLimitError(rateLimitResetsAt));
        else reject(new Error(`Session exited with code ${code}`));
      };
      processManager.on('event', onEvent);
      processManager.on('exit', onExit);
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
        execFileSync('docker', ['exec', '-u', 'node', '-w', containerCwd, info.containerId, 'git', ...mappedArgs]);
        return;
      }
    }
    execFileSync('git', args, { cwd: hostCwd });
  }

  private getWorktreeBase(): string {
    return readContainerConfig(this.projectRoot).enabled
      ? path.join(this.projectRoot, '.worktrees')
      : path.join(this.projectRoot, '..', 'worktrees');
  }

  private sessionOpts(role: AgentSession['role'], cwd: string, taskId: string, logFile?: string) {
    const providerCfg = resolveProvider(this.projectRoot, role);
    const providerOpts = providerToSessionOpts(providerCfg);
    return { taskId, role, cwd, projectRoot: this.projectRoot, permissionMode: 'bypassPermissions', logFile, ...providerOpts };
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
