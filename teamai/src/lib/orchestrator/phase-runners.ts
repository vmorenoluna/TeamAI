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
import { squashWithMessage, hasCommitsBeyondBase, readImplementationSummary, readSpecSummary } from './artifact-commit';
import { restoreWorktreeGitFileToHostPaths, worktreeGitEnv } from './worktree-utils';
import { runSensors, sensorRunSummary, type SensorsConfig } from '../sensors';
import { resolveBaseBranch } from '../git-platform';
import { updateSessionMap, logToOutput } from './helpers';
import { humanDirectiveFor, consumeFeedbackIfDue, readHumanFeedback } from './human-feedback';
import { removeStaleWorktreeRegistration } from './worktree-utils';
import { applyPlanFileSerialization, logUndeclaredSubtaskReferences, snapshotPreservedPlanSubtasks, restorePreservedPlanSubtasks, loadPreservedPlanSubtasks, clearPreservedPlanSubtasks, planDeclaresRealFileChanges } from './plan-validation';
import { warn } from '../logger';
import { WorktreeError, PipelineConfigError } from './errors';
import { prepareBacklogCheck, runBacklogCheck, backlogCheckEnabled } from './backlog-check';
import { log as logInfo } from '../logger';
import { resolvePhaseWakeup, buildWakeupReentryHeader, PHASE_WAKEUP_FILENAME } from './wakeup';
import { renderCommand } from '../command-templates';
import type { PipelinePhase } from '@/constants/phases';
import type { AgentSession } from '../process-manager';
import type { TaskPipeline, SessionOptsResult } from './types';
import type { FailureReason } from './qa-feedback';

// ── Shared rebase helper ──────────────────────────────────────────────────

export interface RebaseDeps {
  projectRoot: string;
  execGit: (args: string[], hostCwd: string) => void;
  execGitCapture: (args: string[], hostCwd: string) => string;
  sessionOpts: SessionOptsFn;
  waitForCompletion: (sessionId: string) => Promise<void>;
  gitPush: (pushArgs: string[], logFile: string) => void;
}

/**
 * Rebase the feature branch onto the latest origin/master before merge/PR,
 * then push the result ourselves.
 *
 * Skips the rebase entirely when origin/<baseBranch> has not advanced
 * past the worktree's HEAD — saves a redundant merger spawn and test
 * suite run for a no-op (#3).
 *
 * If the rebase has conflicts, spawns a merger agent to resolve them —
 * that agent's job is only to resolve the conflict and commit locally; it
 * does not push. Agent sessions run their own git INSIDE the container
 * (container mode auto-enables whenever Docker is available), and have no
 * GitHub credentials to push with — devcontainer.json mounts the host's
 * `.gitconfig`/`.ssh`, but a Windows host's `.gitconfig` names a credential
 * helper binary that doesn't exist in a Linux container, and `.ssh` only
 * helps an SSH remote when this codebase authenticates over HTTPS via `gh`.
 * `fetch`/`pull` from a public repo need no auth at all, which is why only
 * a push ever surfaced this. The commit the merger produces (or the plain
 * rebase produces) lands in the same shared object store and branch ref
 * this checkout also sees — worktrees share `.git/objects` and
 * `refs/heads/*` with the repo they're linked from — so pushing it from
 * here, host-side, via the same gh-authenticated `gitPush` every other push
 * in this codebase uses, needs no container involvement at all.
 *
 * Returns true on success (rebased/merged AND pushed). On failure, the
 * caller decides whether to throw (merge path, where unresolved conflicts
 * or an unpushed rebase would corrupt the repo) or warn (create-pr path,
 * where the PR can still be reviewed and resolved manually).
 */
