/**
 * Phase runner functions extracted from orchestrator.ts.
 * runImplement and runQaReview remain inline in orchestrator.ts due to
 * deep test coupling and complex internal state dependencies.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, unlinkSync, appendFileSync, rmSync } from 'fs';
import path from 'path';
import { processManager } from '../process-manager';
import { TaskStore } from '../task-store';
import { detectGitPlatform, buildPlatformPrompt } from '../git-platform';
import { runSensors, sensorRunSummary, type SensorsConfig } from '../sensors';
import type { PipelinePhase } from '@/constants/phases';
import type { AgentSession } from '../process-manager';
import type { TaskPipeline, SessionOptsResult } from './types';

// ── Shared rebase helper ──────────────────────────────────────────────────

interface RebaseDeps {
  projectRoot: string;
  execGit: (args: string[], hostCwd: string) => void;
  sessionOpts: SessionOptsFn;
  waitForCompletion: (sessionId: string) => Promise<void>;
}

/**
 * Rebase the feature branch onto the latest origin/master before merge/PR.
 *
 * If the rebase has conflicts, spawns a merger agent to resolve them.
 * Returns true on success. On failure, the caller decides whether to throw
 * (merge path, where unresolved conflicts would corrupt the repo) or warn
 * (create-pr path, where the PR can still be reviewed and resolved manually).
 */
async function rebaseOntoLatestMaster(
  worktreePath: string,
  taskId: string,
  logFile: string,
  deps: RebaseDeps,
): Promise<boolean> {
  try {
    execFileSync('git', ['fetch', 'origin', 'master'], { cwd: deps.projectRoot, stdio: 'pipe' });
    deps.execGit(['rebase', 'origin/master'], worktreePath);
    appendFileSync(logFile, '\n[INFO] Feature branch rebased onto latest master\n');
    return true;
  } catch {
    try { deps.execGit(['rebase', '--abort'], worktreePath); } catch { /* ignore */ }
    appendFileSync(logFile, '\n[INFO] Rebase had conflicts — spawning merger to resolve via git merge\n');
    try {
      const mergeSessionId = await processManager.createSession(
        deps.sessionOpts('merger', worktreePath, taskId, logFile),
      );
      processManager.sendMessage(mergeSessionId, '/merge origin/master');
      await deps.waitForCompletion(mergeSessionId);
      processManager.killSession(mergeSessionId);
      appendFileSync(logFile, '\n[INFO] Merger resolved rebase conflicts\n');
      return true;
    } catch (mergeErr) {
      const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
      appendFileSync(logFile, `\n[WARN] Merger could not resolve rebase conflicts: ${mergeMsg}\n`);
      return false;
    }
  }
}

// ── Dependency interfaces ──

interface SessionOptsFn {
  (role: AgentSession['role'], cwd: string, taskId: string, logFile?: string): SessionOptsResult;
}

interface BasePhaseDeps {
  projectRoot: string;
  persistAndEmitPhase: (pipeline: TaskPipeline) => void;
  sessionOpts: SessionOptsFn;
  waitForCompletion: (sessionId: string) => Promise<void>;
  advancePhase: (pipeline: TaskPipeline, phase: PipelinePhase, eventExtra?: Record<string, unknown>) => void;
}

