/**
 * runQaReview phase runner — extracted from Orchestrator class.
 *
 * Handles the QA review phase: locked-report detection, unpushed-commit
 * check, session timeout, spec-concern routing, FAIL-type routing,
 * and bounce-back to implement.
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { updateSessionMap, logToOutput } from './helpers';
import { humanDirectiveFor, consumeFeedbackIfDue } from './human-feedback';
import path from 'path';
import { processManager, type AgentSession } from '../process-manager';
import { syncPhaseBaseline } from './phase-runners';
import { readJsonFile } from '../json-io';
import { RateLimitError } from './rate-limit';
import { warn } from '../logger';
import type { PipelinePhase } from '@/constants/phases';
import type { TaskPipeline, QaReport, QaIssue, SessionOptsResult } from './types';
import type { FailureReason } from './qa-feedback';

function additionalIssueKey(issue: QaIssue): string {
  const file = (issue.file || '').trim().replace(/\\/g, '/').toLowerCase();
  const description = (issue.description || issue.message || '').trim().replace(/\\s+/g, ' ').toLowerCase();
  return `${file}::${description}`;
}

function additionalIssueKeys(report: QaReport): Set<string> {
  return new Set((report.additional_issues || report.issues || [])
    .map(additionalIssueKey)
    .filter(key => key !== '::'));
}

function updateAdditionalIssueCounts(
  pipeline: TaskPipeline,
  report: QaReport,
  previousReport: QaReport | null,
): void {
  const current = additionalIssueKeys(report);
  const previous = previousReport ? additionalIssueKeys(previousReport) : new Set<string>();
  if (current.size === 0 || previous.size === 0) return;
  if (!pipeline.persistedAdditionalIssueCounts) pipeline.persistedAdditionalIssueCounts = {};

  for (const key of current) {
    if (previous.has(key)) {
      pipeline.persistedAdditionalIssueCounts[key] = (pipeline.persistedAdditionalIssueCounts[key] || 1) + 1;
    }
  }
  for (const key of Object.keys(pipeline.persistedAdditionalIssueCounts)) {
    if (!current.has(key)) delete pipeline.persistedAdditionalIssueCounts[key];
  }
}

function previousQaReport(specPath: string): QaReport | null {
  const previousPath = path.join(specPath, 'qa_report_before_bounce.json');
  if (!existsSync(previousPath)) return null;
  try { return JSON.parse(readFileSync(previousPath, 'utf-8')) as QaReport; } catch { return null; }
}

function failCriterionNames(report: QaReport): Set<string> {
  return new Set((report.criteria || [])
    .filter(c => c.status === 'FAIL')
    .map(c => (c.criterion || c.name || '').trim())
    .filter(Boolean));
}

function updateCriterionCounts(
  pipeline: TaskPipeline,
  report: QaReport,
  previousReport: QaReport | null,
): void {
  const current = failCriterionNames(report);
  const previous = previousReport ? failCriterionNames(previousReport) : new Set<string>();
  if (current.size === 0 || previous.size === 0) return;
  if (!pipeline.persistedCriterionFailCounts) pipeline.persistedCriterionFailCounts = {};

  for (const name of current) {
    if (previous.has(name)) {
      pipeline.persistedCriterionFailCounts[name] = (pipeline.persistedCriterionFailCounts[name] || 1) + 1;
      logToOutput(pipeline.specPath, `\\n[QA-ESCALATE] Persisted FAIL criterion detected: "${name}" has failed ${pipeline.persistedCriterionFailCounts[name]} times in a row\\n`);
    }
  }
  for (const name of Object.keys(pipeline.persistedCriterionFailCounts)) {
    if (!current.has(name)) {
      delete pipeline.persistedCriterionFailCounts[name];
      logToOutput(pipeline.specPath, `\\n[QA-ESCALATE] Criterion "${name}" resolved — removed from persisted failures tracking\\n`);
    }
  }
}

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
  execGit: (args: string[], hostCwd: string) => void;
  writeQaFeedback: (pipeline: TaskPipeline, report: QaReport) => void;
  writeCompletionSummary: (pipeline: TaskPipeline, reason: FailureReason, detail?: string) => void;
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
 * Returns which path succeeded. Neither path pushes on its own — a plain
 * rebase never does, and the merger agent only resolves the conflict and
 * commits locally (see .claude/commands/merge.md step 6: agent sessions run
 * their own git inside the container and have no GitHub credentials to push
 * with). The caller must push the result itself for BOTH 'rebased' and
 * 'merged'.
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
 * Terminal routing for a FAIL report whose QA budget is exhausted — always
 * write qa_feedback.md first (so there's a record of what was flagged, and
 * moveTaskToPhase's retry-preservation logic has something to re-derive from
 * even without a human re-typing it) before failing the task.
 *
 * @internal — exported for unit tests only. Not part of the public API.
 */
