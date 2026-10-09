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
import { createOutOfScopeTicketsFromLog } from './out-of-scope-tickets';
import { humanDirectiveFor, readHumanFeedback } from './human-feedback';
import { renderCommand } from '../command-templates';
import { resolveBaseBranch } from '../git-platform';
import { getUnpushedCommits } from './worktree-ops';
import { removeStaleWorktreeRegistration } from './worktree-utils';
import { warn } from '../logger';
import {
  scanWakeupFilesWithRetry, parseWakeupFile, computeNextAttemptCount, isGenuineRelaunch,
  snapshotMtime, checkStaleWakeupReentry, clearWakeupState, wakeupAttemptsExceeded, buildWakeupReentryHeader,
  findLiveOrphanedJob,
} from './wakeup';
import type { TaskStore } from '../task-store';
import type { PipelinePhase } from '@/constants/phases';
import type { TaskPipeline, QaReport, PlanSubtask, SessionOptsResult } from './types';
import type { FailureReason } from './qa-feedback';
import { readFilesToFix } from './qa-feedback';

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
  /** Regenerates task.json's completionSummary/failureReason and
   *  completion_summary.md — every implement-phase path that fails the task
   *  directly (bypassing QA) must call this so the UI reflects the actual
   *  cause instead of a stale summary from a prior QA-driven failure. */
  writeCompletionSummary: (pipeline: ImplementPipeline, reason: FailureReason, detail?: string) => void;
  getPipelineConfig: () => { maxQaAttempts: number; parallelSubtasks: boolean; sensors?: SensorsConfig; maxImplementRetries: number; maxStallRecoveries: number; idleStallMinutes: number; toolStallMinutes: number; wakeupScanRetryDelayMs?: number };
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
 * open by an orphaned process — a background server/job from an
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
      `run (e.g. an orphaned background server/job). Manually stop whatever holds ` +
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
    pipeline.worktreePath, pipeline.taskId, pipeline.branch, implementLog,
    {
      projectRoot: deps.projectRoot,
      execGit: deps.execGit,
      execGitCapture: deps.execGitCapture,
      gitPush: deps.gitPush,
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
 * Select the subtask IDs a coder-targeted human directive should re-run.
 * Best-effort keyword match against title/description/files/acceptance
 * criteria; falls back to all subtasks when nothing matches.
 */
export function selectReworkTargets(subtasks: PlanSubtask[], feedback: string): number[] {
  const tokens = feedback
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(t => t.length > 2);
  if (tokens.length === 0) return subtasks.map(s => s.id);

  const scored = subtasks.map(s => {
    const haystack = [
      s.title,
      s.description,
      ...(s.files || []),
      ...(s.acceptance_criteria || []),
    ]
      .join(' ')
      .toLowerCase();
    const hits = tokens.filter(t => haystack.includes(t)).length;
    return { id: s.id, hits };
  });

  const best = Math.max(0, ...scored.map(s => s.hits));
  if (best === 0) return subtasks.map(s => s.id);
  return scored.filter(s => s.hits > 0).map(s => s.id);
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
      try {
        writeFileSync(snapshotPath, readFileSync(humanFeedbackPath, 'utf-8'));
      } catch (err) {
        // Defensive snapshot — a failure only means nothing to restore from
        // later, but surface it so a silently-missing snapshot is diagnosable.
        warn('implement', `Failed to snapshot human feedback to ${snapshotPath}`, err);
      }
    }
  }

  // Only re-run QA-flagged subtasks on bounce-back. The synthetic rework
  // subtask (id 9999, see below) is excluded from this real-subtask pool:
  // every bounce that reaches the fallback must synthesise a fresh one from
  // the *current* qa_feedback.md, never replay a stale persisted copy.
  const realSubtasks = plan.subtasks.filter((s: PlanSubtask) => s.id !== 9999);

  // A coder-targeted human directive forces a rework even when every subtask is
  // already complete (otherwise the [SKIP] branch below would drop the comment
  // and bounce straight to QA without the coder ever seeing it). The affected
  // subtasks come from the reviewer's explicit selection when present, else a
  // keyword match against title/description/files/criteria — mark them
  // incomplete so they re-run. A human directive for the coder is authoritative:
  // it overrides both `completed` and any stale `qa_flagged` flags.
  const humanFeedback = hasHumanFeedback ? readHumanFeedback(pipeline.specPath) : null;
  let humanReworkIds: Set<number> | null = null;
  if (humanFeedback?.target === 'coder') {
    const ids = humanFeedback.subtaskIds?.length
      ? humanFeedback.subtaskIds
      : selectReworkTargets(realSubtasks, humanFeedback.message);
    humanReworkIds = new Set(ids);
    for (const s of realSubtasks) {
      if (humanReworkIds.has(s.id)) s.completed = false;
    }
  }

  // `qa_flagged` alone is not enough: it is intentionally left set on an
  // already-completed subtask until the whole QA-targeted set finishes (see
  // the qaTargetedDone cleanup below, which needs it to stay readable as
  // "was this part of the targeted set" after completion). A multi-pass
  // bounce-back round re-enters this selection once per pass, so without the
  // `!s.completed` guard a subtask that genuinely finished on an earlier
  // pass of the SAME round gets reselected on the next one, forced back to
  // `completed: false` by the reset below, redispatched with nothing left to
  // fix, and rejected by the "ended without touching any files" heuristic as
  // a false scope violation — which then trips GROUP-BARRIER to defer every
  // later group (including whichever one holds the subtask that actually
  // still needs work) until the pass cap fails the task outright. Found on
  // task a-later-demo-task: subtask 11 genuinely
  // completed on pass 1, then looped as a false rejection on passes 2–3
  // while subtask 12 — in a later group, deferred by the barrier each time —
  // never got a chance to run again.
  const subtasksToRun = humanReworkIds
    ? realSubtasks.filter((s: PlanSubtask) => humanReworkIds!.has(s.id))
    : hasQaFeedback
      ? realSubtasks.filter((s: PlanSubtask) => s.qa_flagged && !s.completed)
      : realSubtasks.filter((s: PlanSubtask) => !s.completed);

  let effectiveSubtasks: PlanSubtask[];
  if (!humanReworkIds && hasQaFeedback && subtasksToRun.length === 0) {
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
    } catch (err) {
      // The pipeline proceeds (the in-memory plan already carries the
      // synthesized subtask), but a failed persist means the next run lacks
      // the 9999 entry, so getTaskFull() can't surface output-st9999.log.
      warn('implement', `Failed to persist synthesized QA-rework subtask to plan.json for ${pipeline.taskId}`, err);
    }
  } else {
    effectiveSubtasks = subtasksToRun;
  }

  // ADR 002: Wakeup isolation — only re-enter the wakeup-pending subtask.
  // Gate this on whether the wakeup subtask is actually still part of this
  // round's selection, NOT on pipeline.wakeupUntil — orchestrator.ts's
  // _fireWakeup clears wakeupUntil on the pipeline BEFORE re-entering this
  // phase for a genuine resume (while deliberately leaving wakeupSubtaskId
  // set, for the re-entry prompt below), so wakeupUntil is already falsy at
  // this point on every real resume too, not just stale ones. Gating on it
  // would disable isolation for real resumes as well, letting deferred
  // subtasks (never started) run early — breaking the "deferred until the
  // wakeup subtask's artifact is committed" guarantee this filter exists
  // for. See tests/unit/orchestrator-robustness.test.ts's
  // "only re-enters the wakeup subtask — deferred subtasks are excluded".
  //
  // Selection membership alone isn't sufficient, though: a scoped replan (a
  // human directive that re-plans only some subtasks, or a fresh plan after
  // a `failed` task is retried) can reset an EARLIER subtask back to
  // `completed: false` while a LATER subtask's stale wakeupSubtaskId pointer
  // survives untouched — that later subtask still trivially shows up in
  // effectiveSubtasks (it was simply never completed either), so a
  // membership-only check would isolate to it and skip the dependency the
  // replan just invalidated. Require every depends_on id of the wakeup
  // subtask to still be completed in the full plan before trusting the
  // isolation. See tests/unit/select-subtasks-stale-wakeup.test.ts's
  // "wakeup subtask whose dependency was reset by a replan" case.
  if (pipeline.wakeupSubtaskId != null) {
    const isolated = effectiveSubtasks.filter(s => s.id === pipeline.wakeupSubtaskId);
    const dependenciesSatisfied = isolated.length > 0 && (isolated[0].depends_on ?? []).every(
      depId => plan.subtasks.find(s => s.id === depId)?.completed === true,
    );
    if (dependenciesSatisfied) {
      effectiveSubtasks = isolated;
    } else {
      // Either the wakeup subtask isn't part of this round's selection (e.g.
      // QA flagged a different subtask on bounce-back) or one of its
      // dependencies was reset back to incomplete by a replan — either way,
      // drop the stale isolation instead of silently emptying the run or
      // dispatching a subtask whose prerequisite was just invalidated.
      const staleWakeupSubtaskId = pipeline.wakeupSubtaskId;
      pipeline.wakeupSubtaskId = undefined;
      const reason = isolated.length > 0
        ? 'its dependencies are no longer satisfied'
        : "it is not part of this round's selection";
      logToOutput(pipeline.specPath,
        `\n[QA-REWORK] Stale wakeup isolation for subtask ${staleWakeupSubtaskId} cleared — ${reason}\n`);
    }
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
    } catch (err) {
      // A failed checkpoint write silently loses the completed→true marks, so
      // on resume the subtask re-runs. Must never fail the pipeline, but must
      // be visible.
      warn('implement', `Failed to persist completed subtasks to plan.json for ${pipeline.taskId}`, err);
    }
  });
}

