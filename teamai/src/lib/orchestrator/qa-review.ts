/**
 * runQaReview phase runner — extracted from Orchestrator class.
 *
 * Handles the QA review phase: locked-report detection, unpushed-commit
 * check, session timeout, spec-concern routing, FAIL-type routing,
 * and bounce-back to implement.
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, renameSync } from 'fs';
import { updateSessionMap, logToOutput } from './helpers';
import { humanDirectiveFor, consumeFeedbackIfDue } from './human-feedback';
import path from 'path';
import { processManager, type AgentSession } from '../process-manager';
import { resolveBaseBranch } from '../git-platform';
import { readJsonFile } from '../json-io';
import { RateLimitError } from './rate-limit';
import { warn } from '../logger';
import type { PipelinePhase } from '@/constants/phases';
import type { TaskPipeline, QaReport, SessionOptsResult, PlanSubtask } from './types';

// ── Dependencies ──────────────────────────────────────────────────────────

export interface QaReviewDeps {
  projectRoot: string;
  persistAndEmitPhase: (pipeline: TaskPipeline) => void;
  advancePhase: (pipeline: TaskPipeline, phase: PipelinePhase, eventExtra?: Record<string, unknown>) => void;
  savePipelineState: (pipeline: TaskPipeline) => void;
  executePhase: (pipeline: TaskPipeline) => Promise<void>;
  sessionOpts: (role: AgentSession['role'], cwd: string, taskId: string, logFile?: string) => SessionOptsResult;
  waitForCompletion: (sessionId: string) => Promise<void>;
  gitPush: (pushArgs: string[], logFile: string) => void;
  writeQaFeedback: (pipeline: TaskPipeline, report: QaReport) => void;
  writeCompletionSummary: (pipeline: TaskPipeline) => void;
  phaseHeader: (logFile: string, phase: string) => void;
  toAgentPath: (hostPath: string) => string;
  autoReviseSpec: (pipeline: TaskPipeline) => Promise<void>;
  /** Mutable reference to the plan-write serialization lock. */
  planWriteLock: { current: Promise<void> };
}

// ── Diverged-branch reconciliation ──────────────────────────────────────

type ReconcileOutcome = 'rebased' | 'merged' | 'failed';

/**
 * Reconcile a feature branch that has diverged from its own remote
 * counterpart — origin/<branch> holds commits (or different commit hashes
 * for the same logical changes) that this worktree's local branch doesn't
 * have — as opposed to a rebase onto the upstream base branch. Attempts a
 * rebase onto origin/<branch> first; on conflict, aborts the rebase and
 * spawns a merger agent to resolve via `git merge` instead. Same recovery
 * pattern already proven for base-branch rebases (phase-runners.ts,
 * rebaseOntoLatestDefault), just targeting the branch's own origin ref.
 *
 * Returns which path succeeded, since the caller needs to push itself only
 * for 'rebased' — a merger session pushes the resolved branch as its own
 * final step (see .claude/commands/merge.md step 6), so 'merged' means the
 * push has already been attempted and the caller should just verify the
 * result rather than push again.
 */
async function reconcileDivergedBranch(
  pipeline: TaskPipeline,
  deps: QaReviewDeps,
): Promise<ReconcileOutcome> {
  const targetRef = `origin/${pipeline.branch}`;
  try {
    execFileSync('git', ['rebase', targetRef], { cwd: pipeline.worktreePath, stdio: 'pipe' });
    logToOutput(pipeline.specPath, `[QA-PRECHECK] Rebased onto ${targetRef}\n`);
    return 'rebased';
  } catch {
    try { execFileSync('git', ['rebase', '--abort'], { cwd: pipeline.worktreePath, stdio: 'pipe' }); } catch { /* ignore */ }
    logToOutput(pipeline.specPath, `[QA-PRECHECK] Rebase onto ${targetRef} had conflicts — spawning merger to resolve via git merge\n`);
    try {
      const mergeLogFile = path.join(pipeline.specPath, 'output-merge.log');
      const mergeSessionId = await processManager.createSession(
        deps.sessionOpts('merger', pipeline.worktreePath, pipeline.taskId, mergeLogFile),
      );
      updateSessionMap(pipeline.specPath, 'merge', mergeSessionId);
      processManager.sendMessage(mergeSessionId, `/merge ${targetRef}`);
      await deps.waitForCompletion(mergeSessionId);
      processManager.killSession(mergeSessionId);
      logToOutput(pipeline.specPath, `[QA-PRECHECK] Merger resolved divergence from ${targetRef}\n`);
      return 'merged';
    } catch (mergeErr) {
      const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
      logToOutput(pipeline.specPath, `[QA-PRECHECK] Merger could not resolve divergence: ${mergeMsg}\n`);
      return 'failed';
    }
  }
}

