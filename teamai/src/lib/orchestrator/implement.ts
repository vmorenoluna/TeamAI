/**
 * runImplement phase runner — extracted from Orchestrator class.
 *
 * Handles the entire implement phase: Docker gate, worktree setup,
 * per-subtask session creation, QA rework, sensor hooks, git push,
 * and post-implement cleanup.
 *
 * Decomposed (T16) into six named helpers called in sequence by runImplement.
 */
import { execFileSync } from 'child_process';
import { getToolPath } from '../tool-checker';
import { readFileSync, writeFileSync, existsSync, readdirSync, unlinkSync, renameSync, rmSync } from 'fs';
import { PipelineConfigError, WorktreeError, PushVerificationError, SessionKilledError } from './errors';
import { readJsonFile } from '../json-io';
import path from 'path';
import { processManager, type AgentSession } from '../process-manager';
import { readContainerConfig, containerManager, dockerAvailable, _resetDockerAvailableCache } from '../container-manager';
import { runSensors, sensorRunSummary, type SensorsConfig } from '../sensors';
import { rebaseOntoLatestDefault } from './phase-runners';
import { updateSessionMap, logToOutput } from './helpers';
import { resolveBaseBranch } from '../git-platform';
import { getUnpushedCommits } from './worktree-ops';
import { removeStaleWorktreeRegistration } from './worktree-utils';
import type { TaskStore } from '../task-store';
import type { PipelinePhase } from '@/constants/phases';
import type { TaskPipeline, QaReport, PlanSubtask, SessionOptsResult } from './types';

export interface ImplementPipeline extends TaskPipeline {
  /** Internal flag: set when wakeup completes during this run so post-groups code re-enters (ADR 002) */
  _wakeupJustCompleted?: boolean;
}

// ── Dependencies ──────────────────────────────────────────────────────────

export interface ImplementDeps {
  projectRoot: string;
  taskStore: TaskStore;
  persistAndEmitPhase: (pipeline: ImplementPipeline) => void;
  advancePhase: (pipeline: ImplementPipeline, phase: PipelinePhase, eventExtra?: Record<string, unknown>) => void;
  savePipelineState: (pipeline: ImplementPipeline) => void;
  executePhase: (pipeline: ImplementPipeline) => Promise<void>;
  sessionOpts: (role: AgentSession['role'], cwd: string, taskId: string, logFile?: string) => SessionOptsResult;
  waitForCompletion: (sessionId: string) => Promise<void>;
  execGit: (args: string[], hostCwd: string) => void;
  /** Same routing as execGit, but returns captured stdout — needed to read
   *  `git status --porcelain` etc. against a worktree that may be
   *  container-patched and thus unresolvable via a plain host execFileSync. */
  execGitCapture: (args: string[], hostCwd: string) => string;
  gitPush: (pushArgs: string[], logFile: string) => void;
  patchWorktreeGitFile: (hostWorktreePath: string, containerWorkspace: string) => void;
  isWorktreeHealthy: (worktreePath: string) => boolean;
  cleanStaleSubtaskWorktrees: (pipeline: ImplementPipeline) => void;
  restoreQaReportFromSnapshot: (specPath: string) => void;
  restoreHumanFeedbackFromSnapshot: (specPath: string) => void;
  writeQaFeedback: (pipeline: ImplementPipeline, report: QaReport) => void;
  getPipelineConfig: () => { maxQaAttempts: number; parallelSubtasks: boolean; sensors?: SensorsConfig; maxDeliverableFails: number; maxWakeupAttempts: number; maxStallRecoveries: number; idleStallMinutes: number; toolStallMinutes: number };
  phaseHeader: (logFile: string, phase: string) => void;
  /** Mutable reference to the plan-write serialization lock. */
  planWriteLock: { current: Promise<void> };
  /** Schedule a wakeup timer (ADR 002). */
  scheduleWakeup: (pipeline: ImplementPipeline) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Helper 1 — ensureWorktree
// ═══════════════════════════════════════════════════════════════════════════

/** Retry bounds for clearing a worktree directory that still exists after
 *  git-level removal — see clearWorktreeDirectoryOrThrow for why this can
 *  happen (a file locked open by a leftover process from an earlier run). */
const WORKTREE_CLEANUP_MAX_ATTEMPTS = 3;
const WORKTREE_CLEANUP_RETRY_MS = 1000;

export interface ClearWorktreeDirDeps {
  exists: (path: string) => boolean;
  rm: (path: string) => void;
  pruneWorktrees: () => void;
}

/**
 * Retry clearing a worktree directory that still exists after git-level
 * removal (`git worktree remove --force`). A leftover file handle held
 * open by an orphaned process — a background server/sweep from an
 * earlier, incompletely-torn-down run of this same task — can block
 * deletion on Windows even with force:true, which only suppresses ENOENT,
 * not a lock. git's own worktree metadata gets deregistered regardless of
 * whether the directory itself survives (confirmed independently: `git
 * worktree list` stops showing the entry even when files remain), so a
 * subsequent `worktree add` at the same path crashes on "already exists"
 * with no indication why. A lock can release on its own shortly after the
 * owning process finishes writing, so retry a few times before giving up
 * rather than on the first attempt — but throw a clear, actionable error
 * instead of silently falling through to that confusing crash if it never
 * clears.
 */
export async function clearWorktreeDirectoryOrThrow(
  worktreePath: string,
  deps: ClearWorktreeDirDeps,
): Promise<void> {
  for (let attempt = 0; attempt < WORKTREE_CLEANUP_MAX_ATTEMPTS && deps.exists(worktreePath); attempt++) {
    try { deps.rm(worktreePath); } catch { /* best-effort */ }
    try { deps.pruneWorktrees(); } catch { /* best-effort */ }
    if (deps.exists(worktreePath) && attempt < WORKTREE_CLEANUP_MAX_ATTEMPTS - 1) {
      await new Promise(resolve => setTimeout(resolve, WORKTREE_CLEANUP_RETRY_MS));
    }
  }
  if (deps.exists(worktreePath)) {
    throw new WorktreeError(
      `Worktree directory at ${worktreePath} could not be fully removed — ` +
      `it likely still has a file locked open by a leftover process from an earlier ` +
      `run (e.g. an orphaned background server/sweep). Manually stop whatever holds ` +
      `it open and delete the directory, then retry the task.`,
      'WORKTREE_LOCKED',
    );
  }
}

/**
 * Commit any uncommitted/untracked changes in a worktree before it's
 * abandoned (removed, or relocated to a different path via
 * relocateStuckWorktree) — otherwise in-flight WIP that was never
 * committed is silently discarded. Verified safe even when a *different*
 * file in the directory is locked open by an external process without
 * delete permission: git only needs read/write access to commit, not
 * delete access, so this succeeds independently of whether the directory
 * can subsequently be removed. Since it's the same branch, the commit is
 * automatically present in any worktree that later checks out that branch
 * — including a relocated one — with no copying needed. Best-effort: a
 * failure here must never block the teardown/relocation it's protecting.
 */
export function preserveUncommittedWork(pipeline: ImplementPipeline, deps: ImplementDeps): void {
  try {
    const status = deps.execGitCapture(['status', '--porcelain'], pipeline.worktreePath);
    if (!status.trim()) return;
    deps.execGit(['add', '-A'], pipeline.worktreePath);
    deps.execGit(['commit', '-m', 'WIP: auto-preserved before worktree teardown/relocation'], pipeline.worktreePath);
    logToOutput(pipeline.specPath, '[WORKTREE] Committed uncommitted changes before teardown (WIP auto-preserve)\n');
  } catch { /* best-effort — never block teardown on this */ }
}

const WORKTREE_RELOCATE_MAX_SUFFIX = 5;

/**
 * Find the first available `<original-dirname>-rN` path (N=2..5) not
 * currently occupied on disk, switch the pipeline to it, and persist the
 * choice on the task (worktreeDirName) so future runs of this task —
 * retries, resumes after a restart — resolve to the same place via
 * resolveWorktreeDirName() instead of colliding with the stuck original.
 *
 * The abandoned original directory is left exactly where it is: it can't
 * be safely deleted (that's why we're here) or even renamed out of the
 * way — verified independently that a Windows handle without
 * FILE_SHARE_DELETE blocks renaming ancestor directories, not just the
 * locked file itself. It's swept opportunistically by
 * sweepAbandonedWorktreeRelocations on a later run, once the lock clears.
 *
 * Throws WorktreeError only if every relocation slot is also occupied —
 * at that point this is no longer a transient external lock, and silently
 * trying yet another path would just paper over a real problem (e.g. a
 * runaway prior process that's actually creating these directories).
 */
export function relocateStuckWorktree(pipeline: ImplementPipeline, deps: ImplementDeps): void {
  const worktreeBase = path.dirname(pipeline.worktreePath);
  const originalDirName = path.basename(pipeline.worktreePath);
  const baseDirName = originalDirName.replace(/-r\d+$/, ''); // don't stack suffixes on repeated relocations

  for (let n = 2; n <= WORKTREE_RELOCATE_MAX_SUFFIX; n++) {
    const candidateDirName = `${baseDirName}-r${n}`;
    const candidatePath = path.join(worktreeBase, candidateDirName);
    if (existsSync(candidatePath)) continue;

    logToOutput(pipeline.specPath,
      `[WORKTREE] ${originalDirName} still locked after cleanup retries — relocating to ${candidateDirName} instead of failing the task\n`
    );
    pipeline.worktreePath = candidatePath;
    deps.taskStore.update(pipeline.taskId, { worktreeDirName: candidateDirName });
    return;
  }

  throw new WorktreeError(
    `Worktree directory at ${pipeline.worktreePath} could not be removed, and every relocation ` +
    `slot up to ${baseDirName}-r${WORKTREE_RELOCATE_MAX_SUFFIX} is also occupied. Manually clear out ` +
    `stale "${baseDirName}-r*" directories under ${worktreeBase} and retry the task.`,
    'WORKTREE_LOCKED',
  );
}

/**
 * Best-effort cleanup of directories left behind by relocateStuckWorktree
 * on an earlier run of this task — the external lock that forced the
 * relocation has often cleared by the time a later run starts, so this
 * recovers the disk space instead of leaving garbage forever. Never
 * touches the currently active worktreePath, and skips anything still
 * registered as a live git worktree (could belong to a
 * concurrently-running pipeline elsewhere). Silent on failure throughout —
 * this is opportunistic tidying, never load-bearing for the current run.
 */
export function sweepAbandonedWorktreeRelocations(pipeline: ImplementPipeline, deps: ImplementDeps): void {
  try {
    const worktreeBase = path.dirname(pipeline.worktreePath);
    const activeDirName = path.basename(pipeline.worktreePath);
    const baseDirName = activeDirName.replace(/-r\d+$/, '');
    if (!existsSync(worktreeBase)) return;

    let registered: Set<string>;
    try {
      const list = execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: deps.projectRoot, encoding: 'utf-8', stdio: 'pipe' });
      registered = new Set(
        list.split('\n')
          .filter(l => l.startsWith('worktree '))
          .map(l => path.resolve(l.slice('worktree '.length).trim()))
      );
    } catch {
      return; // can't verify what's live — don't risk deleting something in use
    }