/** Shared callbacks for spec and plan — phases that cascade to the next phase. */
interface CascadePhaseDeps extends BasePhaseDeps {
  rotateOutputLog: (logFile: string) => void;
  phaseHeader: (logFile: string, phase: string) => void;
  savePipelineState: (pipeline: TaskPipeline) => void;
  toAgentPath: (hostPath: string) => string;
  executePhase: (pipeline: TaskPipeline) => Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────
//  runSpec — analyst creates the spec
// ─────────────────────────────────────────────────────────────────────

export async function runSpecPhase(
  pipeline: TaskPipeline,
  deps: CascadePhaseDeps,
): Promise<void> {
  const logFile = path.join(pipeline.specPath, 'output.log');
  deps.rotateOutputLog(logFile);
  deps.phaseHeader(logFile, 'spec');
  deps.persistAndEmitPhase(pipeline);
  const sessionId = await processManager.createSession(
    deps.sessionOpts('analyst', deps.projectRoot, pipeline.taskId, logFile),
  );
  pipeline.sessionId = sessionId;
  deps.savePipelineState(pipeline);
  const agentSpecPath = deps.toAgentPath(pipeline.specPath);

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
  await deps.waitForCompletion(sessionId);
  processManager.killSession(sessionId);
  if (isRevision && existsSync(revisionFeedbackPath)) {
    unlinkSync(revisionFeedbackPath);
  }
  deps.advancePhase(pipeline, 'plan');
  await deps.executePhase(pipeline);
}

// ─────────────────────────────────────────────────────────────────────
//  runPlan — planner creates the plan and worktree
// ─────────────────────────────────────────────────────────────────────

interface PlanPhaseDeps extends CascadePhaseDeps {
  gitPush: (pushArgs: string[], logFile: string) => void;
  execGit: (args: string[], hostCwd: string) => void;
}

export async function runPlanPhase(
  pipeline: TaskPipeline,
  deps: PlanPhaseDeps,
): Promise<void> {
  const logFile = path.join(pipeline.specPath, 'output.log');
  deps.rotateOutputLog(logFile);
  deps.phaseHeader(logFile, 'plan');
  deps.persistAndEmitPhase(pipeline);
  const sessionId = await processManager.createSession(
    deps.sessionOpts('planner', deps.projectRoot, pipeline.taskId, logFile),
  );
  pipeline.sessionId = sessionId;
  deps.savePipelineState(pipeline);
  processManager.sendMessage(sessionId, `/plan ${deps.toAgentPath(pipeline.specPath)}/spec.md`);
  await deps.waitForCompletion(sessionId);
  processManager.killSession(sessionId);

  try {
    deps.gitPush(['pull', '--ff-only', 'origin', 'master'], path.join(pipeline.specPath, 'output.log'));
  } catch { /* non-fast-forward or offline — proceed with local master */ }

  if (!existsSync(pipeline.worktreePath)) {
    if (path.resolve(pipeline.worktreePath) === path.resolve(deps.projectRoot)) {
      throw new Error('Refusing to create worktree at project root — this would destroy the repository');
    }
    try {
      deps.execGit(['worktree', 'add', pipeline.worktreePath, '-b', pipeline.branch], deps.projectRoot);
    } catch {
      if (existsSync(pipeline.worktreePath)) {
        try { rmSync(pipeline.worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
        try { execFileSync('git', ['worktree', 'prune'], { cwd: deps.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
      }
      deps.execGit(['worktree', 'add', pipeline.worktreePath, pipeline.branch], deps.projectRoot);
    }
  }

  deps.advancePhase(pipeline, 'implement');
  await deps.executePhase(pipeline);
}

// ─────────────────────────────────────────────────────────────────────
//  runMerge — merger merges the feature branch
// ─────────────────────────────────────────────────────────────────────

interface MergePhaseDeps extends BasePhaseDeps {
  execGit: (args: string[], hostCwd: string) => void;
  phaseHeader: (logFile: string, phase: string) => void;
  commitArtifactsToWorktree: (pipeline: TaskPipeline) => void;
  getPipelineConfig: () => { maxQaAttempts: number; parallelSubtasks: boolean; sensors?: SensorsConfig };
  removeWorktree: (taskId: string) => void;
}

export async function runMergePhase(
  pipeline: TaskPipeline,
  deps: MergePhaseDeps,
): Promise<void> {
  deps.persistAndEmitPhase(pipeline);
  const logFile = path.join(pipeline.specPath, 'output.log');
  deps.phaseHeader(logFile, 'merge');

  // Rebase onto latest master before merging so the diff only contains the
  // ticket's actual changes, not drift from an old worktree snapshot.
  const rebaseOk = await rebaseOntoLatestMaster(
    pipeline.worktreePath, pipeline.taskId, logFile,
    { projectRoot: deps.projectRoot, execGit: deps.execGit, sessionOpts: deps.sessionOpts, waitForCompletion: deps.waitForCompletion },
  );
  if (!rebaseOk) {
    throw new Error(
      'Rebase onto latest master failed with conflicts that could not be resolved. ' +
      'The target branch has likely diverged too far from master. ' +
      'Consider stopping and restarting the task to recreate the worktree from the latest master.'
    );
  }

  deps.commitArtifactsToWorktree(pipeline);

  const pipelineConfig = deps.getPipelineConfig();
  if (pipelineConfig.sensors?.pre_merge?.length) {
    const planPath = path.join(pipeline.specPath, 'plan.json');
    let allFiles: string[] = [];
    if (existsSync(planPath)) {
      try {
        const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
        allFiles = (plan.subtasks || []).flatMap((s: { files?: string[] }) => s.files || []);
      } catch { /* best-effort */ }
    }
    const mergeResult = await runSensors(pipelineConfig.sensors.pre_merge, 'pre_merge', {
      cwd: pipeline.worktreePath,
      specPath: pipeline.specPath,
      files: allFiles,
      logFile,
    });
    appendFileSync(logFile, sensorRunSummary(mergeResult));
    if (!mergeResult.allPassed) {
      const failMsg = mergeResult.reports.filter(r => !r.passed).map(r => r.sensor + ': ' + (r.error || 'exit ' + r.exitCode)).join('; ');
      throw new Error('Pre-merge sensors failed: ' + failMsg);
    }
  }

  const sessionId = await processManager.createSession(
    deps.sessionOpts('merger', deps.projectRoot, pipeline.taskId, logFile),
  );
  pipeline.sessionId = sessionId;
  processManager.sendMessage(sessionId, `/merge ${pipeline.branch}`);
  await deps.waitForCompletion(sessionId);
  processManager.killSession(sessionId);

  deps.removeWorktree(pipeline.taskId);
  deps.advancePhase(pipeline, 'done');
}

// ─────────────────────────────────────────────────────────────────────
//  runCreatePR — creates a pull request
// ─────────────────────────────────────────────────────────────────────

interface CreatePRDeps extends BasePhaseDeps {
  taskStore: TaskStore;
  execGit: (args: string[], hostCwd: string) => void;
  commitArtifactsToWorktree: (pipeline: TaskPipeline) => void;
  gitPush: (pushArgs: string[], logFile: string) => void;
  extractPrUrl: (logFile: string) => string | null;
}

export async function runCreatePRPhase(
  pipeline: TaskPipeline,
  deps: CreatePRDeps,
): Promise<void> {
  deps.persistAndEmitPhase(pipeline);
  const logFile = path.join(pipeline.specPath, 'output.log');

  // Rebase onto latest master so the PR diff only contains the ticket's actual changes.
  const rebaseOk = await rebaseOntoLatestMaster(
    pipeline.worktreePath, pipeline.taskId, logFile,
    { projectRoot: deps.projectRoot, execGit: deps.execGit, sessionOpts: deps.sessionOpts, waitForCompletion: deps.waitForCompletion },
  );
  if (rebaseOk) {
    appendFileSync(logFile, '\n[INFO] PR will be conflict-free\n');
  } else {
    appendFileSync(logFile, '\n[WARN] PR may require manual conflict resolution\n');
  }

  deps.commitArtifactsToWorktree(pipeline);
  deps.gitPush(['push', '-u', '--force', 'origin', pipeline.branch], logFile);

  const sessionId = await processManager.createSession({
    ...deps.sessionOpts('merger', deps.projectRoot, pipeline.taskId, logFile),
    projectRoot: undefined,
  });
  pipeline.sessionId = sessionId;

  const specContent = readFileSync(path.join(pipeline.specPath, 'spec.md'), 'utf-8');
  const platform = detectGitPlatform(deps.projectRoot);
  const platformMsg = buildPlatformPrompt(platform, pipeline.branch, pipeline.description, specContent, deps.projectRoot);
  processManager.sendMessage(sessionId, platformMsg);
  await deps.waitForCompletion(sessionId);
  processManager.killSession(sessionId);

  const prUrl = deps.extractPrUrl(logFile);

  deps.taskStore.update(pipeline.taskId, {
    platform: platform !== 'unknown' ? platform : undefined,
    ...(prUrl ? { prUrl } : {}),
  });

  deps.advancePhase(pipeline, 'pr-open', {
    ...(prUrl ? { prUrl } : {}),
    ...(platform !== 'unknown' ? { platform } : {}),
  });
}