/**
 * Re-check whether the branch still has commits its remote counterpart
 * doesn't have — the same relationship the top-level precheck computes,
 * exposed as a helper so it can be re-run after a reconciliation attempt
 * to see the actual resulting state instead of assuming one.
 */
function hasUnpushedCommits(pipeline: TaskPipeline, deps: QaReviewDeps): boolean {
  try {
    execFileSync('git', ['fetch', 'origin', pipeline.branch], { cwd: deps.projectRoot, stdio: 'pipe' });
  } catch { /* offline — proceed with cached refs */ }
  try {
    const unpushed = execFileSync('git', ['log', `origin/${pipeline.branch}..${pipeline.branch}`, '--oneline'], {
      cwd: deps.projectRoot, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
    return unpushed.length > 0;
  } catch {
    return false; // branch doesn't exist on remote — nothing to compare
  }
}

const MERGED_RECHECK_POLL_MS = 500;
const MERGED_RECHECK_MAX_ATTEMPTS = 2;

/**
 * Small safety net for the 'merged' path only: the merger's own push
 * (.claude/commands/merge.md step 6) should mean the branch is already up
 * to date by the time its session reports completion, but
 * waitForCompletion resolving is a session/turn-ended signal, not a
 * git-durability guarantee — retry the cheap read-only check a couple of
 * times before concluding the push didn't happen. This is deliberately
 * much smaller than the old blind pre-push poll: it's verifying an action
 * that (per the skill) already happened, not guessing when to attempt one.
 */
async function waitForMergerPushToSettle(pipeline: TaskPipeline, deps: QaReviewDeps): Promise<boolean> {
  for (let attempt = 0; attempt < MERGED_RECHECK_MAX_ATTEMPTS; attempt++) {
    if (!hasUnpushedCommits(pipeline, deps)) return true;
    if (attempt < MERGED_RECHECK_MAX_ATTEMPTS - 1) {
      await new Promise(resolve => setTimeout(resolve, MERGED_RECHECK_POLL_MS));
    }
  }
  return false;
}

// ── Main function ─────────────────────────────────────────────────────────

/**
 * Write a structured FAIL report to qa_report.json, guarding the write so a
 * disk failure can't abort the bounce/failed flow — the in-memory report
 * still reaches writeQaFeedback/writeCompletionSummary.
 *
 * @internal — exported for unit tests only. Not part of the public API.
 */
export function writeFailReport(pipeline: TaskPipeline, failReport: QaReport, label: string): void {
  const reportPath = path.join(pipeline.specPath, 'qa_report.json');
  try {
    writeFileSync(reportPath, JSON.stringify(failReport, null, 2));
  } catch (err) {
    warn('qa-review', `Failed to write ${label} FAIL report for ${pipeline.taskId}`, err);
  }
}

/**
 * Snapshot qa_report.json to qa_report_before_bounce.json so the next QA
 * cycle can compare FAIL criteria against the previous cycle.
 *
 * @internal — exported for unit tests only. Not part of the public API.
 */
export function snapshotQaReportBeforeBounce(pipeline: TaskPipeline): void {
  const reportPath = path.join(pipeline.specPath, 'qa_report.json');
  const bounceSnapshot = path.join(pipeline.specPath, 'qa_report_before_bounce.json');
  try {
    writeFileSync(bounceSnapshot, readFileSync(reportPath, 'utf-8'));
  } catch (err) {
    warn('qa-review', `Failed to snapshot QA report before bounce for ${pipeline.taskId}`, err);
  }
}

/**
 * Snapshot qa_report.json to qa_report_v{N}.json (N = pipeline.qaRevision)
 * for historical comparison, like spec_v{N}.md for specs.
 *
 * @internal — exported for unit tests only. Not part of the public API.
 */
export function snapshotQaReportVersioned(pipeline: TaskPipeline): void {
  const reportPath = path.join(pipeline.specPath, 'qa_report.json');
  const versionedPath = path.join(pipeline.specPath, `qa_report_v${pipeline.qaRevision}.json`);
  try {
    writeFileSync(versionedPath, readFileSync(reportPath, 'utf-8'));
  } catch (err) {
    warn('qa-review', `Failed to snapshot qa_report_v${pipeline.qaRevision} for ${pipeline.taskId}`, err);
  }
}

/**
 * Reconcile plan.json's per-subtask `completed` flags with the QA PASS
 * verdict before advancing to awaiting-review.
 *
 * A PASS overall QA verdict is ground truth that every subtask's work is
 * complete and verified. But `completed` is only ever set to `true` inside
 * runSubtaskSession() when a subtask is actually selected and re-run, so
 * subtasks that finished in an earlier cycle (e.g. via a wakeup re-entry and
 * never touched again) or the synthetic QA-rework subtask (id 9999) can stay
 * `false`/missing forever. The kanban "N/M subtasks completed" counter is
 * derived from these flags, so it undercounts even after everything has
 * passed. Stamp `completed: true` on every subtask — including the synthetic
 * 9999 entry, which is deliberately kept (not filtered) so getTaskFull() can
 * still surface output-st9999.log to the terminal tab — and emit a fresh
 * `subtask-progress` event, reusing the same write-lock / tmp-rename /
 * event-shape pattern as persistCompletedSubtasks() in implement.ts.
 *
 * Unlike persistCompletedSubtasks(), this is NOT best-effort: the write is
 * awaited by the caller and any failure propagates (throws), so the task can
 * never advance to awaiting-review with a stale counter.
 *
 * @internal — exported for unit tests only. Not part of the public API.
 */
export async function reconcileCompletedSubtasksOnQaPass(
  pipeline: TaskPipeline,
  deps: QaReviewDeps,
): Promise<void> {
  const attempt = deps.planWriteLock.current.then(() => {
    const planPath = path.join(pipeline.specPath, 'plan.json');
    if (!existsSync(planPath)) return;

    const plan = JSON.parse(readFileSync(planPath, 'utf-8'));
    if (plan.subtasks) {
      for (const s of plan.subtasks) {
        s.completed = true;
      }
    }
    const tmpPath = planPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(plan, null, 2));
    renameSync(tmpPath, planPath);

    // Emit subtask progress so the kanban counter updates immediately on
    // QA PASS rather than waiting for a stale read. Same event shape as
    // persistCompletedSubtasks().
    const subtasks = (plan as { subtasks?: PlanSubtask[] }).subtasks ?? [];
    const completed = subtasks.filter((s: PlanSubtask) => s.completed).length;
    processManager.emit('subtask-progress', {
      taskId: pipeline.taskId,
      completed,
      total: subtasks.length,
      projectRoot: deps.projectRoot,
    });
  });

  // Keep the shared lock chain resolvable even if this write fails, so a
  // failed reconcile can't silently suppress other tasks' checkpoint writes.
  deps.planWriteLock.current = attempt.catch(() => undefined);

  // Propagate any failure to the caller — the QA-PASS transition must not
  // proceed while the kanban counter would still be stale.
  await attempt;
}

export async function runQaReview(
  pipeline: TaskPipeline,
  deps: QaReviewDeps,
): Promise<void> {
  deps.persistAndEmitPhase(pipeline);
  pipeline.qaAttempt++;
  deps.savePipelineState(pipeline);
  const logFile = path.join(pipeline.specPath, 'output.log'); // kept for deps.phaseHeader and deps.gitPush
  const qaLogFile = path.join(pipeline.specPath, 'output-qa.log');
  deps.phaseHeader(logFile, `qa-review (attempt ${pipeline.qaAttempt})`);

  // Gap 3: Respect locked QA reports
  const reportPath = path.join(pipeline.specPath, 'qa_report.json');
  if (existsSync(reportPath)) {
    try {
      const existingReport = JSON.parse(readFileSync(reportPath, 'utf-8'));
      if (existingReport.locked === true) {
        logToOutput(pipeline.specPath, '\n[INFO] qa_report.json is locked — skipping QA review\n');
        await reconcileCompletedSubtasksOnQaPass(pipeline, deps);
        deps.advancePhase(pipeline, 'awaiting-review');
        return;
      }
      if (existingReport.reviewedBy && typeof existingReport.reviewedBy === 'string' &&
          existingReport.reviewedBy.toLowerCase().includes('manual override')) {
        logToOutput(pipeline.specPath, '\n[INFO] qa_report.json has manual override — skipping QA review\n');
        await reconcileCompletedSubtasksOnQaPass(pipeline, deps);
        deps.advancePhase(pipeline, 'awaiting-review');
        return;
      }
    } catch { /* malformed JSON — proceed with fresh QA review */ }
  }

  // Gap 1: Verify worktree state matches remote
  try {
    execFileSync('git', ['fetch', 'origin', pipeline.branch], { cwd: deps.projectRoot, stdio: 'pipe' });
  } catch { /* branch doesn't exist on remote yet */ }

  let hasUnpushed = false;
  try {
    const unpushed = execFileSync('git', ['log', `origin/${pipeline.branch}..${pipeline.branch}`, '--oneline'], {
      cwd: deps.projectRoot, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
    hasUnpushed = unpushed.length > 0;
    if (hasUnpushed) {
      logToOutput(pipeline.specPath, `\n[QA-PRECHECK] Unpushed commits detected on ${pipeline.branch}:\n${unpushed}\n`);
      try {
        deps.gitPush(['push', 'origin', pipeline.branch], logFile);
        logToOutput(pipeline.specPath, '[QA-PRECHECK] Pushed unpushed commits successfully — remote matches worktree\n');
        hasUnpushed = false;
      } catch (pushErr) {
        const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
        logToOutput(pipeline.specPath, `[QA-PRECHECK] Auto-push failed: ${pushMsg}\n`);

        // A rejected non-fast-forward push means the branch has diverged
        // from its own remote counterpart — e.g. an earlier session's push
        // rewrote history, or a prior rebase/merge produced different
        // commit hashes for the same logical changes on origin than the
        // ones this worktree built on top of. A plain retry can never
        // succeed here (it's not a transient failure), and without this
        // reconciliation step the task bounces to implement, finds every
        // subtask already marked complete, skips straight back to this
        // exact same precheck, and fails identically — burning every QA
        // attempt on a problem nothing in that loop ever touches. Reconcile
        // with the same rebase-then-merger-fallback pattern already proven
        // for base-branch rebases (phase-runners.ts,
        // rebaseOntoLatestDefault), just targeting the branch's own origin
        // ref instead of the base branch, then retry the push once.
        if (/rejected|non-fast-forward/i.test(pushMsg)) {
          logToOutput(pipeline.specPath, '[QA-PRECHECK] Push rejected (non-fast-forward) — reconciling with origin before retrying\n');
          const reconcileOutcome = await reconcileDivergedBranch(pipeline, deps);
          if (reconcileOutcome === 'rebased') {
            // A plain rebase doesn't push on its own — push it ourselves.
            try {
              deps.gitPush(['push', 'origin', pipeline.branch], logFile);
              logToOutput(pipeline.specPath, '[QA-PRECHECK] Pushed after reconciling with origin — remote matches worktree\n');
              hasUnpushed = false;
            } catch (retryErr) {
              const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
              logToOutput(pipeline.specPath, `[QA-PRECHECK] Push still failing after reconciliation: ${retryMsg}\n`);
            }
          } else if (reconcileOutcome === 'merged') {
            // The merger's /merge skill pushes the resolved branch as its
            // own final step (.claude/commands/merge.md step 6) — don't
            // retry blind against a ref that may or may not have caught
            // up yet, just verify the actual resulting state.
            const pushed = await waitForMergerPushToSettle(pipeline, deps);
            if (pushed) {
              logToOutput(pipeline.specPath, '[QA-PRECHECK] Merger pushed the reconciled branch — remote matches worktree\n');
              hasUnpushed = false;
            } else {
              logToOutput(pipeline.specPath, `[QA-PRECHECK] Branch still diverged from origin/${pipeline.branch} after the merger's push — giving up\n`);
            }
          }
        }
      }
    }
  } catch { /* branch doesn't exist on remote */ }

  if (hasUnpushed) {
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
    writeFailReport(pipeline, failReport, 'unpushed-commits');
    logToOutput(pipeline.specPath, '[QA-PRECHECK] FAIL — unpushed commits detected, engineer must push first\n');

    if (pipeline.qaAttempt >= pipeline.maxQaAttempts) {
      deps.writeCompletionSummary(pipeline);
      deps.advancePhase(pipeline, 'failed');
    } else {
      if (existsSync(reportPath)) {
        snapshotQaReportBeforeBounce(pipeline);
      }
      deps.writeQaFeedback(pipeline, failReport);
      deps.advancePhase(pipeline, 'implement');
      deps.savePipelineState(pipeline);
      await deps.executePhase(pipeline);
    }
    return;
  }

  // Fetch latest origin/default-branch
  try {
    const baseBranch = resolveBaseBranch(deps.projectRoot);
    execFileSync('git', ['fetch', 'origin', baseBranch], { cwd: deps.projectRoot, stdio: 'pipe' });
  } catch { /* offline — proceed with cached refs */ }

  const sessionId = await processManager.createSession(
    deps.sessionOpts('qa-reviewer', pipeline.worktreePath, pipeline.taskId, qaLogFile),
  );
  pipeline.sessionId = sessionId;
  // Write QA session mapping for live streaming in the UI
  updateSessionMap(pipeline.specPath, 'qa', sessionId);
  const agentSpecPath = deps.toAgentPath(pipeline.specPath);
  processManager.sendMessage(sessionId,
    humanDirectiveFor(pipeline.specPath, 'qa-reviewer') +
    `/qa-review ${agentSpecPath}/spec.md\n\n` +
    `IMPORTANT: Write the QA report to \`${agentSpecPath}/qa_report.json\` (use this exact absolute path, not a relative path).\n` +
    `The working directory is a git worktree — do NOT write to a .teamai/ subdirectory relative to the current directory.`);

  try {
    await deps.waitForCompletion(sessionId);
  } catch (err) {
    if (err instanceof RateLimitError) {
      pipeline.qaAttempt--; // rate limits are free retries — don't count against the failure budget
    }
    throw err;
  }
  processManager.killSession(sessionId);
  consumeFeedbackIfDue(pipeline.specPath, 'qa-review');

  const reportResult = readJsonFile<QaReport>(reportPath, { required: true });
  if (reportResult.error) {
    // QA agent produced no readable report — write a structured FAIL and
    // follow the normal bounce/fail budget instead of crashing with ENOENT.
    logToOutput(pipeline.specPath, `\n[QA-ERROR] QA agent did not produce a readable report: ${reportResult.error.message}\n`);
    const failReport: QaReport = {
      overall: 'FAIL',
      criteria: [{
        criterion: 'QA report unreadable',
        name: 'QA report unreadable',
        status: 'FAIL',
        notes: `The QA agent session completed but the report at ${reportPath} is missing or invalid: ${reportResult.error.message}. This is a pipeline error — re-running QA may produce a valid report.`,
      }],
    };
    writeFailReport(pipeline, failReport, 'unreadable-report');
    if (pipeline.qaAttempt >= pipeline.maxQaAttempts) {
      deps.writeCompletionSummary(pipeline);
      deps.advancePhase(pipeline, 'failed');
    } else {
      deps.writeQaFeedback(pipeline, failReport);
      deps.advancePhase(pipeline, 'implement');
      deps.savePipelineState(pipeline);
      await deps.executePhase(pipeline);
    }
    return;
  }
  const report: QaReport = reportResult.data!;

  // Stamp HEAD sha and spec version so every QA report explicitly
  // identifies which spec revision it was produced against.
  try {
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: pipeline.worktreePath, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
    report.head_at_review = headSha;
    report.spec_revision = pipeline.specRevision;
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch { /* best-effort */ }

  // Versioned snapshot: preserve every QA report for historical comparison,
  // like spec_v{N}.md for specs. Increment before writing so v1 is the first
  // completed QA report, not the zero-index.
  pipeline.qaRevision++;
  deps.savePipelineState(pipeline);
  snapshotQaReportVersioned(pipeline);

  const hasSpecConcerns = report.spec_concerns && Array.isArray(report.spec_concerns) && report.spec_concerns.length > 0;

  if (hasSpecConcerns) {
    await deps.autoReviseSpec(pipeline);
    return;
  } else if (report.overall === 'PASS') {
    await reconcileCompletedSubtasksOnQaPass(pipeline, deps);
    deps.advancePhase(pipeline, 'awaiting-review');
  } else if (pipeline.qaAttempt >= pipeline.maxQaAttempts) {
    deps.writeCompletionSummary(pipeline);
    deps.advancePhase(pipeline, 'failed');
  } else {
    // Persisted FAIL criterion detection: compare current FAIL criteria
    // against the PREVIOUS cycle's report (read before snapshot overwrite).
    const prevSnapshotPath = path.join(pipeline.specPath, 'qa_report_before_bounce.json');
    const currentFailNames = new Set<string>(
      (report.criteria || []).filter(c => c.status === 'FAIL').map(c => (c.criterion || c.name || '').trim())
    );
    let prevFailNames = new Set<string>();
    if (existsSync(prevSnapshotPath) && currentFailNames.size > 0) {
      try {
        const prevReport: QaReport = JSON.parse(readFileSync(prevSnapshotPath, 'utf-8'));
        prevFailNames = new Set<string>(
          (prevReport.criteria || []).filter(c => c.status === 'FAIL').map(c => (c.criterion || c.name || '').trim())
        );
      } catch { /* best-effort */ }
    }

    // Snapshot QA report before bouncing back (overwrites previous snapshot)
    snapshotQaReportBeforeBounce(pipeline);

    // Update persisted criterion fail counts based on comparison
    if (currentFailNames.size > 0 && prevFailNames.size > 0) {
      if (!pipeline.persistedCriterionFailCounts) pipeline.persistedCriterionFailCounts = {};
      for (const name of currentFailNames) {
        if (prevFailNames.has(name)) {
          // persistedCriterionFailCounts tracks the total number of consecutive
          // QA cycles where this criterion has appeared unchanged. On first
          // detection: previous cycle (at least 1) + current cycle = 2 total.
          const prevTotal = pipeline.persistedCriterionFailCounts[name] || 1;
          pipeline.persistedCriterionFailCounts[name] = prevTotal + 1;
          logToOutput(pipeline.specPath, `\n[QA-ESCALATE] Persisted FAIL criterion detected: "${name}" has failed ${pipeline.persistedCriterionFailCounts[name]} times in a row\n`);
        }
      }
      // Remove criteria that are no longer failing (they got fixed)
      for (const name of Object.keys(pipeline.persistedCriterionFailCounts)) {
        if (!currentFailNames.has(name)) {
          delete pipeline.persistedCriterionFailCounts[name];
          logToOutput(pipeline.specPath, `\n[QA-ESCALATE] Criterion "${name}" resolved — removed from persisted failures tracking\n`);
        }
      }
    }

    // FAIL-type router
    if (report.fail_type === 'cleanup') {
      logToOutput(pipeline.specPath, '\n[QA-ROUTER] fail_type=cleanup — routing to implement for automated mechanical fix\n');
      const failCriteria = report.criteria?.filter(c => c.status === 'FAIL') || [];
      for (const c of failCriteria) {
        logToOutput(pipeline.specPath, `[QA-ROUTER] Cleanup required: ${c.fix_needed || c.notes || c.criterion}\n`);
      }
      logToOutput(pipeline.specPath, '[QA-ROUTER] Cleanup fix is automated — executing via implement cleanup-only rework mode\n');
    }

    deps.writeQaFeedback(pipeline, report);
    deps.advancePhase(pipeline, 'implement');
    deps.savePipelineState(pipeline);
    await deps.executePhase(pipeline);
  }
}
