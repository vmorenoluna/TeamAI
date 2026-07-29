/**
 * Phase runner functions extracted from orchestrator.ts.
 * runImplement and runQaReview remain inline in orchestrator.ts due to
 * deep test coupling and complex internal state dependencies.
 */
import { execFileSync } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync, rmSync } from 'fs';
import path from 'path';
import { processManager } from '../process-manager';
import { TaskStore } from '../task-store';
import { detectGitPlatform, checkExistingPRViaCLI, createPRViaCLI, buildPRBody } from '../git-platform';
import { runSensors, sensorRunSummary, type SensorsConfig } from '../sensors';
import { resolveBaseBranch } from '../git-platform';
import { updateSessionMap, logToOutput } from './helpers';
import { WorktreeError, PipelineConfigError } from './errors';
import type { PipelinePhase } from '@/constants/phases';
import type { AgentSession } from '../process-manager';
import type { TaskPipeline, SessionOptsResult } from './types';

// ── Shared rebase helper ──────────────────────────────────────────────────

export interface RebaseDeps {
  projectRoot: string;
  execGit: (args: string[], hostCwd: string) => void;
  sessionOpts: SessionOptsFn;
  waitForCompletion: (sessionId: string) => Promise<void>;
}

/**
 * Rebase the feature branch onto the latest origin/master before merge/PR.
 *
 * Skips the rebase entirely when origin/<baseBranch> has not advanced
 * past the worktree's HEAD — saves a redundant merger spawn and test
 * suite run for a no-op (#3).
 *
 * If the rebase has conflicts, spawns a merger agent to resolve them.
 * Returns true on success. On failure, the caller decides whether to throw
 * (merge path, where unresolved conflicts would corrupt the repo) or warn
 * (create-pr path, where the PR can still be reviewed and resolved manually).
 */