/**
 * Remove qa_flagged markers from plan.json after a bounce-back implement run
 * completes, so the next run doesn't re-trigger already-fixed subtasks.
 *
 * @internal — exported for unit tests only. Not part of the public API.
 */
export function cleanQaFlaggedMarkers(pipeline: ImplementPipeline): void {
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
  } catch (err) {
    // A failed cleanup leaves stale qa_flagged markers on the next run,
    // re-triggering QA-rework subtasks that were already fixed. Surface it.
    warn('implement', `Failed to clean qa_flagged markers from plan.json for ${pipeline.taskId}`, err);
  }
}

/**
 * The `files_to_create` paths a dispatch must freshly (re)commit — one rule for
 * every pass. Freshness exists to reject stale evidence the dispatch was meant
 * to produce, so only the deliverables QA said need fixing count. `filesToFix`
 * null = nothing narrows the dispatch (the first pass, or QA/a human didn't say
 * which files), so every deliverable is relevant; an empty array = QA asserts
 * no file needs to change, so none is required to be fresh.
 *
 * @internal — exported for unit tests only. Not part of the public API.
 */
export function relevantDeliverables(filesToCreate: string[], filesToFix: string[] | null): string[] {
  if (filesToFix === null) return filesToCreate;
  const fix = new Set(filesToFix);
  return filesToCreate.filter(f => fix.has(f));
}

/** QA's files_to_fix for the current rework; null when absent, or a human directive is in play. */
function reworkFilesToFix(specPath: string): string[] | null {
  if (existsSync(path.join(specPath, 'human_feedback.md'))) return null;
  return readFilesToFix(specPath);
}

/**
 * Reconcile stale `completed: false` flags against what's actually on disk,
 * right before the implement-completeness gate reads them.
 *
 * The QA-fallback synthetic subtask (id 9999, see selectSubtasks) is scoped
 * to "fix everything qa_feedback.md names," not to any one original
 * subtask's declared `files_to_create` — so when its fix happens to satisfy
 * a REAL subtask's own deliverables (e.g. it wrote the exact files subtask 5
 * was supposed to produce), subtask 5 itself never ran this pass and its
 * `completed` flag never gets set by the normal runSubtaskSession path. Left
 * unreconciled, the completeness gate checks subtask 5's stale
 * `completed: false` forever — no number of correct 9999 rework attempts can
 * ever flip it, so the task fails deterministically regardless of how many
 * times the coder fixes the actual problem. Found on task
 * detect-mechanical-periodic-melodic-loops: 9999 restored subtask 5's three
 * missing evidence files across two further (correctly-idle) rework
 * attempts, yet the task still failed with "Subtask(s) 5, 6 remained
 * incomplete."
 *
 * Any real subtask whose `files_to_create` are all present on disk is marked
 * completed here regardless of which subtask's session actually produced
 * them — mirrors the same existence check runSubtaskSession's own deliverable
 * verification applies to the subtask that ran, now ALSO freshness-checked
 * the same way (see that check's comment): existence alone can't distinguish
 * a file this pass genuinely produced from one left over, untouched, from a
 * prior QA-rejected round. When `passStartHead`/`execGitCapture` are given,
 * a files_to_create path only counts if it also appears in `cwd`'s own
 * `git diff passStartHead..HEAD` — i.e. was actually (re)committed somewhere
 * during THIS pass, whether by the subtask's own session or, per this
 * function's whole reason for existing, a DIFFERENT one (9999). Omitted or
 * unresolvable, this falls back to existence-only, same as before. Found on
 * task a-later-demo-task: subtask 15's five
 * files_to_create survived on disk from a stale commit two rounds back; no
 * session in the current pass touched them, yet this reconciliation marked
 * subtask 15 completed anyway immediately after the per-session check had
 * correctly rejected it moments earlier in the same pass.
 *
 * Also flags (`qa_flagged: true`) any not-yet-complete real subtask whose
 * `depends_on` are now all satisfied by this reconciliation pass, so a
 * dependent like subtask 6 above — never itself named in qa_feedback.md, and
 * so never selected by the qa_flagged-only bounce filter — gets picked up on
 * the next implement pass instead of staying permanently unreachable.
 *
 * Mutates `subtasks` in place (including 9999, harmlessly — it has no
 * files_to_create and is filtered out of `realSubtasks` before this array is
 * ever built) and returns whether anything changed.
 *
 * @internal — exported for unit tests only. Not part of the public API.
 */
export function reconcileSubtaskCompletionFromDeliverables(
  subtasks: PlanSubtask[],
  cwd: string,
  specPath: string,
  passStartHead?: string,
  execGitCapture?: ImplementDeps['execGitCapture'],
): boolean {
  let changed = false;
  const newlyCompletedIds: number[] = [];

  const filesToFix = reworkFilesToFix(specPath);
  let changedFiles: string[] | null = null;
  if (passStartHead && execGitCapture) {
    try {
      changedFiles = execGitCapture(['diff', '--name-only', passStartHead + '..HEAD'], cwd).trim().split('\n').filter(Boolean);
    } catch { changedFiles = null; }
  }

  for (const s of subtasks) {
    if (s.completed || s.id === 9999 || !s.files_to_create?.length) continue;
    const allPresent = s.files_to_create.every(f => existsSync(path.join(cwd, f)));
    const allFresh = changedFiles === null
      || relevantDeliverables(s.files_to_create, filesToFix).every(f => changedFiles!.includes(f));
    if (allPresent && allFresh) {
      s.completed = true;
      changed = true;
      newlyCompletedIds.push(s.id);
      logToOutput(specPath,
        '\n[RECONCILE] Subtask ' + s.id + ' marked completed — its declared files_to_create ' +
        'now all exist on disk (produced by another subtask, e.g. a QA-rework fix)\n');
    }
  }

  if (newlyCompletedIds.length) {
    for (const s of subtasks) {
      if (s.completed || s.id === 9999 || s.qa_flagged || !s.depends_on?.length) continue;
      const touchesNewCompletion = s.depends_on.some(id => newlyCompletedIds.includes(id));
      if (!touchesNewCompletion) continue;
      const allDepsComplete = s.depends_on.every(depId => subtasks.find(t => t.id === depId)?.completed);
      if (allDepsComplete) {
        s.qa_flagged = true;
        changed = true;
        logToOutput(specPath,
          '\n[RECONCILE] Subtask ' + s.id + ' flagged for the next implement pass — its dependency (' +
          s.depends_on.join(', ') + ') just completed via reconciliation\n');
      }
    }
  }

  return changed;
}

/**
 * Read and consume a `subtask_blocked-st<ID>.json` file, if the subtask's
 * session wrote one. This is the deterministic counterpart to the coder
 * simply narrating "this needs a code fix, not more waiting, route this to
 * failure" in its summary — the orchestrator must not infer that conclusion
 * from the ABSENCE of other signals (no wakeup file, no missing
 * `files_to_create` deliverable), because that's indistinguishable from a
 * session that simply never got around to doing anything. A coder that has
 * already root-caused a genuine defect and decided further retries are
 * pointless writes this file instead of relying on a human (or a later pass)
 * to read and act on its prose explanation.
 *
 * Found on task a-later-demo-task: subtask 15's
 * session correctly diagnosed a defect in an earlier subtask, wrote "this
 * should go to the pipeline's failure path... no wakeup file written" in its
 * summary, and ended. Nothing read that sentence — the orchestrator
 * re-entered the subtask a 4th time, which re-verified the same artifacts
 * and reached the identical conclusion a second time, before an unrelated
 * circuit breaker (the `files_to_create` deliverable-verification cap)
 * finally failed the task anyway, one wasted session later.
 *
 * Deletes the file after reading (best-effort), mirroring the wakeup-file
 * convention. Returns null if the file doesn't exist or is malformed.
 */