export function failBudgetExhausted(
  pipeline: TaskPipeline,
  deps: QaReviewDeps,
  report: QaReport,
  reason: FailureReason = 'qa-attempts-exhausted',
): void {
  deps.writeQaFeedback(pipeline, report);
  deps.writeCompletionSummary(pipeline, reason);
  deps.advancePhase(pipeline, 'failed');
}

/**
 * Bounce a FAIL report back to implement — the shared tail of every
 * non-exhausted FAIL path (unpushed-commits precheck, unreadable-report
 * precheck, and the main QA-report FAIL router).
 *
 * @internal — exported for unit tests only. Not part of the public API.
 */
export async function bounceToImplement(pipeline: TaskPipeline, deps: QaReviewDeps, report: QaReport): Promise<void> {
  deps.writeQaFeedback(pipeline, report);
  deps.advancePhase(pipeline, 'implement');
  deps.savePipelineState(pipeline);
  await deps.executePhase(pipeline);
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

export async function runQaReview(
  pipeline: TaskPipeline,
  deps: QaReviewDeps,
): Promise<void> {
  deps.persistAndEmitPhase(pipeline);
  pipeline.qaAttempt++;
  pipeline.qaRoundCount = (pipeline.qaRoundCount || 0) + 1;
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
        deps.advancePhase(pipeline, 'awaiting-review');
        return;
      }
      if (existingReport.reviewedBy && typeof existingReport.reviewedBy === 'string' &&
          existingReport.reviewedBy.toLowerCase().includes('manual override')) {
        logToOutput(pipeline.specPath, '\n[INFO] qa_report.json has manual override — skipping QA review\n');
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
            // The merger only resolves the conflict and commits locally —
            // it doesn't push (agent sessions run their own git inside the
            // container and have no GitHub credentials to push with). Push
            // its result ourselves, same as the 'rebased' branch above.
            try {
              deps.gitPush(['push', 'origin', pipeline.branch], logFile);
              logToOutput(pipeline.specPath, '[QA-PRECHECK] Pushed the reconciled branch after merger resolution — remote matches worktree\n');
              hasUnpushed = false;
            } catch (pushErr) {
              const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
              logToOutput(pipeline.specPath, `[QA-PRECHECK] Push failed after merger resolution: ${pushMsg}\n`);
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
    // Keep the precheck report as the previous-round input too. This path
    // returns before the normal post-QA snapshot below.
    snapshotQaReportBeforeBounce(pipeline);
    logToOutput(pipeline.specPath, '[QA-PRECHECK] FAIL — unpushed commits detected, engineer must push first\n');

    if (Math.max(pipeline.qaRoundCount || 0, pipeline.qaAttempt) >= pipeline.maxQaAttempts) {
      failBudgetExhausted(pipeline, deps, failReport);
    } else {
      await bounceToImplement(pipeline, deps, failReport);
    }
    return;
  }

  // Keep the worktree current with the latest default branch before QA
  // judges it. This used to only fetch origin/<base> here, never rebase onto
  // it — a retry (or any resume) landing directly on qa-review without
  // passing through implement first would then judge code that could be
  // missing an upstream fix its own prior failure depended on.
  await syncPhaseBaseline(pipeline, deps);

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
    if (Math.max(pipeline.qaRoundCount || 0, pipeline.qaAttempt) >= pipeline.maxQaAttempts) {
      failBudgetExhausted(pipeline, deps, failReport);
    } else {
      await bounceToImplement(pipeline, deps, failReport);
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
  // Read the prior round before replacing it with the current report.
  const priorReport = previousQaReport(pipeline.specPath);

  // Persist recurrence history before any routing decision. Spec revisions
  // preserve these maps, so a defect cannot evade escalation by repeatedly
  // attaching an unrelated spec concern.
  updateCriterionCounts(pipeline, report, priorReport);
  updateAdditionalIssueCounts(pipeline, report, priorReport);
  // Preserve the completed report for the next QA round, regardless of routing.
  snapshotQaReportBeforeBounce(pipeline);

  const budgetExhausted = Math.max(pipeline.qaRoundCount || 0, pipeline.qaAttempt) >= pipeline.maxQaAttempts;

  // An `overall` that's neither PASS nor FAIL (almost always "IN_PROGRESS")
  // means the reviewer never reached a verdict. Per qa-review.md Step 5,
  // IN_PROGRESS is only a mid-session crash-recovery placeholder — the
  // reviewer's own instructions say to replace it with a real PASS/FAIL
  // before the turn ends. Nothing here is an actual FAIL criterion or
  // fix_needed entry for the coder to act on, so routing this through the
  // FAIL-type router below would bounce to implement and waste a round on
  // nothing. Re-run QA instead — Step 0's rework-pass carry-forward makes
  // the retry cheap — and use a distinct failure reason on exhaustion so the
  // UI never reports a QA failure that never actually happened.
  if (report.overall !== 'PASS' && report.overall !== 'FAIL') {
    logToOutput(pipeline.specPath,
      `\n[QA-ROUTER] overall="${report.overall}" — QA review did not reach a verdict; ` +
      `re-running QA instead of treating this as a FAIL\n`);
    if (budgetExhausted) {
      failBudgetExhausted(pipeline, deps, report, 'qa-incomplete');
      return;
    }
    deps.savePipelineState(pipeline);
    await deps.executePhase(pipeline);
    return;
  }

  // The QA budget is global across spec revisions. Check it before
  // spec-concern routing so a task cannot loop through unlimited real
  // implement→QA rounds merely because every report also has spec_concerns.
  if (budgetExhausted && report.overall !== 'PASS') {
    failBudgetExhausted(pipeline, deps, report);
    return;
  }

  // Budget is confirmed NOT exhausted past this point (the check above
  // already returned otherwise, and qaAttempt <= Math.max(qaRoundCount,
  // qaAttempt) means qaAttempt < maxQaAttempts here too) — every branch
  // below bounces back to implement rather than failing.
  if (hasSpecConcerns) {
    // Keep the coder's QA feedback alongside the analyst's spec revision
    // feedback; spec concerns must not discard concrete code defects.
    deps.writeQaFeedback(pipeline, report);
    await deps.autoReviseSpec(pipeline);
    return;
  } else if (report.overall === 'PASS') {
    deps.advancePhase(pipeline, 'awaiting-review');
  } else {
    // FAIL-type router
    if (report.fail_type === 'cleanup') {
      logToOutput(pipeline.specPath, '\n[QA-ROUTER] fail_type=cleanup — routing to implement for automated mechanical fix\n');
      const failCriteria = report.criteria?.filter(c => c.status === 'FAIL') || [];
      for (const c of failCriteria) {
        logToOutput(pipeline.specPath, `[QA-ROUTER] Cleanup required: ${c.fix_needed || c.notes || c.criterion}\n`);
      }
      logToOutput(pipeline.specPath, '[QA-ROUTER] Cleanup fix is automated — executing via implement cleanup-only rework mode\n');
    }

    await bounceToImplement(pipeline, deps, report);
  }
}
