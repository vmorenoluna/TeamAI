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
import { readFileSync, writeFileSync, existsSync, appendFileSync, unlinkSync, renameSync, rmSync } from 'fs';
import { PipelineConfigError, WorktreeError, PushVerificationError } from './errors';
import { readJsonFile } from '../json-io';
import path from 'path';
import { processManager, type AgentSession } from '../process-manager';
import { readContainerConfig, containerManager, dockerAvailable, _resetDockerAvailableCache } from '../container-manager';
import { runSensors, sensorRunSummary, type SensorsConfig } from '../sensors';
import { rebaseOntoLatestDefault } from './phase-runners';
import { updateSessionMap } from './helpers';
import { resolveBaseBranch } from '../git-platform';
import type { PipelinePhase } from '@/constants/phases';
import type { TaskPipeline, QaReport, PlanSubtask, SessionOptsResult } from './types';

export interface ImplementPipeline extends TaskPipeline {
  /** Internal flag: set when wakeup completes during this run so post-groups code re-enters (ADR 002) */
  _wakeupJustCompleted?: boolean;
}

// ── Dependencies ──────────────────────────────────────────────────────────

export interface ImplementDeps {
  projectRoot: string;
  persistAndEmitPhase: (pipeline: ImplementPipeline) => void;
  advancePhase: (pipeline: ImplementPipeline, phase: PipelinePhase, eventExtra?: Record<string, unknown>) => void;
  savePipelineState: (pipeline: ImplementPipeline) => void;
  executePhase: (pipeline: ImplementPipeline) => Promise<void>;
  sessionOpts: (role: AgentSession['role'], cwd: string, taskId: string, logFile?: string) => SessionOptsResult;
  waitForCompletion: (sessionId: string) => Promise<void>;
  execGit: (args: string[], hostCwd: string) => void;
  gitPush: (pushArgs: string[], logFile: string) => void;
  patchWorktreeGitFile: (hostWorktreePath: string, containerWorkspace: string) => void;
  isWorktreeHealthy: (worktreePath: string) => boolean;
  cleanStaleSubtaskWorktrees: (pipeline: ImplementPipeline) => void;
  restoreQaReportFromSnapshot: (specPath: string) => void;
  restoreHumanFeedbackFromSnapshot: (specPath: string) => void;
  writeQaFeedback: (pipeline: ImplementPipeline, report: QaReport) => void;
  getPipelineConfig: () => { maxQaAttempts: number; parallelSubtasks: boolean; sensors?: SensorsConfig; maxDeliverableFails: number; maxWakeupAttempts: number };
  phaseHeader: (logFile: string, phase: string) => void;
  /** Mutable reference to the plan-write serialization lock. */
  planWriteLock: { current: Promise<void> };
  /** Schedule a wakeup timer (ADR 002). */
  scheduleWakeup: (pipeline: ImplementPipeline) => void;
}