function readSubtaskBlockedFile(
  specPath: string,
  subtaskId: number,
): { reason: string; blockingSubtaskId?: number } | null {
  const blockedPath = path.join(specPath, `subtask_blocked-st${subtaskId}.json`);
  if (!existsSync(blockedPath)) return null;
  let result: { reason: string; blockingSubtaskId?: number } | null = null;
  try {
    const raw = JSON.parse(readFileSync(blockedPath, 'utf-8'));
    if (raw && typeof raw.reason === 'string' && raw.reason.trim()) {
      result = {
        reason: raw.reason.trim(),
        blockingSubtaskId: typeof raw.blocking_subtask_id === 'number' ? raw.blocking_subtask_id : undefined,
      };
    }
  } catch { /* malformed — treated as missing */ }
  try { unlinkSync(blockedPath); } catch { /* best-effort */ }
  return result;
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
    wakeupHeader = buildWakeupReentryHeader({
      unitLabel: 'this subtask',
      wakeupFilename: 'subtask_wakeup-st' + subtask.id + '.json',
      command: pipeline.wakeupCommand,
      artifact: pipeline.wakeupArtifact,
      worktreeNote: true,
      headAtSchedule: pipeline.wakeupHeadAtSchedule,
      currentHead: (() => {
        try { return deps.execGitCapture(['rev-parse', 'HEAD'], pipeline.worktreePath).trim(); } catch { return undefined; }
      })(),
    });
  }

  // Deliverable re-verification prompt header
  let deliverableHeader = '';
  if (!hasQaFeedback && !wakeupHeader && pipeline.deliverableFailCounts?.[subtask.id]) {
    const attemptCount = pipeline.deliverableFailCounts[subtask.id];
    const maxFails = deps.getPipelineConfig().maxImplementRetries;
    deliverableHeader = '⚠️ DELIVERABLE RE-VERIFICATION (attempt ' + attemptCount + '/' + maxFails + ')\n\n' +
      'Your previous session for this subtask ended but the following required\n' +
      'deliverable files were NOT created:\n\n' +
      (subtask.files_to_create?.map(f => '  - ' + f).join('\n') || '') + '\n\n' +
      'You MUST create these files before ending your session — unless they come from\n' +
      'a long-running job (yours, or one the previous session already started) that\n' +
      'will not finish within this session. Then confirm the job is still running, write\n' +
      '`subtask_wakeup-st' + subtask.id + '.json` as your instructions describe, and end the\n' +
      'session: the orchestrator pauses this subtask instead of counting it as missing.\n' +
      'Do not wait on the job in this session. If you cannot create them at all (e.g.,\n' +
      'the task is impossible with the current spec), explain why and the orchestrator\n' +
      'will advance the task to failed.\n\n';
  }

  const promptHeader = wakeupHeader || deliverableHeader;

  // Resume-context header (#6): inject task/branch/subtask context so a
  // restarted session doesn't pay a full re-read tax to reconstruct state.
  let resumeContext = '## SESSION CONTEXT\n\n' +
    'Task: ' + pipeline.description + '\n' +
    'Branch: ' + pipeline.branch + '\n';

  // Show only the completed dependencies this subtask builds on — not every
  // completed subtask, which wastes tokens re-listing work the agent never
  // needs to inspect.
  try {
    const planPath = path.join(pipeline.specPath, 'plan.json');
    if (existsSync(planPath)) {
      const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
      if (plan.subtasks) {
        const dependsOn = new Set(subtask.depends_on || []);
        const completedDeps = plan.subtasks.filter((s: PlanSubtask) =>
          s.completed && dependsOn.has(s.id)
        );
        resumeContext += 'Subtasks: ' + plan.subtasks.length + ' total';
        if (completedDeps.length > 0) resumeContext += ', ' + completedDeps.length + ' dependencies already done (' +
          completedDeps.map((s: PlanSubtask) => '#' + s.id + ': ' + s.title).join(', ') + ')';
        resumeContext += '\n';
      }
    }
  } catch { /* best-effort */ }

  resumeContext += 'Current: Subtask ' + subtask.id + ': ' + subtask.title + '\n';
  resumeContext += 'Working directory: ' + cwd + ' (this is your git worktree)\n\n';

  // QA rework is its own command (implement-fix) — the orchestrator already
  // knows which mode this is, so the agent never has to infer it.
  const command = hasQaFeedback ? 'implement-fix' : 'implement';
  const request =
    humanDirectiveFor(pipeline.specPath, 'coder') +
    promptHeader +
    resumeContext +
    (subtaskFeedback ? subtaskFeedback + '\n---\n' : '') +
    'Subtask ' + subtask.id + ': ' + subtask.title + '\n\n' +
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

  // Populated by the scope check below (preSessionHead..HEAD diff) whenever
  // it runs; reused by the files_to_create deliverable check further down to
  // require freshness, not just existence — see that check's comment for why.
  let sessionChangedFiles: string[] = [];

  // Stall-detector-kill recovery loop. A session killed for stalling
  // (killReason 'stalled' — 30+ min with a tool call in flight and zero
  // output) doesn't necessarily mean the work is unrecoverable: the command
  // may have actually finished, or the coder may just need to diagnose why
  // it hung. Give it a bounded number of fresh-session retries before
  // failing outright. A deliberate stop (killReason unset) is never
  // retried — it rethrows immediately, exactly as before this loop existed.
  let sessionId: string;
  let sessionStartedAt = Date.now();
  let stallRecoveryHeader = '';
  for (;;) {
    // Rendered before the session exists, so a template problem can never
    // leave a spawned session waiting on a message that never comes.
    const message = renderCommand(command, stallRecoveryHeader + request);
    try {
      sessionStartedAt = Date.now();
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

    processManager.sendMessage(sessionId, message);

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
        deps.writeCompletionSummary(pipeline, 'implement-failure');
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

  // Commit guard: a coder session can legitimately finish its edits, run
  // tests, and report success without ever running `git add`/`git commit` —
  // nothing in its prompt is verified, only suggested (teamai-workflow.md's
  // "commit after every change" is a convention, not an enforcement point).
  // Left uncommitted, this working-tree-only diff is invisible to two things
  // downstream: the scope check just below only diffs COMMITTED history
  // (preSessionHead..HEAD), so out-of-scope uncommitted edits sail through
  // unchecked; and squashWithMessage's `git reset --soft <merge-base>` only
  // restages the tree of the previous commit, so anything never staged is
  // silently dropped from the PR entirely — no error, no warning, the code
  // just never reaches the branch. Found on a real
  // task: subtask 1 implemented the fix
  // and its tests, verified all green, and ended the session having never
  // committed either file; QA (which runs directly against the worktree, not
  // its git history) reviewed the working tree and passed it; the eventual PR
  // shipped with only the unrelated evidence-log commit from a later subtask.
  // Auto-commit here, before the scope check reads git history, so both gaps
  // close at the same point: real work is never silently lost, and the scope
  // check can now see (and reject) uncommitted out-of-scope edits too.
  try {
    const status = deps.execGitCapture(['status', '--porcelain'], cwd);
    if (status.trim()) {
      deps.execGit(['add', '-A', '--', '.', ':!.teamai'], cwd);
      deps.execGit(['commit', '-m', `WIP: auto-commit subtask ${subtask.id} changes (coder session ended without committing)`], cwd);
      logToOutput(pipeline.specPath,
        '\n[COMMIT-GUARD] Subtask ' + subtask.id + ' left uncommitted changes — auto-committed before scope/QA handoff\n');
    }
  } catch (commitErr) {
    const commitMsg = commitErr instanceof Error ? commitErr.message : String(commitErr);
    logToOutput(pipeline.specPath, '\n[COMMIT-GUARD] Failed to auto-commit subtask ' + subtask.id + ' changes: ' + commitMsg + '\n');
  }

  // Explicit blocked declaration — see readSubtaskBlockedFile's doc for the
  // incident this closes. Checked before scope/wakeup/deliverable
  // verification: none of that matters once the coder has already
  // root-caused a defect that needs a human or a different subtask's fix,
  // not another retry of this one.
  const blocked = readSubtaskBlockedFile(pipeline.specPath, subtask.id);
  if (blocked) {
    const detail = 'Subtask ' + subtask.id + ' reported it cannot proceed: ' + blocked.reason +
      (blocked.blockingSubtaskId != null ? ' (points to subtask ' + blocked.blockingSubtaskId + ')' : '');
    logToOutput(pipeline.specPath, '\n[BLOCKED] ' + detail + ' — advancing to failed without further retries\n');
    try {
      writeFileSync(path.join(pipeline.specPath, 'qa_report.json'), JSON.stringify({
        overall: 'FAIL',
        criteria: [{
          criterion: 'Subtask reported a blocking defect',
          name: 'Subtask reported a blocking defect',
          status: 'FAIL',
          notes: detail,
        }],
      }, null, 2));
    } catch { /* best-effort — writeCompletionSummary below still records the failure */ }
    deps.writeCompletionSummary(pipeline, 'subtask-blocked', detail);
    deps.advancePhase(pipeline, 'failed');
    return;
  }

  // Out-of-scope bug tickets (#3b): the coder reports `[BUG] Fix: ...` lines
  // in its summary instead of hand-writing task.json files; the orchestrator
  // parses the session log and creates deterministic tickets. Best-effort.
  try {
    const createdIds = createOutOfScopeTicketsFromLog(deps.projectRoot, subtaskLogFile, deps.taskStore);
    if (createdIds.length > 0) {
      logToOutput(pipeline.specPath, '[BUG-TICKET] Subtask ' + subtask.id + ' reported ' + createdIds.length + ' out-of-scope bug(s) — created ticket(s): ' + createdIds.join(', ') + '\n');
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logToOutput(pipeline.specPath, '\n[BUG-TICKET] Failed to create out-of-scope tickets: ' + msg + '\n');
  }

  // Post-session scope check: verify agent only modified assigned files.
  // Exempt the QA-fallback synthetic subtask (id 9999, see selectSubtasks) —
  // its `files` array is only a best-effort union seeded from the real
  // subtasks' own declared files, not an authoritative scope, because
  // criterion-matching already found nothing to target it against. Its real
  // scope is whatever qa_feedback.md names (implement-fix.md's QA Rework Mode:
  // "Fix every listed issue. That's the entire scope."), which routinely
  // includes paths no real subtask's `files`/`files_to_create` ever listed —
  // e.g. deliverables owned by a subtask QA's criterion-matcher didn't flag.
  // Rejecting 9999 for touching exactly those paths defeats the fallback
  // synthesis's entire purpose: it fires precisely when nothing else can be
  // targeted, so its coder session must be free to fix what QA actually
  // named. Found on task detect-mechanical-periodic-melodic-loops: 9999
  // correctly produced the three missing evidence files subtask 5 was
  // supposed to create, and got rejected for it — the commit itself was
  // never reverted (this check only marks the subtask incomplete), but the
  // attempt was burned regardless.
  if (preSessionHead && subtask.id !== 9999) {
    try {
      const changedFiles = deps.execGitCapture(['diff', '--name-only', preSessionHead + '..HEAD'], cwd).trim().split('\n').filter(Boolean);
      sessionChangedFiles = changedFiles;

      // A subtask's declared scope is files it edits (`files`) plus files it
      // creates fresh (`files_to_create`) — deliverable verification already
      // treats both as in-scope (it fails the subtask if a files_to_create
      // path is MISSING), so the scope check must accept the same set or it
      // rejects a subtask for doing exactly what it was told to do whenever
      // its entire deliverable is new files (files: [] + files_to_create-only).
      const assignedFiles = new Set([...(subtask.files || []), ...(subtask.files_to_create || [])]);
      const violations = changedFiles.filter(f => !assignedFiles.has(f));

      if (violations.length > 0) {
        scopeViolations.add(subtask.id);
        logToOutput(pipeline.specPath,
          '\n[SCOPE] Subtask ' + subtask.id + ' modified files outside its assigned scope:\n' +
          violations.map(f => '  - ' + f).join('\n') + '\n' +
          '[SCOPE] Assigned files: ' + ([...assignedFiles].join(', ') || '(none)') + '\n'
        );
      } else if ((subtask.files || []).length > 0 && !(subtask.files_to_create || []).length && changedFiles.length === 0 && !subtask.verify_only) {
        // No-op subtask detection: the coder session ended having committed
        // NO changes at all, for a subtask whose only declared scope is
        // EXISTING files to edit. Deterministic and orchestrator-side — does
        // not rely on the coder self-reporting that nothing happened.
        // Restricted to `files_to_create`-less subtasks because that field
        // already has its own existence-based deliverable check (with its
        // own circuit breaker) — a subtask that declares BOTH `files` and
        // `files_to_create` is already verified by that check whenever its
        // new files land, regardless of whether the pre-existing ones in
        // `files` also changed. (Since `violations.length === 0` here,
        // `changedFiles` can only contain entries from `files`/
        // `files_to_create` — so once `files_to_create` is excluded,
        // "changedFiles is empty" and "none of `files` were touched" are the
        // same condition.) Exempt a deliberate `[SKIPPED]` deferral (ticket
        // creation, pipeline-artifact management — see plan.md/implement.md)
        // since those subtasks can legitimately make no code changes at all.
        //
        // Exempt `verify_only` subtasks (run-only gates such as "run the full
        // test suite"): their `files` is the permitted scope for fixing a
        // failure, and a clean run legitimately edits nothing. Found on task
        // fix-calm-minor-8-note-melodies-have-no-v: the suite-gate subtask
        // passed 2618/2618 three times, was rejected each time for making no
        // edit, and the group barrier then deferred subtasks 5-10 until the
        // pass cap failed the task.
        //
        // Found on task a-later-demo-task: subtask 1's
        // entire session was "read some files, dispatch a research sub-agent,
        // wait for it" — the turn ended before any Edit/Write call, before
        // the sub-agent's findings were ever used, and before a single line
        // of the assigned fix was written. Nothing rejected it: no
        // files_to_create to fail, no out-of-scope files to flag. It was
        // marked completed, and the missing fix silently propagated through
        // 14 further subtasks until a verification subtask caught the
        // regression empirically ~12 hours and several dollars of session
        // cost later.
        let sessionSummary = '';
        try { sessionSummary = readFileSync(subtaskLogFile, 'utf-8'); } catch { /* best-effort */ }
        if (!sessionSummary.includes('[SKIPPED]')) {
          scopeViolations.add(subtask.id);
          logToOutput(pipeline.specPath,
            '\n[VERIFY] Subtask ' + subtask.id + ' ended without touching any of its assigned files — no edit was made:\n' +
            '[VERIFY] Assigned files: ' + ((subtask.files || []).join(', ') || '(none)') + '\n'
          );
        }
      }
    } catch (scopeErr) {
      const scopeMsg = scopeErr instanceof Error ? scopeErr.message : String(scopeErr);
      logToOutput(pipeline.specPath, '\n[SCOPE] Could not verify file scope (git diff failed: ' + scopeMsg + ')\n');
    }
  }

  // ADR 002: Check for wakeup file (engineer scheduled background work).
  // NOT gated on hasQaFeedback — a QA-rework/cleanup coder session can
  // legitimately need to start a long verification job (e.g. re-running a
  // benchmark after a fix) just like a first-pass session. Gating this on
  // hasQaFeedback silently dropped wakeup files written during rework: the
  // coder would correctly schedule a wait, but the orchestrator would never
  // look for the file, advance straight to QA before the job finished, and
  // QA would then fail the subtask against incomplete/stale evidence —
  // burning a QA attempt on a false negative unrelated to code or spec quality.
  let wakeupDetected = false;
  {
    // Scan for ANY subtask_wakeup-st<N>.json, not just this subtask's own
    // id — a session can legitimately determine that a DIFFERENT subtask
    // (one it depends on, or one whose still-running background job it
    // discovered) is what's actually blocking progress, and schedule that
    // subtask's wakeup instead of its own. Restricting discovery to only
    // this subtask's own filename made such a file invisible to every
    // future check: it just sat on disk, unconsumed, while the CURRENT
    // subtask — having found none of ITS OWN structural completion
    // blockers (no files_to_create, no wakeup file matching its own id) —
    // got silently marked complete despite explicitly reporting it wasn't.
    // Found on task 585a32e0: Subtask 8 wrote subtask_wakeup-st7.json for
    // its still-running dependency and was marked completed:true anyway.
    //
    // Retry before concluding none exists: in container mode a coder
    // session's writes only reach the host once the bind mount syncs, and
    // that sync is not instantaneous — particularly on Windows/Docker
    // Desktop, where it can lag several seconds behind the container's own
    // (already-flushed) view of the file, worse under I/O contention.
    // killSession() above only waits for the CLI process itself to exit,
    // not for the mount to catch up, so a scan taken immediately after can
    // race a wakeup file the coder definitely wrote. Only worth the delay
    // when a missed wakeup would actually change the outcome — a re-entry
    // session (already mid-wakeup-cycle) or a subtask with a deliverable
    // check that's about to run; a subtask with neither skips verification
    // anyway, so a slow-to-sync (nonexistent) wakeup file costs it nothing.
    // Found on task add-per-constraint-soft-score-attributio: subtask 15
    // wrote subtask_wakeup-st15.json (confirmed via its own session log) and
    // ended its session, but the scan run right after found nothing — the
    // subtask was wrongly treated as having failed deliverable verification,
    // and the task failed outright minutes later, twice.
    const wakeupScanRetryDelayMs = deps.getPipelineConfig().wakeupScanRetryDelayMs ?? 0;
    const wakeupPaths = await scanWakeupFilesWithRetry(
      pipeline.specPath, /^subtask_wakeup-st\d+\.json$/, 'subtask_wakeup.json',
      wakeupScanRetryDelayMs, !!(wasWakeupReentry || subtask.files_to_create?.length),
    );

    for (const wakeupPath of wakeupPaths) {
      let rawWakeup = '';
      try { rawWakeup = readFileSync(wakeupPath, 'utf-8'); } catch { /* treated as malformed below */ }
      const wd = parseWakeupFile(rawWakeup);
      if (wd && wd.subtask_id != null) {
        // Snapshot the previous command for the same subtask BEFORE it's
        // overwritten below — used to detect a genuine relaunch (see the
        // counter reset below).
        const isSameSubtaskReentry = wd.subtask_id === pipeline.wakeupSubtaskId;
        const previousCommand = isSameSubtaskReentry ? pipeline.wakeupCommand : undefined;

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
          // Snapshot the artifact's current mtime so a FUTURE re-entry that
          // ends without writing another wakeup file can be verified — see
          // the freshness check below and the field's doc in types.ts.
          pipeline.wakeupArtifactMtimeAtSchedule = wd.expected_artifact
            ? snapshotMtime(path.join(cwd, wd.expected_artifact))
            : null;
          try {
            pipeline.wakeupHeadAtSchedule = deps.execGitCapture(['rev-parse', 'HEAD'], pipeline.worktreePath).trim() || undefined;
          } catch { pipeline.wakeupHeadAtSchedule = undefined; }
        }

        // Progress-aware circuit breaker: a wakeup re-entry that relaunches
        // the background job under a MATERIALLY DIFFERENT command (not just
        // a later wakeup_at for the same still-running process) means the
        // engineer diagnosed and fixed a real blocker before restarting —
        // that's forward progress, not a stalled retry, and should get a
        // fresh attempt budget rather than consume the old one. Without
        // this, a subtask that fixes a genuine bug on wakeups 1 and 2 and
        // correctly relaunches a multi-hour job on wakeup 3 can have the
        // task fail seconds after that final, now-correct relaunch — the
        // fix itself is indistinguishable from "made no progress" to a bare
        // attempt counter. Reset (not merely decrement) so the relaunched
        // job gets the FULL cap's worth of checks, matching the budget any
        // fresh background attempt is expected to need.
        // Guarded on previousCommand being defined (not the subtask's very
        // first wakeup, nor a different subtask's file) and both commands
        // being non-empty strings — a missing/identical command is treated
        // as "still waiting on the same job", which keeps incrementing.
        pipeline.wakeupAttemptCount = computeNextAttemptCount(previousCommand, wd, pipeline.wakeupAttemptCount || 0);
        if (isGenuineRelaunch(previousCommand, wd.background_command)) {
          logToOutput(pipeline.specPath, '[WAKEUP] Subtask ' + wd.subtask_id + ' background command changed since the last wakeup — treating as a fresh attempt (progress was made) and resetting the wakeup attempt budget to 1\n');
        }
        wakeupDetected = true;
        logToOutput(pipeline.specPath, '[WAKEUP] Subtask ' + wd.subtask_id + ' wakeup scheduled for ' + wd.wakeup_at + ' (attempt ' + pipeline.wakeupAttemptCount + ') — background process: ' + (wd.background_command || 'unknown') +
          (wd.progress_log_path ? ' — progress log: ' + wd.progress_log_path : '') + '\n');
      } else if (!wd) {
        logToOutput(pipeline.specPath, '[WAKEUP] Malformed ' + path.basename(wakeupPath) + ' — treating as missing\n');
      }
      try { unlinkSync(wakeupPath); } catch { /* best-effort */ }
    }
  }

  // A wakeup re-entry session that ends without writing a fresh wakeup file
  // is normally trusted as genuinely complete (see the `wasWakeupReentry &&
  // !wakeupDetected` block below). But a coder session monitoring a
  // long-running background job can run out of turns mid-check and simply
  // stop — without ever reaching its own "if still running, write an
  // updated wakeup file" instruction (see the WAKEUP RE-ENTRY prompt above)
  // — leaving the job still running, uncollected, while the orchestrator
  // silently moves on to the next subtask. Verify the declared artifact
  // actually advanced during this cycle before trusting that silence:
  // unchanged (or still missing) mtime means nothing new was produced, so
  // auto-reschedule a follow-up check instead — bounded by the same
  // maxImplementRetries cap used for explicit reschedules (the wakeup-timer
  // block later in this file), so a genuinely stuck job still eventually
  // fails the task rather than looping forever.
  //
  // Gated on !subtask.files_to_create?.length — a subtask that declares
  // files_to_create already has a more specific, purpose-built deliverable
  // check just below (with its own maxImplementRetries circuit breaker);
  // this mtime check exists for the case that check can't cover, an
  // existing file the subtask overwrites rather than creates.
  if (!subtask.files_to_create?.length) {
    const staleRescheduled = checkStaleWakeupReentry({
      pipeline, wasReentry: wasWakeupReentry, wakeupDetected, cwd, unitLabel: 'Subtask ' + subtask.id,
    });
    if (staleRescheduled) wakeupDetected = true;
  }

  // Last-resort safety net, mirroring resolvePhaseWakeup for the single-session
  // phases: the session wrote no wakeup file this cycle (or wrote it somewhere
  // the orchestrator doesn't scan), yet a process behind one of its own
  // recorded pid files is still alive. For a subtask with a deliverable check
  // that is hard evidence of an in-flight job, not a missing deliverable —
  // counting it as a failed pass burns the retry budget while hours of real
  // work are still running. Auto-schedule a re-entry instead.
  if (!wakeupDetected && subtask.files_to_create?.length) {
    const orphan = findLiveOrphanedJob(pipeline.specPath, sessionStartedAt);
    if (orphan) {
      wakeupDetected = true;
      pipeline.wakeupSubtaskId = subtask.id;
      pipeline.wakeupUntil = new Date(Date.now() + 15 * 60_000).toISOString();
      pipeline.wakeupCommand = 'auto-detected orphaned background job (PID ' + orphan.pid + ', ' + path.relative(pipeline.specPath, orphan.pidFile) + ')';
      pipeline.wakeupArtifact = undefined;
      pipeline.wakeupAttemptCount = (pipeline.wakeupAttemptCount || 0) + 1;
      logToOutput(pipeline.specPath,
        '[WAKEUP] Subtask ' + subtask.id + ' ended without a wakeup file, but PID ' + orphan.pid + ' (from ' +
        path.relative(pipeline.specPath, orphan.pidFile) + ') is still running — auto-scheduling a re-entry in 15 minutes ' +
        'instead of counting a failed deliverable check (attempt ' + pipeline.wakeupAttemptCount + ')\n');
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
    // `existsSync` alone only proves a path was created at SOME point in the
    // branch's history — not that THIS session (or this wakeup chain's final
    // session) actually produced it. A subtask re-dispatched for QA rework
    // (qa_flagged paired with completed: false — see writeQaFeedback) starts
    // in a worktree that already contains whatever its files_to_create held
    // from the PRIOR, QA-rejected attempt: those paths still exist on disk,
    // untouched, if this session's coder stalls out before redoing the work
    // (e.g. still waiting on a background job it kicked off, never reaching
    // the point of collecting results and committing). Require each
    // files_to_create path to also appear in this session's own commit diff
    // (sessionChangedFiles, preSessionHead..HEAD) whenever that diff could be
    // computed at all — matching the actual coder pattern for long jobs (the
    // wakeup-authoring session commits nothing; the session that eventually
    // collects results and commits does so for every deliverable at once).
    // Falls back to existence-only when preSessionHead couldn't be snapshotted
    // (git failure), the same best-effort fallback the scope check above uses.
    // Found on task a-later-demo-task: subtask 15's
    // five files_to_create had existed on disk since a stale commit three
    // rounds earlier; a session that only stood up background job servers
    // and ended before running them was marked completed anyway, because the
    // five paths — untouched this session, carrying three-day-old evidence —
    // still passed existsSync.
    const requireFreshness = preSessionHead !== '';
    // Only the deliverables this dispatch is about must be fresh (see
    // relevantDeliverables): on a rework, QA names the file(s) to fix and the
    // other declared deliverables stay as committed earlier — demanding they
    // change too is unsatisfiable and burns the retry cap on no-op re-dispatches.
    const mustBeFresh = new Set(relevantDeliverables(subtask.files_to_create, reworkFilesToFix(pipeline.specPath)));
    const isFreshFile = (f: string) => !requireFreshness || !mustBeFresh.has(f) || sessionChangedFiles.includes(f);
    for (const file of subtask.files_to_create) {
      const exists = existsSync(path.join(cwd, file));
      const isFresh = isFreshFile(file);
      if (!exists) {
        skipCompletion = true;
        logToOutput(pipeline.specPath, '\n[VERIFY] Subtask ' + subtask.id + ': expected file/directory missing — ' + file + '\n');
      } else if (!isFresh) {
        skipCompletion = true;
        logToOutput(pipeline.specPath, '\n[VERIFY] Subtask ' + subtask.id + ': ' + file + ' exists but was not created or modified this session (stale from an earlier attempt) — ' + file + '\n');
      }
    }
    if (skipCompletion) {
      if (!pipeline.deliverableFailCounts) pipeline.deliverableFailCounts = {};
      const maxFails = deps.getPipelineConfig().maxImplementRetries;
      const count = (pipeline.deliverableFailCounts[subtask.id] || 0) + 1;
      pipeline.deliverableFailCounts[subtask.id] = count;
      const missingFiles = subtask.files_to_create
        .filter(f => !existsSync(path.join(cwd, f)) || !isFreshFile(f))
        .join(', ');
      logToOutput(pipeline.specPath, '[VERIFY] Subtask ' + subtask.id + ' failed deliverable verification (attempt ' + count + '/' + maxFails + ') — missing or stale: ' + missingFiles + '\n');
      if (count >= maxFails) {
        const reportPath = path.join(pipeline.specPath, 'qa_report.json');
        writeFileSync(reportPath, JSON.stringify({
          overall: 'FAIL',
          criteria: [{
            criterion: 'Deliverable verification — missing files',
            name: 'Deliverable verification',
            status: 'FAIL',
            notes: 'Subtask ' + subtask.id + ' failed deliverable verification ' + maxFails + ' times. Missing or stale files: ' + missingFiles,
          }],
        }, null, 2));
        logToOutput(pipeline.specPath, '[VERIFY] Subtask ' + subtask.id + ' exceeded deliverable verification cap (' + maxFails + ') — advancing to failed\n');
        deps.writeCompletionSummary(pipeline, 'implement-failure');
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
      logToOutput(pipeline.specPath, '[SCOPE] Subtask ' + subtask.id + ' rejected — will re-run (see the specific reason logged above)\n');
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
    clearWakeupState(pipeline);
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
    // Repair a cherry-pick an earlier, interrupted session left in progress
    // on the main worktree before attempting a new one — see
    // repairStuckCherryPick's own doc comment for the full rationale. Runs
    // first so the dirty-worktree check right below it (which would
    // otherwise just auto-commit the stuck cherry-pick's pending edit under
    // a generic message without actually resolving CHERRY_PICK_HEAD) sees
    // an already-clean-or-freshly-aborted tree.
    await repairStuckCherryPick(pipeline, deps);

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
        logToOutput(pipeline.specPath, '\n[WORKTREE] Skipping cherry-pick for subtask ' + subtasks[i].id + ' (rejected — see the specific reason logged above)\n');
        continue;
      }

      // Pre-cherry-pick: auto-commit any uncommitted changes in THIS
      // subtask's isolated worktree — mirrors the main-worktree safety net
      // above, which this one lacked. Cherry-pick only ever moves what's
      // already COMMITTED on the subtask's branch; an edit the coder made
      // but never committed before its session ended was invisible to it,
      // and the worktree cleanup below (`git worktree remove --force`)
      // then destroyed it silently. Found on task 585a32e0 via QA's own
      // forensic trace: a verbatim Scaladoc edit subtask 2's session made
      // and reported as done was lost this way — the auto-save commit that
      // ran afterward only touched the MAIN worktree, never this one.
      const stWorktreePath = subtaskWorktrees.get(subtasks[i].id)!;
      try {
        const stStatusOut = deps.execGitCapture(['status', '--porcelain'], stWorktreePath).trim();
        if (stStatusOut) {
          logToOutput(pipeline.specPath, '\n[WORKTREE] Subtask ' + subtasks[i].id + ' worktree has uncommitted changes — auto-committing before cherry-pick:\n' + stStatusOut + '\n');
          deps.execGit(['add', '-A', '--', '.', ':!.teamai'], stWorktreePath);
          deps.execGit(['commit', '-m', 'chore: auto-save subtask ' + subtasks[i].id + ' state before cherry-pick'], stWorktreePath);
          logToOutput(pipeline.specPath, '[WORKTREE] Auto-committed uncommitted changes for subtask ' + subtasks[i].id + '\n');
        }
      } catch (stStatusErr) {
        const stErrMsg = stStatusErr instanceof Error ? stStatusErr.message : String(stStatusErr);
        logToOutput(pipeline.specPath, '\n[WORKTREE] Could not check/commit subtask ' + subtasks[i].id + ' worktree status (git failed: ' + stErrMsg + '), proceeding with cherry-pick\n');
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
      deps.writeCompletionSummary(pipeline, 'implement-failure');
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

export async function runImplement(
  pipeline: ImplementPipeline,
  deps: ImplementDeps,
): Promise<void> {
  // Persist phase on disk now that work is actually starting (#5)
  deps.persistAndEmitPhase(pipeline);

  // ── Phase 1: Ensure worktree is ready ──
  await ensureWorktree(pipeline, deps);

  // Snapshot the shared worktree's HEAD before any subtask in this pass
  // dispatches — used by reconcileSubtaskCompletionFromDeliverables below to
  // tell a deliverable this pass actually (re)produced from one merely left
  // over, untouched, from an earlier round. By the time that check runs,
  // every subtask this pass successfully integrated has been cherry-picked
  // back into pipeline.worktreePath, so a diff against this snapshot covers
  // the whole pass regardless of which subtask's session did the committing.
  let passStartHead = '';
  try {
    passStartHead = deps.execGitCapture(['rev-parse', 'HEAD'], pipeline.worktreePath).trim();
  } catch { /* best-effort — reconciliation falls back to existence-only if snapshot fails */ }

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

  // No force-reset needed here: every path that builds effectiveSubtasks
  // above (the qa_flagged && !completed filter, the human-rework filter, and
  // the synthetic 9999 fallback) already guarantees completed === false for
  // every member. Do not reintroduce an unconditional reset — see the
  // qa_flagged && !completed comment above for why that clobbers a subtask
  // that completes partway through a multi-pass bounce-back round.

  // ── Phase 3: Process groups of subtasks ──
  // Tracks every subtask id completed so far — both before this pass
  // started and by earlier groups within it — so a later group can verify
  // its subtasks' depends_on are actually satisfied before dispatching.
  // `parallel_group` alone doesn't guarantee this: it only reflects the
  // planner's INTENDED order, and a subtask can fail to complete (scope
  // violation, exhausted wakeup attempts) without anything stopping the
  // group loop from moving on to the next group regardless.
  const completedThisRun = new Set(plan.subtasks.filter(s => s.completed).map(s => s.id));

  for (const [, subtasks] of groups) {
    if (pipeline.phase === 'failed') break;

    // Depends_on gate: a subtask whose dependencies aren't all satisfied
    // yet (an earlier subtask was rejected for scope violation, never
    // finished a wakeup cycle, etc.) is deferred to a future pass instead
    // of running against a dependency that doesn't actually exist yet.
    // Found on task 585a32e0: Subtask 7 (depends_on a never-completed
    // Subtask 3) and Subtask 8 (depends_on a never-completed Subtask 7)
    // both ran anyway, producing a "final regression gate" that verified
    // nothing real about the fresh evidence it was supposed to gate.
    const readySubtasks = subtasks.filter(s =>
      (s.depends_on ?? []).every(depId => completedThisRun.has(depId)));
    const blockedSubtasks = subtasks.filter(s => !readySubtasks.includes(s));
    for (const b of blockedSubtasks) {
      const unmetDeps = (b.depends_on ?? []).filter(depId => !completedThisRun.has(depId));
      logToOutput(pipeline.specPath,
        '\n[DEPENDS-ON] Subtask ' + b.id + ' deferred to a future pass — depends_on [' +
        unmetDeps.join(', ') + '] not yet completed\n');
    }
    if (readySubtasks.length === 0) continue;

    // Shadow the outer `subtasks` (the full, unfiltered group) with the
    // ready-only subset for the rest of this iteration — every existing
    // reference below this point (worktree isolation, dispatch,
    // integrateGroup, the wakeup break check) should only ever see
    // subtasks that were actually dispatched this pass.
    {
    const subtasks = readySubtasks;
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

    for (const id of completedIds) completedThisRun.add(id);

    // Cross-group barrier: plan.md's own contract for `parallel_group` is
    // that "one full group's changes land on the feature branch before the
    // next group starts" — but until now that was only actually enforced
    // for the wakeup case above. A subtask that ran to completion and ended
    // its session WITHOUT scheduling a wakeup, but whose declared
    // files_to_create still don't exist (still under its own
    // maxImplementRetries cap — a hard cap instead sets pipeline.phase to
    // 'failed', already caught by this loop's own top-of-iteration guard)
    // is just as real a reason a later group's assumptions about this
    // group's output may not hold. Without this, a later group whose
    // depends_on happens not to name this group's subtasks (an
    // under-declared ordering requirement, or simply unrelated work) is
    // dispatched in the SAME pass regardless — wasting a session (or an
    // entire multi-hour background job) on work whose true prerequisites
    // were never satisfied. Found on task
    // add-per-constraint-soft-score-attributio: subtask 15 (group G) was
    // dispatched and burned its full wakeup budget while its real
    // prerequisites, subtasks 13/14 (group F), had silently failed
    // deliverable verification in the very same pass. The existing
    // "Structural completeness gate" below already catches this and
    // retries the incomplete subtask — but only after every later group
    // has already been attempted; breaking here gets there one group
    // sooner, before the wasted work happens.
    if (completedIds.length < subtasks.length) {
      const stillIncomplete = subtasks.filter(s => !completedIds.includes(s.id)).map(s => s.id);
      logToOutput(pipeline.specPath,
        '\n[GROUP-BARRIER] ' + stillIncomplete.length + ' subtask(s) in this group did not complete (id' +
        (stillIncomplete.length > 1 ? 's' : '') + ' ' + stillIncomplete.join(', ') + ') — deferring all ' +
        'later groups to a future pass instead of dispatching them alongside a still-incomplete group\n');
      break;
    }
    } // end of the `const subtasks = readySubtasks` shadow block
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
    if (wakeupAttemptsExceeded(pipeline, deps.getPipelineConfig().maxImplementRetries)) {
      logToOutput(pipeline.specPath, '[WAKEUP] Subtask ' + pipeline.wakeupSubtaskId + ' exceeded wakeup attempt cap (' + deps.getPipelineConfig().maxImplementRetries + ') — advancing to failed\n');
      const reportPath = path.join(pipeline.specPath, 'qa_report.json');
      writeFileSync(reportPath, JSON.stringify({
        overall: 'FAIL',
        criteria: [{
          criterion: 'Wakeup attempt limit exceeded',
          name: 'Wakeup attempt limit exceeded',
          status: 'FAIL',
          notes: 'Subtask ' + pipeline.wakeupSubtaskId + ' failed to produce artifact after ' + deps.getPipelineConfig().maxImplementRetries + ' wakeup attempts. Expected artifact: ' + (pipeline.wakeupArtifact || 'unknown'),
        }],
      }, null, 2));
      // Clear wakeup state before failing: a truthy wakeupUntil with no armed
      // timer would make the caller's cleanup guard skip releasing the
      // pipeline/active-task lock, blocking any later retry of this task.
      clearWakeupState(pipeline);
      deps.writeCompletionSummary(pipeline, 'implement-failure');
      deps.advancePhase(pipeline, 'failed');
      return;
    }
    deps.savePipelineState(pipeline);
    deps.scheduleWakeup(pipeline);
    return;
  }

  // Structural completeness gate: don't push to QA when plan.json already
  // shows subtasks left incomplete (an unmet dependency, a repeated scope
  // violation, an exhausted-but-under-cap deliverable check, etc.). QA is
  // an expensive full LLM review; burning one confirming what the
  // orchestrator can already see for free in plan.json wastes it — and
  // with a low maxQaAttempts, can fail the whole task on a review that was
  // doomed before it started. Re-read plan.json fresh (awaiting
  // planWriteLock so every prior group's persisted completion is visible)
  // rather than trusting the in-memory `plan` snapshot taken before this
  // pass ran. Checked against the FULL plan, not just this round's
  // effectiveSubtasks — a subtask QA never flagged (and so wasn't
  // targeted for rework) but that never completed either is just as real
  // a blocker for anything depending on it.
  await deps.planWriteLock.current;
  const finalPlanPath = path.join(pipeline.specPath, 'plan.json');
  const finalPlanResult = readJsonFile<{ subtasks: PlanSubtask[] }>(
    finalPlanPath, { required: true },
  );
  const finalSubtasks = finalPlanResult.data?.subtasks ?? [];
  // Reconcile before checking — see reconcileSubtaskCompletionFromDeliverables's
  // doc comment for why a real subtask's `completed` flag can go stale when a
  // QA-fallback synthetic subtask (id 9999) fixes its deliverables instead.
  if (reconcileSubtaskCompletionFromDeliverables(finalSubtasks, pipeline.worktreePath, pipeline.specPath, passStartHead, deps.execGitCapture)) {
    try {
      const tmpPath = finalPlanPath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(finalPlanResult.data, null, 2));
      renameSync(tmpPath, finalPlanPath);
    } catch (err) {
      warn('implement', `Failed to persist reconciled subtask completions to plan.json for ${pipeline.taskId}`, err);
    }
  }
  // QA-targeted rework completion: clean up qa_feedback.md / qa_flagged
  // markers as soon as the subtasks QA actually named (every real subtask
  // carrying qa_flagged, or the synthetic 9999 fallback — both are marked
  // qa_flagged the same way) are done, INDEPENDENT of whether other,
  // unrelated real subtasks in the plan are still incomplete for their own
  // separate reasons (never yet dispatched, an unmet depends_on, etc.).
  // Gating this cleanup on the ENTIRE plan being complete (the old
  // behavior, further down) creates a trap: while qa_feedback.md exists,
  // selectSubtasks only ever dispatches qa_flagged subtasks — once those
  // are all fixed, that set is permanently empty, so every subsequent pass
  // falls into the "criterion matching flagged no subtasks" branch and
  // re-synthesizes a FRESH 9999 from the same now-stale qa_feedback.md,
  // forever, with no path back to normal `!completed` dispatch for the
  // other subtasks — burning the whole incompleteImplementPassCount budget
  // on a QA rework that already succeeded while a real subtask that was
  // never QA's business never gets a normal session. Found on task
  // add-per-constraint-soft-score-attributio: three separate 9999 sessions
  // each confirmed the QA-flagged artifact was already committed and
  // correct, found nothing left in their own scope to fix, and ended
  // cleanly — while subtask 15 (never QA-flagged, just never finished on
  // its own) sat untouched until the pass cap failed the whole task.
  if (hasQaFeedback) {
    const qaTargetedIds = finalSubtasks.filter(s => s.qa_flagged).map(s => s.id);
    const qaTargetedDone = qaTargetedIds.length > 0
      && qaTargetedIds.every(id => finalSubtasks.find(s => s.id === id)?.completed === true);
    if (qaTargetedDone) {
      logToOutput(pipeline.specPath,
        '\n[QA-REWORK] Targeted subtask(s) ' + qaTargetedIds.join(', ') + ' complete — clearing QA feedback ' +
        'now so any other still-incomplete subtasks fall through to normal dispatch on the next pass instead ' +
        'of re-synthesizing rework from stale feedback\n');
      if (existsSync(qaFeedbackPath)) unlinkSync(qaFeedbackPath);
      cleanQaFlaggedMarkers(pipeline);
    }
  }

  const incompleteSubtasks = finalSubtasks.filter(s => !s.completed);
  if (incompleteSubtasks.length > 0) {
    const attemptCount = (pipeline.incompleteImplementPassCount || 0) + 1;
    pipeline.incompleteImplementPassCount = attemptCount;
    const maxPasses = deps.getPipelineConfig().maxImplementRetries;
    const ids = incompleteSubtasks.map(s => s.id).join(', ');
    logToOutput(pipeline.specPath,
      '\n[IMPLEMENT-GATE] ' + incompleteSubtasks.length + ' subtask(s) still incomplete after this pass (id' +
      (incompleteSubtasks.length > 1 ? 's' : '') + ' ' + ids + ') — skipping QA (attempt ' + attemptCount + '/' + maxPasses + ')\n');
    if (attemptCount >= maxPasses) {
      const reportPath = path.join(pipeline.specPath, 'qa_report.json');
      writeFileSync(reportPath, JSON.stringify({
        overall: 'FAIL',
        criteria: [{
          criterion: 'Implement completeness gate',
          name: 'Implement completeness gate',
          status: 'FAIL',
          notes: 'Subtask(s) ' + ids + ' remained incomplete after ' + maxPasses + ' implement passes. See output.log for the specific reason on each (scope violation, unmet dependency, deliverable verification failure, etc.).',
        }],
      }, null, 2));
      logToOutput(pipeline.specPath, '[IMPLEMENT-GATE] Exceeded incomplete-pass cap (' + maxPasses + ') — advancing to failed\n');
      deps.writeCompletionSummary(pipeline, 'implement-failure');
      deps.advancePhase(pipeline, 'failed');
      return;
    }
    deps.savePipelineState(pipeline);
    deps.advancePhase(pipeline, 'implement');
    await deps.executePhase(pipeline);
    return;
  }
  pipeline.incompleteImplementPassCount = 0;

  // Clean up feedback files
  if (hasQaFeedback && existsSync(qaFeedbackPath)) unlinkSync(qaFeedbackPath);
  // Targeted human feedback is consumed later by consumeFeedbackIfDue at its
  // consuming phase (so QA can see a coder-directed request); only legacy
  // untargeted feedback keeps the old end-of-implement cleanup.
  const pendingFeedback = hasHumanFeedback ? readHumanFeedback(pipeline.specPath) : null;
  if (hasHumanFeedback && !pendingFeedback?.target && existsSync(humanFeedbackPath)) {
    unlinkSync(humanFeedbackPath);
  }

  // Clean up qa_flagged markers
  if (hasQaFeedback) {
    cleanQaFlaggedMarkers(pipeline);
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
    // Require non-empty output, not just "didn't throw": a real `git
    // rev-parse --verify` either throws (ref doesn't exist) or prints the
    // resolved SHA — it never succeeds with empty stdout — so this is no
    // less correct against real git, and it stops a test's catch-all
    // `execGitCapture: vi.fn(() => '')` default (used throughout this
    // suite for calls a given test doesn't care about) from being misread
    // as "a cherry-pick is in progress" for every other execGitCapture
    // call the test makes too.
    return execGitCapture(['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], worktreePath).trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Repair a cherry-pick left in progress on the MAIN worktree by a previous
 * session that was interrupted before it could finish or abort — called
 * from integrateGroup right before it attempts a new one. The main
 * worktree has no writer but this pipeline's own sessions (integrateGroup's
 * cherry-picks, this repair), so leftover cherry-pick state here is never
 * an ambiguous external actor, always the leftover of a session that died
 * mid-flight (crashed, killed by the stall sweep, etc.) with nothing to
 * clean it up. Mirrors rebaseOntoLatestDefault's unconditional rebase/merge
 * reset guard (phase-runners.ts) for the same class of race, one layer in:
 * implement never calls that guard (it rebases per-subtask branches via
 * cherry-pick, not the base branch), so a stuck cherry-pick here had
 * nothing resetting it before a fresh cherry-pick was attempted.
 *
 * Runs unconditionally rather than gating on a CHERRY_PICK_HEAD check:
 * a multi-commit `git cherry-pick <range>` killed in the narrow window
 * between finishing one commit and starting the next leaves
 * `.git/sequencer/todo` with pending entries but *no* live
 * CHERRY_PICK_HEAD — real git still refuses a fresh cherry-pick with
 * "cherry-pick is already in progress" in that state, but a
 * CHERRY_PICK_HEAD-only existence check reports "nothing to repair" and
 * this function would silently no-op right past it (confirmed live: this
 * exact gap let a first version of this fix still fail on the task that
 * motivated it). `git cherry-pick --quit` forgets sequencer bookkeeping
 * unconditionally, regardless of which of those shapes it's in, and is a
 * documented no-op when nothing is in progress at all — so it's always
 * safe to call first. It never touches the working tree or index, so the
 * content-preservation decision below is independent of it.
 *
 * A clean pending change (no unmerged paths) is committed, preserving
 * whatever work it contains, since that content may be a real, otherwise-
 * unrecoverable fix (found via QA: an interrupted session had left a
 * correct test fix sitting uncommitted this way for three review rounds).
 * Unmerged paths (conflict markers left mid resolution) are discarded
 * instead — a resolution abandoned mid-session can't be trusted — and left
 * to integrateGroup's own cherry-pick retry/merger-recovery path to re-run
 * cleanly from the subtask's own branch.
 */
export async function repairStuckCherryPick(
  pipeline: ImplementPipeline,
  deps: ImplementDeps,
): Promise<void> {
  try { deps.execGit(['cherry-pick', '--quit'], pipeline.worktreePath); } catch { /* best-effort */ }

  let unmergedFiles = '';
  try {
    unmergedFiles = deps.execGitCapture(['diff', '--name-only', '--diff-filter=U'], pipeline.worktreePath).trim();
  } catch { /* best-effort — treat as no conflicts, fall through to the clean-pending path */ }

  if (unmergedFiles) {
    logToOutput(pipeline.specPath,
      '\n[WORKTREE] Main worktree has conflict markers left by an interrupted ' +
      'cherry-pick in ' + unmergedFiles.split('\n').length +
      ' file(s) — discarding so a fresh cherry-pick can run cleanly\n');
    try { deps.execGit(['reset', '--hard', 'HEAD'], pipeline.worktreePath); } catch { /* best-effort */ }
    return;
  }

  try {
    const statusOut = deps.execGitCapture(['status', '--porcelain'], pipeline.worktreePath).trim();
    if (statusOut) {
      logToOutput(pipeline.specPath,
        '\n[WORKTREE] Main worktree has pending changes left by an interrupted ' +
        'cherry-pick with no conflicts — committing them to finish it instead of ' +
        'discarding them:\n' + statusOut + '\n');
      deps.execGit(['add', '-A', '--', '.', ':!.teamai'], pipeline.worktreePath);
      deps.execGit(['commit', '-m', 'chore: finish cherry-pick left in progress by an interrupted session'], pipeline.worktreePath);
      logToOutput(pipeline.specPath, '[WORKTREE] Finished the stuck cherry-pick\n');
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    logToOutput(pipeline.specPath, '\n[WARN] Could not repair stuck cherry-pick: ' + errMsg + '\n');
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
    // The command has the merger run the tests BEFORE `--continue`, so it
    // fixes its resolution while it still has the conflict context, and
    // report (never hide) failures it couldn't fix — QA stays the backstop
    // for those. Only an unresolvable conflict is left in progress, which the
    // check below turns into an abort + preserved branches, as before.
    const mergeMessage = renderCommand('resolve-cherry-pick',
      'Subtask ' + subtaskId + ': a `git cherry-pick` of branch `' + stBranch + '` onto `' + pipeline.branch + '`\n' +
      'stopped on merge conflicts. Resolve them, run the tests, and complete the ' +
      'cherry-pick (`git cherry-pick --continue`) as the instructions below describe.');
    const mergeSessionId = await processManager.createSession(
      deps.sessionOpts('merger', pipeline.worktreePath, pipeline.taskId, mergeLogFile),
    );
    updateSessionMap(pipeline.specPath, 'merge', mergeSessionId);
    processManager.sendMessage(mergeSessionId, mergeMessage);
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