export async function rebaseOntoLatestDefault(
  worktreePath: string,
  taskId: string,
  branch: string,
  logFile: string,
  deps: RebaseDeps & { baseBranch: string },
): Promise<boolean> {
  // Reset any git operation left in progress on this worktree. TeamAI is the
  // sole writer to a task's worktree (no external actor touches it), so a
  // stuck rebase/merge here is never ambiguous — it's the leftover of one of
  // our own sessions (most concretely: a merger killed mid-`git merge` by
  // recovery.ts's stall sweep, which has no cleanup of its own) getting
  // interrupted before it could finish or abort cleanly. Both are safe
  // unconditional no-ops when nothing is actually in progress.
  try { deps.execGit(['rebase', '--abort'], worktreePath); } catch { /* nothing to abort */ }
  try { deps.execGit(['merge', '--abort'], worktreePath); } catch { /* nothing to abort */ }

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

  // Push whatever the rebase (clean or merger-resolved) produced. Both
  // paths rewrite/advance the branch's history, so this always needs
  // --force-with-lease; refreshing the remote-tracking ref immediately
  // before the push keeps the lease check honest instead of comparing
  // against a possibly-stale cached ref.
  const pushRebased = (): boolean => {
    try {
      deps.gitPush(['fetch', 'origin', branch], logFile);
    } catch { /* best-effort — the lease check below still runs */ }
    try {
      deps.gitPush(['push', '--force-with-lease', 'origin', branch], logFile);
      logToOutput(path.dirname(logFile), `\n[INFO] Pushed ${branch} after rebasing onto ${deps.baseBranch}\n`);
      return true;
    } catch (pushErr) {
      const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
      logToOutput(path.dirname(logFile), `\n[WARN] Rebase succeeded locally but push failed: ${pushMsg}\n`);
      return false;
    }
  };

  // `git rebase` refuses to even start against a dirty worktree — not a
  // content conflict, just an uncommitted leftover (most commonly a coder
  // session that ended without committing). This is deterministically
  // fixable without an agent: auto-commit it first, matching the same
  // WIP-commit safety net used elsewhere (implement.ts's COMMIT-GUARD,
  // artifact-commit.ts's pre-squash commit) — a session's real work should
  // never be lost to a failed rebase precheck. `.teamai` is excluded since
  // pipeline artifacts are the orchestrator's responsibility, not a coder
  // commit's, mirroring COMMIT-GUARD's own exclusion.
  try {
    const status = deps.execGitCapture(['status', '--porcelain'], worktreePath).trim();
    if (status) {
      deps.execGit(['add', '-A', '--', '.', ':!.teamai'], worktreePath);
      deps.execGit(['commit', '-m', 'WIP: auto-commit uncommitted changes before rebase'], worktreePath);
      logToOutput(path.dirname(logFile), `\n[INFO] Worktree had uncommitted changes — auto-committed before rebasing onto ${deps.baseBranch}\n`);
    }
  } catch (guardErr) {
    const guardMsg = guardErr instanceof Error ? guardErr.message : String(guardErr);
    logToOutput(path.dirname(logFile), `\n[WARN] Could not auto-commit dirty worktree before rebase: ${guardMsg}\n`);
  }

  try {
    deps.execGit(['rebase', `origin/${deps.baseBranch}`], worktreePath);
    logToOutput(path.dirname(logFile), `\n[INFO] Feature branch rebased onto latest ${deps.baseBranch}\n`);
    return pushRebased();
  } catch (rebaseErr) {
    // A failed `git rebase` is NOT necessarily a real conflict — the dirty-
    // worktree case is handled deterministically above, but a stale git
    // lock, a permission error, or any other git failure raises the exact
    // same way and has no mechanical fix the orchestrator can apply. Check
    // for actual unmerged paths (mid-rebase, before aborting — the abort
    // below clears this state) before deciding a merger session is
    // warranted. Spawning one for a non-conflict failure wastes a session
    // on an agent that finds nothing to resolve and reports "nothing to
    // do" — which reads as if the orchestrator lied about there being a
    // conflict in the first place; the merger is for resolving conflicting
    // content, not for causes it has no more ability to fix than we do.
    let unmergedFiles = '';
    try {
      unmergedFiles = deps.execGitCapture(['diff', '--name-only', '--diff-filter=U'], worktreePath).trim();
    } catch { /* best-effort — treat as unknown, fall through to the conflict path below */ }
    try { deps.execGit(['rebase', '--abort'], worktreePath); } catch { /* ignore */ }

    if (!unmergedFiles) {
      const rebaseMsg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr);
      logToOutput(path.dirname(logFile),
        `\n[WARN] Rebase onto ${deps.baseBranch} failed for a non-conflict reason (no unmerged files found) — ` +
        `not spawning a merger: ${rebaseMsg}\n`);
      return false;
    }

    logToOutput(path.dirname(logFile),
      `\n[INFO] Rebase had conflicts in ${unmergedFiles.split('\n').length} file(s) — spawning merger to resolve via git merge\n`);
    try {
      const mergeLogFile = path.join(path.dirname(logFile), 'output-merge.log');
      const mergeMessage = renderCommand('merge', `origin/${deps.baseBranch}`);
      const mergeSessionId = await processManager.createSession(
        deps.sessionOpts('merger', worktreePath, taskId, mergeLogFile),
      );
      updateSessionMap(path.dirname(logFile), 'merge', mergeSessionId);
      processManager.sendMessage(mergeSessionId, mergeMessage);
      await deps.waitForCompletion(mergeSessionId);
      processManager.killSession(mergeSessionId);
      logToOutput(path.dirname(logFile), '\n[INFO] Merger resolved rebase conflicts — pushing its result\n');
      return pushRebased();
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
  /** Remove the task's worktree (spec phase: a rejected ticket is deleted). */
  removeWorktree?: (taskId: string) => void;
  rotateOutputLog: (logFile: string) => void;
  phaseHeader: (logFile: string, phase: string) => void;
  savePipelineState: (pipeline: TaskPipeline) => void;
  toAgentPath: (hostPath: string) => string;
  executePhase: (pipeline: TaskPipeline) => Promise<void>;
  gitPush: (pushArgs: string[], logFile: string) => void;
  execGit: (args: string[], hostCwd: string) => void;
  execGitCapture: (args: string[], hostCwd: string) => string;
  // ── Wakeup (ADR 002, generalized beyond implement — see wakeup.ts) ──
  getPipelineConfig: () => { wakeupScanRetryDelayMs?: number; maxImplementRetries: number; backlogCheck?: boolean };
  scheduleWakeup: (pipeline: TaskPipeline) => void;
  writeCompletionSummary: (pipeline: TaskPipeline, reason: FailureReason, detail?: string) => void;
  /** Board access for the backlog check (backlog-check.ts). */
  taskStore?: TaskStore;
}

// ── Shared pre-phase freshness sync ─────────────────────────────────────────

/**
 * Freshen the code an about-to-run phase's agent will look at, regardless of
 * which phase this is or how we got here — a brand-new task's very first
 * spec run, a retry, a QA bounce-back, a spec revision loop. Two independent
 * staleness gaps this closes:
 *
 *  1. spec/plan sessions run in `projectRoot`, not the worktree — nothing
 *     else kept that checkout's base branch current, so an analyst
 *     re-examining a previously-failed task could reason from pre-fix
 *     source, and a brand-new task's worktree (branched from projectRoot's
 *     HEAD in runPlan) could be cut from a stale base.
 *  2. an existing feature-branch worktree previously only got rebased onto
 *     the latest base branch when a run happened to pass through
 *     `implement` (ensureWorktree). A retry landing straight on
 *     `qa-review` — the default resume phase for most failed tasks per
 *     getResumePhaseForFailedTask — skipped that rebase entirely, letting
 *     QA judge code that could be missing an upstream fix its own failure
 *     depended on.
 *
 * Call this AFTER persistAndEmitPhase, not before — moveTaskToPhase's
 * synchronous-persist invariant (see its doc comment) means the UI is
 * expected to see a phase's status update promptly; putting a network fetch
 * or a merger-agent conflict-resolution session ahead of that persist would
 * silently reintroduce the I/O-bound delay that invariant exists to avoid.
 *
 * Both steps are best-effort and non-fatal: a fast-forward pull can't
 * conflict, and an unresolvable worktree rebase just proceeds with a
 * warning — merge/create-pr still run their own authoritative rebase
 * (rebaseOntoLatestDefault again — a no-op if this already did the work)
 * and fail loudly there if a real conflict is still unresolved by the time
 * it actually matters.
 */
export async function syncPhaseBaseline(
  pipeline: Pick<TaskPipeline, 'taskId' | 'specPath' | 'worktreePath' | 'phase' | 'branch'>,
  deps: RebaseDeps,
): Promise<void> {
  const baseBranch = resolveBaseBranch(deps.projectRoot);
  const logFile = path.join(pipeline.specPath, 'output.log');

  try {
    deps.gitPush(['pull', '--ff-only', 'origin', baseBranch], logFile);
  } catch { /* non-fast-forward or offline — best-effort */ }

  if (!existsSync(pipeline.worktreePath)) return;

  const ok = await rebaseOntoLatestDefault(
    pipeline.worktreePath, pipeline.taskId, pipeline.branch, logFile, { ...deps, baseBranch },
  );
  if (!ok) {
    logToOutput(pipeline.specPath,
      `\n[WARN] Could not rebase worktree onto latest ${baseBranch} before '${pipeline.phase}' — proceeding with the worktree's current state.\n`);
  }
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
  await syncPhaseBaseline(pipeline, deps);
  const agentSpecPath = deps.toAgentPath(pipeline.specPath);

  const revisionFeedbackPath = path.join(pipeline.specPath, 'spec_revision_feedback.md');
  const isRevision = existsSync(revisionFeedbackPath);
  const humanDirective = humanDirectiveFor(pipeline.specPath, 'analyst');
  // Every ticket-capable session judges the whole open board (backlog-check.ts);
  // the spec phase also judges its own ticket.
  const specStore = deps.taskStore ?? new TaskStore(deps.projectRoot);
  const backlogOn = backlogCheckEnabled(deps.getPipelineConfig);
  const backlogHeader = backlogOn ? prepareBacklogCheck({
    specPath: pipeline.specPath, unit: 'spec', store: specStore, ownTaskId: pipeline.taskId, requireSelf: true,
  }) : '';

  // ADR 002 (generalized — see wakeup.ts): a wakeup cycle is in flight for
  // this phase iff wakeupCommand already carried over from a previous cycle
  // when this session started — spec/plan/qa-review run exactly one session
  // at a time, so unlike implement's per-subtask wakeupSubtaskId, there's no
  // multiplicity to disambiguate.
  const isWakeupReentry = !!pipeline.wakeupCommand;
  const wakeupHeader = isWakeupReentry
    ? buildWakeupReentryHeader({
        unitLabel: 'the spec phase',
        wakeupFilename: PHASE_WAKEUP_FILENAME,
        command: pipeline.wakeupCommand,
        artifact: pipeline.wakeupArtifact,
      })
    : '';

  // Rendered before the session exists, so a template problem can never leave
  // a spawned session waiting on a message that never comes.
  let message: string;
  if (isRevision) {
    // beginSpecRevision renamed the pre-revision spec to spec_v{R-1}.md — the
    // analyst reads THAT baseline (spec.md no longer holds the original), and
    // writes the revised spec to spec.md.
    const baselineFile = `spec_v${pipeline.specRevision - 1}.md`;
    message = renderCommand('spec-revise',
      wakeupHeader + humanDirective + backlogHeader +
      `Feature request: ${pipeline.description}\n\n` +
      `Read the existing spec at: \`${agentSpecPath}/${baselineFile}\`\n` +
      `Read the spec revision feedback at: \`${agentSpecPath}/spec_revision_feedback.md\`\n` +
      `Revise the spec to address ALL concerns in the feedback.\n` +
      `Preserve parts of the spec that are still valid — only change what the feedback asks for.\n` +
      `IMPORTANT: Write the revised spec to \`${agentSpecPath}/spec.md\` (overwrite the existing file).\n` +
      `IMPORTANT: Also update \`${agentSpecPath}/spec_summary.md\` to reflect the revised spec — this is a required step, not optional. Do not end the session without it.`);
  } else {
    message = renderCommand('spec',
      wakeupHeader + humanDirective + backlogHeader +
      `${pipeline.description}\n\nIMPORTANT: Write the spec file to \`${agentSpecPath}/spec.md\` (use this exact path, not a new subdirectory).\n` +
      `IMPORTANT: Also write \`${agentSpecPath}/spec_summary.md\` next to it — this is a required step, not optional. Do not end the session without it.`);
  }

  // Floor for findLiveOrphanedJob's pid-file scan in resolvePhaseWakeup below
  // — captured just before dispatch so a leftover pid file from an earlier,
  // unrelated run of this task can't false-match.
  const sessionStartedAt = Date.now();
  const sessionId = await processManager.createSession(
    deps.sessionOpts('analyst', deps.projectRoot, pipeline.taskId, specLogFile),
  );
  pipeline.sessionId = sessionId;
  deps.savePipelineState(pipeline);
  updateSessionMap(pipeline.specPath, 'spec', sessionId);
  processManager.sendMessage(sessionId, message);
  await deps.waitForCompletion(sessionId);
  processManager.killSession(sessionId);

  // ADR 002 (generalized): a pending background job must pause the phase
  // before any of the "session ended without producing X" checks below run —
  // otherwise a legitimate multi-hour job in progress gets treated as a
  // failed/missing spec. See wakeup.ts's module doc for the incident this
  // closes (an analyst's long-running verification job outlived its session
  // with no way to signal "still running").
  if (await resolvePhaseWakeup({
    pipeline, specDir: pipeline.specPath, cwd: deps.projectRoot, wasReentry: isWakeupReentry,
    sessionStartedAt, unitLabel: 'The spec phase', deps,
    deliverables: [path.join(pipeline.specPath, 'spec.md'), path.join(pipeline.specPath, 'spec_summary.md')],
  }) === 'pending') return;

  if (isRevision && existsSync(revisionFeedbackPath)) {
    unlinkSync(revisionFeedbackPath);
  }
  consumeFeedbackIfDue(pipeline.specPath, 'spec');

  // No-op revision guard: beginSpecRevision (review-actions.ts) renamed the
  // pre-revision spec to spec_v{R-1}.md before this session ran. If spec.md
  // comes back byte-identical to that baseline, the analyst session completed
  // without actually addressing spec_revision_feedback.md — advancing to
  // `plan` would silently replay the same QA failure through a full plan →
  // implement → qa-review cycle. Park for human review instead of trusting
  // the agent's self-reported summary.
  if (isRevision) {
    const baselinePath = path.join(pipeline.specPath, `spec_v${pipeline.specRevision - 1}.md`);
    const specMdPath = path.join(pipeline.specPath, 'spec.md');
    let after: string | null = null;
    try {
      after = existsSync(specMdPath) ? readFileSync(specMdPath, 'utf-8') : null;
    } catch (err) {
      warn('spec', `Failed to read revised spec for ${pipeline.taskId}`, err);
    }
    if (after === null) {
      // A missing post-session spec.md (crash, or the analyst deleted it)
      // would break every downstream phase — park for human review rather
      // than advancing to plan without a spec.
      logToOutput(pipeline.specPath,
        `\n[SPEC] Revision produced no spec.md — parking in awaiting-review for human review.\n`);
      warn('spec', `Spec revision produced no spec.md for ${pipeline.taskId} — parking for human review`);
      deps.savePipelineState(pipeline);
      deps.advancePhase(pipeline, 'awaiting-review', {
        awaitingReviewReason: 'Spec revision produced no spec.md — the analyst session ended without writing a revised spec. This is not a QA pass; reject back to the analyst to retry.',
      });
      return;
    }
    try {
      const before = existsSync(baselinePath) ? readFileSync(baselinePath, 'utf-8') : null;
      if (before !== null && before === after) {
        logToOutput(pipeline.specPath,
          `\n[SPEC] No-op revision detected — spec.md is byte-identical to the pre-revision baseline ` +
          `(${path.basename(baselinePath)}). The analyst session completed without addressing ` +
          `spec_concerns from this round. Pausing in awaiting-review instead of advancing to plan.\n`);
        warn('spec', `No-op spec revision detected for ${pipeline.taskId} — spec.md unchanged from the pre-revision baseline`);
        deps.savePipelineState(pipeline);
        deps.advancePhase(pipeline, 'awaiting-review', {
          awaitingReviewReason: `No-op spec revision — the analyst session completed without changing spec.md (still identical to ${path.basename(baselinePath)}). This round's feedback was not addressed. This is not a QA pass; reject back to the analyst to retry.`,
        });
        // Leave spec.md in place even though it duplicates the baseline: the
        // versions UI already dedupes a live spec that's byte-identical to
        // its highest snapshot (getTaskFull in tasks.ts), and spec.md must
        // keep existing so a follow-up "Request Changes → Analyst" can find
        // it — routeHumanFeedback's analyst target only enters revision mode
        // when spec.md exists, so deleting it here would silently downgrade
        // the next revision attempt into a from-scratch spec run that
        // discards the human's feedback and orphans this baseline.
        return;
      }
    } catch (err) {
      // A failed comparison must not silently mask a real no-op — surface it,
      // but don't block the pipeline on a diagnostic-only check.
      warn('spec', `Failed to compare revised spec against pre-revision baseline for ${pipeline.taskId}`, err);
    }
    // No archive copy here: the baseline rename in beginSpecRevision IS the
    // version history (v{R-1}), and the revised spec lives on as spec.md —
    // which the versions UI surfaces live as v{R}. Copying again would
    // double-count the revision in the spec versions UI.
  } else {
    // First (non-revision) run: no snapshot copy — the live spec.md IS v1
    // under the rename-at-revision scheme. It only becomes a numbered file
    // when beginSpecRevision renames it at the task's first revision, so a
    // task with no revisions has exactly one spec file on disk.
    if (!existsSync(path.join(pipeline.specPath, 'spec.md'))) {
      // The analyst produced no spec — advancing to plan without one would
      // break every downstream phase. Park for human review.
      logToOutput(pipeline.specPath,
        `\n[SPEC] Spec phase produced no spec.md — parking in awaiting-review for human review.\n`);
      warn('spec', `Spec phase produced no spec.md for ${pipeline.taskId} — parking for human review`);
      deps.savePipelineState(pipeline);
      deps.advancePhase(pipeline, 'awaiting-review', {
        awaitingReviewReason: 'Spec phase produced no spec.md — the analyst session ended without writing a spec. This is not a QA pass; retry the task to run the analyst again.',
      });
      return;
    }
  }

  // spec_summary.md is required exactly like spec.md, not best-effort: it's
  // the only durable record of the spec's reasoning once spec.md is deleted
  // at task completion (spec.md is never committed to git), and buildPRBody
  // has nowhere else to source it from. Enforced here — the single point
  // where the analyst is expected to have just written it — rather than
  // re-checked at create-PR time, mirroring exactly how spec.md itself is
  // validated once at the end of the spec phase and trusted downstream.
  //
  // In practice this step gets skipped by an analyst session that stops
  // right after verifying its own spec.md diff (revision Step 9) without
  // reaching the summary step after it — an agent-compliance gap the prompt
  // reminders above narrow but can't close entirely. Rather than park
  // immediately (stalling a correct spec on a human for one missed file),
  // give one focused follow-up session a chance to self-heal it: it only has
  // to read the now-final spec.md and write the summary, so it's cheap
  // relative to a full human round-trip.
  if (!existsSync(path.join(pipeline.specPath, 'spec_summary.md'))) {
    logToOutput(pipeline.specPath,
      `\n[SPEC] Spec phase produced no spec_summary.md — retrying with a focused follow-up session.\n`);
    warn('spec', `Spec phase produced no spec_summary.md for ${pipeline.taskId} — retrying once before parking`);

    // Same guidelines as the spec command's own summary step — both include
    // _shared/spec-summary-guidelines.md, so the two can't drift apart.
    const retryMessage = renderCommand('spec-summary',
      `Spec: \`${agentSpecPath}/spec.md\`\n` +
      `Write: \`${agentSpecPath}/spec_summary.md\`\n` +
      `Do not modify spec.md.`);
    const retrySessionId = await processManager.createSession(
      deps.sessionOpts('analyst', deps.projectRoot, pipeline.taskId, specLogFile),
    );
    pipeline.sessionId = retrySessionId;
    deps.savePipelineState(pipeline);
    updateSessionMap(pipeline.specPath, 'spec', retrySessionId);
    processManager.sendMessage(retrySessionId, retryMessage);
    await deps.waitForCompletion(retrySessionId);
    processManager.killSession(retrySessionId);

    if (!existsSync(path.join(pipeline.specPath, 'spec_summary.md'))) {
      logToOutput(pipeline.specPath,
        `\n[SPEC] Retry also produced no spec_summary.md — parking in awaiting-review for human review.\n`);
      warn('spec', `Spec phase produced no spec_summary.md for ${pipeline.taskId} even after a retry — parking for human review`);
      deps.savePipelineState(pipeline);
      deps.advancePhase(pipeline, 'awaiting-review', {
        awaitingReviewReason: 'Spec phase produced no spec_summary.md — spec.md was written but the summary needed to build the PR body is missing, even after an automatic retry. This is not a QA pass; reject back to the analyst to regenerate it.',
      });
      return;
    }
    logToOutput(pipeline.specPath, `\n[SPEC] Retry produced spec_summary.md — continuing to plan.\n`);
  }

  // Backlog check (backlog-check.ts): verified and applied only once the
  // spec itself is complete, so a parked spec never touches other tickets.
  const specBacklog = backlogOn ? await runBacklogCheck({
    specPath: pipeline.specPath, unit: 'spec', unitLabel: 'The spec phase', taskId: pipeline.taskId,
    role: 'analyst', cwd: deps.projectRoot, requireSelf: true, projectRoot: deps.projectRoot,
    store: specStore, sessionOpts: deps.sessionOpts, waitForCompletion: deps.waitForCompletion,
  }) : { ok: true as const };
  if (!specBacklog.ok) {
    deps.writeCompletionSummary(pipeline, 'backlog-check-incomplete', specBacklog.problems.join('; '));
    deps.advancePhase(pipeline, 'failed');
    return;
  }
  // The analyst verified the ticket's premise and found it does not hold
  // (already fixed, obsolete, or a misreading by the agent that filed it).
  // Its verdict is final: the ticket is removed without planning anything.
  const selfVerdict = 'self' in specBacklog ? specBacklog.self : undefined;
  if (selfVerdict?.verdict === 'reject') {
    const reason = selfVerdict.reason;
    logInfo('spec', `Ticket "${pipeline.title}" (${pipeline.taskId}) deleted — the analyst rejected its premise: ${reason}`);
    try { deps.removeWorktree?.(pipeline.taskId); } catch { /* no worktree yet */ }
    specStore.delete(pipeline.taskId);
    return;
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
  await syncPhaseBaseline(pipeline, deps);

  // Re-plan mode: when plan.json already exists (preserved by a spec revision),
  // the planner must re-work it in place, keeping completed subtasks that are
  // still valid — not regenerate from scratch and discard the prior work.
  const agentSpecPath = deps.toAgentPath(pipeline.specPath);
  const isReplan = existsSync(path.join(pipeline.specPath, 'plan.json'));
  const planInstruction = isReplan
    ? `Read the existing plan at \`${agentSpecPath}/plan.json\` and the spec at \`${agentSpecPath}/spec.md\`.\n` +
      `Re-plan to match the spec while PRESERVING work that is still valid:\n` +
      `- Keep completed subtasks whose files and acceptance criteria are still covered by the spec, and leave their \`completed: true\` flag set so they are NOT re-implemented.\n` +
      `- Mark only affected/invalidated subtasks \`completed: false\` (and drop any stale \`qa_flagged\`) so they re-run.\n` +
      `- Rewrite plan.json in place — do NOT delete it.\n` +
      `IMPORTANT: Write the updated plan to \`${agentSpecPath}/plan.json\` (overwrite the existing file).`
    : `${agentSpecPath}/spec.md`;

  // Scoped re-plan preserve-list guardrail: when the pending human feedback
  // targets the planner and carries a subtask selection, snapshot the subtasks
  // NOT in the selection before the session runs. The directive (humanDirectiveFor
  // emits a replan scope note) asks the planner to leave them byte-for-byte
  // unchanged, but the restore below is the guarantee — an LLM re-planning will
  // naturally rewrite descriptions it shouldn't.
  const plannerFeedback = readHumanFeedback(pipeline.specPath);
  const preservedPlanSubtasks =
    plannerFeedback?.target === 'planner' && plannerFeedback.subtaskIds?.length
      // Crash recovery: a persisted snapshot from an interrupted replan is the
      // authoritative baseline — the current plan.json may already have been
      // rewritten by that interrupted session, so re-snapshotting it would
      // bake the clobbered subtasks in as the "original".
      ? (loadPreservedPlanSubtasks(pipeline.specPath)
        ?? snapshotPreservedPlanSubtasks(pipeline.specPath, plannerFeedback.subtaskIds))
      : null;

  // ADR 002 (generalized — see wakeup.ts): see runSpecPhase's identical
  // reasoning for why wakeupCommand alone identifies a re-entry here.
  const isWakeupReentry = !!pipeline.wakeupCommand;
  const wakeupHeader = isWakeupReentry
    ? buildWakeupReentryHeader({
        unitLabel: 'the plan phase',
        wakeupFilename: PHASE_WAKEUP_FILENAME,
        command: pipeline.wakeupCommand,
        artifact: pipeline.wakeupArtifact,
      })
    : '';

  const planStore = deps.taskStore ?? new TaskStore(deps.projectRoot);
  const backlogOn = backlogCheckEnabled(deps.getPipelineConfig);
  const backlogHeader = backlogOn ? prepareBacklogCheck({
    specPath: pipeline.specPath, unit: 'plan', store: planStore, ownTaskId: pipeline.taskId, requireSelf: false,
  }) : '';
  // Rendered before the session exists — see runSpecPhase.
  const message = renderCommand(isReplan ? 'plan-revise' : 'plan',
    wakeupHeader + humanDirectiveFor(pipeline.specPath, 'planner') + backlogHeader + planInstruction);

  // Floor for findLiveOrphanedJob's pid-file scan in resolvePhaseWakeup below
  // — see runSpecPhase's identical capture for why.
  const sessionStartedAt = Date.now();
  const sessionId = await processManager.createSession(
    deps.sessionOpts('planner', deps.projectRoot, pipeline.taskId, planLogFile),
  );
  pipeline.sessionId = sessionId;
  deps.savePipelineState(pipeline);
  updateSessionMap(pipeline.specPath, 'plan', sessionId);
  processManager.sendMessage(sessionId, message);
  await deps.waitForCompletion(sessionId);
  processManager.killSession(sessionId);

  // ADR 002 (generalized): see runSpecPhase's identical wakeup pause — a
  // planner can just as legitimately kick off a long-running feasibility
  // check or dry run before committing to a plan built on its results.
  if (await resolvePhaseWakeup({
    pipeline, specDir: pipeline.specPath, cwd: deps.projectRoot, wasReentry: isWakeupReentry,
    sessionStartedAt, unitLabel: 'The plan phase', deps,
    deliverables: [path.join(pipeline.specPath, 'plan.json')],
  }) === 'pending') return;


  // Enforce the preserve-list unconditionally: whatever the planner wrote for
  // the unselected subtasks is overwritten with the pre-session snapshot.
  if (preservedPlanSubtasks && preservedPlanSubtasks.size > 0) {
    restorePreservedPlanSubtasks(pipeline.specPath, preservedPlanSubtasks);
  }
  // The snapshot exists only to survive a crash mid-replan. Once the plan
  // phase has completed, clear it BEFORE the feedback is consumed — a crash
  // after this point re-derives a fresh baseline from the restored, pristine
  // plan.json instead of trusting a stale file.
  clearPreservedPlanSubtasks(pipeline.specPath);
  consumeFeedbackIfDue(pipeline.specPath, 'plan');

  // Evidence producibility gate (#4): if the planner rejected the spec's
  // acceptance criteria as unverifiable (no producing artifact possible),
  // route to human review instead of silently proceeding to implement.
  // Write a minimal qa_report.json with spec_concerns so the review panel
  // can render the spec concerns banner.
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

  // Plan-time validation: deterministically serialize subtasks that share a
  // file within the same parallel_group (plan rule #13). The planner is
  // instructed to avoid this, but a stray overlap would otherwise guarantee a
  // cherry-pick conflict at implement time — fixing it here is cheap and
  // deterministic, and cheaper than burning a merger-agent session later.
  applyPlanFileSerialization(pipeline.specPath);

  const planBacklog = backlogOn ? await runBacklogCheck({
    specPath: pipeline.specPath, unit: 'plan', unitLabel: 'The plan phase', taskId: pipeline.taskId,
    role: 'planner', cwd: deps.projectRoot, requireSelf: false, projectRoot: deps.projectRoot,
    store: planStore, sessionOpts: deps.sessionOpts, waitForCompletion: deps.waitForCompletion,
  }) : { ok: true as const };
  if (!planBacklog.ok) {
    deps.writeCompletionSummary(pipeline, 'backlog-check-incomplete', planBacklog.problems.join('; '));
    deps.advancePhase(pipeline, 'failed');
    return;
  }

  // Plan-time validation: warn when a subtask's own prose says it must wait
  // on another subtask (a "confirm N has finished before starting this one"
  // style sentence) but that subtask's `depends_on` doesn't actually name it.
  // depends_on is the only field the implement-phase group scheduler reads
  // for cross-group ordering — see plan-validation.ts's
  // detectUndeclaredSubtaskReferences for the incident this catches.
  logUndeclaredSubtaskReferences(pipeline.specPath);

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
      }
      // Unconditional — a container-patched worktree's registration is
      // invisible to existsSync on the host but still blocks the -b
      // creation above (and would block it again on the no-`-b` retry
      // below too, since the branch would still read as checked out).
      removeStaleWorktreeRegistration(deps.projectRoot, pipeline.worktreePath);
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
  execGitCapture: (args: string[], hostCwd: string) => string;
  gitPush: (pushArgs: string[], logFile: string) => void;
  phaseHeader: (logFile: string, phase: string) => void;
  getPipelineConfig: () => { maxQaAttempts: number; parallelSubtasks: boolean; sensors?: SensorsConfig };
  removeWorktree: (taskId: string) => void;
  /** Build the trailer-bearing commit message for this task (null when recordHistoryInGit is off). */
  buildTicketMessage: (pipeline: TaskPipeline) => import('./artifact-commit').TicketMessageResult | null;
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
    pipeline.worktreePath, pipeline.taskId, pipeline.branch, logFile,
    { projectRoot: deps.projectRoot, execGit: deps.execGit, execGitCapture: deps.execGitCapture, gitPush: deps.gitPush, sessionOpts: deps.sessionOpts, waitForCompletion: deps.waitForCompletion, baseBranch },
  );
  if (!rebaseOk) {
    throw new PipelineConfigError(
      `Rebase onto latest ${baseBranch} failed with conflicts that could not be resolved. ` +
      `The target branch has likely diverged too far from ${baseBranch}. ` +
      `Consider stopping and restarting the task to recreate the worktree from the latest ${baseBranch}.`,
      'REBASE_CONFLICT_UNRESOLVABLE',
    );
  }

  // Nothing to merge: a task whose plan never expected code changes
  // (empty/absent `files` everywhere, per implement.md's guidance) should
  // still leave a real — if empty — commit on the branch (squashWithMessage
  // preserves those now), so this only fires for a branch with truly no
  // commit at all beyond the base. `git merge` of such a branch would just
  // no-op ("Already up to date"), but that's easy to misread as "the merge
  // silently did nothing" — detect it explicitly instead.
  if (!hasCommitsBeyondBase(pipeline.worktreePath, baseBranch, {
    restoreWorktreeGitFileToHostPaths: (h) => restoreWorktreeGitFileToHostPaths(h, deps.projectRoot),
    worktreeGitEnv: (h, c) => worktreeGitEnv(h, deps.projectRoot, c),
  })) {
    // A branch with no commit at all is only unsuspicious if the plan never
    // expected one — otherwise this is the signature of an implementation
    // that was lost, skipped, or never finished, and marking it `done`
    // would silently ship nothing for a task that was supposed to change
    // something. Fail loudly instead so it's investigated, not missed.
    if (planDeclaresRealFileChanges(pipeline.specPath)) {
      throw new PipelineConfigError(
        `Plan declared file changes for this task, but its branch has no commits beyond ${baseBranch} ` +
        `after rebasing — the implementation may have been lost, skipped, or never committed. ` +
        `Investigate the worktree at ${pipeline.worktreePath} before retrying.`,
        'NO_CHANGES_BUT_PLAN_EXPECTED_THEM',
      );
    }
    logToOutput(pipeline.specPath,
      `[MERGE] No commits between ${baseBranch} and ${pipeline.branch} — this task's implementation required ` +
      `no changes beyond what's already on ${baseBranch}. Nothing to merge; marking done directly.\n`);
    deps.removeWorktree(pipeline.taskId);
    deps.advancePhase(pipeline, 'done');
    return;
  }

  // Pre-merge squash: collapse the feature branch to a single trailer-bearing
  // commit so the trailers survive the merge (merge/rebase keep messages
  // verbatim; squash pre-fills from the sole commit). No-op when
  // recordHistoryInGit is off or the worktree has nothing to commit.
  const ticketMessage = deps.buildTicketMessage(pipeline);
  if (ticketMessage) {
    const squashed = squashWithMessage(pipeline.worktreePath, ticketMessage.message, baseBranch, pipeline.specPath, {
      restoreWorktreeGitFileToHostPaths: (h) => restoreWorktreeGitFileToHostPaths(h, deps.projectRoot),
      worktreeGitEnv: (h, c) => worktreeGitEnv(h, deps.projectRoot, c),
    });
    logToOutput(pipeline.specPath, squashed
      ? '[MERGE] Feature branch squashed to a single trailer-bearing commit\n'
      : '[MERGE] Squash skipped (nothing to collapse or a git error) — proceeding with the branch as-is\n');
  }

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
    const mergeMessage = renderCommand('merge', pipeline.branch);
    const sessionId = await processManager.createSession(
      deps.sessionOpts('merger', deps.projectRoot, pipeline.taskId, mergeLogFile),
    );
    pipeline.sessionId = sessionId;
    updateSessionMap(pipeline.specPath, 'merge', sessionId);
    processManager.sendMessage(sessionId, mergeMessage);
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
  execGitCapture: (args: string[], hostCwd: string) => string;
  gitPush: (pushArgs: string[], logFile: string) => void;
  extractPrUrl: (logFile: string) => string | null;
  /** Build the trailer-bearing commit message for this task (null when recordHistoryInGit is off). */
  buildTicketMessage: (pipeline: TaskPipeline) => import('./artifact-commit').TicketMessageResult | null;
  removeWorktree: (taskId: string) => void;
}