// ═══════════════════════════════════════════════════════════════════════════
//  Helper 1 — ensureWorktree
// ═══════════════════════════════════════════════════════════════════════════

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

  // Ensure worktree exists and is healthy
  if (!existsSync(pipeline.worktreePath) || !deps.isWorktreeHealthy(pipeline.worktreePath)) {
    if (existsSync(pipeline.worktreePath)) {
      if (path.resolve(pipeline.worktreePath) === path.resolve(deps.projectRoot)) {
        throw new WorktreeError('Refusing to remove worktree at project root — this would destroy the repository', 'WORKTREE_AT_ROOT');
      }
      try {
        deps.execGit(['worktree', 'remove', '--force', pipeline.worktreePath], deps.projectRoot);
      } catch { /* best-effort */ }
      if (existsSync(pipeline.worktreePath)) {
        try { rmSync(pipeline.worktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
        try { execFileSync('git', ['worktree', 'prune'], { cwd: deps.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
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
    const logFile = path.join(pipeline.specPath, 'output.log');
    appendFileSync(logFile, `\n[ERROR] Cannot read plan.json: ${planResult.error.message}\n`);
    throw new PipelineConfigError(`Plan file is missing or invalid at ${planPath}: ${planResult.error.message}. The planner must produce a valid plan.json before implement can proceed.`);
  }
  const plan = planResult.data!;

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

  // Only re-run QA-flagged subtasks on bounce-back
  const subtasksToRun = hasQaFeedback
    ? plan.subtasks.filter((s: PlanSubtask) => s.qa_flagged)
    : plan.subtasks.filter((s: PlanSubtask) => !s.completed);

  let effectiveSubtasks: PlanSubtask[];
  if (hasQaFeedback && subtasksToRun.length === 0) {
    const allFiles: string[] = [...new Set<string>(
      plan.subtasks.flatMap((s: PlanSubtask) => s.files ?? [])
    )];
    let qaContent = '';
    try { qaContent = readFileSync(qaFeedbackPath, 'utf-8'); } catch { /* best-effort */ }
    const logFile = path.join(pipeline.specPath, 'output.log');
    appendFileSync(logFile, '\n[QA-FALLBACK] Criterion matching flagged no subtasks — synthesising targeted rework subtask from qa_feedback.md\n');
    effectiveSubtasks = [{
      id: 9999,
      title: 'QA Rework: fix failing criteria (criterion matching found no flagged subtasks)',
      description: buildSyntheticReworkDescription(qaContent),
      files: allFiles,
      depends_on: [],
      acceptance_criteria: ['All criteria listed in the QA feedback above are satisfied'],
      parallel_group: 'QA-REWORK',
      qa_flagged: true,
      completed: false,
    }];
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
 * Run a single subtask's agent session: pre-sensors → create session → build
 * prompt (QA/wakeup/deliverable headers) → wait → post-session checks (scope,
 * wakeup detect, deliverable verification) → post-sensors → checkpoint.
 *
 * Mutates `pipeline`, `completedIds`, `scopeViolations`, and `sessionMapLock`
 * in-place (same as the original inline handler).
 */
async function runSubtaskSession(
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
      if (!preResult.allPassed) appendFileSync(logFile, sensorRunSummary(preResult));
    }
  } catch (preSensorErr) {
    const msg = preSensorErr instanceof Error ? preSensorErr.message : String(preSensorErr);
    appendFileSync(logFile, '\n[SENSOR:pre_subtask] pre-subtask sensors failed (non-blocking): ' + msg + '\n');
  }

  const subtaskLogFile = path.join(pipeline.specPath, `output-st${subtask.id}.log`);
  let sessionId: string;
  try {
    sessionId = await processManager.createSession(deps.sessionOpts(coderRole, cwd, pipeline.taskId, subtaskLogFile));
    // Serialised through a lock so parallel subtasks don't race on the JSON file.
    sessionMapLock.current = sessionMapLock.current.then(() => {
      updateSessionMap(pipeline.specPath, String(subtask.id), sessionId);
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    appendFileSync(logFile, '\n[ERROR] Session creation failed for subtask ' + subtask.id + ': ' + msg + '\n');
    throw err;
  }

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

  // Snapshot HEAD before the agent session starts (for post-session scope check)
  let preSessionHead = '';
  try {
    preSessionHead = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
  } catch { /* best-effort — scope check is skipped if snapshot fails */ }

  processManager.sendMessage(sessionId, prompt);

  await deps.waitForCompletion(sessionId);

  processManager.killSession(sessionId);

  // Post-session scope check: verify agent only modified assigned files.
  if (preSessionHead) {
    try {
      const changedFiles = execFileSync('git', ['diff', '--name-only', preSessionHead + '..HEAD'], {
        cwd, encoding: 'utf-8', stdio: 'pipe',
      }).trim().split('\n').filter(Boolean);

      const assignedFiles = new Set(subtask.files || []);
      const violations = changedFiles.filter(f => !assignedFiles.has(f));

      if (violations.length > 0) {
        scopeViolations.add(subtask.id);
        appendFileSync(logFile,
          '\n[SCOPE] Subtask ' + subtask.id + ' modified files outside its assigned scope:\n' +
          violations.map(f => '  - ' + f).join('\n') + '\n' +
          '[SCOPE] Assigned files: ' + ((subtask.files || []).join(', ') || '(none)') + '\n'
        );
      }
    } catch (scopeErr) {
      const scopeMsg = scopeErr instanceof Error ? scopeErr.message : String(scopeErr);
      appendFileSync(logFile, '\n[SCOPE] Could not verify file scope (git diff failed: ' + scopeMsg + ')\n');
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
          }
          pipeline.wakeupAttemptCount = (pipeline.wakeupAttemptCount || 0) + 1;
          wakeupDetected = true;
          appendFileSync(logFile, '[WAKEUP] Subtask ' + wd.subtask_id + ' wakeup scheduled for ' + wd.wakeup_at + ' (attempt ' + pipeline.wakeupAttemptCount + ') — background process: ' + (wd.background_command || 'unknown') + '\n');
        }
      } catch {
        appendFileSync(logFile, '[WAKEUP] Malformed subtask_wakeup.json — treating as missing\n');
      }
      try { unlinkSync(wakeupPath); } catch { /* best-effort */ }
    }
  }

  // Verify deliverable files exist before marking subtask complete
  let skipCompletion = false;
  const hasWakeup = pipeline.wakeupSubtaskId != null;
  if (!hasWakeup && subtask.files_to_create?.length) {
    for (const file of subtask.files_to_create) {
      if (!existsSync(path.join(cwd, file))) {
        skipCompletion = true;
        appendFileSync(logFile, '\n[VERIFY] Subtask ' + subtask.id + ': expected file/directory missing — ' + file + '\n');
      }
    }
    if (skipCompletion) {
      if (!pipeline.deliverableFailCounts) pipeline.deliverableFailCounts = {};
      const maxFails = deps.getPipelineConfig().maxDeliverableFails;
      const count = (pipeline.deliverableFailCounts[subtask.id] || 0) + 1;
      pipeline.deliverableFailCounts[subtask.id] = count;
      const missingFiles = subtask.files_to_create.filter(f => !existsSync(path.join(cwd, f))).join(', ');
      appendFileSync(logFile, '[VERIFY] Subtask ' + subtask.id + ' failed deliverable verification (attempt ' + count + '/' + maxFails + ') — missing: ' + missingFiles + '\n');
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
        appendFileSync(logFile, '[VERIFY] Subtask ' + subtask.id + ' exceeded deliverable verification cap (' + maxFails + ') — advancing to failed\n');
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
      appendFileSync(logFile, '[SCOPE] Subtask ' + subtask.id + ' rejected — will re-run with scope enforcement\n');
    } else {
      if (pipeline.deliverableFailCounts?.[subtask.id] !== undefined) {
        delete pipeline.deliverableFailCounts[subtask.id];
      }
      completedIds.push(subtask.id);
    }
  }

  // ADR 002: After wakeup completes — only on re-entry with no new wakeup file
  if (wasWakeupReentry && !wakeupDetected && !skipCompletion) {
    pipeline.wakeupUntil = undefined;
    pipeline.wakeupSubtaskId = undefined;
    pipeline.wakeupCommand = undefined;
    pipeline.wakeupArtifact = undefined;
    pipeline.wakeupAttemptCount = 0;
    pipeline._wakeupJustCompleted = true;
    appendFileSync(logFile, '[WAKEUP] Subtask ' + subtask.id + ' completed after wakeup — clearing wakeup state\n');
    return;
  }

  // post_subtask sensor
  try {
    const pipelineConfig = deps.getPipelineConfig();
    if (pipelineConfig.sensors?.post_subtask?.length) {
      const postResult = await runSensors(pipelineConfig.sensors.post_subtask, 'post_subtask', {
        cwd, specPath: pipeline.specPath, files: subtask.files || [], subtaskId: subtask.id, logFile,
      });
      appendFileSync(logFile, sensorRunSummary(postResult));
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
    appendFileSync(logFile, '\n[SENSOR:post_subtask] post-subtask sensors error: ' + msg + '\n');
  }

  deps.planWriteLock.current = deps.planWriteLock.current.then(() => {
    try {
      const cpPlanPath = path.join(pipeline.specPath, 'plan.json');
      if (!existsSync(cpPlanPath)) return;
      const cpPlan = JSON.parse(readFileSync(cpPlanPath, 'utf-8'));
      if (cpPlan.subtasks) {
        for (const s of cpPlan.subtasks) {
          if (completedIds.includes(s.id)) s.completed = true;
        }
      }
      const tmpPath = cpPlanPath + '.tmp';
      writeFileSync(tmpPath, JSON.stringify(cpPlan, null, 2));
      renameSync(tmpPath, cpPlanPath);

      // Emit subtask progress so the kanban counter updates live during implement.
      // Without this, the UI only sees updated counts on phase-change or page refresh.
      const subtasks = (cpPlan as { subtasks?: PlanSubtask[] }).subtasks ?? [];
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
 */
async function integrateGroup(
  pipeline: ImplementPipeline,
  deps: ImplementDeps,
  subtasks: PlanSubtask[],
  results: PromiseSettledResult<void>[],
  scopeViolations: Set<number>,
  subtaskWorktrees: Map<number, string>,
  logFile: string,
  isMultiGroup: boolean,
): Promise<boolean> {
  // Cherry-pick successful commits back to main worktree
  if (isMultiGroup) {
    // Pre-cherry-pick: auto-commit any uncommitted changes in the main worktree.
    try {
      const statusOut = execFileSync('git', ['status', '--porcelain'], {
        cwd: pipeline.worktreePath, encoding: 'utf-8', stdio: 'pipe',
      }).trim();
      if (statusOut) {
        appendFileSync(logFile, '\n[WORKTREE] Main worktree has uncommitted changes — auto-committing before cherry-pick:\n' + statusOut + '\n');
        execFileSync('git', ['add', '-A', '--', '.', ':!.teamai'], { cwd: pipeline.worktreePath, stdio: 'pipe' });
        execFileSync('git', ['commit', '-m', 'chore: auto-save worktree state before cherry-pick'], {
          cwd: pipeline.worktreePath, stdio: 'pipe',
        });
        appendFileSync(logFile, '[WORKTREE] Auto-committed uncommitted changes\n');
      }
    } catch (statusErr) {
      const errMsg = statusErr instanceof Error ? statusErr.message : String(statusErr);
      appendFileSync(logFile, '\n[WORKTREE] Could not check/commit worktree status (git failed: ' + errMsg + '), proceeding with cherry-pick\n');
    }

    for (let i = 0; i < results.length; i++) {
      if (results[i].status !== 'fulfilled') continue;
      if (scopeViolations.has(subtasks[i].id)) {
        appendFileSync(logFile, '\n[WORKTREE] Skipping cherry-pick for subtask ' + subtasks[i].id + ' (scope violation)\n');
        continue;
      }
      const stBranch = pipeline.branch + '-st' + subtasks[i].id;
      const cherrySuccess = await tryCherryPickWithRecovery(
        pipeline, deps, logFile, stBranch, subtasks[i].id,
      );
      if (!cherrySuccess) {
        appendFileSync(logFile, '\n[WORKTREE] Retained ' + subtaskWorktrees.size + ' per-subtask worktree(s) and branches for manual recovery (auto-recovery exhausted).\n');
        appendFileSync(logFile, '[WORKTREE] Branches preserved: ' + subtasks.map(s => pipeline.branch + '-st' + s.id).join(', ') + '\n');
        // Don't clean up — preserve work for manual recovery
        return false;
      }
    }
  }

  // Clean up per-subtask worktrees
  if (isMultiGroup) {
    for (const stWorktreePath of subtaskWorktrees.values()) {
      try { deps.execGit(['worktree', 'remove', '--force', stWorktreePath], deps.projectRoot); } catch {
        try { rmSync(stWorktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
        try { execFileSync('git', ['worktree', 'prune'], { cwd: deps.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
      }
    }
    for (const subtask of subtasks) {
      try { execFileSync('git', ['branch', '-D', pipeline.branch + '-st' + subtask.id], { cwd: deps.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
    }
    appendFileSync(logFile, '\n[WORKTREE] Cleaned up ' + subtaskWorktrees.size + ' per-subtask worktree(s)\n');
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
    appendFileSync(logFile, '[PUSH] Successfully pushed ' + pipeline.branch + ' to origin\n');

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
      appendFileSync(logFile, '[PUSH] Verified remote HEAD matches local HEAD\n');
    } catch (verifyErr) {
      const verifyMsg = verifyErr instanceof Error ? verifyErr.message : String(verifyErr);
      appendFileSync(logFile, '[PUSH] Remote verification failed: ' + verifyMsg + '\n');
      throw verifyErr;
    }
  } catch (pushErr) {
    const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr);
    appendFileSync(logFile, '[PUSH] Push failed: ' + pushMsg + '\n');

    let prExists = false;
    try {
      const prCheck = execFileSync(getToolPath('gh'), ['pr', 'list', '--head', pipeline.branch, '--json', 'url', '--jq', '.[0].url'], {
        cwd: deps.projectRoot, encoding: 'utf-8', stdio: 'pipe', timeout: 10_000,
      }).trim();
      if (prCheck) {
        prExists = true;
        appendFileSync(logFile, '[PUSH] PR already exists for branch ' + pipeline.branch + ': ' + prCheck + ' — push failure is non-fatal\n');
        appendFileSync(logFile, '[PUSH] Code is already in the PR — advancing to QA review\n');
      }
    } catch { /* gh unavailable or no PR exists — fall through to normal failure */ }

    if (!prExists) {
      appendFileSync(logFile, '[PUSH] Task cannot advance — engineer must be able to push before QA can verify\n');
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
  logFile: string,
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
    appendFileSync(logFile, '\n[SENSOR-GATE] post_subtask sensors failed (' + allSensorFailures.length + ' failure(s)) — bouncing to implement for sensor fixes\n');
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

  // ── Phase 2: Select subtasks ──
  const selection = selectSubtasks(pipeline);
  const { plan, effectiveSubtasks, groups, hasQaFeedback, hasHumanFeedback } = selection;

  const logFile = path.join(pipeline.specPath, 'output.log');
  const qaFeedbackPath = path.join(pipeline.specPath, 'qa_feedback.md');
  const humanFeedbackPath = path.join(pipeline.specPath, 'human_feedback.md');

  // Skip implement if all subtasks complete and not in QA rework
  if (!hasQaFeedback && effectiveSubtasks.length === 0 && plan.subtasks.length > 0) {
    appendFileSync(logFile, '\n[SKIP] All subtasks already completed — skipping implement, advancing to QA review\n');
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

    // Per-subtask worktree isolation
    if (isMultiGroup) {
      if (readContainerConfig(deps.projectRoot).enabled) {
        const info = containerManager.getRunningContainer(deps.projectRoot);
        containerWorkspace = info?.remoteWorkspaceFolder || undefined;
      }

      for (const subtask of subtasks) {
        const stWorktreePath = pipeline.worktreePath + '-st' + subtask.id;
        const stBranch = pipeline.branch + '-st' + subtask.id;

        // Defect 4: auto-recover unintegrated commits from a previous run
        // before force-deleting the branch. Without this, a retry after a
        // mid-implement failure silently discards finished subtask work that
        // was never cherry-picked onto the feature branch.
        const canRecreate = await _recoverSubtaskBranchBeforeDelete(pipeline, deps, logFile, stBranch, subtask);

        // Clean up old worktree directory (common to both paths)
        try { deps.execGit(['worktree', 'remove', '--force', stWorktreePath], deps.projectRoot); } catch { /* best-effort */ }
        if (existsSync(stWorktreePath)) {
          try { rmSync(stWorktreePath, { recursive: true, force: true }); } catch { /* best-effort */ }
          try { execFileSync('git', ['worktree', 'prune'], { cwd: deps.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
        }

        if (canRecreate) {
          try { execFileSync('git', ['branch', '-D', stBranch], { cwd: deps.projectRoot, stdio: 'pipe' }); } catch { /* best-effort */ }
          deps.execGit(['worktree', 'add', stWorktreePath, '-b', stBranch, pipeline.branch], deps.projectRoot);
        } else {
          // Branch preserved — create worktree from existing branch (no -b).
          // The merger agent in integrateGroup will handle conflicts when
          // cherry-picking back onto pipeline.branch.
          deps.execGit(['worktree', 'add', stWorktreePath, stBranch], deps.projectRoot);
          appendFileSync(logFile, '\n[WORKTREE] Created worktree from preserved branch ' + stBranch + ' (conflict resolution deferred to merger agent)\n');
        }

        if (containerWorkspace) {
          deps.patchWorktreeGitFile(stWorktreePath, containerWorkspace);
        }

        subtaskWorktrees.set(subtask.id, stWorktreePath);
        appendFileSync(logFile, '\n[WORKTREE] Created isolated worktree for subtask ' + subtask.id + ' at ' + stWorktreePath + '\n');
      }
    }

    const scopeViolations = new Set<number>();
    const sessionMapLock = { current: Promise.resolve() };

    const subtaskHandler = (subtask: PlanSubtask) =>
      runSubtaskSession(
        pipeline, deps, subtask,
        isMultiGroup ? subtaskWorktrees.get(subtask.id)! : pipeline.worktreePath,
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
      subtaskWorktrees, logFile, isMultiGroup,
    );
    if (!ok) {
      throw new WorktreeError(
        'Cherry-pick recovery exhausted — per-subtask branches have been preserved for manual recovery.',
        'CHERRY_PICK_RECOVERY_EXHAUSTED',
      );
    }

    // Batch-update plan.json (original group-level write, kept for compatibility
    // with the per-subtask checkpoints in runSubtaskSession).
    if (completedIds.length > 0) {
      deps.planWriteLock.current = deps.planWriteLock.current.then(() => {
        const planPath2 = path.join(pipeline.specPath, 'plan.json');
        try {
          const p = JSON.parse(readFileSync(planPath2, 'utf-8'));
          if (p.subtasks) {
            for (const s of p.subtasks) {
              if (completedIds.includes(s.id)) s.completed = true;
            }
          }
          writeFileSync(planPath2, JSON.stringify(p, null, 2));
        } catch { /* best-effort */ }
      });
    }
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
      appendFileSync(logFile, '[WAKEUP] Subtask ' + pipeline.wakeupSubtaskId + ' exceeded wakeup attempt cap (' + deps.getPipelineConfig().maxWakeupAttempts + ') — advancing to failed\n');
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
  const bounced = await applySensorGate(pipeline, deps, logFile);
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
  appendFileSync(logFile,
    '\n[WORKTREE] Found ' + commits.length + ' unintegrated commit(s) on ' + stBranch +
    ' (subtask ' + subtaskId + ') — auto-recovering:\n' +
    commits.map(c => '  ' + c).join('\n') + '\n'
  );

  // Attempt to cherry-pick the commits into the main worktree
  try {
    execGitFn(['cherry-pick', pipelineBranch + '..' + stBranch], worktreePath);
    appendFileSync(logFile,
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
        appendFileSync(logFile,
          '[WORKTREE] Infra error recovering ' + stBranch + ' — reprovisioning container and retrying (attempt ' + (retry + 1) + '/2)\n'
        );
        try {
          await containerManager.ensureContainer(projectRoot, logFile);
          await new Promise(r => setTimeout(r, 1000)); // brief backoff for container stabilisation
          execGitFn(['cherry-pick', pipelineBranch + '..' + stBranch], worktreePath);
          appendFileSync(logFile,
            '[WORKTREE] Auto-recovered ' + commits.length + ' commit(s) from ' + stBranch +
            ' onto ' + pipelineBranch + ' after infra retry\n'
          );
          return { recovered: true, commits };
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          appendFileSync(logFile, '[WORKTREE] Recovery retry ' + (retry + 1) + ' for ' + stBranch + ' failed: ' + retryMsg + '\n');
          try { execGitFn(['cherry-pick', '--abort'], worktreePath); } catch { /* best-effort */ }
        }
      }
      appendFileSync(logFile, '[WORKTREE] Infra retries exhausted for ' + stBranch + ' — cannot auto-recover\n');
      return { recovered: false, commits };
    }

    appendFileSync(logFile,
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

/** Check whether a cherry-pick is currently in progress (CHERRY_PICK_HEAD exists). */
function checkCherryPickInProgress(worktreePath: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', 'CHERRY_PICK_HEAD'], {
      cwd: worktreePath, encoding: 'utf-8', stdio: 'pipe',
    });
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
  // Tier 1: Normal cherry-pick
  try {
    appendFileSync(logFile, '\n[WORKTREE] Cherry-picking commits from ' + stBranch + ' onto ' + pipeline.branch + '\n');
    deps.execGit(['cherry-pick', pipeline.branch + '..' + stBranch], pipeline.worktreePath);
    appendFileSync(logFile, '[WORKTREE] Cherry-pick succeeded for subtask ' + subtaskId + '\n');
    return true;
  } catch (firstErr) {
    const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr);
    appendFileSync(logFile, '[WORKTREE] Cherry-pick failed for subtask ' + subtaskId + ': ' + firstMsg + '\n');

    // Defect 3: detect infra-class errors (dead container, Docker unreachable)
    // and retry after reprovisioning before giving up. These are trivially
    // retryable once the container is back, unlike genuine git conflicts.
    if (!checkCherryPickInProgress(pipeline.worktreePath) && isInfraError(firstMsg)) {
      try { deps.execGit(['cherry-pick', '--abort'], pipeline.worktreePath); } catch { /* best-effort */ }

      // Check if container mode is active and attempt reprovision
      if (readContainerConfig(deps.projectRoot).enabled) {
        for (let retry = 0; retry < 2; retry++) {
          appendFileSync(logFile, '[WORKTREE] Infra error detected — reprovisioning container and retrying cherry-pick (attempt ' + (retry + 1) + '/2)\n');
          try {
            await containerManager.ensureContainer(deps.projectRoot, logFile);
            await new Promise(r => setTimeout(r, 1000)); // brief backoff for container stabilisation
            deps.execGit(['cherry-pick', pipeline.branch + '..' + stBranch], pipeline.worktreePath);
            appendFileSync(logFile, '[WORKTREE] Cherry-pick recovered after infra retry for subtask ' + subtaskId + '\n');
            return true;
          } catch (retryErr) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            appendFileSync(logFile, '[WORKTREE] Cherry-pick retry ' + (retry + 1) + ' failed: ' + retryMsg + '\n');
            try { deps.execGit(['cherry-pick', '--abort'], pipeline.worktreePath); } catch { /* best-effort */ }
          }
        }
        appendFileSync(logFile, '[WORKTREE] Infra retries exhausted for subtask ' + subtaskId + ' — cannot auto-recover\n');
        return false;
      }

      // Not in container mode — nothing to reprovision
      appendFileSync(logFile, '[WORKTREE] Cherry-pick hard-failed (not a conflict) — cannot auto-recover subtask ' + subtaskId + '\n');
      return false;
    }
  }

  // Check whether this is a recoverable conflict or a hard failure
  if (!checkCherryPickInProgress(pipeline.worktreePath)) {
    try { deps.execGit(['cherry-pick', '--abort'], pipeline.worktreePath); } catch { /* best-effort */ }
    appendFileSync(logFile, '[WORKTREE] Cherry-pick hard-failed (not a conflict) — cannot auto-recover subtask ' + subtaskId + '\n');
    return false;
  }

  // Tier 2: Spawn merger agent to resolve conflicts semantically
  try {
    const conflictedFiles = execFileSync('git', ['diff', '--name-only', '--diff-filter=U'], {
      cwd: pipeline.worktreePath, encoding: 'utf-8', stdio: 'pipe',
    }).trim();
    appendFileSync(logFile, '[WORKTREE] Conflicted files: ' + (conflictedFiles || '(none listed)') + '\n');
  } catch { /* best-effort — proceed with merger */ }
  appendFileSync(logFile, '[WORKTREE] Cherry-pick has conflicts — spawning merger agent for subtask ' + subtaskId + '\n');
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

    if (checkCherryPickInProgress(pipeline.worktreePath)) {
      appendFileSync(logFile, '[WORKTREE] Merger finished but cherry-pick still in progress for subtask ' + subtaskId + ' — aborting\n');
      try { deps.execGit(['cherry-pick', '--abort'], pipeline.worktreePath); } catch { /* best-effort */ }
      return false;
    }

    appendFileSync(logFile, '[WORKTREE] Merger agent resolved cherry-pick conflicts for subtask ' + subtaskId + '\n');
    return true;
  } catch (mergeErr) {
    const mergeMsg = mergeErr instanceof Error ? mergeErr.message : String(mergeErr);
    appendFileSync(logFile, '[WORKTREE] Merger agent failed for subtask ' + subtaskId + ': ' + mergeMsg + '\n');
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