    for (const entry of readdirSync(worktreeBase, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === activeDirName) continue;
      if (!entry.name.startsWith(`${baseDirName}-r`)) continue;
      if (!/^\d+$/.test(entry.name.slice(baseDirName.length + 2))) continue;
      const candidatePath = path.join(worktreeBase, entry.name);
      if (registered.has(path.resolve(candidatePath))) continue; // live worktree — leave it
      try { rmSync(candidatePath, { recursive: true, force: true }); } catch { /* still locked — try again next run */ }
    }
  } catch { /* best-effort */ }
}

/**
 * Ensure the task's git worktree exists, is healthy, and is ready for
 * the implement phase.  Covers:
 * - Docker-gate check
 * - Restore snapshot files (Gap 4b)
 * - Pull latest default branch
 * - Create / repair worktree
 * - Container-mode setup
 * - Rebase onto latest default
 * - Clean stale per-subtask worktrees (AC9)
 */
export async function ensureWorktree(
  pipeline: ImplementPipeline,
  deps: ImplementDeps,
): Promise<void> {
  // Fail fast if Docker is not available
  const containerCfg = readContainerConfig(deps.projectRoot);
  if (containerCfg.enabled && !containerCfg.explicit) {
    _resetDockerAvailableCache();
    if (!dockerAvailable()) {
      throw new PipelineConfigError('Docker is not running. Start Docker Desktop and move the task back to In Progress to retry.');
    }
  }

  // Gap 4b: restore snapshots if deleted
  deps.restoreQaReportFromSnapshot(pipeline.specPath);
  deps.restoreHumanFeedbackFromSnapshot(pipeline.specPath);

  // Pull latest default branch (token-authed)
  const baseBranch = resolveBaseBranch(deps.projectRoot);
  try {
    deps.gitPush(['pull', '--ff-only', 'origin', baseBranch], path.join(pipeline.specPath, 'output.log'));
  } catch { /* non-fast-forward or offline */ }

  // Opportunistically reclaim disk space from earlier relocations of this
  // task (see relocateStuckWorktree) — never load-bearing for this run.
  sweepAbandonedWorktreeRelocations(pipeline, deps);

  // Ensure worktree exists and is healthy
  if (!existsSync(pipeline.worktreePath) || !deps.isWorktreeHealthy(pipeline.worktreePath)) {
    if (existsSync(pipeline.worktreePath)) {
      if (path.resolve(pipeline.worktreePath) === path.resolve(deps.projectRoot)) {
        throw new WorktreeError('Refusing to remove worktree at project root — this would destroy the repository', 'WORKTREE_AT_ROOT');
      }
      // Check for unpushed commits before tearing down the worktree.
      // A commit made directly in this worktree outside the normal pipeline
      // push steps (e.g. a manual session after PR creation) would be
      // silently lost — the worktree gets force-removed and recreated below.
      try {
        const unpushed = getUnpushedCommits(deps.projectRoot, pipeline.branch);
        if (unpushed) {
          logToOutput(pipeline.specPath,
            `\n[WORKTREE] ⚠ WARNING: Removing unhealthy worktree at ${pipeline.worktreePath}\n` +
            `[WORKTREE] The branch ${pipeline.branch} has unpushed commits:\n` +
            unpushed.split('\n').map(l => `[WORKTREE]   ${l}`).join('\n') + '\n' +
            `[WORKTREE] Attempting to push before teardown...\n`
          );
          try {
            deps.gitPush(['push', 'origin', pipeline.branch], path.join(pipeline.specPath, 'output.log'));
            logToOutput(pipeline.specPath, '[WORKTREE] Pushed unpushed commits successfully\n');
          } catch (pushErr) {
            const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
            logToOutput(pipeline.specPath, `[WORKTREE] Auto-push failed: ${pushMsg}\n`);
            logToOutput(pipeline.specPath,
              `[WORKTREE] These commits will become unreachable once the worktree is removed.\n` +
              `[WORKTREE] To recover: git branch recover-${pipeline.taskId} ${pipeline.branch} && git push origin recover-${pipeline.taskId}\n`
            );
          }
        }
      } catch { /* best-effort — unpushed check must not block worktree repair */ }
      // Commits are protected by the push above; uncommitted/untracked
      // changes are not — capture those too before anything is torn down.
      preserveUncommittedWork(pipeline, deps);
      try {
        deps.execGit(['worktree', 'remove', '--force', pipeline.worktreePath], deps.projectRoot);
      } catch { /* best-effort */ }
      // Unconditional, like the per-subtask cleanup above — a container-
      // patched worktree's registration is invisible to existsSync on the
      // host but still blocks a subsequent worktree add/branch -D.
      removeStaleWorktreeRegistration(deps.projectRoot, pipeline.worktreePath);
      if (existsSync(pipeline.worktreePath)) {
        try {
          await clearWorktreeDirectoryOrThrow(pipeline.worktreePath, {
            exists: existsSync,
            rm: (p) => rmSync(p, { recursive: true, force: true }),
            pruneWorktrees: () => removeStaleWorktreeRegistration(deps.projectRoot, pipeline.worktreePath),
          });
        } catch (err) {
          // A directory that survives every removal attempt is almost
          // always a Windows-side lock this pipeline has no business
          // fighting (an IDE indexer, an antivirus scanner) — see
          // relocateStuckWorktree. Anything else (WORKTREE_AT_ROOT, etc.)
          // is a real problem and must still fail the task.
          if (err instanceof WorktreeError && err.code === 'WORKTREE_LOCKED') {
            relocateStuckWorktree(pipeline, deps);
          } else {
            throw err;
          }
        }
      }
    }
    try {
      deps.execGit(['worktree', 'add', pipeline.worktreePath, '-b', pipeline.branch], deps.projectRoot);
    } catch {
      deps.execGit(['worktree', 'add', pipeline.worktreePath, pipeline.branch], deps.projectRoot);
    }
  }

  // Container mode: patch worktree .git file
  if (readContainerConfig(deps.projectRoot).enabled) {
    const earlyLog = path.join(pipeline.specPath, 'output.log');
    const containerInfo = await containerManager.ensureContainer(deps.projectRoot, earlyLog);
    deps.patchWorktreeGitFile(pipeline.worktreePath, containerInfo.remoteWorkspaceFolder);
  }

  // Rebase feature branch onto latest default so coders see the current upstream
  const implementLog = path.join(pipeline.specPath, 'output.log');
  await rebaseOntoLatestDefault(
    pipeline.worktreePath, pipeline.taskId, implementLog,
    {
      projectRoot: deps.projectRoot,
      execGit: deps.execGit,
      sessionOpts: deps.sessionOpts,
      waitForCompletion: deps.waitForCompletion,
      baseBranch: resolveBaseBranch(deps.projectRoot),
    },
  );

  // AC9: clean stale per-subtask worktrees
  deps.cleanStaleSubtaskWorktrees(pipeline);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Helper 2 — selectSubtasks
// ═══════════════════════════════════════════════════════════════════════════

export interface SubtaskSelection {
  plan: { subtasks: PlanSubtask[] };
  effectiveSubtasks: PlanSubtask[];
  groups: Map<string, PlanSubtask[]>;
  hasQaFeedback: boolean;
  hasHumanFeedback: boolean;
}

/**
 * Read plan.json and determine which subtasks to execute:
 * - On QA bounce-back: only qa_flagged subtasks (or synthetic 9999)
 * - On first pass: all non-completed subtasks
 * - Wakeup isolation filters to a single subtask
 */
export function selectSubtasks(
  pipeline: ImplementPipeline,
): SubtaskSelection {
  const planPath = path.join(pipeline.specPath, 'plan.json');
  const planResult = readJsonFile<{ subtasks: PlanSubtask[] }>(planPath, { required: true });
  if (planResult.error) {
    logToOutput(pipeline.specPath, `\n[ERROR] Cannot read plan.json: ${planResult.error.message}\n`);
    throw new PipelineConfigError(`Plan file is missing or invalid at ${planPath}: ${planResult.error.message}. The planner must produce a valid plan.json before implement can proceed.`);
  }
  const plan = planResult.data!;

  // Normalize array fields the planner can legitimately omit — e.g. a subtask
  // that only creates new files via files_to_create (nothing existing to
  // modify) has no reason to include an empty `files: []`. The PlanSubtask
  // type declares these required because everything downstream assumes they
  // exist; enforce that invariant here, once, right after parsing, instead of
  // guarding every individual consumer (several .join() call sites in this
  // file crash outright on undefined otherwise).
  for (const s of plan.subtasks) {
    s.files ??= [];
    s.acceptance_criteria ??= [];
    s.depends_on ??= [];
  }

  const qaFeedbackPath = path.join(pipeline.specPath, 'qa_feedback.md');
  const humanFeedbackPath = path.join(pipeline.specPath, 'human_feedback.md');
  const hasQaFeedback = existsSync(qaFeedbackPath);
  const hasHumanFeedback = existsSync(humanFeedbackPath);

  if (hasHumanFeedback) {
    const snapshotPath = path.join(pipeline.specPath, 'human_feedback_before_bounce.md');
    if (!existsSync(snapshotPath)) {
      try { writeFileSync(snapshotPath, readFileSync(humanFeedbackPath, 'utf-8')); } catch { /* best-effort */ }
    }
  }

  // Only re-run QA-flagged subtasks on bounce-back. The synthetic rework
  // subtask (id 9999, see below) is excluded from this real-subtask pool:
  // every bounce that reaches the fallback must synthesise a fresh one from
  // the *current* qa_feedback.md, never replay a stale persisted copy.
  const realSubtasks = plan.subtasks.filter((s: PlanSubtask) => s.id !== 9999);
  const subtasksToRun = hasQaFeedback
    ? realSubtasks.filter((s: PlanSubtask) => s.qa_flagged)
    : realSubtasks.filter((s: PlanSubtask) => !s.completed);

  let effectiveSubtasks: PlanSubtask[];
  if (hasQaFeedback && subtasksToRun.length === 0) {
    const allFiles: string[] = [...new Set<string>(
      realSubtasks.flatMap((s: PlanSubtask) => s.files ?? [])
    )];
    let qaContent = '';
    try { qaContent = readFileSync(qaFeedbackPath, 'utf-8'); } catch { /* best-effort */ }
    logToOutput(pipeline.specPath, '\n[QA-FALLBACK] Criterion matching flagged no subtasks — synthesising targeted rework subtask from qa_feedback.md\n');
    const synthesizedSubtask: PlanSubtask = {
      id: 9999,
      title: 'QA Rework: fix failing criteria (criterion matching found no flagged subtasks)',
      description: buildSyntheticReworkDescription(qaContent),
      files: allFiles,
      depends_on: [],
      acceptance_criteria: ['All criteria listed in the QA feedback above are satisfied'],
      parallel_group: 'QA-REWORK',
      qa_flagged: true,
      completed: false,
    };
    effectiveSubtasks = [synthesizedSubtask];

    // Persist the synthesized subtask into plan.json (upserting over any
    // stale 9999 entry from a prior bounce). Without this, plan.json's
    // subtasks array never mentions id 9999, and getTaskFull() — which
    // reads output-st<id>.log only for ids present in plan.subtasks — can
    // never surface output-st9999.log to the UI's terminal tab. The coder
    // tab would then be stuck showing whichever real subtask last ran,
    // forever, regardless of how many QA-rework bounces happen afterward.
    plan.subtasks = [...realSubtasks, synthesizedSubtask];
    try {
      const tmpPath = planPath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(plan, null, 2));
      renameSync(tmpPath, planPath);
    } catch { /* best-effort — pipeline proceeds even if this write fails */ }
  } else {
    effectiveSubtasks = subtasksToRun;
  }

  // ADR 002: Wakeup isolation — only re-enter the wakeup-pending subtask
  if (pipeline.wakeupSubtaskId != null) {
    effectiveSubtasks = effectiveSubtasks.filter(s => s.id === pipeline.wakeupSubtaskId);
  }

  const groups = new Map<string, PlanSubtask[]>();
  for (const subtask of effectiveSubtasks) {
    const group = subtask.parallel_group || String(subtask.id);
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group)!.push(subtask);
  }

  return { plan, effectiveSubtasks, groups, hasQaFeedback, hasHumanFeedback };
}