export async function rebaseOntoLatestDefault(
  worktreePath: string,
  taskId: string,
  logFile: string,
  deps: RebaseDeps & { baseBranch: string },
): Promise<boolean> {
  try {
    execFileSync('git', ['fetch', 'origin', deps.baseBranch], { cwd: deps.projectRoot, stdio: 'pipe' });
  } catch {
    logToOutput(path.dirname(logFile), `\n[WARN] Could not fetch origin/${deps.baseBranch} — proceeding with rebase anyway\n`);
  }

  // Skip rebase when origin/<baseBranch> has not advanced past HEAD.
  // This avoids spawning a redundant merger + full test suite for a no-op,
  // which was wasting sessions on nearly every phase transition (#3).
  try {
    const count = execFileSync(
      'git', ['rev-list', '--count', `HEAD..origin/${deps.baseBranch}`],
      { cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe' },
    ).trim();
    if (count === '0') {
      logToOutput(path.dirname(logFile), `\n[INFO] origin/${deps.baseBranch} has not advanced past HEAD — skipping rebase\n`);
      return true;
    }
  } catch {
    // Can't determine — proceed with rebase to be safe
  }

  try {
    deps.execGit(['rebase', `origin/${deps.baseBranch}`], worktreePath);
    logToOutput(path.dirname(logFile), `\n[INFO] Feature branch rebased onto latest ${deps.baseBranch}\n`);
    return true;
  } catch {
    try { deps.execGit(['rebase', '--abort'], worktreePath); } catch { /* ignore */ }
    logToOutput(path.dirname(logFile), '\n[INFO] Rebase had conflicts — spawning merger to resolve via git merge\n');
    try {
      const mergeLogFile = path.join(path.dirname(logFile), 'output-merge.log');
      const mergeSessionId = await processManager.createSession(
        deps.sessionOpts('merger', worktreePath, taskId, mergeLogFile),
      );
      updateSessionMap(path.dirname(logFile), 'merge', mergeSessionId);
      processManager.sendMessage(mergeSessionId, `/merge origin/${deps.baseBranch}`);
      await deps.waitForCompletion(mergeSessionId);
      processManager.killSession(mergeSessionId);
      logToOutput(path.dirname(logFile), '\n[INFO] Merger resolved rebase conflicts\n');
      return true;
    } catch (mergeErr) {
      const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
      logToOutput(path.dirname(logFile), `\n[WARN] Merger could not resolve rebase conflicts: ${mergeMsg}\n`);
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
  const specLogFile = path.join(pipeline.specPath, 'output-spec.log');
  deps.rotateOutputLog(logFile);
  deps.phaseHeader(logFile, 'spec');
  deps.persistAndEmitPhase(pipeline);
  const sessionId = await processManager.createSession(
    deps.sessionOpts('analyst', deps.projectRoot, pipeline.taskId, specLogFile),
  );
  pipeline.sessionId = sessionId;
  deps.savePipelineState(pipeline);
  updateSessionMap(pipeline.specPath, 'spec', sessionId);
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
  const planLogFile = path.join(pipeline.specPath, 'output-plan.log');
  deps.rotateOutputLog(logFile);
  deps.phaseHeader(logFile, 'plan');
  deps.persistAndEmitPhase(pipeline);
  const sessionId = await processManager.createSession(
    deps.sessionOpts('planner', deps.projectRoot, pipeline.taskId, planLogFile),
  );
  pipeline.sessionId = sessionId;
  deps.savePipelineState(pipeline);
  updateSessionMap(pipeline.specPath, 'plan', sessionId);
  processManager.sendMessage(sessionId, `/plan ${deps.toAgentPath(pipeline.specPath)}/spec.md`);
  await deps.waitForCompletion(sessionId);
  processManager.killSession(sessionId);

  // Evidence producibility gate (#4): if the planner rejected the spec's
  // acceptance criteria as unverifiable (no producing artifact possible),
  // route to human review instead of silently proceeding to implement.
  // Write a minimal qa_report.json with spec_concerns so the review panel
  // can render the familiar "Revise Spec" banner.
  const planGapsPath = path.join(pipeline.specPath, 'plan_gaps.md');
  if (existsSync(planGapsPath)) {
    logToOutput(pipeline.specPath, '\n[GATE] Plan contains unverifiable acceptance criteria — routing to human review. See plan_gaps.md.\n');
    try {
      writeFileSync(path.join(pipeline.specPath, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        criteria: [],
        spec_concerns: [{
          issue: 'Plan rejected unverifiable acceptance criteria',
          reasoning: 'One or more spec acceptance criteria cannot be verified because no committed artifact can structurally contain their required evidence. See plan_gaps.md for details.',
          suggested_fix: 'Revise the spec to make all criteria independently verifiable, then re-plan.',
        }],
      }, null, 2));
    } catch { /* best-effort — the human can still read plan_gaps.md directly */ }
    deps.advancePhase(pipeline, 'awaiting-review');
    return;
  }

  const baseBranch = resolveBaseBranch(deps.projectRoot);
  try {
    deps.gitPush(['pull', '--ff-only', 'origin', baseBranch], path.join(pipeline.specPath, 'output.log'));
  } catch { /* non-fast-forward or offline — proceed with local branch */ }

  if (!existsSync(pipeline.worktreePath)) {
    if (path.resolve(pipeline.worktreePath) === path.resolve(deps.projectRoot)) {
      throw new WorktreeError('Refusing to create worktree at project root — this would destroy the repository', 'WORKTREE_AT_ROOT');
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

  // Rebase onto latest default branch before merging so the diff only contains the
  // ticket's actual changes, not drift from an old worktree snapshot.
  const baseBranch = resolveBaseBranch(deps.projectRoot);
  const rebaseOk = await rebaseOntoLatestDefault(
    pipeline.worktreePath, pipeline.taskId, logFile,
    { projectRoot: deps.projectRoot, execGit: deps.execGit, sessionOpts: deps.sessionOpts, waitForCompletion: deps.waitForCompletion, baseBranch },
  );
  if (!rebaseOk) {
    throw new PipelineConfigError(
      `Rebase onto latest ${baseBranch} failed with conflicts that could not be resolved. ` +
      `The target branch has likely diverged too far from ${baseBranch}. ` +
      `Consider stopping and restarting the task to recreate the worktree from the latest ${baseBranch}.`,
      'REBASE_CONFLICT_UNRESOLVABLE',
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
    logToOutput(pipeline.specPath, sensorRunSummary(mergeResult));
    if (!mergeResult.allPassed) {
      const failMsg = mergeResult.reports.filter(r => !r.passed).map(r => r.sensor + ': ' + (r.error || 'exit ' + r.exitCode)).join('; ');
      throw new PipelineConfigError('Pre-merge sensors failed: ' + failMsg, 'PRE_MERGE_SENSORS_FAILED');
    }
  }

  // Try direct merge first — only spawn agent on conflict
  let mergeSucceeded = false;
  try {
    logToOutput(pipeline.specPath, `[MERGE] Attempting direct merge of ${pipeline.branch} into ${baseBranch}\n`);
    deps.execGit(['merge', pipeline.branch, '--no-edit'], deps.projectRoot);
    mergeSucceeded = true;
    logToOutput(pipeline.specPath, `[MERGE] Direct merge succeeded — no conflicts\n`);
  } catch {
    try { deps.execGit(['merge', '--abort'], deps.projectRoot); } catch { /* best-effort */ }
    logToOutput(pipeline.specPath, `[MERGE] Merge had conflicts — spawning merger agent\n`);
  }

  if (!mergeSucceeded) {
    const mergeLogFile = path.join(pipeline.specPath, 'output-merge.log');
    const sessionId = await processManager.createSession(
      deps.sessionOpts('merger', deps.projectRoot, pipeline.taskId, mergeLogFile),
    );
    pipeline.sessionId = sessionId;
    updateSessionMap(pipeline.specPath, 'merge', sessionId);
    processManager.sendMessage(sessionId, `/merge ${pipeline.branch}`);
    await deps.waitForCompletion(sessionId);
    processManager.killSession(sessionId);
  }

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

  // Rebase onto latest default branch so the PR diff only contains the ticket's actual changes.
  const baseBranch = resolveBaseBranch(deps.projectRoot);
  const rebaseOk = await rebaseOntoLatestDefault(
    pipeline.worktreePath, pipeline.taskId, logFile,
    { projectRoot: deps.projectRoot, execGit: deps.execGit, sessionOpts: deps.sessionOpts, waitForCompletion: deps.waitForCompletion, baseBranch },
  );
  if (rebaseOk) {
    logToOutput(pipeline.specPath, '\n[INFO] PR will be conflict-free\n');
  } else {
    logToOutput(pipeline.specPath, '\n[WARN] PR may require manual conflict resolution\n');
  }

  deps.commitArtifactsToWorktree(pipeline);
  deps.gitPush(['push', '-u', '--force', 'origin', pipeline.branch], logFile);

  const specContent = readFileSync(path.join(pipeline.specPath, 'spec.md'), 'utf-8');
  const platform = detectGitPlatform(deps.projectRoot);

  // Check for existing open PR first — avoid creating duplicates
  let prUrl: string | null = checkExistingPRViaCLI(platform, pipeline.branch, deps.projectRoot);
  if (prUrl) {
    logToOutput(pipeline.specPath, `[PR] Open PR already exists for branch ${pipeline.branch}: ${prUrl}\n`);
  } else {
    // Create PR directly via CLI (gh) instead of spawning a merger agent
    const body = buildPRBody(pipeline.description, specContent);
    prUrl = createPRViaCLI(platform, pipeline.branch, pipeline.description, body, deps.projectRoot, logFile);
    // Fallback: scan log for PR URL (handles unknown platforms where CLI returns null)
    if (!prUrl) {
      prUrl = deps.extractPrUrl(logFile);
    }
  }

  deps.taskStore.update(pipeline.taskId, {
    platform: platform !== 'unknown' ? platform : undefined,
    ...(prUrl ? { prUrl } : {}),
  });

  // Re-commit + push so the artifact snapshot that lands in the PR (and
  // later in master, and later in whatever markTaskDone restores after
  // merge) actually includes prUrl. The commit above ran before the PR
  // existed, so its task.json snapshot is necessarily prUrl-less — without
  // this second pass, every pull-request-strategy task's committed
  // artifacts permanently lack the PR reference, even though the live
  // task.json has it.
  if (prUrl) {
    deps.commitArtifactsToWorktree(pipeline);
    deps.gitPush(['push', '-u', '--force', 'origin', pipeline.branch], logFile);
  }

  deps.advancePhase(pipeline, 'pr-open', {
    ...(prUrl ? { prUrl } : {}),
    ...(platform !== 'unknown' ? { platform } : {}),
  });
}