export async function runCreatePRPhase(
  pipeline: TaskPipeline,
  deps: CreatePRDeps,
): Promise<void> {
  deps.persistAndEmitPhase(pipeline);
  const logFile = path.join(pipeline.specPath, 'output.log');

  // spec_summary.md is required, not best-effort — runSpecPhase already
  // guarantees it exists for every task going forward (parks in
  // awaiting-review otherwise), so this should never fire for a task that
  // went through the spec phase under current code. It exists only to catch
  // a legacy task whose spec phase ran before that gate did: fail loudly
  // here rather than silently shipping a PR body with no Specification
  // Summary section.
  const specSummary = readSpecSummary(pipeline.specPath);
  if (!specSummary) {
    const msg = `Missing spec_summary.md for task ${pipeline.taskId} — cannot build the PR body without it.`;
    warn('create-pr', msg);
    throw new Error(msg);
  }

  // Rebase onto latest default branch so the PR diff only contains the ticket's actual changes.
  const baseBranch = resolveBaseBranch(deps.projectRoot);
  const rebaseOk = await rebaseOntoLatestDefault(
    pipeline.worktreePath, pipeline.taskId, pipeline.branch, logFile,
    { projectRoot: deps.projectRoot, execGit: deps.execGit, execGitCapture: deps.execGitCapture, gitPush: deps.gitPush, sessionOpts: deps.sessionOpts, waitForCompletion: deps.waitForCompletion, baseBranch },
  );
  if (rebaseOk) {
    logToOutput(pipeline.specPath, '\n[INFO] PR will be conflict-free\n');
  } else {
    logToOutput(pipeline.specPath, '\n[WARN] PR may require manual conflict resolution\n');
  }

  // Nothing to PR: a task whose plan never expected code changes (empty/
  // absent `files` everywhere, per implement.md's guidance) should still
  // leave a real — if empty — commit on the branch (squashWithMessage
  // preserves those now), so this only fires for a branch with truly no
  // commit at all beyond the base. Pushing and calling `gh pr create` on
  // such a branch fails with a confusing raw GraphQL error ("No commits
  // between <base> and <branch>") — detect it up front instead.
  if (!hasCommitsBeyondBase(pipeline.worktreePath, baseBranch, {
    restoreWorktreeGitFileToHostPaths: (h) => restoreWorktreeGitFileToHostPaths(h, deps.projectRoot),
    worktreeGitEnv: (h, c) => worktreeGitEnv(h, deps.projectRoot, c),
  })) {
    // A branch with no commit at all is only unsuspicious if the plan never
    // expected one — otherwise this is the signature of an implementation
    // that was lost, skipped, or never finished, and marking it `done`
    // would silently ship nothing for a task that was supposed to change
    // something. Fail loudly instead so it's investigated, not missed.
    if (planDeclaresRealFileChanges(pipeline.specPath)) {
      throw new PipelineConfigError(
        `Plan declared file changes for this task, but its branch has no commits beyond ${baseBranch} ` +
        `after rebasing — the implementation may have been lost, skipped, or never committed. ` +
        `Investigate the worktree at ${pipeline.worktreePath} before retrying.`,
        'NO_CHANGES_BUT_PLAN_EXPECTED_THEM',
      );
    }
    logToOutput(pipeline.specPath,
      `[PR] No commits between ${baseBranch} and ${pipeline.branch} — this task's implementation required ` +
      `no changes beyond what's already on ${baseBranch}. Nothing to open a PR for; marking done directly.\n`);
    deps.removeWorktree(pipeline.taskId);
    deps.advancePhase(pipeline, 'done');
    return;
  }

  // Pre-push squash: collapse the feature branch to a single trailer-bearing
  // commit so the trailers survive any GitHub merge method (merge/rebase keep
  // messages verbatim; squash pre-fills from the sole commit). No-op when
  // recordHistoryInGit is off or the worktree has nothing to commit.
  const ticketMessage = deps.buildTicketMessage(pipeline);
  if (ticketMessage) {
    const squashed = squashWithMessage(pipeline.worktreePath, ticketMessage.message, baseBranch, pipeline.specPath, {
      restoreWorktreeGitFileToHostPaths: (h) => restoreWorktreeGitFileToHostPaths(h, deps.projectRoot),
      worktreeGitEnv: (h, c) => worktreeGitEnv(h, deps.projectRoot, c),
    });
    logToOutput(pipeline.specPath, squashed
      ? '[PR] Feature branch squashed to a single trailer-bearing commit\n'
      : '[PR] Squash skipped (nothing to collapse or a git error) — proceeding with the branch as-is\n');
  }
  deps.gitPush(['push', '-u', '--force', 'origin', pipeline.branch], logFile);

  const platform = detectGitPlatform(deps.projectRoot);

  // Check for existing open PR first — avoid creating duplicates
  let prUrl: string | null = checkExistingPRViaCLI(platform, pipeline.branch, deps.projectRoot);
  if (prUrl) {
    logToOutput(pipeline.specPath, `[PR] Open PR already exists for branch ${pipeline.branch}: ${prUrl}\n`);
  } else {
    // Create PR directly via CLI (gh) instead of spawning a merger agent.
    // implementation_summary.md is independent of recordHistoryInGit (it's
    // prose, not a trailer) — read it directly rather than through
    // ticketMessage, which is null when that toggle is off. specSummary was
    // already read (and required-checked) above.
    const body = buildPRBody(
      pipeline.description,
      specSummary,
      ticketMessage?.trailerLines ?? [],
      readImplementationSummary(pipeline.specPath),
    );
    prUrl = createPRViaCLI(platform, pipeline.branch, pipeline.title, body, deps.projectRoot, logFile);
    // Fallback: scan log for PR URL (handles unknown platforms where CLI returns null)
    if (!prUrl) {
      prUrl = deps.extractPrUrl(logFile);
    }
  }

  deps.taskStore.update(pipeline.taskId, {
    platform: platform !== 'unknown' ? platform : undefined,
    ...(prUrl ? { prUrl } : {}),
  });

  // The old second commit+push pass (backfilling prUrl into a committed
  // artifact snapshot) is gone — there is no committed snapshot anymore.

  deps.advancePhase(pipeline, 'pr-open', {
    ...(prUrl ? { prUrl } : {}),
    ...(platform !== 'unknown' ? { platform } : {}),
  });
}
