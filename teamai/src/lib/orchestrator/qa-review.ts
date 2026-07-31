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
import path from 'path';
import { processManager, type AgentSession } from '../process-manager';
import { resolveBaseBranch } from '../git-platform';
import { readJsonFile } from '../json-io';
import { RateLimitError } from './rate-limit';
import type { PipelinePhase } from '@/constants/phases';
import type { TaskPipeline, QaReport, SessionOptsResult } from './types';

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
}

// ── Diverged-branch reconciliation ──────────────────────────────────────

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
 * Returns true on success (the branch is safe to push again).
 */
async function reconcileDivergedBranch(
  pipeline: TaskPipeline,
  deps: QaReviewDeps,
): Promise<boolean> {
  const targetRef = `origin/${pipeline.branch}`;
  try {
    execFileSync('git', ['rebase', targetRef], { cwd: pipeline.worktreePath, stdio: 'pipe' });
    logToOutput(pipeline.specPath, `[QA-PRECHECK] Rebased onto ${targetRef}\n`);
    return true;
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
      return true;
    } catch (mergeErr) {
      const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
      logToOutput(pipeline.specPath, `[QA-PRECHECK] Merger could not resolve divergence: ${mergeMsg}\n`);
      return false;
    }
  }
}

const RECONCILE_SETTLE_POLL_MS = 1000;
const RECONCILE_SETTLE_MAX_ATTEMPTS = 5;

/**
 * Poll for the local branch ref actually descending from origin/<branch>
 * after a merger session reports completion — see the call site in
 * runQaReview for why this can't be trusted immediately. Costs nothing on
 * the common path (only reached after a real divergence + merger cycle);
 * worst case adds ~RECONCILE_SETTLE_MAX_ATTEMPTS seconds to a QA precheck
 * that would otherwise have failed the task outright.
 */
async function waitForBranchAheadOfOrigin(pipeline: TaskPipeline, projectRoot: string): Promise<boolean> {
  for (let attempt = 0; attempt < RECONCILE_SETTLE_MAX_ATTEMPTS; attempt++) {
    try {
      execFileSync('git', ['merge-base', '--is-ancestor', `origin/${pipeline.branch}`, pipeline.branch], {
        cwd: projectRoot, stdio: 'pipe',
      });
      return true;
    } catch { /* not yet settled — retry after a short delay */ }
    await new Promise(resolve => setTimeout(resolve, RECONCILE_SETTLE_POLL_MS));
  }
  return false;
}

// ── Main function ─────────────────────────────────────────────────────────

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
          const reconciled = await reconcileDivergedBranch(pipeline, deps);
          if (reconciled) {
            // waitForCompletion resolving only means the merger's own
            // session/turn ended — not that its git operations are
            // guaranteed durable yet. Observed directly in production: the
            // orchestrator logged the merger as resolved a full 39 seconds
            // before the resulting merge commit's own committer timestamp,
            // and an immediate retry push here hit the identical
            // non-fast-forward rejection because the shared local branch
            // ref hadn't caught up. Poll for the branch actually
            // descending from origin/<branch> before trusting it's safe to
            // push, instead of retrying blind against a ref that may still
            // be mid-update.
            const settled = await waitForBranchAheadOfOrigin(pipeline, deps.projectRoot);
            if (!settled) {
              logToOutput(pipeline.specPath, `[QA-PRECHECK] Local branch still not ahead of origin/${pipeline.branch} after reconciliation — giving up\n`);
            } else {
              try {
                deps.gitPush(['push', 'origin', pipeline.branch], logFile);
                logToOutput(pipeline.specPath, '[QA-PRECHECK] Pushed after reconciling with origin — remote matches worktree\n');
                hasUnpushed = false;
              } catch (retryErr) {
                const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
                logToOutput(pipeline.specPath, `[QA-PRECHECK] Push still failing after reconciliation: ${retryMsg}\n`);
              }
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
    writeFileSync(reportPath, JSON.stringify(failReport, null, 2));
    logToOutput(pipeline.specPath, '[QA-PRECHECK] FAIL — unpushed commits detected, engineer must push first\n');

    if (pipeline.qaAttempt >= pipeline.maxQaAttempts) {
      deps.writeCompletionSummary(pipeline);
      deps.advancePhase(pipeline, 'failed');
    } else {
      if (existsSync(reportPath)) {
        try {
          const bounceSnapshot = path.join(pipeline.specPath, 'qa_report_before_bounce.json');
          writeFileSync(bounceSnapshot, readFileSync(reportPath, 'utf-8'));
        } catch { /* best-effort */ }
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
    writeFileSync(reportPath, JSON.stringify(failReport, null, 2));
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

  // Stamp HEAD sha
  try {
    const headSha = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: pipeline.worktreePath, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
    report.head_at_review = headSha;
    writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } catch { /* best-effort */ }

  const hasSpecConcerns = report.spec_concerns && Array.isArray(report.spec_concerns) && report.spec_concerns.length > 0;

  if (hasSpecConcerns) {
    await deps.autoReviseSpec(pipeline);
    return;
  } else if (report.overall === 'PASS') {
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
    try {
      const bounceSnapshot = path.join(pipeline.specPath, 'qa_report_before_bounce.json');
      writeFileSync(bounceSnapshot, readFileSync(reportPath, 'utf-8'));
    } catch { /* best-effort */ }

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
