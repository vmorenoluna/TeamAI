import { execSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { processManager } from './process-manager';
import { TaskStore } from './task-store';

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
  private taskStore: TaskStore;

  constructor(private projectRoot: string) {
    this.taskStore = new TaskStore(projectRoot);
  }

  private getPipelineConfig(): { phases: string[]; maxQaAttempts: number; parallelSubtasks: boolean } {
    const cfgPath = path.join(this.projectRoot, '.teamai', 'pipeline.json');
    if (existsSync(cfgPath)) {
      try { return JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch { /* use defaults */ }
    }
    return { phases: ['spec', 'plan', 'implement', 'qa-review', 'merge'], maxQaAttempts: 3, parallelSubtasks: true };
  }

  async runTask(taskId: string, description: string): Promise<void> {
    const config = this.getPipelineConfig();
    const slug = this.slugify(description);
    const branch = `feat/${slug}`;
    const worktreePath = path.join(this.projectRoot, '..', 'worktrees', slug);
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

    // Skip phases not in the config (e.g. if spec is removed, start from plan)
    const firstPhase = (config.phases[0] ?? 'spec') as PipelinePhase;
    pipeline.phase = firstPhase;

    this.pipelines.set(taskId, pipeline);
    this.taskStore.update(taskId, { branch }); // persist branch so review panel can read it
    this.advancePhase(pipeline, 'spec');
    await this.executePhase(pipeline);
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
    const sessionId = processManager.createSession({
      taskId: pipeline.taskId, role: 'planner', cwd: this.projectRoot,
    });
    pipeline.sessionId = sessionId;
    processManager.sendMessage(sessionId, `/spec ${pipeline.description}`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);
    this.advancePhase(pipeline, 'plan');
    await this.executePhase(pipeline);
  }

  private async runPlan(pipeline: TaskPipeline): Promise<void> {
    const sessionId = processManager.createSession({
      taskId: pipeline.taskId, role: 'planner', cwd: this.projectRoot,
    });
    pipeline.sessionId = sessionId;
    processManager.sendMessage(sessionId, `/plan ${pipeline.specPath}/spec.md`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    execSync(
      `git worktree add "${pipeline.worktreePath}" -b "${pipeline.branch}"`,
      { cwd: this.projectRoot }
    );

    this.advancePhase(pipeline, 'implement');
    await this.executePhase(pipeline);
  }

  private async runImplement(pipeline: TaskPipeline): Promise<void> {
    const planPath = path.join(pipeline.specPath, 'plan.json');
    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));

    const groups = new Map<string, any[]>();
    for (const subtask of plan.subtasks) {
      const group = subtask.parallel_group || String(subtask.id);
      if (!groups.has(group)) groups.set(group, []);
      groups.get(group)!.push(subtask);
    }

    for (const [, subtasks] of groups) {
      await Promise.allSettled(
        subtasks.map(async (subtask: any) => {
          const sessionId = processManager.createSession({
            taskId: pipeline.taskId, role: 'coder', cwd: pipeline.worktreePath,
          });
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
    const sessionId = processManager.createSession({
      taskId: pipeline.taskId, role: 'qa-reviewer', cwd: pipeline.worktreePath,
    });
    pipeline.sessionId = sessionId;
    processManager.sendMessage(sessionId, `/qa-review ${pipeline.specPath}/spec.md`);
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
    const sessionId = processManager.createSession({
      taskId: pipeline.taskId, role: 'qa-fixer', cwd: pipeline.worktreePath,
    });
    pipeline.sessionId = sessionId;
    processManager.sendMessage(sessionId, `/qa-fix ${pipeline.specPath}/qa_report.json`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);
    this.advancePhase(pipeline, 'qa-review');
    await this.executePhase(pipeline);
  }

  private async runMerge(pipeline: TaskPipeline): Promise<void> {
    const sessionId = processManager.createSession({
      taskId: pipeline.taskId, role: 'merger', cwd: this.projectRoot,
    });
    pipeline.sessionId = sessionId;
    processManager.sendMessage(sessionId, `/merge ${pipeline.branch}`);
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    execSync(`git worktree remove "${pipeline.worktreePath}"`, { cwd: this.projectRoot });
    execSync(`git branch -d "${pipeline.branch}"`, { cwd: this.projectRoot });

    this.advancePhase(pipeline, 'done');
  }

  private async runCreatePR(pipeline: TaskPipeline): Promise<void> {
    execSync(`git push -u origin "${pipeline.branch}"`, { cwd: pipeline.worktreePath });

    const sessionId = processManager.createSession({
      taskId: pipeline.taskId, role: 'merger', cwd: pipeline.worktreePath,
    });
    pipeline.sessionId = sessionId;

    const specContent = readFileSync(path.join(pipeline.specPath, 'spec.md'), 'utf-8');
    processManager.sendMessage(
      sessionId,
      `Create a Pull Request for branch "${pipeline.branch}" targeting the main branch.\n\n` +
      `Use the GitHub MCP server's create_pull_request tool.\n\n` +
      `Title: ${pipeline.description}\n\n` +
      `Body: Generate a clear PR description from this spec:\n\n${specContent}\n\n` +
      `Include a summary of changes, testing done (QA passed), and any notes for reviewers.`
    );
    await this.waitForCompletion(sessionId);
    processManager.killSession(sessionId);

    this.advancePhase(pipeline, 'done');
  }

  private advancePhase(pipeline: TaskPipeline, phase: PipelinePhase): void {
    pipeline.phase = phase;
    this.taskStore.updatePhase(pipeline.taskId, phase);
    processManager.emit('phase-change', { taskId: pipeline.taskId, phase });
  }

  private waitForCompletion(sessionId: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onEvent = ({ sessionId: sid, event }: any) => {
        if (sid !== sessionId) return;
        if (event.type === 'result') {
          processManager.off('event', onEvent);
          processManager.off('exit', onExit);
          resolve();
        }
      };
      const onExit = ({ sessionId: sid, code }: any) => {
        if (sid !== sessionId) return;
        processManager.off('event', onEvent);
        processManager.off('exit', onExit);
        if (code === 0 || code === null) resolve();
        else reject(new Error(`Session exited with code ${code}`));
      };
      processManager.on('event', onEvent);
      processManager.on('exit', onExit);
    });
  }

  private slugify(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40);
  }
}

// Store on global for the same reason as processManager — shared across module contexts
declare global {
  // eslint-disable-next-line no-var
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