// ═══════════════════════════════════════════════════════════════════════════
//  Helper 3 — runSubtaskSession
// ═══════════════════════════════════════════════════════════════════════════

/** Result of a single subtask agent session. */
export interface SubtaskSessionResult {
  completed: boolean;
  scopeViolated: boolean;
  wakeupDetected: boolean;
  skipCompletion: boolean;
}

/**
 * Persist a set of completed subtask ids to plan.json and emit a live
 * `subtask-progress` event. Serialized through the shared plan-write lock so
 * parallel subtasks don't interleave their checkpoint writes. Best-effort:
 * a failed checkpoint write must never fail the pipeline.
 *
 * @internal — exported for unit tests only. Not part of the public API.
 */
export function persistCompletedSubtasks(
  pipeline: ImplementPipeline,
  deps: ImplementDeps,
  completedIds: number[],
): void {
  deps.planWriteLock.current = deps.planWriteLock.current.then(() => {
    try {
      const planPath = path.join(pipeline.specPath, 'plan.json');
      if (!existsSync(planPath)) return;
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      if (plan.subtasks) {
        for (const s of plan.subtasks) {
          if (completedIds.includes(s.id)) s.completed = true;
        }
      }
      const tmpPath = planPath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(plan, null, 2));
      renameSync(tmpPath, planPath);

      // Emit subtask progress so the kanban counter updates live during implement.
      // Without this, the UI only sees updated counts on phase-change or page refresh.
      const subtasks = (plan as { subtasks?: PlanSubtask[] }).subtasks ?? [];
      const completed = subtasks.filter((s: PlanSubtask) => s.completed).length;
      processManager.emit('subtask-progress', {
        taskId: pipeline.taskId,
        completed,
        total: subtasks.length,
        projectRoot: deps.projectRoot,
      });
    } catch { /* best-effort */ }
  });
}

/**
 * Run a single subtask's agent session: pre-sensors → create session → build
 * prompt (QA/wakeup/deliverable headers) → wait → post-session checks (scope,
 * wakeup detect, deliverable verification) → post-sensors → checkpoint.
 *
 * Mutates `pipeline`, `completedIds`, `scopeViolations`, and `sessionMapLock`
 * in-place (same as the original inline handler).
 *
 * @internal — exported for unit tests only. Not part of the public API.
 */
