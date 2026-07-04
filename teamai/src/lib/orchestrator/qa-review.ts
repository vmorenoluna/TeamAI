/**
 * runQaReview phase runner — extracted from Orchestrator class.
 *
 * Handles the QA review phase: locked-report detection, unpushed-commit
 * check, session timeout, spec-concern routing, FAIL-type routing,
 * and bounce-back to implement.
 */
import { execFileSync } from 'child_process';
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'fs';
import path from 'path';
import { processManager, type AgentSession } from '../process-manager';
import { RateLimitError } from './rate-limit';
import type { PipelinePhase } from '@/constants/phases';
import type { TaskPipeline, QaReport } from './types';

// ── Types ─────────────────────────────────────────────────────────────────

type SessionOptsResult = { taskId: string; role: AgentSession['role']; cwd: string; [key: string]: unknown };

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

// ── Main function ─────────────────────────────────────────────────────────

export async function runQaReview(
  pipeline: TaskPipeline,
  deps: QaReviewDeps,
): Promise<void> {
  deps.persistAndEmitPhase(pipeline);
  pipeline.qaAttempt++;
  deps.savePipelineState(pipeline);
  const logFile = path.join(pipeline.specPath, 'output.log');
  deps.phaseHeader(logFile, `qa-review (attempt ${pipeline.qaAttempt})`);

  // Gap 3: Respect locked QA reports
  const reportPath = path.join(pipeline.specPath, 'qa_report.json');
  if (existsSync(reportPath)) {
    try {
      const existingReport = JSON.parse(readFileSync(reportPath, 'utf-8'));
      if (existingReport.locked === true) {
        appendFileSync(logFile, '\n[INFO] qa_report.json is locked — skipping QA review\n');
        deps.advancePhase(pipeline, 'awaiting-review');
        return;
      }
      if (existingReport.reviewedBy && typeof existingReport.reviewedBy === 'string' &&
          existingReport.reviewedBy.toLowerCase().includes('manual override')) {
        appendFileSync(logFile, '\n[INFO] qa_report.json has manual override — skipping QA review\n');
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
      appendFileSync(logFile, `\n[QA-PRECHECK] Unpushed commits detected on ${pipeline.branch}:\n${unpushed}\n`);
      try {
        deps.gitPush(['push', 'origin', pipeline.branch], logFile);
        appendFileSync(logFile, '[QA-PRECHECK] Pushed unpushed commits successfully — remote matches worktree\n');
        hasUnpushed = false;
      } catch (pushErr) {
        const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
        appendFileSync(logFile, `[QA-PRECHECK] Auto-push failed: ${pushMsg}\n`);
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
    appendFileSync(logFile, '[QA-PRECHECK] FAIL — unpushed commits detected, engineer must push first\n');

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

  // Fetch latest origin/master
  try {
    execFileSync('git', ['fetch', 'origin', 'master'], { cwd: deps.projectRoot, stdio: 'pipe' });
  } catch { /* offline — proceed with cached refs */ }

  const sessionId = await processManager.createSession(
    deps.sessionOpts('qa-reviewer', pipeline.worktreePath, pipeline.taskId, logFile),
  );
  pipeline.sessionId = sessionId;
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

  const report: QaReport = JSON.parse(readFileSync(reportPath, 'utf-8'));

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
    // Snapshot QA report before bouncing back
    try {
      const bounceSnapshot = path.join(pipeline.specPath, 'qa_report_before_bounce.json');
      writeFileSync(bounceSnapshot, readFileSync(reportPath, 'utf-8'));
    } catch { /* best-effort */ }

    // FAIL-type router
    if (report.fail_type === 'cleanup') {
      appendFileSync(logFile, '\n[QA-ROUTER] fail_type=cleanup — routing to implement for automated mechanical fix\n');
      const failCriteria = report.criteria?.filter(c => c.status === 'FAIL') || [];
      for (const c of failCriteria) {
        appendFileSync(logFile, `[QA-ROUTER] Cleanup required: ${c.fix_needed || c.notes || c.criterion}\n`);
      }
      appendFileSync(logFile, '[QA-ROUTER] Cleanup fix is automated — executing via implement cleanup-only rework mode\n');
    }

    deps.writeQaFeedback(pipeline, report);
    deps.advancePhase(pipeline, 'implement');
    deps.savePipelineState(pipeline);
    await deps.executePhase(pipeline);
  }
}