export async function runSubtaskSession(
  pipeline: ImplementPipeline,
  deps: ImplementDeps,
  subtask: PlanSubtask,
  cwd: string,
  logFile: string,
  hasQaFeedback: boolean,
  hasHumanFeedback: boolean,
  humanFeedbackPath: string,
  completedIds: number[],
  scopeViolations: Set<number>,
  sessionMapLock: { current: Promise<void> },
): Promise<void> {
  if (pipeline.phase === 'failed') return;

  const coderRole = 'coder' as AgentSession['role'];

  deps.phaseHeader(logFile, 'implement — subtask ' + subtask.id + ': ' + subtask.title);

  // pre_subtask sensor
  try {
    const pipelineConfig = deps.getPipelineConfig();
    if (pipelineConfig.sensors?.pre_subtask?.length) {
      const preResult = await runSensors(pipelineConfig.sensors.pre_subtask, 'pre_subtask', {
        cwd, specPath: pipeline.specPath, files: subtask.files || [], subtaskId: subtask.id, logFile,
      });
      if (!preResult.allPassed) logToOutput(pipeline.specPath, sensorRunSummary(preResult));
    }
  } catch (preSensorErr) {
    const msg = preSensorErr instanceof Error ? preSensorErr.message : String(preSensorErr);
    logToOutput(pipeline.specPath, '\n[SENSOR:pre_subtask] pre-subtask sensors failed (non-blocking): ' + msg + '\n');
  }

  const subtaskLogFile = path.join(pipeline.specPath, `output-st${subtask.id}.log`);

  const qaOnlyCriteria = hasQaFeedback
    ? subtask.acceptance_criteria.filter(ac => ac.includes('[QA CORRECTION') || ac.includes('[QA ISSUE'))
    : subtask.acceptance_criteria;

  const criteriaLine = hasQaFeedback
    ? (qaOnlyCriteria.length > 0
        ? 'QA issues to fix: ' + qaOnlyCriteria.join('; ')
        : 'No specific QA criteria for this subtask — see the QA feedback above for issues to address.')
    : 'Acceptance criteria: ' + subtask.acceptance_criteria.join('; ');

  const subtaskFeedback = buildSubtaskFeedback(hasQaFeedback, qaOnlyCriteria, subtask, pipeline.specPath, humanFeedbackPath, hasHumanFeedback);

  // ADR 002: Snapshot whether this subtask was a wakeup re-entry
  const wasWakeupReentry = pipeline.wakeupSubtaskId === subtask.id;

  // ADR 002: Wakeup re-entry prompt header (takes priority over deliverable).
  // NOT gated on hasQaFeedback — a QA-rework/cleanup session can just as
  // legitimately be resuming a background job it scheduled itself.
  let wakeupHeader = '';
  if (pipeline.wakeupSubtaskId === subtask.id) {
    wakeupHeader = '⚠️ WAKEUP RE-ENTRY\n\n' +
      'Your previous session was paused to wait for a background process.\n' +
      'Background command: ' + (pipeline.wakeupCommand || 'unknown') + '\n' +
      'Expected artifact to verify: ' + (pipeline.wakeupArtifact || 'unknown') + '\n\n' +
      'CRITICAL: Run ALL verification commands, scripts, and servers from the current\n' +
      'working directory (this worktree) — NOT from the base project root. The code in\n' +
      'this worktree is your branch\'s revision; running from the project root would\n' +
      'exercise the wrong code and produce meaningless results.\n\n' +
      'Check if the artifact exists and is complete. If it is: verify it, git add, commit,\n' +
      'and mark the subtask done. If it\'s missing or incomplete, first check whether the\n' +
      'background process is still running:\n' +
      '- If the process is still running: estimate remaining time, write an updated\n' +
      '  subtask_wakeup-st' + subtask.id + '.json with a new wakeup_at, and end.\n' +
      '- If the process has crashed or exited with an error: do NOT write another wakeup\n' +
      '  file. Report the failure immediately so the task can advance to failed without\n' +
      '  wasting the remaining wakeup attempts.\n\n';
  }

  // Deliverable re-verification prompt header
  let deliverableHeader = '';
  if (!hasQaFeedback && !wakeupHeader && pipeline.deliverableFailCounts?.[subtask.id]) {
    const attemptCount = pipeline.deliverableFailCounts[subtask.id];
    const maxFails = deps.getPipelineConfig().maxDeliverableFails;
    deliverableHeader = '⚠️ DELIVERABLE RE-VERIFICATION (attempt ' + attemptCount + '/' + maxFails + ')\n\n' +
      'Your previous session for this subtask ended but the following required\n' +
      'deliverable files were NOT created:\n\n' +
      (subtask.files_to_create?.map(f => '  - ' + f).join('\n') || '') + '\n\n' +
      'You MUST create these files before ending your session. If you cannot\n' +
      'create them (e.g., the task is impossible with the current spec), explain\n' +
      'why and the orchestrator will advance the task to failed.\n\n';
  }

  const promptHeader = wakeupHeader || deliverableHeader;

  // Resume-context header (#6): inject task/branch/subtask context so a
  // restarted session doesn't pay a full re-read tax to reconstruct state.
  let resumeContext = '## SESSION CONTEXT\n\n' +
    'Task: ' + pipeline.description + '\n' +
    'Branch: ' + pipeline.branch + '\n';

  // Show completed subtasks so the agent knows what's already done
  try {
    const planPath = path.join(pipeline.specPath, 'plan.json');
    if (existsSync(planPath)) {
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      if (plan.subtasks) {
        const completed = plan.subtasks.filter((s: PlanSubtask) => s.completed);
        resumeContext += 'Subtasks: ' + plan.subtasks.length + ' total';
        if (completed.length > 0) resumeContext += ', ' + completed.length + ' already done (' +
          completed.map((s: PlanSubtask) => '#' + s.id + ': ' + s.title).join(', ') + ')';
        resumeContext += '\n';
      }
    }
  } catch { /* best-effort */ }

  resumeContext += 'Current: Subtask ' + subtask.id + ': ' + subtask.title + '\n';
  resumeContext += 'Working directory: ' + cwd + ' (this is your git worktree)\n\n';

  const prompt =
    promptHeader +
    resumeContext +
    (subtaskFeedback ? subtaskFeedback + '\n---\n' : '') +
    '/implement Subtask ' + subtask.id + ': ' + subtask.title + '\n\n' +
    subtask.description + '\n\n' +
    'Files: ' + subtask.files.join(', ') + '\n\n' +
    criteriaLine + '\n' +
    'PROJECT_ROOT=' + deps.projectRoot + '\n\n' +
    (hasQaFeedback
      ? '⚠️ Only fix the QA issues listed above. Do NOT re-validate criteria that QA already passed.\n' +
        'After fixing all issues, run the FULL test suite to verify no regressions.\n'
      : '');

  // Snapshot HEAD before the agent session starts (for post-session scope check).
  // Taken once, before the FIRST attempt — a stall-recovery retry (below)
  // must measure the cumulative diff across every attempt on this subtask,
  // not just the last one.
  let preSessionHead = '';
  try {
    preSessionHead = deps.execGitCapture(['rev-parse', 'HEAD'], cwd).trim();
  } catch { /* best-effort — scope check is skipped if snapshot fails */ }

  // Stall-detector-kill recovery loop. A session killed for stalling
  // (killReason 'stalled' — 30+ min with a tool call in flight and zero
  // output) doesn't necessarily mean the work is unrecoverable: the command
  // may have actually finished, or the coder may just need to diagnose why
  // it hung. Give it a bounded number of fresh-session retries before
  // failing outright. A deliberate stop (killReason unset) is never
  // retried — it rethrows immediately, exactly as before this loop existed.
  let sessionId: string;
  let stallRecoveryHeader = '';
  for (;;) {
    try {
      sessionId = await processManager.createSession(deps.sessionOpts(coderRole, cwd, pipeline.taskId, subtaskLogFile));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logToOutput(pipeline.specPath, '\n[ERROR] Session creation failed for subtask ' + subtask.id + ': ' + msg + '\n');
      throw err;
    }
    // Serialised through a lock so parallel subtasks don't race on the JSON file.
    sessionMapLock.current = sessionMapLock.current.then(() => {
      updateSessionMap(pipeline.specPath, String(subtask.id), sessionId);
    });

    processManager.sendMessage(sessionId, stallRecoveryHeader + prompt);

    try {
      await deps.waitForCompletion(sessionId);
      break;
    } catch (err) {
      if (!(err instanceof SessionKilledError) || err.reason !== 'stalled') throw err;

      if (!pipeline.stallRecoveryCounts) pipeline.stallRecoveryCounts = {};
      const attemptCount = (pipeline.stallRecoveryCounts[subtask.id] || 0) + 1;
      pipeline.stallRecoveryCounts[subtask.id] = attemptCount;
      const maxRecoveries = deps.getPipelineConfig().maxStallRecoveries;

      // The two stall thresholds are very different situations (a session
      // idle for N minutes between tool calls vs. a single tool call still
      // running after M minutes) — describe whichever one actually fired
      // instead of assuming/hardcoding the tool-in-flight case. err.stallKind
      // is undefined only if this SessionKilledError somehow reached here
      // without going through the stall-detector's own kill call; treat that
      // as unknown rather than asserting a specific duration that may be wrong.
      const cfg = deps.getPipelineConfig();
      const stallDescription = err.stallKind === 'idle'
        ? `idle for over ${cfg.idleStallMinutes} minutes with no tool running`
        : err.stallKind === 'tool'
          ? `a tool call running for over ${cfg.toolStallMinutes} minutes with no output`
          : 'an extended period with no output (exact cause unknown)';

      if (attemptCount >= maxRecoveries) {
        logToOutput(pipeline.specPath, '[STALL-RECOVERY] Subtask ' + subtask.id + ' exceeded stall-recovery cap (' + maxRecoveries + ') — advancing to failed\n');
        const reportPath = path.join(pipeline.specPath, 'qa_report.json');
        writeFileSync(reportPath, JSON.stringify({
          overall: 'FAIL',
          criteria: [{
            criterion: 'Session repeatedly stalled',
            name: 'Session repeatedly stalled',
            status: 'FAIL',
            notes: 'Subtask ' + subtask.id + ' had its session killed for stalling (' + stallDescription + ' on its most recent kill) ' + maxRecoveries + ' time(s) in a row. This may indicate a genuine hang introduced by the change (an infinite loop, unbounded recursion, a non-terminating solver configuration) rather than an environment issue.',
          }],
        }, null, 2));
        deps.advancePhase(pipeline, 'failed');
        return;
      }

      logToOutput(pipeline.specPath, '[STALL-RECOVERY] Subtask ' + subtask.id + ' session killed (stalled — ' + stallDescription + ') — retrying with a fresh session (attempt ' + attemptCount + '/' + maxRecoveries + ')\n');
      stallRecoveryHeader = err.stallKind === 'idle'
        ? '⚠️ SESSION RECOVERED AFTER STALL-KILL (attempt ' + attemptCount + '/' + maxRecoveries + ')\n\n' +
          'Your previous session for this subtask was terminated by the orchestrator — it produced\n' +
          'no output for over ' + cfg.idleStallMinutes + ' minutes while IDLE (no tool call was in progress at the time). This\n' +
          'is not the "a command ran long" case — the session went silent between turns for longer\n' +
          'than a normal thinking/reasoning pause should take. Check git status/git diff for\n' +
          'whatever progress you\'d already made, then continue from where you left off. If this\n' +
          'keeps recurring on the same subtask, note it in your summary — it may point to a genuine\n' +
          'hang in the CLI process itself rather than something in your code.\n\n'
        : '⚠️ SESSION RECOVERED AFTER STALL-KILL (attempt ' + attemptCount + '/' + maxRecoveries + ')\n\n' +
          'Your previous session for this subtask was terminated by the orchestrator — it\n' +
          'produced no output for over ' + cfg.toolStallMinutes + ' minutes while a tool was running. Two distinct\n' +
          'possibilities, and you need to tell them apart before doing anything else:\n\n' +
          '1. The command was simply slow and unrelated to your changes (a cold compile, a\n' +
          '   large test suite, a slow network call) — check git status/git diff for what\n' +
          '   you\'d already done, and whether re-running the command now completes in a\n' +
          '   reasonable time. If so, continue or re-run as needed.\n\n' +
          '2. Your own change caused a genuine hang or pathological slowdown — an infinite\n' +
          '   loop, unbounded recursion, a solver configuration that no longer terminates,\n' +
          '   a resource leak, a join that becomes combinatorial. Re-running the exact same\n' +
          '   command blind wastes your remaining attempts if this is the real cause — look\n' +
          '   for it specifically. If you find one, fix the root cause (this is a code bug\n' +
          '   in your own change, not a spec or environment issue) and verify the fix with\n' +
          '   a bounded/timeout-guarded run before resuming normal work.\n\n';
      // Loop and retry with a fresh session.
    }
  }

  processManager.killSession(sessionId);

  // Post-session scope check: verify agent only modified assigned files.
  if (preSessionHead) {
    try {
      const changedFiles = deps.execGitCapture(['diff', '--name-only', preSessionHead + '..HEAD'], cwd).trim().split('\n').filter(Boolean);

      const assignedFiles = new Set(subtask.files || []);
      const violations = changedFiles.filter(f => !assignedFiles.has(f));

      if (violations.length > 0) {
        scopeViolations.add(subtask.id);
        logToOutput(pipeline.specPath,
          '\n[SCOPE] Subtask ' + subtask.id + ' modified files outside its assigned scope:\n' +
          violations.map(f => '  - ' + f).join('\n') + '\n' +
          '[SCOPE] Assigned files: ' + ((subtask.files || []).join(', ') || '(none)') + '\n'
        );
      }
    } catch (scopeErr) {
      const scopeMsg = scopeErr instanceof Error ? scopeErr.message : String(scopeErr);
      logToOutput(pipeline.specPath, '\n[SCOPE] Could not verify file scope (git diff failed: ' + scopeMsg + ')\n');
    }
  }

  // ADR 002: Check for wakeup file (engineer scheduled background work).
  // NOT gated on hasQaFeedback — a QA-rework/cleanup coder session can
  // legitimately need to start a long verification job (e.g. re-running a
  // sweep after a fix) just like a first-pass session. Gating this on
  // hasQaFeedback silently dropped wakeup files written during rework: the
  // coder would correctly schedule a wait, but the orchestrator would never
  // look for the file, advance straight to QA before the job finished, and
  // QA would then fail the subtask against incomplete/stale evidence —
  // burning a QA attempt on a false negative unrelated to code or spec quality.
  let wakeupDetected = false;
  {
    const wakeupPathId = path.join(pipeline.specPath, `subtask_wakeup-st${subtask.id}.json`);
    const wakeupPathLegacy = path.join(pipeline.specPath, 'subtask_wakeup.json');
    const wakeupPath = existsSync(wakeupPathId) ? wakeupPathId : (existsSync(wakeupPathLegacy) ? wakeupPathLegacy : null);
    if (wakeupPath) {
      try {
        const wd = JSON.parse(readFileSync(wakeupPath, 'utf-8'));
        if (wd.subtask_id != null && wd.wakeup_at) {
          // When parallel subtasks both schedule wakeups, adopt the EARLIEST
          // wakeup_at (ADR 002) — the later sibling must not clobber an
          // already-scheduled earlier wakeup. A re-schedule by the SAME
          // subtask always wins (its previous wakeup_at is already in the past).
          const existing = pipeline.wakeupUntil ? Date.parse(pipeline.wakeupUntil) : Infinity;
          if (pipeline.wakeupSubtaskId == null || wd.subtask_id === pipeline.wakeupSubtaskId
              || Date.parse(wd.wakeup_at) < existing) {
            pipeline.wakeupSubtaskId = wd.subtask_id;
            pipeline.wakeupUntil = wd.wakeup_at;
            pipeline.wakeupCommand = wd.background_command;
            pipeline.wakeupArtifact = wd.expected_artifact;
            pipeline.wakeupProgressPath = wd.progress_log_path;
          }
          pipeline.wakeupAttemptCount = (pipeline.wakeupAttemptCount || 0) + 1;
          wakeupDetected = true;
          logToOutput(pipeline.specPath, '[WAKEUP] Subtask ' + wd.subtask_id + ' wakeup scheduled for ' + wd.wakeup_at + ' (attempt ' + pipeline.wakeupAttemptCount + ') — background process: ' + (wd.background_command || 'unknown') +
            (wd.progress_log_path ? ' — progress log: ' + wd.progress_log_path : '') + '\n');
        }
      } catch {
        logToOutput(pipeline.specPath, '[WAKEUP] Malformed subtask_wakeup.json — treating as missing\n');
      }
      try { unlinkSync(wakeupPath); } catch { /* best-effort */ }
    }
  }

  // Verify deliverable files exist before marking subtask complete.
  // Gated on wakeupDetected (THIS session scheduled a fresh wakeup), not on
  // pipeline.wakeupSubtaskId (which stays set across every re-entry cycle
  // until a session completes cleanly). Gating on the stale pipeline field
  // let a wakeup-reentry session that silently failed to reschedule — no new
  // wakeup file, deliverable still missing — sail through as "completed"
  // with the verification skipped, because the pipeline still remembered an
  // EARLIER, legitimate wakeup on the same subtask.
  let skipCompletion = false;
  if (!wakeupDetected && subtask.files_to_create?.length) {
    for (const file of subtask.files_to_create) {
      if (!existsSync(path.join(cwd, file))) {
        skipCompletion = true;
        logToOutput(pipeline.specPath, '\n[VERIFY] Subtask ' + subtask.id + ': expected file/directory missing — ' + file + '\n');
      }
    }
    if (skipCompletion) {
      if (!pipeline.deliverableFailCounts) pipeline.deliverableFailCounts = {};
      const maxFails = deps.getPipelineConfig().maxDeliverableFails;
      const count = (pipeline.deliverableFailCounts[subtask.id] || 0) + 1;
      pipeline.deliverableFailCounts[subtask.id] = count;
      const missingFiles = subtask.files_to_create.filter(f => !existsSync(path.join(cwd, f))).join(', ');
      logToOutput(pipeline.specPath, '[VERIFY] Subtask ' + subtask.id + ' failed deliverable verification (attempt ' + count + '/' + maxFails + ') — missing: ' + missingFiles + '\n');
      if (count >= maxFails) {
        const reportPath = path.join(pipeline.specPath, 'qa_report.json');
        writeFileSync(reportPath, JSON.stringify({
          overall: 'FAIL',
          criteria: [{
            criterion: 'Deliverable verification — missing files',
            name: 'Deliverable verification',
            status: 'FAIL',
            notes: 'Subtask ' + subtask.id + ' failed deliverable verification ' + maxFails + ' times. Missing files: ' + missingFiles,
          }],
        }, null, 2));
        logToOutput(pipeline.specPath, '[VERIFY] Subtask ' + subtask.id + ' exceeded deliverable verification cap (' + maxFails + ') — advancing to failed\n');
        deps.advancePhase(pipeline, 'failed');
        return;
      }
    }
  }

  if (wakeupDetected) {
    skipCompletion = true;
  }

  if (!skipCompletion) {
    if (scopeViolations.has(subtask.id)) {
      skipCompletion = true;
      logToOutput(pipeline.specPath, '[SCOPE] Subtask ' + subtask.id + ' rejected — will re-run with scope enforcement\n');
    } else {
      if (pipeline.deliverableFailCounts?.[subtask.id] !== undefined) {
        delete pipeline.deliverableFailCounts[subtask.id];
      }
      if (pipeline.stallRecoveryCounts?.[subtask.id] !== undefined) {
        delete pipeline.stallRecoveryCounts[subtask.id];
      }
      completedIds.push(subtask.id);

      // Persist completion to plan.json BEFORE the wakeup-reentry early return
      // below (ADR 002). A subtask whose final wakeup re-entry session ends with
      // no fresh wakeup file is added to completedIds above, but the early
      // return here used to skip this write entirely — so `completed: true`
      // never landed in plan.json for wakeup-completed subtasks. Guarded on a
      // successful completion so scope-violation / deliverable-defer skip paths
      // don't queue a redundant no-op write + duplicate emit.
      persistCompletedSubtasks(pipeline, deps, completedIds);
    }
  }

  // ADR 002: After wakeup completes — only on re-entry with no new wakeup file
  if (wasWakeupReentry && !wakeupDetected && !skipCompletion) {
    pipeline.wakeupUntil = undefined;
    pipeline.wakeupSubtaskId = undefined;
    pipeline.wakeupCommand = undefined;
    pipeline.wakeupArtifact = undefined;
    pipeline.wakeupProgressPath = undefined;
    pipeline.wakeupAttemptCount = 0;
    pipeline._wakeupJustCompleted = true;
    logToOutput(pipeline.specPath, '[WAKEUP] Subtask ' + subtask.id + ' completed after wakeup — clearing wakeup state\n');
    return;
  }

  // post_subtask sensor
  try {
    const pipelineConfig = deps.getPipelineConfig();
    if (pipelineConfig.sensors?.post_subtask?.length) {
      const postResult = await runSensors(pipelineConfig.sensors.post_subtask, 'post_subtask', {
        cwd, specPath: pipeline.specPath, files: subtask.files || [], subtaskId: subtask.id, logFile,
      });
      logToOutput(pipeline.specPath, sensorRunSummary(postResult));
      if (!postResult.allPassed) {
        const sensorReportPath = path.join(pipeline.specPath, 'sensor_report-st' + subtask.id + '.json');
        const failMsg = postResult.reports.filter(r => !r.passed).map(r => r.sensor + ': ' + (r.error || 'exit ' + r.exitCode)).join('; ');
        const failures = postResult.reports.filter(r => !r.passed).map(r => ({
          subtask: subtask.title, sensor: r.sensor, error: r.error || 'exit code ' + r.exitCode,
          fix_needed: 'Fix sensor failures: ' + failMsg + '. Run the sensor locally to reproduce.',
        }));
        writeFileSync(sensorReportPath, JSON.stringify({ failures, overall: 'FAIL' }, null, 2));
      }
    }
  } catch (postSensorErr) {
    const msg = postSensorErr instanceof Error ? postSensorErr.message : String(postSensorErr);
    logToOutput(pipeline.specPath, '\n[SENSOR:post_subtask] post-subtask sensors error: ' + msg + '\n');
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Helper 4 — integrateGroup
// ═══════════════════════════════════════════════════════════════════════════

/**
 * After parallel subtask sessions complete: auto-commit stray changes in the
 * main worktree, cherry-pick each subtask branch, and clean up per-subtask
 * worktrees.  Handles cherry-pick conflict recovery via the merger agent.
 *
 * @returns true if the pipeline should continue, false if a hard failure
 *          (retainWorktrees was set) requires aborting the groups loop.
 *
 * @internal — exported for unit tests only. Not part of the public API.
 */
export async function integrateGroup(
  pipeline: ImplementPipeline,
  deps: ImplementDeps,
  subtasks: PlanSubtask[],
  results: PromiseSettledResult<void>[],
  scopeViolations: Set<number>,
  subtaskWorktrees: Map<number, string>,
  logFile: string,
): Promise<boolean> {
  // Cherry-pick successful commits back to main worktree. subtaskWorktrees
  // is the source of truth for "this subtask worked in an isolated
  // worktree this round" — true both for a genuine multi-subtask group and
  // for a lone subtask resuming after a wakeup in a now-collapsed group.
  if (subtaskWorktrees.size > 0) {
    // Pre-cherry-pick: auto-commit any uncommitted changes in the main worktree.
    // Must go through deps.execGit/execGitCapture, not a raw execFileSync —
    // the main worktree is routinely container-patched (its .git file and
    // the admin back-reference point at container-only /workspaces/... paths)
    // while a pipeline run is active, and a raw host-side `git status` against
    // a container-patched worktree fails outright ("fatal: not a git
    // repository"). That failure was being silently swallowed by the catch
    // below, which let real uncommitted changes sit in the worktree
    // unnoticed — with nothing to catch them, the cherry-pick that follows
    // fails instead with "local changes would be overwritten by merge",
    // which reads as a completely different problem.
    try {
      const statusOut = deps.execGitCapture(['status', '--porcelain'], pipeline.worktreePath).trim();
      if (statusOut) {
        logToOutput(pipeline.specPath, '\n[WORKTREE] Main worktree has uncommitted changes — auto-committing before cherry-pick:\n' + statusOut + '\n');
        deps.execGit(['add', '-A', '--', '.', ':!.teamai'], pipeline.worktreePath);
        deps.execGit(['commit', '-m', 'chore: auto-save worktree state before cherry-pick'], pipeline.worktreePath);
        logToOutput(pipeline.specPath, '[WORKTREE] Auto-committed uncommitted changes\n');
      }
    } catch (statusErr) {
      const errMsg = statusErr instanceof Error ? statusErr.message : String(statusErr);
      logToOutput(pipeline.specPath, '\n[WORKTREE] Could not check/commit worktree status (git failed: ' + errMsg + '), proceeding with cherry-pick\n');
    }

    for (let i = 0; i < results.length; i++) {
      if (results[i].status !== 'fulfilled') continue;
      if (!subtaskWorktrees.has(subtasks[i].id)) continue;
      if (subtasks[i].id === pipeline.wakeupSubtaskId) {
        logToOutput(pipeline.specPath, '\n[WORKTREE] Skipping cherry-pick for subtask ' + subtasks[i].id + ' — wakeup pending\n');
        continue;
      }
      if (scopeViolations.has(subtasks[i].id)) {
        logToOutput(pipeline.specPath, '\n[WORKTREE] Skipping cherry-pick for subtask ' + subtasks[i].id + ' (scope violation)\n');
        continue;
      }
      const stBranch = pipeline.branch + '-st' + subtasks[i].id;
      const cherrySuccess = await tryCherryPickWithRecovery(
        pipeline, deps, logFile, stBranch, subtasks[i].id,
      );
      if (!cherrySuccess) {
        logToOutput(pipeline.specPath, '\n[WORKTREE] Retained ' + subtaskWorktrees.size + ' per-subtask worktree(s) and branches for manual recovery (auto-recovery exhausted).\n');
        logToOutput(pipeline.specPath, '[WORKTREE] Branches preserved: ' + subtasks.map(s => pipeline.branch + '-st' + s.id).join(', ') + '\n');
        // Don't clean up — preserve work for manual recovery
        return false;
      }
    }
  }

  // Clean up per-subtask worktrees — but never the one still waiting on a
  // wakeup (its background job depends on that worktree surviving).
  if (subtaskWorktrees.size > 0) {
    let cleanedCount = 0;
    for (const [id, stWorktreePath] of subtaskWorktrees.entries()) {
      if (id === pipeline.wakeupSubtaskId) continue;
      try { deps.execGit(['worktree', 'remove', '--force', stWorktreePath], deps.projectRoot); } catch {
        try { rmSync(stWorktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
        removeStaleWorktreeRegistration(deps.projectRoot, stWorktreePath);
      }
      try { execFileSync('git', ['branch', '-D', pipeline.branch + '-st' + id], { cwd: deps.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
      cleanedCount++;
    }
    if (cleanedCount > 0) {
      logToOutput(pipeline.specPath, '\n[WORKTREE] Cleaned up ' + cleanedCount + ' per-subtask worktree(s)\n');
    }
  }

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Helper 5 — pushAndVerify
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Force-push the feature branch and verify remote HEAD matches local.
 * On push failure, checks whether a PR already exists (non-fatal) or
 * advances the pipeline to failed.
 */
export function pushAndVerify(
  pipeline: ImplementPipeline,
  deps: ImplementDeps,
  logFile: string,
): void {
  deps.phaseHeader(logFile, 'implement — push to remote');
  try {
    deps.gitPush(['push', '-u', '--force', 'origin', pipeline.branch], logFile);
    logToOutput(pipeline.specPath, '[PUSH] Successfully pushed ' + pipeline.branch + ' to origin\n');

    // Verify remote HEAD
    try {
      const localHead = execFileSync('git', ['rev-parse', pipeline.branch], {
        cwd: deps.projectRoot, encoding: 'utf-8', stdio: 'pipe',
      }).trim();
      const remoteHead = execFileSync('git', ['rev-parse', 'origin/' + pipeline.branch], {
        cwd: deps.projectRoot, encoding: 'utf-8', stdio: 'pipe',
      }).trim();
      if (localHead !== remoteHead) {
        throw new PushVerificationError('Push succeeded but HEADs differ — local=' + localHead + ' remote=' + remoteHead, 'HEAD_MISMATCH');
      }
      logToOutput(pipeline.specPath, '[PUSH] Verified remote HEAD matches local HEAD\n');
    } catch (verifyErr) {
      const verifyMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
      logToOutput(pipeline.specPath, '[PUSH] Remote verification failed: ' + verifyMsg + '\n');
      throw verifyErr;
    }
  } catch (pushErr) {
    const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
    logToOutput(pipeline.specPath, '[PUSH] Push failed: ' + pushMsg + '\n');

    let prExists = false;
    try {
      const prCheck = execFileSync(getToolPath('gh'), ['pr', 'list', '--head', pipeline.branch, '--json', 'url', '--jq', '.[0].url'], {
        cwd: deps.projectRoot, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000,
      }).trim();
      if (prCheck) {
        prExists = true;
        logToOutput(pipeline.specPath, '[PUSH] PR already exists for branch ' + pipeline.branch + ': ' + prCheck + ' — push failure is non-fatal\n');
        logToOutput(pipeline.specPath, '[PUSH] Code is already in the PR — advancing to QA review\n');
      }
    } catch { /* gh unavailable or no PR exists — fall through to normal failure */ }

    if (!prExists) {
      logToOutput(pipeline.specPath, '[PUSH] Task cannot advance — engineer must be able to push before QA can verify\n');
      const reportPath = path.join(pipeline.specPath, 'qa_report.json');
      writeFileSync(reportPath, JSON.stringify({
        overall: 'FAIL',
        criteria: [{
          criterion: 'Git push verification',
          name: 'Git push verification',
          status: 'FAIL',
          notes: 'Git push failed: ' + pushMsg + '. The engineer must be able to push commits before QA can verify.',
        }],
      }, null, 2));
      deps.advancePhase(pipeline, 'failed');
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Helper 6 — applySensorGate
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Read per-subtask sensor reports and, if any failures exist, bounce back to
 * implement with cleanup-type QA feedback.
 *
 * @returns true if the pipeline bounced to implement, false otherwise.
 */
export async function applySensorGate(
  pipeline: ImplementPipeline,
  deps: ImplementDeps,
): Promise<boolean> {
  const planPath = path.join(pipeline.specPath, 'plan.json');
  const allSensorFailures: { subtask: string; sensor: string; error: string; fix_needed: string }[] = [];
  if (existsSync(planPath)) {
    try {
      const planFinal = JSON.parse(readFileSync(planPath, 'utf-8'));
      for (const s of (planFinal.subtasks || [])) {
        const srPath = path.join(pipeline.specPath, 'sensor_report-st' + s.id + '.json');
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
    logToOutput(pipeline.specPath, '\n[SENSOR-GATE] post_subtask sensors failed (' + allSensorFailures.length + ' failure(s)) — bouncing to implement for sensor fixes\n');
    deps.writeQaFeedback(pipeline, {
      overall: 'FAIL',
      fail_type: 'cleanup',
      criteria: allSensorFailures.map(f => ({
        name: 'Sensor: ' + f.subtask + ' — ' + f.sensor,
        criterion: 'Sensor: ' + f.subtask + ' — ' + f.sensor,
        status: 'FAIL' as const,
        notes: f.error,
        fix_needed: f.fix_needed,
      })),
    });
    deps.advancePhase(pipeline, 'implement');
    deps.savePipelineState(pipeline);
    await deps.executePhase(pipeline);
    return true;
  }

  return false;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Main function
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Find the first pair of subtasks that declare the same file in their
 * `files` arrays. When two subtasks in a parallel group share a file, each
 * works in its own isolated worktree branched from the same base and their
 * branches are cherry-picked back sequentially — a guaranteed merge conflict.
 * The plan-phase rules require `depends_on` (or merging) between such
 * subtasks; this detects that condition so the caller can surface a
 * prominent warning. It deliberately does NOT fail the pipeline — the
 * merger agent can still auto-resolve the cherry-pick conflict.
 *
 * @internal — exported for unit tests only.
 */
export function findFileOwnershipConflict(
  subtasks: PlanSubtask[],
): { a: PlanSubtask; b: PlanSubtask; file: string } | null {
  for (let i = 0; i < subtasks.length; i++) {
    const filesA = subtasks[i].files ?? [];
    for (let j = i + 1; j < subtasks.length; j++) {
      const filesB = subtasks[j].files ?? [];
      for (const f of filesA) {
        if (filesB.includes(f)) return { a: subtasks[i], b: subtasks[j], file: f };
      }
    }
  }
  return null;
}

export async function runImplement(
  pipeline: ImplementPipeline,
  deps: ImplementDeps,
): Promise<void> {
  // Persist phase on disk now that work is actually starting (#5)
  deps.persistAndEmitPhase(pipeline);

  // ── Phase 1: Ensure worktree is ready ──
  await ensureWorktree(pipeline, deps);

  // ── Phase 2: Select subtasks ──
  const selection = selectSubtasks(pipeline);
  const { plan, effectiveSubtasks, groups, hasQaFeedback, hasHumanFeedback } = selection;

  const logFile = path.join(pipeline.specPath, 'output.log');
  const qaFeedbackPath = path.join(pipeline.specPath, 'qa_feedback.md');
  const humanFeedbackPath = path.join(pipeline.specPath, 'human_feedback.md');

  // Skip implement if all subtasks complete and not in QA rework
  if (!hasQaFeedback && effectiveSubtasks.length === 0 && plan.subtasks.length > 0) {
    logToOutput(pipeline.specPath, '\n[SKIP] All subtasks already completed — skipping implement, advancing to QA review\n');
    deps.advancePhase(pipeline, 'qa-review');
    await deps.executePhase(pipeline);
    return;
  }

  if (hasQaFeedback) {
    for (const s of effectiveSubtasks) s.completed = false;
  }

  // ── Phase 3: Process groups of subtasks ──
  for (const [, subtasks] of groups) {
    if (pipeline.phase === 'failed') break;
    const completedIds: number[] = [];
    const isMultiGroup = deps.getPipelineConfig().parallelSubtasks !== false && subtasks.length >= 2;
    const subtaskWorktrees = new Map<number, string>();
    let containerWorkspace: string | undefined;
    if (readContainerConfig(deps.projectRoot).enabled) {
      const info = containerManager.getRunningContainer(deps.projectRoot);
      containerWorkspace = info?.remoteWorkspaceFolder || undefined;
    }

    // Per-subtask worktree isolation
    if (isMultiGroup) {
      // Runtime file-ownership warning: two parallel subtasks that modify the
      // same file from the same base branch will likely produce a cherry-pick
      // conflict at integration. The plan-phase rules require depends_on (or
      // merging) for such subtasks. We deliberately do NOT fail the pipeline
      // here — the merger agent can still auto-resolve the conflict — but
      // surface it prominently so the plan can be corrected at the source
      // instead of relying on the merger agent every run.
      const conflict = findFileOwnershipConflict(subtasks);
      if (conflict) {
        logToOutput(
          pipeline.specPath,
          `\n[WORKTREE] Warning: parallel subtasks ${conflict.a.id} and ${conflict.b.id} both modify "${conflict.file}" — ` +
          `they will likely conflict at cherry-pick. Add an explicit depends_on between them (or merge them) to avoid relying on the merger agent.\n`,
        );
      }
      for (const subtask of subtasks) {
        const stWorktreePath = pipeline.worktreePath + '-st' + subtask.id;
        const stBranch = pipeline.branch + '-st' + subtask.id;

        // Defect 4: auto-recover unintegrated commits from a previous run
        // before force-deleting the branch. Without this, a retry after a
        // mid-implement failure silently discards finished subtask work that
        // was never cherry-picked onto the feature branch.
        const canRecreate = await _recoverSubtaskBranchBeforeDelete(pipeline, deps, logFile, stBranch, subtask);

        // Clean up old worktree directory and registration (common to both
        // paths). removeStaleWorktreeRegistration must run unconditionally,
        // not just when stWorktreePath exists on the host: a container-
        // patched worktree's gitdir points to a container-only path, so
        // nothing is ever visible here via existsSync, yet git still
        // considers the branch checked out (and refuses `branch -D`) until
        // that registration is cleared.
        try { deps.execGit(['worktree', 'remove', '--force', stWorktreePath], deps.projectRoot); }
        catch (err) {
          // Log rather than swallow: a failed worktree removal is the root
          // cause of the "branch still checked out" failures downstream, and
          // previously it was invisible.
          logToOutput(pipeline.specPath, `\n[WORKTREE] Failed to remove per-subtask worktree ${stWorktreePath}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
        if (existsSync(stWorktreePath)) {
          logToOutput(pipeline.specPath, '\n[WORKTREE] Per-subtask worktree at ' + stWorktreePath + ' still exists after git-level removal — falling back to rmSync\n');
          try { rmSync(stWorktreePath, { recursive: true, force: true }); }
          catch (err) {
            logToOutput(pipeline.specPath, `\n[WORKTREE] Failed to rmSync per-subtask worktree ${stWorktreePath}: ${err instanceof Error ? err.message : String(err)}\n`);
          }
        }
        removeStaleWorktreeRegistration(deps.projectRoot, stWorktreePath);

        if (canRecreate) {
          try { execFileSync('git', ['branch', '-D', stBranch], { cwd: deps.projectRoot, stdio: 'pipe' }); }
          catch (err) {
            logToOutput(pipeline.specPath, `\n[WORKTREE] Failed to delete branch ${stBranch}: ${err instanceof Error ? err.message : String(err)}\n`);
          }

          // Verify the branch is actually gone before attempting -b creation.
          // A prior-worktree lingering with a file lock (the worktree removal
          // above failed silently) prevents branch deletion — git branch -D
          // can't delete a branch still checked out in an existing worktree.
          // Without this check, the subsequent `worktree add -b <same-name>`
          // fails with "a branch named '<stBranch>' already exists" and the
          // best-effort catch on worktree removal swallowed the real reason.
          let branchStillExists = true;
          try {
            execFileSync('git', ['rev-parse', '--verify', stBranch], { cwd: deps.projectRoot, stdio: 'pipe' });
          } catch {
            branchStillExists = false; // branch doesn't exist — expected and correct
          }

          if (!branchStillExists) {
            deps.execGit(['worktree', 'add', stWorktreePath, '-b', stBranch, pipeline.branch], deps.projectRoot);
          } else {
            // Branch deletion failed — fall back to checking out the existing
            // branch. Log this distinctly from the canRecreate=false case
            // (branch preserved by recovery decision) because the root cause
            // is different: this one means the worktree cleanup above didn't
            // actually free the branch, likely because a file lock prevented
            // full directory removal.
            logToOutput(pipeline.specPath, '\n[WORKTREE] Branch ' + stBranch + ' still exists after deletion attempt (worktree removal likely incomplete due to a file lock) — checking out existing branch instead of recreating\n');
            deps.execGit(['worktree', 'add', stWorktreePath, stBranch], deps.projectRoot);
          }
        } else {
          // Branch preserved — create worktree from existing branch (no -b).
          // The merger agent in integrateGroup will handle conflicts when
          // cherry-picking back onto pipeline.branch.
          deps.execGit(['worktree', 'add', stWorktreePath, stBranch], deps.projectRoot);
          logToOutput(pipeline.specPath, '\n[WORKTREE] Created worktree from preserved branch ' + stBranch + ' (conflict resolution deferred to merger agent)\n');
        }

        if (containerWorkspace) {
          deps.patchWorktreeGitFile(stWorktreePath, containerWorkspace);
        }

        subtaskWorktrees.set(subtask.id, stWorktreePath);
        logToOutput(pipeline.specPath, '\n[WORKTREE] Created isolated worktree for subtask ' + subtask.id + ' at ' + stWorktreePath + '\n');
      }
    } else {
      // Group has collapsed to a single remaining subtask. Normally that
      // means it works directly in pipeline.worktreePath — but if this lone
      // subtask is resuming after a wakeup that was originally scheduled
      // from an isolated per-subtask worktree (it started life in a
      // multi-subtask group; sibling(s) have since completed and dropped
      // out of the group), it must keep working in that SAME isolated
      // worktree. Falling back to pipeline.worktreePath would strand the
      // resumed session away from the background job's progress log and
      // expected artifact, which live relative to the isolated worktree.
      const resuming = subtasks.find(s => s.id === pipeline.wakeupSubtaskId);
      if (resuming) {
        const stWorktreePath = pipeline.worktreePath + '-st' + resuming.id;
        if (existsSync(stWorktreePath)) {
          subtaskWorktrees.set(resuming.id, stWorktreePath);
          if (containerWorkspace) {
            // Idempotent — cheap insurance in case the worktree was reset to
            // host paths since the wakeup was scheduled (e.g. a server
            // restart running restoreContainerPatchedWorktrees()).
            deps.patchWorktreeGitFile(stWorktreePath, containerWorkspace);
          }
          logToOutput(pipeline.specPath, '\n[WORKTREE] Resuming subtask ' + resuming.id + ' in its preserved isolated worktree at ' + stWorktreePath + '\n');
        }
      }
    }

    const scopeViolations = new Set<number>();
    const sessionMapLock = { current: Promise.resolve() };

    const subtaskHandler = (subtask: PlanSubtask) =>
      runSubtaskSession(
        pipeline, deps, subtask,
        subtaskWorktrees.get(subtask.id) ?? pipeline.worktreePath,
        logFile,
        hasQaFeedback, hasHumanFeedback, humanFeedbackPath,
        completedIds, scopeViolations, sessionMapLock,
      );

    let results: PromiseSettledResult<void>[] = [];
    if (deps.getPipelineConfig().parallelSubtasks === false) {
      for (const subtask of subtasks) {
        try {
          await subtaskHandler(subtask);
          results.push({ status: 'fulfilled', value: undefined });
        } catch (err) {
          results.push({ status: 'rejected', reason: err });
        }
      }
    } else {
      results = await Promise.allSettled(subtasks.map(subtaskHandler));
    }

    if (results.length > 0 && results.every(r => r.status === 'rejected')) {
      const firstReason = (results[0] as PromiseRejectedResult).reason;
      throw firstReason instanceof Error ? firstReason : new Error(String(firstReason));
    }

    // Cherry-pick from subtask worktrees back to main, then cleanup
    const ok = await integrateGroup(
      pipeline, deps, subtasks, results, scopeViolations,
      subtaskWorktrees, logFile,
    );
    if (!ok) {
      throw new WorktreeError(
        'Cherry-pick recovery exhausted — per-subtask branches have been preserved for manual recovery.',
        'CHERRY_PICK_RECOVERY_EXHAUSTED',
      );
    }

    // A subtask in this group scheduled a wakeup — stop starting further
    // groups (their depends_on may not even be satisfiable yet) and fall
    // through to the Phase 4 logic below, which schedules the wakeup timer
    // and returns.
    if (pipeline.wakeupUntil) break;
  }

  // ── Phase 4: Post-groups logic ──

  if (pipeline.phase === 'failed') return;

  // ADR 002: Wakeup just completed — re-enter implement for deferred subtasks
  if (pipeline._wakeupJustCompleted) {
    delete pipeline._wakeupJustCompleted;
    deps.savePipelineState(pipeline);
    deps.advancePhase(pipeline, 'implement');
    await deps.executePhase(pipeline);
    return;
  }

  // ADR 002: Wakeup timer — pause implement phase until wakeup time
  if (pipeline.wakeupUntil) {
    if ((pipeline.wakeupAttemptCount || 0) >= deps.getPipelineConfig().maxWakeupAttempts) {
      logToOutput(pipeline.specPath, '[WAKEUP] Subtask ' + pipeline.wakeupSubtaskId + ' exceeded wakeup attempt cap (' + deps.getPipelineConfig().maxWakeupAttempts + ') — advancing to failed\n');
      const reportPath = path.join(pipeline.specPath, 'qa_report.json');
      writeFileSync(reportPath, JSON.stringify({
        overall: 'FAIL',
        criteria: [{
          criterion: 'Wakeup attempt limit exceeded',
          name: 'Wakeup attempt limit exceeded',
          status: 'FAIL',
          notes: 'Subtask ' + pipeline.wakeupSubtaskId + ' failed to produce artifact after ' + deps.getPipelineConfig().maxWakeupAttempts + ' wakeup attempts. Expected artifact: ' + (pipeline.wakeupArtifact || 'unknown'),
        }],
      }, null, 2));
      // Clear wakeup state before failing: a truthy wakeupUntil with no armed
      // timer would make the caller's cleanup guard skip releasing the
      // pipeline/active-task lock, blocking any later retry of this task.
      pipeline.wakeupUntil = undefined;
      pipeline.wakeupSubtaskId = undefined;
      pipeline.wakeupCommand = undefined;
      pipeline.wakeupArtifact = undefined;
      pipeline.wakeupProgressPath = undefined;
      pipeline.wakeupAttemptCount = 0;
      deps.advancePhase(pipeline, 'failed');
      return;
    }
    deps.savePipelineState(pipeline);
    deps.scheduleWakeup(pipeline);
    return;
  }

  // Clean up feedback files
  if (hasQaFeedback && existsSync(qaFeedbackPath)) unlinkSync(qaFeedbackPath);
  if (hasHumanFeedback && existsSync(humanFeedbackPath)) unlinkSync(humanFeedbackPath);

  // Clean up qa_flagged markers
  if (hasQaFeedback) {
    try {
      const planPath = path.join(pipeline.specPath, 'plan.json');
      const planAfter = JSON.parse(readFileSync(planPath, 'utf-8'));
      let cleaned = false;
      if (planAfter.subtasks) {
        for (const s of planAfter.subtasks) {
          if (s.qa_flagged) { delete s.qa_flagged; cleaned = true; }
        }
      }
      if (cleaned) writeFileSync(planPath, JSON.stringify(planAfter, null, 2));
    } catch { /* best-effort */ }
  }

  // Mandatory git push before QA
  pushAndVerify(pipeline, deps, logFile);
  if (pipeline.phase === 'failed') return;

  // Sensor gate: check per-subtask sensor reports
  const bounced = await applySensorGate(pipeline, deps);
  if (bounced) return;

  deps.advancePhase(pipeline, 'qa-review');
  await deps.executePhase(pipeline);
}

// ═══════════════════════════════════════════════════════════════════════════
//  Cherry-pick recovery helpers
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
//  Shared st-branch recovery (Defects 4 & 8)
// ═══════════════════════════════════════════════════════════════════════════

/** Result of recovering unintegrated commits from a per-subtask -stN branch. */
export interface StBranchRecoveryResult {
  /** True if recovery succeeded or was not needed (safe to delete/recreate). */
  recovered: boolean;
  /** The commit SHAs found (empty if nothing to recover). */
  commits: string[];
}

/**
 * Check a per-subtask -stN branch for unintegrated commits and attempt to
 * cherry-pick them onto the pipeline branch's main worktree.
 *
 * Shared by Defect 4 (`_recoverSubtaskBranchBeforeDelete` — called during
 * worktree setup) and Defect 8 (`_reconcileSubtaskCompletionsOnStop` —
 * called when a task is stopped mid-implement).
 *
 * @param projectRoot  The git repository root (for branch-existence checks).
 * @param execGitFn    Container-aware git executor (host-mode git for direct
 *                     calls, docker exec git in container mode).
 * @param logFile      Where to write recovery log lines (best-effort).
 * @param pipelineBranch  The main feature branch (e.g. feat/my-slug).
 * @param stBranch     The per-subtask branch (e.g. feat/my-slug-st1).
 * @param worktreePath The main worktree path to cherry-pick into.
 * @param subtaskId    For log context only.
 *
 * On a dead-container/infra-class cherry-pick failure (Defect 3 parity),
 * reprovisions the container via `containerManager.ensureContainer()` and
 * retries up to 2 times before falling back to preserving the branch as-is.
 * Without this, a transient infra hiccup at exactly the moment of recovery
 * (worktree setup or Stop) would be misdiagnosed as a genuine conflict and
 * cause an avoidable reset/preserve instead of a trivial retry.
 *
 * @internal — exported for use by {@link Orchestrator._reconcileSubtaskCompletionsOnStop}
 *             and unit tests. Not part of the public API.
 */
export async function _recoverStBranchCommits(
  projectRoot: string,
  execGitFn: (args: string[], hostCwd: string) => void,
  logFile: string,
  pipelineBranch: string,
  stBranch: string,
  worktreePath: string,
  subtaskId: number,
): Promise<StBranchRecoveryResult> {
  const specPath = path.dirname(logFile);
  const none: StBranchRecoveryResult = { recovered: true, commits: [] };

  // Check if the branch exists
  let branchExists = false;
  try {
    execFileSync('git', ['rev-parse', '--verify', stBranch], {
      cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe',
    });
    branchExists = true;
  } catch { /* branch doesn't exist — nothing to recover */ }
  if (!branchExists) return none;

  // Check for unintegrated commits on the st-branch
  let logOutput = '';
  try {
    logOutput = execFileSync('git', [
      'log', pipelineBranch + '..' + stBranch, '--oneline',
    ], { cwd: projectRoot, encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    // Can't verify — assume recovery is not possible so caller can decide fallback
    return { recovered: false, commits: [] };
  }
  if (!logOutput) return none;

  const commits = logOutput.split('\n').filter(Boolean);
  logToOutput(specPath,
    '\n[WORKTREE] Found ' + commits.length + ' unintegrated commit(s) on ' + stBranch +
    ' (subtask ' + subtaskId + ') — auto-recovering:\n' +
    commits.map(c => '  ' + c).join('\n') + '\n'
  );

  // Attempt to cherry-pick the commits into the main worktree
  try {
    execGitFn(['cherry-pick', pipelineBranch + '..' + stBranch], worktreePath);
    logToOutput(specPath,
      '[WORKTREE] Auto-recovered ' + commits.length + ' commit(s) from ' + stBranch +
      ' onto ' + pipelineBranch + '\n'
    );
    return { recovered: true, commits };
  } catch (cpErr) {
    const cpMsg = cpErr instanceof Error ? cpErr.message : String(cpErr);
    // Abort any in-progress cherry-pick before deciding how to handle the failure
    try { execGitFn(['cherry-pick', '--abort'], worktreePath); } catch { /* best-effort */ }

    // Defect 3 parity: a dead-container/infra error here is trivially
    // retryable once the container is back — don't treat it the same as a
    // genuine content conflict that needs the merger agent.
    if (isInfraError(cpMsg) && readContainerConfig(projectRoot).enabled) {
      for (let retry = 0; retry < 2; retry++) {
        logToOutput(specPath,
          '[WORKTREE] Infra error recovering ' + stBranch + ' — reprovisioning container and retrying (attempt ' + (retry + 1) + '/2)\n'
        );
        try {
          await containerManager.ensureContainer(projectRoot, logFile);
          await new Promise(r => setTimeout(r, 1000)); // brief backoff for container stabilisation
          execGitFn(['cherry-pick', pipelineBranch + '..' + stBranch], worktreePath);
          logToOutput(specPath,
            '[WORKTREE] Auto-recovered ' + commits.length + ' commit(s) from ' + stBranch +
            ' onto ' + pipelineBranch + ' after infra retry\n'
          );
          return { recovered: true, commits };
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          logToOutput(specPath, '[WORKTREE] Recovery retry ' + (retry + 1) + ' for ' + stBranch + ' failed: ' + retryMsg + '\n');
          try { execGitFn(['cherry-pick', '--abort'], worktreePath); } catch { /* best-effort */ }
        }
      }
      logToOutput(specPath, '[WORKTREE] Infra retries exhausted for ' + stBranch + ' — cannot auto-recover\n');
      return { recovered: false, commits };
    }

    logToOutput(specPath,
      '[WORKTREE] Cherry-pick recovery conflicted for ' + stBranch + ': ' + cpMsg + '\n' +
      '[WORKTREE] Branch ' + stBranch + ' preserved as-is — merger agent will resolve during cherry-pick phase\n'
    );
    return { recovered: false, commits };
  }
}

/**
 * Auto-recover unintegrated commits from a per-subtask branch before it gets
 * force-deleted during worktree setup. Defect 4: without this, a retry after a
 * mid-implement failure silently discards finished subtask work that was never
 * cherry-picked onto the feature branch.
 *
 * Delegates to {@link _recoverStBranchCommits} for the shared recovery logic.
 *
 * @returns true if the branch can be safely deleted and recreated (recovery
 *          succeeded or was not needed), false if recovery failed and the
 *          branch should be preserved for the merger agent to handle.
 *
 * @internal — exported for unit tests only. Not part of the public API.
 */
export async function _recoverSubtaskBranchBeforeDelete(
  pipeline: ImplementPipeline,
  deps: ImplementDeps,
  logFile: string,
  stBranch: string,
  subtask: PlanSubtask,
): Promise<boolean> {
  // Skip if subtask is already marked complete — its work was already integrated
  if (subtask.completed) return true;

  const result = await _recoverStBranchCommits(
    deps.projectRoot, deps.execGit, logFile,
    pipeline.branch, stBranch, pipeline.worktreePath, subtask.id,
  );
  return result.recovered;
}

/**
 * Check whether a cherry-pick is currently in progress (CHERRY_PICK_HEAD exists).
 * Takes execGitCapture rather than shelling out directly — worktreePath here
 * is always the main worktree, which is routinely container-patched while a
 * pipeline run is active, and a raw host-side git call against it fails
 * outright instead of reporting "not in progress".
 */
function checkCherryPickInProgress(worktreePath: string, execGitCapture: ImplementDeps['execGitCapture']): boolean {
  try {
    execGitCapture(['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], worktreePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Detect infrastructure-class errors that are retryable (dead container,
 * Docker daemon not reachable, etc.) vs genuine git errors that aren't.
 * Defect 3: without this, a dead-container error like
 * "fatal: not a git repository: (null)" is misclassified as an
 * unrecoverable cherry-pick failure.
 *
 * @internal — exported for unit tests only. Not part of the public API.
 */
export function isInfraError(errMsg: string): boolean {
  const lower = errMsg.toLowerCase();
  return lower.includes('not a git repository')
    || lower.includes('no such container')
    || lower.includes('cannot connect to the docker daemon')
    || lower.includes('spawn docker enoent');
}

/**
 * Attempt to cherry-pick a st-branch into the main worktree with auto-recovery.
 *
 * Tier 1: Normal `git cherry-pick`.
 * Tier 2: If conflicts, spawn the merger agent to resolve them semantically.
 *
 * Returns true if the cherry-pick succeeded (cleanly or via agent recovery),
 * false if recovery was exhausted and manual intervention is needed.
 *
 * @internal — exported for use by {@link integrateGroup} and unit tests.
 *             Not part of the public API.
 */
export async function tryCherryPickWithRecovery(
  pipeline: ImplementPipeline,
  deps: ImplementDeps,
  logFile: string,
  stBranch: string,
  subtaskId: number,
): Promise<boolean> {
  // Guard against an empty cherry-pick range. `git cherry-pick` hard-errors
  // on zero commits ("empty commit set passed") instead of treating it as a
  // no-op. A subtask can legitimately reach this point with no commits yet
  // for reasons other than a live wakeup (a deliverable-verification
  // failure, a scope violation, or a session that simply didn't produce
  // anything) — in all of those cases there is nothing to integrate, so
  // skip the git call entirely rather than crashing the whole group's
  // integration over it. Checked via projectRoot (never container-patched,
  // unlike a per-subtask worktree) so this works regardless of container
  // mode. If the check itself fails, fall through and let the real
  // cherry-pick attempt surface the actual error.
  try {
    const log = execFileSync('git', ['log', pipeline.branch + '..' + stBranch, '--oneline'], {
      cwd: deps.projectRoot, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
    if (!log) {
      logToOutput(pipeline.specPath, '\n[WORKTREE] Subtask ' + subtaskId + ' branch ' + stBranch + ' has no new commits — nothing to cherry-pick\n');
      return true;
    }
  } catch { /* best-effort — fall through to the real attempt */ }

  // Tier 1: Normal cherry-pick
  try {
    logToOutput(pipeline.specPath, '\n[WORKTREE] Cherry-picking commits from ' + stBranch + ' onto ' + pipeline.branch + '\n');
    deps.execGit(['cherry-pick', pipeline.branch + '..' + stBranch], pipeline.worktreePath);
    logToOutput(pipeline.specPath, '[WORKTREE] Cherry-pick succeeded for subtask ' + subtaskId + '\n');
    return true;
  } catch (firstErr) {
    const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    logToOutput(pipeline.specPath, '[WORKTREE] Cherry-pick failed for subtask ' + subtaskId + ': ' + firstMsg + '\n');

    // Defect 3: detect infra-class errors (dead container, Docker unreachable)
    // and retry after reprovisioning before giving up. These are trivially
    // retryable once the container is back, unlike genuine git conflicts.
    if (!checkCherryPickInProgress(pipeline.worktreePath, deps.execGitCapture) && isInfraError(firstMsg)) {
      try { deps.execGit(['cherry-pick', '--abort'], pipeline.worktreePath); } catch { /* best-effort */ }

      // Check if container mode is active and attempt reprovision
      if (readContainerConfig(deps.projectRoot).enabled) {
        for (let retry = 0; retry < 2; retry++) {
          logToOutput(pipeline.specPath, '[WORKTREE] Infra error detected — reprovisioning container and retrying cherry-pick (attempt ' + (retry + 1) + '/2)\n');
          try {
            await containerManager.ensureContainer(deps.projectRoot, logFile);
            await new Promise(r => setTimeout(r, 1000)); // brief backoff for container stabilisation
            deps.execGit(['cherry-pick', pipeline.branch + '..' + stBranch], pipeline.worktreePath);
            logToOutput(pipeline.specPath, '[WORKTREE] Cherry-pick recovered after infra retry for subtask ' + subtaskId + '\n');
            return true;
          } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            logToOutput(pipeline.specPath, '[WORKTREE] Cherry-pick retry ' + (retry + 1) + ' failed: ' + retryMsg + '\n');
            try { deps.execGit(['cherry-pick', '--abort'], pipeline.worktreePath); } catch { /* best-effort */ }
          }
        }
        logToOutput(pipeline.specPath, '[WORKTREE] Infra retries exhausted for subtask ' + subtaskId + ' — cannot auto-recover\n');
        return false;
      }

      // Not in container mode — nothing to reprovision
      logToOutput(pipeline.specPath, '[WORKTREE] Cherry-pick hard-failed (not a conflict) — cannot auto-recover subtask ' + subtaskId + '\n');
      return false;
    }
  }

  // Check whether this is a recoverable conflict or a hard failure
  if (!checkCherryPickInProgress(pipeline.worktreePath, deps.execGitCapture)) {
    try { deps.execGit(['cherry-pick', '--abort'], pipeline.worktreePath); } catch { /* best-effort */ }
    logToOutput(pipeline.specPath, '[WORKTREE] Cherry-pick hard-failed (not a conflict) — cannot auto-recover subtask ' + subtaskId + '\n');
    return false;
  }

  // Tier 2: Spawn merger agent to resolve conflicts semantically
  try {
    const conflictedFiles = deps.execGitCapture(['diff', '--name-only', '--diff-filter=U'], pipeline.worktreePath).trim();
    logToOutput(pipeline.specPath, '[WORKTREE] Conflicted files: ' + (conflictedFiles || '(none listed)') + '\n');
  } catch { /* best-effort — proceed with merger */ }
  logToOutput(pipeline.specPath, '[WORKTREE] Cherry-pick has conflicts — spawning merger agent for subtask ' + subtaskId + '\n');
  try {
    const mergeLogFile = path.join(pipeline.specPath, 'output-merge.log');
    const mergeSessionId = await processManager.createSession(
      deps.sessionOpts('merger', pipeline.worktreePath, pipeline.taskId, mergeLogFile),
    );
    updateSessionMap(pipeline.specPath, 'merge', mergeSessionId);
    processManager.sendMessage(mergeSessionId,
      'Resolve cherry-pick conflicts\n\n' +
      'A `git cherry-pick` from branch `' + stBranch + '` was attempted onto `' + pipeline.branch + '`\n' +
      'but encountered merge conflicts. The conflict markers are already in the files.\n\n' +
      'Your job:\n' +
      '1. Read each conflicted file and understand the intent of both sides of each conflict\n' +
      '2. Resolve all conflicts semantically — preserve the intent of BOTH sets of changes\n' +
      '3. `git add` the resolved files\n' +
      '4. Run `git cherry-pick --continue` to complete the cherry-pick\n' +
      '5. Run the test suite to verify correctness (one attempt, wait for completion)\n' +
      '6. Print a summary of conflicts resolved and test results'
    );
    await deps.waitForCompletion(mergeSessionId);
    processManager.killSession(mergeSessionId);

    if (checkCherryPickInProgress(pipeline.worktreePath, deps.execGitCapture)) {
      logToOutput(pipeline.specPath, '[WORKTREE] Merger finished but cherry-pick still in progress for subtask ' + subtaskId + ' — aborting\n');
      try { deps.execGit(['cherry-pick', '--abort'], pipeline.worktreePath); } catch { /* best-effort */ }
      return false;
    }

    logToOutput(pipeline.specPath, '[WORKTREE] Merger agent resolved cherry-pick conflicts for subtask ' + subtaskId + '\n');
    return true;
  } catch (mergeErr) {
    const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
    logToOutput(pipeline.specPath, '[WORKTREE] Merger agent failed for subtask ' + subtaskId + ': ' + mergeMsg + '\n');
    try { deps.execGit(['cherry-pick', '--abort'], pipeline.worktreePath); } catch { /* best-effort */ }
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Other helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Build the description string for synthetic subtask 9999.
 *
 * @internal — exported for unit tests to verify the header is present.
 *             Not part of the public API.
 */
export function buildSyntheticReworkDescription(qaContent: string): string {
  return (
    '⚠️ ALL PLAN SUBTASKS ARE DONE — THIS IS TARGETED REWORK, NOT FRESH IMPLEMENTATION.\n\n' +
    'QA found failures that could not be automatically mapped to specific plan subtasks. ' +
    'The original plan subtasks are already implemented — do NOT re-read or re-implement them. ' +
    'Do NOT re-read the spec. Your ONLY job is to fix the QA issues listed below.\n\n' +
    '**QA feedback (source of truth):**\n\n' + qaContent
  );
}

function buildSubtaskFeedback(
  hasQaFeedback: boolean,
  qaOnlyCriteria: string[],
  subtask: PlanSubtask,
  specPath: string,
  humanFeedbackPath: string,
  hasHumanFeedback: boolean,
): string {
  if (!hasQaFeedback) return '';
  const lines: string[] = [];
  lines.push('## ⚠️ QA FEEDBACK — FIX THESE FIRST ⚠️');
  lines.push('');
  try {
    const reportPath = path.join(specPath, 'qa_report.json');
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
        .replace(/\s*\[QA ISSUE\s*(?:(?:\w*)\))?:\s*/g, '')
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
}
